//! Reset inventory and pure state helpers.

use crate::{
    dispatch::{
        aven::{refresh_task_by_ref, reset_incomplete, task_generation},
        parse_context, selected_for,
    },
    model::{Attempt, Invocation},
    process::{aven, aven_args, field, opencode, run},
    store::LockedStore,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    time::Duration,
};

pub(crate) fn metadata_attempts(task: &Value, task_id: &str) -> Result<Vec<Attempt>> {
    let empty = serde_json::Map::new();
    let metadata = task
        .get("metadata")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut attempts = Vec::new();
    for (key, value) in metadata {
        if key == "dispatch.attempt" || key.starts_with("dispatch.attempt.") {
            let snapshot = value
                .as_str()
                .with_context(|| format!("{key} must be a JSON string"))?;
            let attempt: Attempt = serde_json::from_str(snapshot)
                .with_context(|| format!("invalid {key} snapshot"))?;
            if attempt.task_id != task_id {
                bail!("{key} snapshot belongs to a different immutable task");
            }
            attempts.push(attempt);
        }
    }
    Ok(attempts)
}
pub(crate) fn attempt_session_ids(attempt: &Attempt) -> Vec<&str> {
    let mut ids = vec![
        attempt.session_id.as_str(),
        attempt.coordinator_session_id.as_str(),
        attempt.babysitter_session_id.as_str(),
    ];
    ids.extend(attempt.phases.iter().map(|phase| phase.session_id.as_str()));
    ids.into_iter().filter(|id| !id.is_empty()).collect()
}
pub(crate) fn json_contains_string(value: &Value, expected: &str) -> bool {
    match value {
        Value::String(value) => value == expected,
        Value::Array(values) => values
            .iter()
            .any(|value| json_contains_string(value, expected)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key == expected || json_contains_string(value, expected)),
        _ => false,
    }
}
pub(crate) fn active_sessions(sessions: &[String], active: &Value) -> Vec<String> {
    sessions
        .iter()
        .filter(|id| json_contains_string(active, id))
        .cloned()
        .collect()
}
pub(crate) fn authoritative_execution_state(current: &str, snapshot: &Value) -> String {
    // A local admission checkpoint is not superseded by an API snapshot that
    // has not observed the prompt yet. Downgrading it would strand a durable
    // pending prompt and could make recovery submit it twice.
    if matches!(
        current,
        "workspace-pending"
            | "session-pending"
            | "terminal-pending"
            | "prompt-pending"
            | "babysitter-session-pending"
            | "babysitter-prompt-pending"
    ) {
        return current.into();
    }
    match snapshot.pointer("/data/outcome").and_then(Value::as_str) {
        Some("succeeded") => "needs-review".into(),
        Some("failed") => "failed".into(),
        Some("interrupted") | Some("canceled") => "interrupted".into(),
        // An explicit local interrupt remains terminal even if an older
        // snapshot has not yet exposed its outcome.
        None if current == "interrupted" => "interrupted".into(),
        None => "running".into(),
        Some(_) => "waiting".into(),
    }
}
pub(crate) fn reset_phase_children(root: &Value) -> Result<Vec<String>> {
    let empty = Vec::new();
    root.pointer("/epic_children")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .map(|child| {
            child
                .get("ref")
                .and_then(Value::as_str)
                .filter(|reference| !reference.is_empty())
                .map(str::to_owned)
                .context("epic child is missing ref")
        })
        .collect()
}

pub(crate) fn reset_operation_strings(operation: &Value, key: &str) -> Result<Vec<String>> {
    operation
        .get(key)
        .map(|value| {
            value
                .as_array()
                .with_context(|| format!("reset operation {key} must be an array"))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .with_context(|| format!("reset operation {key} contains an invalid value"))
                })
                .collect()
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}
pub(crate) fn merged_reset_inventory(
    mut current: Vec<String>,
    recovered: Vec<String>,
) -> Vec<String> {
    current.extend(recovered);
    current.sort();
    current.dedup();
    current
}

// Reset session state refresh and interrupt/drain operations.
pub(crate) fn refresh_attempt_execution_state(attempt: &mut Attempt) -> Result<()> {
    if attempt.session_id.is_empty() {
        return Ok(());
    }
    let snapshot = opencode("GET", &format!("/api/session/{}", attempt.session_id), None)?;
    attempt.state = authoritative_execution_state(&attempt.state, &snapshot);
    Ok(())
}
pub(crate) fn interrupt_and_drain_sessions(sessions: &[String]) -> Result<()> {
    let unique: BTreeSet<_> = sessions.iter().collect();
    for session in unique {
        opencode("POST", &format!("/api/session/{session}/interrupt"), None)
            .with_context(|| format!("interrupt associated OpenCode session {session}"))?;
    }
    for _ in 0..60 {
        let active = opencode("GET", "/api/session/active", None)
            .context("cannot confirm OpenCode sessions stopped after reset interrupt")?;
        let running = active_sessions(sessions, &active);
        if running.is_empty() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    bail!(
        "associated OpenCode session(s) remained active after interrupt: {}",
        active_sessions(sessions, &opencode("GET", "/api/session/active", None)?).join(", ")
    );
}

// Reset target resolution and confirmation.
pub(crate) fn reset_context(task: Option<String>) -> Result<(Invocation, String)> {
    let input = env::var_os("AVEN_COMMAND_CONTEXT")
        .map(fs::read_to_string)
        .transpose()
        .context("read Aven terminal command context")?;
    let context = input.as_deref().map(parse_context).transpose()?;
    match (task, context.as_ref()) {
        (Some(task), Some(context)) => {
            let selected = selected_for(context)?;
            if task != selected.reference() && task != selected.task.id {
                bail!("explicit reset task does not match the focused Aven task");
            }
            Ok((context.invocation.clone(), selected.reference().to_owned()))
        }
        (Some(task), None) => Ok((
            Invocation {
                aven_exe: String::new(),
                db_path: None,
                workspace: None,
                origin_cwd: env::current_dir()?.display().to_string(),
            },
            task,
        )),
        (None, Some(context)) => {
            let selected = selected_for(context)?;
            Ok((context.invocation.clone(), selected.reference().to_owned()))
        }
        (None, None) => bail!("reset requires a task ref outside an Aven focused-task command"),
    }
}
pub(crate) fn confirm_reset(reference: &str, attempts: usize) -> Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        bail!("reset mutates state only with --yes when no interactive terminal is available");
    }
    print!(
        "Reset {reference}, invalidating {attempts} dispatch attempt(s) while preserving its Aven plan? [y/N] "
    );
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    if !matches!(answer.trim(), "y" | "Y" | "yes" | "YES") {
        bail!("reset canceled; no state was changed");
    }
    Ok(())
}

// Reset command orchestration.
pub(crate) fn reset(
    path: PathBuf,
    requested_task: Option<String>,
    yes: bool,
    dry_run: bool,
) -> Result<()> {
    let (invocation, reference) = reset_context(requested_task)?;
    let root = refresh_task_by_ref(&invocation, &reference)?;
    let task_id = field(&root, "/task/id")?.to_owned();
    let existing_generation = task_generation(&root)?;
    let recovering = reset_incomplete(&root);
    let generation = if recovering {
        existing_generation
    } else {
        existing_generation + 1
    };
    let mut store = LockedStore::open(path)?;
    let mut attempts: BTreeMap<String, Attempt> = store
        .store
        .attempts
        .values()
        .filter(|attempt| attempt.task_id == task_id)
        .map(|attempt| (attempt.attempt_id.clone(), attempt.clone()))
        .collect();
    for attempt in metadata_attempts(&root, &task_id)? {
        attempts.insert(attempt.attempt_id.clone(), attempt);
    }
    // This inventory is for audit only. It is deliberately derived from the
    // current Aven graph and is never used to alter epic membership.
    let children = reset_phase_children(&root)?;
    let mut recovered_sessions = Vec::new();
    let mut recovered_attempt_ids = Vec::new();
    if recovering {
        let operation = root
            .pointer("/metadata/dispatch.reset-operation")
            .and_then(Value::as_str)
            .context("incomplete reset is missing its operation record")?;
        let operation: Value =
            serde_json::from_str(operation).context("invalid incomplete reset operation record")?;
        if operation.get("generation").and_then(Value::as_u64) != Some(generation) {
            bail!("incomplete reset operation generation does not match task generation");
        }
        recovered_sessions = reset_operation_strings(&operation, "sessions")?;
        recovered_attempt_ids = reset_operation_strings(&operation, "attempt_ids")?;
        // Legacy operation records may contain `detached_children` from the
        // former destructive reset implementation. Ignore that stale inventory:
        // it must never attach, detach, or otherwise override the membership
        // currently recorded by Aven.
    }
    let active = opencode("GET", "/api/session/active", None)
        .context("cannot establish OpenCode session activity; reset refuses to guess")?;
    let sessions = merged_reset_inventory(
        attempts
            .values()
            .flat_map(attempt_session_ids)
            .map(str::to_owned)
            .collect(),
        recovered_sessions,
    );
    let operation_attempt_ids =
        merged_reset_inventory(attempts.keys().cloned().collect(), recovered_attempt_ids);
    let running = active_sessions(&sessions, &active);
    println!(
        "reset target={reference} generation={} attempts={} sessions={} phase_children={}",
        generation,
        operation_attempt_ids.len(),
        sessions.len(),
        children.len()
    );
    if !running.is_empty() {
        println!(
            "hard reset will interrupt associated active session(s): {}",
            running.join(", ")
        );
    }
    if dry_run {
        println!(
            "dry run: no Aven metadata, state store, sessions, worktrees, branches, or files were changed"
        );
        return Ok(());
    }
    if !yes {
        confirm_reset(&reference, attempts.len())?;
    }
    if !running.is_empty() {
        interrupt_and_drain_sessions(&running)?;
    }
    if !recovering {
        let operation = json!({"schema":"aven-dispatch-reset/v1", "generation": generation, "state":"incomplete", "attempt_ids": operation_attempt_ids, "sessions": sessions, "phase_children": children});
        let begin = vec![
            "edit".to_owned(),
            reference.clone(),
            "--metadata".into(),
            format!("dispatch.reset-generation={generation}"),
            "--metadata".into(),
            "dispatch.reset-state=incomplete".into(),
            "--metadata".into(),
            format!("dispatch.reset-operation={operation}"),
        ];
        run(
            if invocation.aven_exe.is_empty() {
                "aven"
            } else {
                &invocation.aven_exe
            },
            &{
                let mut args = aven_args(&invocation, &[]);
                args.extend(begin);
                args
            },
            None,
        )?;
    }
    store.remove_attempts_for_task(&task_id)?;
    let mut cleanup = vec!["edit".to_owned(), reference.clone()];
    let existing_metadata = root.get("metadata").and_then(Value::as_object);
    for key in [
        "dispatch.backend",
        "dispatch.core-id",
        "dispatch.terminal",
        "dispatch.session-id",
        "dispatch.attempt-id",
        "dispatch.state",
        "dispatch.workflow",
        "dispatch.branch",
        "dispatch.attempt",
        "dispatch.attempt.default",
        "dispatch.attempt.planning",
        "dispatch.attempt.implementation",
    ] {
        // Aven treats removal of an absent custom field as an error. A reset
        // commonly follows an aborted dispatch, so optional legacy/workflow
        // fields must be removed only when this task actually has them.
        if existing_metadata.is_some_and(|metadata| metadata.contains_key(key)) {
            cleanup.extend(["--remove-metadata".into(), key.into()]);
        }
    }
    // Workflow names are extensible, so fixed known names are not enough to
    // invalidate every task-scoped snapshot during a hard reset.
    if let Some(metadata) = existing_metadata {
        for key in metadata.keys().filter(|key| {
            key.starts_with("dispatch.attempt.")
                && !matches!(
                    key.as_str(),
                    "dispatch.attempt.default"
                        | "dispatch.attempt.planning"
                        | "dispatch.attempt.implementation"
                )
        }) {
            cleanup.extend(["--remove-metadata".into(), key.clone()]);
        }
    }
    cleanup.extend(["--metadata".into(), "dispatch.reset-state=incomplete".into(), "--metadata".into(), format!("dispatch.reset-operation={}", json!({"schema":"aven-dispatch-reset/v1", "generation":generation, "state":"auditing", "attempt_ids":operation_attempt_ids, "sessions":sessions, "phase_children":children}))]);
    run(
        if invocation.aven_exe.is_empty() {
            "aven"
        } else {
            &invocation.aven_exe
        },
        &{
            let mut args = aven_args(&invocation, &[]);
            args.extend(cleanup);
            args
        },
        None,
    )?;
    let note = format!(
        "## Dispatcher reset\n\nReset generation {} supersedes prior dispatch execution only. Removed {} attempt record(s) from the shared store and Aven snapshots. Preserved the approved Aven plan, including task status, metadata, epic membership, phase dependencies, specification, notes, history, sessions, branches, worktrees, and source files. Current phase inventory: {}. A new dispatch may use the retained approved plan.",
        generation,
        attempts.len(),
        if children.is_empty() {
            "none".into()
        } else {
            children.join(", ")
        }
    );
    aven(&invocation, &["note", &reference, "--stdin"], Some(&note))?;
    // The reset remains admission-fenced until the audit note is durable.
    aven(
        &invocation,
        &[
            "edit",
            &reference,
            "--metadata",
            "dispatch.reset-state=completed",
            "--metadata",
            &format!(
                "dispatch.reset-operation={}",
                json!({"schema":"aven-dispatch-reset/v1", "generation":generation, "state":"completed", "attempt_ids":operation_attempt_ids, "sessions":sessions, "phase_children":children})
            ),
        ],
        None,
    )?;
    println!(
        "reset complete for {reference}; dispatch attempts were invalidated while the Aven plan was preserved"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dispatch::aven::ensure_attempt_current;
    use crate::model::{Attempt, ExecutionMode, Invocation, TerminalRef};
    use serde_json::json;
    use std::collections::BTreeMap;

    #[test]
    fn authoritative_session_outcome_controls_running_state() {
        assert_eq!(
            authoritative_execution_state("running", &json!({"data":{"outcome":"succeeded"}})),
            "needs-review"
        );
        assert_eq!(
            authoritative_execution_state("running", &json!({"data":{"outcome":"failed"}})),
            "failed"
        );
        assert_eq!(
            authoritative_execution_state("running", &json!({"data":{}})),
            "running"
        );
        assert_eq!(
            authoritative_execution_state("interrupted", &json!({"data":{}})),
            "interrupted"
        );
    }
    #[test]
    fn reset_phase_inventory_uses_current_membership_without_plan_ownership_checks() {
        let root = json!({
            "epic_children": [
                {"ref": "APP-MANUAL"},
                {"ref": "APP-PHASE"}
            ]
        });
        assert_eq!(
            reset_phase_children(&root).unwrap(),
            vec!["APP-MANUAL", "APP-PHASE"]
        );
    }
    #[test]
    fn reset_recovery_reads_saved_operation_sessions_and_attempts() {
        let operation = json!({
            "attempt_ids": ["att-root", "att-phase"],
            "sessions": ["ses-root", "ses-worker"],
            // This legacy field is parsed for a safe recovery audit but never
            // used to change current Aven membership.
            "detached_children": ["APP-P1"]
        });
        assert_eq!(
            reset_operation_strings(&operation, "attempt_ids").unwrap(),
            vec!["att-root", "att-phase"]
        );
        assert_eq!(
            reset_operation_strings(&operation, "sessions").unwrap(),
            vec!["ses-root", "ses-worker"]
        );
        assert!(reset_operation_strings(&json!({"sessions":"bad"}), "sessions").is_err());
    }
    #[test]
    fn reset_recovery_preserves_saved_attempt_ids_without_current_snapshots() {
        let operation = json!({
            "attempt_ids": ["att-root", "att-worker"],
            "sessions": ["ses-root", "ses-worker"]
        });
        // Model recovery after both the central store and task metadata
        // snapshots have already been removed: only the operation record is
        // available for the auditing/completed checkpoint.
        let attempts = merged_reset_inventory(
            Vec::new(),
            reset_operation_strings(&operation, "attempt_ids").unwrap(),
        );
        let sessions = merged_reset_inventory(
            Vec::new(),
            reset_operation_strings(&operation, "sessions").unwrap(),
        );
        assert_eq!(attempts, vec!["att-root", "att-worker"]);
        assert_eq!(sessions, vec!["ses-root", "ses-worker"]);
    }
    #[test]
    fn reset_generation_defaults_to_zero_and_fences_stale_attempts() {
        let mut attempt = Attempt {
            task_id: "task-id".into(),
            task_ref: "APP-1".into(),
            workflow: "default".into(),
            attempt_id: "att_1".into(),
            branch: String::new(),
            worktree: String::new(),
            worktree_created_by_attempt: false,
            backend: "hc".into(),
            core_id: String::new(),
            core_name: String::new(),
            terminal: TerminalRef::default(),
            pane: String::new(),
            aven_panel: false,
            agent: String::new(),
            model: String::new(),
            execution_mode: ExecutionMode::SingleSession,
            coordinator_session_id: String::new(),
            coordinator_agent: String::new(),
            coordinator_model: String::new(),
            coordinator_terminal: TerminalRef::default(),
            auto_permissions: false,
            phases: Vec::new(),
            terminals: BTreeMap::new(),
            last_event_seq: 0,
            session_id: String::new(),
            prompt_id: String::new(),
            pending_prompt: String::new(),
            state: "running".into(),
            aven_update_pending: false,
            log_cursor: String::new(),
            log_task_ref: String::new(),
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
        assert_eq!(task_generation(&json!({"metadata": {}})).unwrap(), 0);
        assert!(
            ensure_attempt_current(
                &json!({"metadata": {"dispatch.reset-generation": "1"}}),
                &attempt
            )
            .is_err()
        );
        attempt.generation = 1;
        assert!(
            ensure_attempt_current(
                &json!({"metadata": {"dispatch.reset-generation": "1"}}),
                &attempt
            )
            .is_ok()
        );
        assert!(ensure_attempt_current(&json!({"metadata": {"dispatch.reset-state": "incomplete", "dispatch.reset-generation": "1"}}), &attempt).is_err());
    }
    #[test]
    fn reset_active_session_detection_matches_nested_active_payloads() {
        assert!(json_contains_string(
            &json!({"data": {"ses_1": {"status": "running"}}}),
            "ses_1"
        ));
        assert!(!json_contains_string(
            &json!({"data": {"ses_2": {}}}),
            "ses_1"
        ));
    }
}
