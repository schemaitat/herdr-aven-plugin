//! Scoped Aven task reads and generation fencing.

use crate::{
    dispatch::lifecycle::ensure_pending_admission_open,
    model::{Attempt, EffectRecord, Invocation},
    process::{aven, aven_args, now, run},
    store::{LockedStore, store_attempt},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

const AVEN_METADATA_VALUE_LIMIT: usize = 4096;
pub(crate) const HANDOFF_MARKER_PREFIX: &str = "aven-dispatch:handoff:";

fn handoff_marker(attempt: &Attempt) -> String {
    format!("<!-- {HANDOFF_MARKER_PREFIX}{} -->", attempt.attempt_id)
}

fn effect(attempt: &Attempt, operation_id: String, kind: &str, payload: &str) -> EffectRecord {
    EffectRecord {
        scope: attempt
            .aven
            .workspace
            .clone()
            .unwrap_or_else(|| "default".into()),
        task_id: attempt.task_id.clone(),
        task_ref: attempt.task_ref.clone(),
        workflow: attempt.workflow.clone(),
        attempt_id: attempt.attempt_id.clone(),
        operation_id,
        kind: kind.into(),
        state: "pending".into(),
        payload: payload.into(),
        generation: attempt.generation,
        revision: attempt.lifecycle.revision,
        created_at: now(),
        updated_at: now(),
    }
}

fn task_notes(task: &Value) -> Vec<&str> {
    task.get("notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|note| note.get("body").and_then(Value::as_str))
        .collect()
}

fn task_has_marker(task: &Value, marker: &str) -> bool {
    task_notes(task).iter().any(|note| note.contains(marker))
}

/// Read a bounded, scoped Aven list. Used only for idempotent read-back of
/// logical operations created by this dispatcher.
pub(crate) fn list_tasks(
    invocation: &Invocation,
    project: &str,
    metadata: Option<&str>,
) -> Result<Vec<Value>> {
    let mut args = vec![
        "list".to_owned(),
        "--project".into(),
        project.into(),
        "--json".into(),
        "--limit".into(),
        "500".into(),
    ];
    if let Some(metadata) = metadata {
        args.extend(["--metadata".into(), metadata.into()]);
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = aven(invocation, &refs, None)?;
    serde_json::from_str(&output).context("Aven list --json output")
}

// Admission/reopen task validation and reset-generation fencing.
pub(crate) fn refresh_task_by_ref(invocation: &Invocation, reference: &str) -> Result<Value> {
    let output = aven(invocation, &["context", reference, "--json"], None)?;
    serde_json::from_str(&output).context("Aven context --json output")
}
pub(crate) fn task_generation(task: &Value) -> Result<u64> {
    match task
        .pointer("/metadata/dispatch.reset-generation")
        .and_then(Value::as_str)
    {
        Some(value) => value.parse().context("invalid dispatch.reset-generation"),
        None => Ok(0),
    }
}
pub(crate) fn reset_incomplete(task: &Value) -> bool {
    task.pointer("/metadata/dispatch.reset-state")
        .and_then(Value::as_str)
        == Some("incomplete")
}
pub(crate) fn ensure_attempt_current(task: &Value, attempt: &Attempt) -> Result<()> {
    if reset_incomplete(task) {
        bail!(
            "task reset is incomplete; rerun aven-dispatch reset after resolving its preflight error"
        );
    }
    let generation = task_generation(task)?;
    if attempt.generation != generation {
        bail!(
            "attempt {} belongs to reset generation {}, but task is generation {}; dispatch a fresh session",
            attempt.attempt_id,
            attempt.generation,
            generation
        );
    }
    Ok(())
}

// Machine-readable dispatcher diagnostics.
pub(crate) fn dispatcher_event(attempt: &Attempt, event: &str, detail: &str) -> Value {
    json!({
        "schema": "aven-dispatch-event/v1",
        "time_ms": now(),
        "source_task": attempt.task_ref,
        "attempt_id": attempt.attempt_id,
        "event": event,
        "state": attempt.state,
        "worktree": attempt.worktree,
        "terminal": if attempt.terminal.is_empty() { &attempt.coordinator_terminal.address } else { &attempt.terminal.address },
        "core_id": attempt.core_id,
        "backend": attempt.backend,
        "legacy_pane": attempt.pane,
        "opencode_session_id": attempt.session_id,
        "detail": detail,
    })
}
pub(crate) fn write_debug_event(attempt: &Attempt, event: &str, detail: &str) -> Option<Value> {
    if attempt.log_task_ref.is_empty() {
        return None;
    }
    let record = dispatcher_event(attempt, event, detail);
    // Debug evidence must never hide the operation's original outcome.
    let _ = aven(
        &attempt.aven,
        &["note", &attempt.log_task_ref, "--stdin"],
        Some(&record.to_string()),
    );
    Some(record)
}

// Terminal launch plus durable observation checkpoint.
// Babysitter session creation, terminal checkpointing, and prompt admission.
// Dispatch prompt and durable log ownership.

// Durable task metadata snapshots and handoff links.
pub(crate) fn write_aven_links(
    invocation: &Invocation,
    attempt: &Attempt,
    store: &mut LockedStore,
) -> Result<()> {
    // Aven owns the task-scoped durable snapshot. The individual metadata
    // fields stay queryable, while one workflow-scoped dispatch.attempt snapshot
    // per role permits recovery from any checkout without consulting the
    // central store's row. Planning and implementation therefore retain
    // separate sessions while sharing the selected task's worktree branch.
    let current = refresh_task_by_ref(invocation, &attempt.task_ref)?;
    ensure_attempt_current(&current, attempt)?;
    ensure_pending_admission_open(&current, attempt)?;
    // The snapshot written by this successful publication must represent the
    // post-write state. Keep the durable attempt pending until the write and
    // read-back complete, but don't publish that transient flag back to Aven.
    let snapshot = serialize_aven_publication_snapshot(attempt)?;
    let metadata = vec![
        "dispatch.backend=hc".to_owned(),
        format!("dispatch.session-id={}", attempt.session_id),
        format!("dispatch.core-id={}", attempt.core_id),
        format!(
            "dispatch.terminal={}",
            if attempt.terminal.is_empty() {
                &attempt.coordinator_terminal.address
            } else {
                &attempt.terminal.address
            }
        ),
        format!("dispatch.attempt-id={}", attempt.attempt_id),
        format!("dispatch.state={}", attempt.state),
        format!("dispatch.workflow={}", attempt.workflow),
        format!("dispatch.branch={}", attempt.branch),
        format!("dispatch.attempt.{}={}", attempt.workflow, snapshot),
    ];
    let current_status = current
        .pointer("/task/status")
        .and_then(Value::as_str)
        .unwrap_or("todo");
    // A stale local snapshot must never reactivate work accepted or canceled by
    // Aven. Session completion is execution evidence, not task acceptance.
    let next_status = if matches!(current_status, "done" | "canceled") {
        current_status
    } else {
        "active"
    };
    // Persist metadata intent before the external write. Repeating an
    // unchanged edit is naturally idempotent; the journal proves the exact
    // operation and lets ambiguous outcomes stay visibly pending.
    let metadata_effect = store.begin_effect(effect(
        attempt,
        format!("{}:{}:metadata", attempt.attempt_id, attempt.generation),
        "aven-metadata",
        &metadata.join("\n"),
    ));
    store.save()?;
    let mut args = vec![
        "edit".to_owned(),
        attempt.task_ref.clone(),
        "--status".into(),
        next_status.into(),
    ];
    for item in &metadata {
        args.extend(["--metadata".into(), item.clone()]);
    }
    let executable = if invocation.aven_exe.is_empty() {
        "aven"
    } else {
        &invocation.aven_exe
    };
    if let Err(error) = run(
        executable,
        &{
            let mut global = aven_args(invocation, &[]);
            global.extend(args);
            global
        },
        None,
    ) {
        store.fail_effect(&metadata_effect, "unknown", &format!("{error:#}"));
        store.save()?;
        return Err(error).context("publish dispatcher metadata");
    }
    // Read back the exact scoped metadata before considering the effect done.
    // An Aven build that exposes no metadata surface at all is treated as the
    // successful edit result; a present surface must match exactly.
    let after = refresh_task_by_ref(invocation, &attempt.task_ref)?;
    if after.get("metadata").and_then(Value::as_object).is_some() {
        let observed_state = after
            .pointer("/metadata/dispatch.state")
            .and_then(Value::as_str);
        let observed_attempt = after
            .pointer("/metadata/dispatch.attempt-id")
            .and_then(Value::as_str);
        if observed_state != Some(attempt.state.as_str())
            || observed_attempt != Some(attempt.attempt_id.as_str())
        {
            store.fail_effect(
                &metadata_effect,
                "unknown",
                "metadata read-back did not match the intended attempt/state",
            );
            store.save()?;
            bail!(
                "Aven metadata read-back for {} did not match attempt {} state {}; synchronization remains pending",
                attempt.task_ref,
                attempt.attempt_id,
                attempt.state
            );
        }
    }
    store.complete_effect(&metadata_effect, None);

    // Terminal tasks never receive a new operational handoff. A completed
    // handoff is a durable logical fact: retries inspect it rather than
    // appending a second note.
    if matches!(current_status, "done" | "canceled") {
        store.save()?;
        return Ok(());
    }
    let handoff_id = format!("{}:{}:handoff", attempt.attempt_id, attempt.generation);
    let marker = handoff_marker(attempt);
    if store.effect_completed(&attempt.task_id, &attempt.workflow, &handoff_id)
        || task_has_marker(&after, &marker)
    {
        store.complete_effect(
            &effect(attempt, handoff_id, "handoff-note", "already present"),
            None,
        );
        store.save()?;
        return Ok(());
    }
    let existing = store
        .store
        .effects
        .values()
        .find(|item| {
            item.task_id == attempt.task_id
                && item.workflow == attempt.workflow
                && item.operation_id == handoff_id
        })
        .cloned();
    if existing
        .as_ref()
        .is_some_and(|item| item.state == "unknown")
    {
        // The previous note attempt is ambiguous. Do not repeat it until a
        // later read proves whether it landed.
        store.save()?;
        bail!(
            "dispatcher handoff for attempt {} is ambiguous; inspect notes before retrying",
            attempt.attempt_id
        );
    }
    let note_effect = store.begin_effect(
        existing.unwrap_or_else(|| effect(attempt, handoff_id, "handoff-note", &marker)),
    );
    store.save()?;
    let note = format!(
        "## Dispatcher handoff\n\n{marker}\n\nOpenCode prompt admitted for attempt `{}` (session `{}`). Worktree branch: `{}`. Execution state: `{}`. Use `aven-dispatch status {}` to inspect permissions, forms, and recovery state.",
        attempt.attempt_id, attempt.session_id, attempt.branch, attempt.state, attempt.task_ref
    );
    if let Err(error) = aven(
        invocation,
        &["note", &attempt.task_ref, "--stdin"],
        Some(&note),
    ) {
        // The note may or may not have landed. Keep it unknown and require a
        // fresh read before any retry.
        store.fail_effect(&note_effect, "unknown", &format!("{error:#}"));
        store.save()?;
        return Err(error).context("publish dispatcher handoff note");
    }
    match refresh_task_by_ref(invocation, &attempt.task_ref) {
        Ok(readback) if !task_has_marker(&readback, &marker) => {
            // A payload with a notes surface that omits the marker is a real
            // read-back contradiction. A payload with no notes surface is the
            // successful command result.
            if readback.get("notes").is_some() {
                store.fail_effect(
                    &note_effect,
                    "unknown",
                    "handoff note read-back did not contain its stable marker",
                );
                store.save()?;
                bail!(
                    "Aven handoff note read-back for attempt {} was incomplete; synchronization remains pending",
                    attempt.attempt_id
                );
            }
        }
        Ok(_) => {}
        Err(_) => {
            // The note command exited successfully; a failed read-back is an
            // observation gap, not permission to append a second note. A later
            // reconcile re-reads the evidence without re-publishing.
        }
    }
    store.complete_effect(&note_effect, None);
    store.save()?;
    Ok(())
}
pub(crate) fn aven_attempt_snapshot(attempt: &Attempt) -> Attempt {
    let mut snapshot = attempt.clone();
    // The full prompt is retained in the dispatcher store for recovery, but
    // after admission it is not needed in Aven's size-limited metadata. Keep
    // pending and unknown states intact: they may still need the exact body
    // to recover an admission without submitting a different prompt.
    if matches!(
        snapshot.state.as_str(),
        "running" | "waiting" | "interrupted" | "failed" | "needs-review" | "completed"
    ) {
        snapshot.pending_prompt.clear();
    }
    snapshot
}

fn serialize_aven_attempt_snapshot(attempt: &Attempt) -> Result<String> {
    let snapshot = serde_json::to_string(&aven_attempt_snapshot(attempt))?;
    if snapshot.len() > AVEN_METADATA_VALUE_LIMIT {
        bail!(
            "dispatcher snapshot is {} UTF-8 bytes, exceeding Aven's {}-byte metadata limit; pending prompt and full attempt remain in the dispatcher store",
            snapshot.len(),
            AVEN_METADATA_VALUE_LIMIT
        );
    }
    Ok(snapshot)
}

fn serialize_aven_publication_snapshot(attempt: &Attempt) -> Result<String> {
    let mut published = attempt.clone();
    published.aven_update_pending = false;
    serialize_aven_attempt_snapshot(&published)
}

/// Compare the durable, workflow-scoped Aven snapshot with the current
/// dispatcher attempt while ignoring observation timestamps that naturally
/// advance on every read. This repairs a stale Aven snapshot even when an old
/// store row incorrectly says publication is no longer pending.
pub(crate) fn aven_snapshot_matches(task: &Value, attempt: &Attempt) -> Result<bool> {
    let key = format!("dispatch.attempt.{}", attempt.workflow);
    let Some(encoded) = task
        .pointer(&format!("/metadata/{key}"))
        .and_then(Value::as_str)
    else {
        return Ok(false);
    };
    let Ok(observed) = serde_json::from_str::<Attempt>(encoded) else {
        return Ok(false);
    };
    let normalize = |attempt: &Attempt| -> Result<Value> {
        let mut value = serde_json::to_value(aven_attempt_snapshot(attempt))?;
        if let Some(lifecycle) = value.get_mut("lifecycle")
            && let Some(object) = lifecycle.as_object_mut()
        {
            object.insert("reduced_at".into(), Value::from(0));
        }
        if let Some(terminals) = value.get_mut("terminals")
            && let Some(roles) = terminals.as_object_mut()
        {
            for terminal in roles.values_mut() {
                if let Some(object) = terminal.as_object_mut() {
                    object.insert("updated_at".into(), Value::from(0));
                }
            }
        }
        Ok(value)
    };
    if normalize(&observed)? != normalize(attempt)? {
        return Ok(false);
    }
    let summary_owner = task
        .pointer("/metadata/dispatch.summary-owner")
        .and_then(Value::as_str);
    if summary_owner.is_none_or(|owner| owner == attempt.workflow)
        && (task
            .pointer("/metadata/dispatch.state")
            .and_then(Value::as_str)
            != Some(attempt.state.as_str())
            || task
                .pointer("/metadata/dispatch.attempt-id")
                .and_then(Value::as_str)
                != Some(attempt.attempt_id.as_str()))
    {
        return Ok(false);
    }
    Ok(true)
}

// Durable task link repair. A failure remains visible as pending
// synchronization instead of being silently swallowed.
pub(crate) fn repair_aven_links(attempt: &mut Attempt, store: &mut LockedStore) -> Result<()> {
    write_aven_links(&attempt.aven, attempt, store)?;
    attempt.aven_update_pending = false;
    store_attempt(store, attempt.clone());
    store.save()?;
    Ok(())
}

// Worktree-mode coordinator prompt topology.

// Dispatcher diagnostic task provisioning.
pub(crate) fn ensure_log_task(attempt: &mut Attempt, store: &mut LockedStore) -> Result<()> {
    if !attempt.log_task_ref.is_empty() {
        return Ok(());
    }
    let operation_id = format!("{}:{}:log-task", attempt.attempt_id, attempt.generation);
    let metadata = format!("dispatch.attempt-id={}", attempt.attempt_id);
    let discovered = list_tasks(&attempt.aven, "dispatcher-logs", Some(&metadata))
        .unwrap_or_default()
        .into_iter()
        .find_map(|task| {
            task.pointer("/ref")
                .or_else(|| task.pointer("/display_ref"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    if let Some(reference) = discovered {
        attempt.log_task_ref = reference.clone();
        let record = store.begin_effect(effect(attempt, operation_id, "log-task", &reference));
        store.complete_effect(&record, Some(&reference));
        store.save()?;
        return Ok(());
    }
    let previous = store
        .store
        .effects
        .values()
        .find(|item| {
            item.task_id == attempt.task_id
                && item.workflow == attempt.workflow
                && item.operation_id == operation_id
        })
        .cloned();
    if previous
        .as_ref()
        .is_some_and(|item| item.state == "unknown")
    {
        bail!(
            "log task creation for attempt {} is ambiguous; inspect Aven before retrying",
            attempt.attempt_id
        );
    }
    let record = store.begin_effect(
        previous.unwrap_or_else(|| effect(attempt, operation_id, "log-task", &metadata)),
    );
    store.save()?;
    // Creating an existing project is harmlessly rejected by Aven; the add
    // operation below remains the authority for whether logging is available.
    let _ = aven(
        &attempt.aven,
        &["project", "create", "Dispatcher Logs"],
        None,
    );
    let title = format!(
        "Dispatch log: {} ({})",
        attempt.task_ref, attempt.attempt_id
    );
    let source = format!(
        "Source task: `{}`\n\nAttempt: `{}`",
        attempt.task_ref, attempt.attempt_id
    );
    let output = aven(
        &attempt.aven,
        &[
            "add",
            &title,
            "--project",
            "dispatcher-logs",
            "--status",
            "active",
            "--description",
            &source,
            "--metadata",
            &metadata,
        ],
        None,
    );
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            // A failed `add` may still have created the task. Search before
            // declaring the operation unknown.
            if let Some(reference) = list_tasks(&attempt.aven, "dispatcher-logs", Some(&metadata))
                .unwrap_or_default()
                .into_iter()
                .find_map(|task| {
                    task.pointer("/ref")
                        .or_else(|| task.pointer("/display_ref"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
            {
                attempt.log_task_ref = reference.clone();
                store.complete_effect(&record, Some(&reference));
                store.save()?;
                return Ok(());
            }
            store.fail_effect(&record, "unknown", &format!("{error:#}"));
            store.save()?;
            return Err(error).context("create dispatcher log task");
        }
    };
    let log_task_ref = output
        .split_whitespace()
        .nth(1)
        .filter(|reference| !reference.is_empty())
        .context("Aven did not return a log task reference")?
        .to_owned();
    let _ = aven(
        &attempt.aven,
        &["related", "add", &log_task_ref, &attempt.task_ref],
        None,
    );
    attempt.log_task_ref = log_task_ref.clone();
    store.complete_effect(&record, Some(&log_task_ref));
    store.save()?;
    Ok(())
}

// Reopen effects after preflight and store-lock release.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Attempt, ExecutionMode, Invocation, TerminalRef};
    use std::collections::BTreeMap;

    #[test]
    fn admitted_aven_snapshot_omits_large_prompt_without_changing_store_copy() {
        let mut attempt: Attempt = serde_json::from_value(serde_json::json!({
            "task_id":"task", "task_ref":"APP-TASK", "workflow":"implementation",
            "attempt_id":"att", "branch":"branch", "worktree":"/tmp", "session_id":"ses",
            "prompt_id":"msg", "state":"needs-review", "aven":{}, "created_at":0
        }))
        .unwrap();
        attempt.pending_prompt = "large prompt".repeat(3000);
        for state in [
            "running",
            "waiting",
            "interrupted",
            "failed",
            "needs-review",
            "completed",
        ] {
            attempt.state = state.into();
            assert!(aven_attempt_snapshot(&attempt).pending_prompt.is_empty());
            assert!(serialize_aven_attempt_snapshot(&attempt).is_ok());
        }
        assert_eq!(attempt.pending_prompt.len(), 36000);
        for state in ["prompt-pending", "terminal-pending", "unknown"] {
            attempt.state = state.into();
            assert_eq!(
                aven_attempt_snapshot(&attempt).pending_prompt,
                attempt.pending_prompt
            );
            assert!(serialize_aven_attempt_snapshot(&attempt).is_err());
        }
    }

    #[test]
    fn stale_aven_snapshot_is_detected_but_observation_timestamps_are_ignored() {
        let mut attempt: Attempt = serde_json::from_value(serde_json::json!({
            "task_id":"task", "task_ref":"APP-TASK", "workflow":"implementation",
            "attempt_id":"att", "branch":"branch", "worktree":"/tmp", "session_id":"ses",
            "prompt_id":"msg", "state":"completed", "aven":{}, "created_at":1,
            "lifecycle":{"observation":"stopped-success","contradiction":"","revision":1,"reduced_at":20},
            "terminals":{"builder":{"core_id":"core","address":"t1","state":"live","program":"opencode","status":"idle","updated_at":30}}
        }))
        .unwrap();
        let mut snapshot = aven_attempt_snapshot(&attempt);
        snapshot.lifecycle.reduced_at = 10;
        snapshot.terminals.get_mut("builder").unwrap().updated_at = 15;
        let task = serde_json::json!({
            "metadata":{
                "dispatch.attempt-id":"att",
                "dispatch.state":"completed",
                "dispatch.attempt.implementation":serde_json::to_string(&snapshot).unwrap()
            }
        });
        assert!(aven_snapshot_matches(&task, &attempt).unwrap());

        attempt.state = "needs-review".into();
        assert!(!aven_snapshot_matches(&task, &attempt).unwrap());
    }

    #[test]
    fn published_aven_snapshot_clears_pending_flag_without_clearing_store_copy() {
        let mut attempt: Attempt = serde_json::from_value(serde_json::json!({
            "task_id":"task", "task_ref":"APP-TASK", "workflow":"implementation",
            "attempt_id":"att", "branch":"branch", "worktree":"/tmp", "session_id":"ses",
            "prompt_id":"msg", "state":"needs-review", "aven":{}, "created_at":1,
            "aven_update_pending":true
        }))
        .unwrap();

        let serialized = serialize_aven_publication_snapshot(&attempt).unwrap();
        let published: Attempt = serde_json::from_str(&serialized).unwrap();
        assert!(!published.aven_update_pending);
        assert!(attempt.aven_update_pending);

        let task = serde_json::json!({
            "metadata": {
                "dispatch.attempt-id":"att",
                "dispatch.state":"needs-review",
                "dispatch.attempt.implementation":serialized
            }
        });
        attempt.aven_update_pending = false;
        assert!(aven_snapshot_matches(&task, &attempt).unwrap());
    }

    #[test]
    fn aven_snapshot_limit_counts_serialized_utf8_and_escaping() {
        let mut attempt: Attempt = serde_json::from_value(serde_json::json!({
            "task_id":"task", "task_ref":"APP-TASK", "workflow":"implementation",
            "attempt_id":"att", "branch":"branch", "worktree":"/tmp", "session_id":"ses",
            "prompt_id":"msg", "state":"prompt-pending", "aven":{}, "created_at":0
        }))
        .unwrap();
        let base = serialize_aven_attempt_snapshot(&attempt).unwrap().len();
        attempt.pending_prompt = "é".repeat((AVEN_METADATA_VALUE_LIMIT - base) / 2);
        assert!(serialize_aven_attempt_snapshot(&attempt).is_ok());
        attempt.pending_prompt.push('é');
        assert!(serialize_aven_attempt_snapshot(&attempt).is_err());
        attempt.pending_prompt = "\\".repeat((AVEN_METADATA_VALUE_LIMIT - base) / 2);
        assert!(serialize_aven_attempt_snapshot(&attempt).is_ok());
        attempt.pending_prompt.push('\\');
        assert!(serialize_aven_attempt_snapshot(&attempt).is_err());
    }
    #[test]
    fn dispatcher_events_are_machine_readable_json() {
        let attempt = Attempt {
            task_id: "task-id".into(),
            task_ref: "APP-1".into(),
            workflow: "default".into(),
            attempt_id: "att_1".into(),
            branch: "app/dispatch-task-id".into(),
            worktree: "/worktree".into(),
            worktree_created_by_attempt: true,
            backend: "hc".into(),
            core_id: String::new(),
            core_name: String::new(),
            terminal: TerminalRef::default(),
            pane: "w1:p1".into(),
            aven_panel: false,
            agent: "build".into(),
            model: "provider/model".into(),
            execution_mode: ExecutionMode::SingleSession,
            coordinator_session_id: "ses_1".into(),
            coordinator_agent: "build".into(),
            coordinator_model: "provider/model".into(),
            coordinator_terminal: TerminalRef::default(),
            auto_permissions: true,
            phases: Vec::new(),
            terminals: BTreeMap::new(),
            last_event_seq: 0,
            session_id: "ses_1".into(),
            prompt_id: "msg_1".into(),
            pending_prompt: String::new(),
            state: "running".into(),
            lifecycle: crate::model::LifecycleState::default(),
            aven_update_pending: false,
            log_cursor: String::new(),
            log_task_ref: "DL-1".into(),
            generation: 0,
            babysitter: false,
            babysitter_model: String::new(),
            babysitter_terminal: TerminalRef::default(),
            babysitter_pane: String::new(),
            babysitter_session_id: String::new(),
            babysitter_prompt_id: String::new(),
            aven: Invocation {
                aven_exe: String::new(),
                db_path: None,
                workspace: None,
                origin_cwd: String::new(),
            },
            created_at: 0,
        };
        let record = dispatcher_event(&attempt, "completed", "verified");
        assert_eq!(record["schema"], "aven-dispatch-event/v1");
        assert_eq!(record["source_task"], "APP-1");
        assert_eq!(record["event"], "completed");
        assert_eq!(record["detail"], "verified");
    }
}
