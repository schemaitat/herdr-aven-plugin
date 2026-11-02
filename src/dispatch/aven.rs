//! Scoped Aven task reads and generation fencing.

use crate::{
    model::{Attempt, Invocation},
    process::{aven, aven_args, now, run},
    store::{LockedStore, store_attempt},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

const AVEN_METADATA_VALUE_LIMIT: usize = 4096;

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
pub(crate) fn write_aven_links(invocation: &Invocation, attempt: &Attempt) -> Result<()> {
    // Aven owns the task-scoped durable snapshot. The individual metadata
    // fields stay queryable, while one workflow-scoped dispatch.attempt snapshot
    // per role permits recovery from any checkout without consulting the
    // central store's row. Planning and implementation therefore retain
    // separate sessions while sharing the selected task's worktree branch.
    let current = refresh_task_by_ref(invocation, &attempt.task_ref)?;
    ensure_attempt_current(&current, attempt)?;
    let snapshot = serialize_aven_attempt_snapshot(attempt)?;
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
    let mut args = vec![
        "edit".to_owned(),
        attempt.task_ref.clone(),
        "--status".into(),
        next_status.into(),
    ];
    for item in metadata {
        args.extend(["--metadata".into(), item]);
    }
    let executable = if invocation.aven_exe.is_empty() {
        "aven"
    } else {
        &invocation.aven_exe
    };
    run(
        executable,
        &{
            let mut global = aven_args(invocation, &[]);
            global.extend(args);
            global
        },
        None,
    )?;
    let note = format!(
        "## Dispatcher handoff\n\nOpenCode prompt admitted for attempt `{}` (session `{}`). Worktree branch: `{}`. Execution state: `{}`. Use `aven-dispatch status {}` to inspect permissions, forms, and recovery state.",
        attempt.attempt_id, attempt.session_id, attempt.branch, attempt.state, attempt.task_ref
    );
    aven(
        invocation,
        &["note", &attempt.task_ref, "--stdin"],
        Some(&note),
    )?;
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

// Best-effort durable task link repair.
pub(crate) fn repair_aven_links(attempt: &mut Attempt, store: &mut LockedStore) -> Result<()> {
    if write_aven_links(&attempt.aven, attempt).is_ok() {
        attempt.aven_update_pending = false;
        store_attempt(store, attempt.clone());
        store.save()?;
    }
    Ok(())
}

// Worktree-mode coordinator prompt topology.

// Dispatcher diagnostic task provisioning.
pub(crate) fn ensure_log_task(attempt: &mut Attempt) -> Result<()> {
    if !attempt.log_task_ref.is_empty() {
        return Ok(());
    }
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
            &format!("dispatch.attempt-id={}", attempt.attempt_id),
        ],
        None,
    )?;
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
    attempt.log_task_ref = log_task_ref;
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
