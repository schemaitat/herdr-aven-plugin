//! Pure lifecycle policy: dispatch eligibility and the independent
//! acceptance/execution/synchronization reduction.
//!
//! Aven status is acceptance. Dispatcher/task observations are execution.
//! Neither mutates the other, and missing evidence is `unknown`, never a
//! fabricated `running`, `stopped` or `delivered` fact.

use crate::model::{Attempt, Invocation};
use anyhow::{Result, bail};
use serde_json::Value;

/// Aven's open (non-terminal) statuses. `done` and `canceled` are inert for
/// dispatch admission.
pub(crate) const OPEN_STATUSES: [&str; 4] = ["inbox", "backlog", "todo", "active"];
pub(crate) const TERMINAL_STATUSES: [&str; 2] = ["done", "canceled"];

pub(crate) fn task_status(task: &Value) -> Option<&str> {
    task.pointer("/task/status").and_then(Value::as_str)
}
pub(crate) fn status_is_open(status: &str) -> bool {
    OPEN_STATUSES.contains(&status)
}
pub(crate) fn status_is_terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}
pub(crate) fn status_is_known(status: &str) -> bool {
    status_is_open(status) || status_is_terminal(status)
}

/// Reject any target that cannot safely receive a new dispatch effect.
///
/// The immutable id, non-deleted state, known open status and (when supplied)
/// workspace/project scope must all still match the authoritative Aven read.
/// Callers re-run this immediately before each effect: Aven is not
/// transactionally locked with the dispatcher, so a concurrent external edit
/// can stop remaining targets but cannot retroactively roll back admitted work.
pub(crate) fn validate_dispatch_target(
    task: &Value,
    expected_id: &str,
    invocation: &Invocation,
) -> Result<()> {
    let task_id = task
        .pointer("/task/id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    if task_id != expected_id {
        bail!(
            "Aven re-read returned task {task_id:?}, expected immutable target {expected_id:?}; refusing dispatch"
        );
    }
    if task
        .pointer("/task/deleted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        bail!("task {expected_id} is deleted and cannot be dispatched");
    }
    let status = task_status(task).unwrap_or_default();
    if status.is_empty() {
        bail!("task {expected_id} has no authoritative Aven status; refusing dispatch");
    }
    if !status_is_known(status) {
        bail!("task {expected_id} has unknown Aven status {status:?}; refusing dispatch");
    }
    if status_is_terminal(status) {
        bail!(
            "task {expected_id} is {status}; terminal tasks are inert for dispatch. Reopen it with an explicitly reviewed Aven status transition and reset generation before dispatching again"
        );
    }
    let project = task
        .pointer("/project/key")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if project.is_empty() {
        bail!("task {expected_id} has no project scope; refusing dispatch");
    }
    let workspace = task
        .pointer("/workspace/key")
        .and_then(Value::as_str)
        .unwrap_or("default");
    if let Some(expected_workspace) = invocation.workspace.as_deref()
        && !expected_workspace.is_empty()
        && expected_workspace != workspace
    {
        bail!(
            "task {expected_id} belongs to workspace {workspace:?}, not the selected workspace {expected_workspace:?}; refusing dispatch"
        );
    }
    Ok(())
}

/// Reject a resume/reopen that would re-admit a pending prompt for a task that
/// is no longer open. Reopening is a separate reviewed Aven transition.
pub(crate) fn ensure_pending_admission_open(task: &Value, attempt: &Attempt) -> Result<()> {
    if matches!(
        attempt.state.as_str(),
        "workspace-pending"
            | "session-pending"
            | "terminal-pending"
            | "prompt-pending"
            | "babysitter-session-pending"
            | "babysitter-prompt-pending"
    ) && !status_is_open(task_status(task).unwrap_or_default())
    {
        bail!(
            "attempt {} still owns a pending prompt but task {} is {:?}; refusing to re-admit it. Reopen the task explicitly or reset the attempt",
            attempt.attempt_id,
            attempt.task_ref,
            task_status(task).unwrap_or("unknown")
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionOutcome {
    Succeeded,
    Failed,
    Interrupted,
    Missing,
}

impl SessionOutcome {
    pub(crate) fn from_outcome(value: Option<&str>) -> Self {
        match value {
            Some("succeeded") => Self::Succeeded,
            Some("failed") => Self::Failed,
            Some("interrupted") | Some("canceled") => Self::Interrupted,
            _ => Self::Missing,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecutionObservation {
    Live,
    StoppedSuccess,
    StoppedFailure,
    StoppedInterrupted,
    Unknown,
}

impl ExecutionObservation {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::StoppedSuccess => "stopped-success",
            Self::StoppedFailure => "stopped-failure",
            Self::StoppedInterrupted => "stopped-interrupted",
            Self::Unknown => "unknown",
        }
    }
}

/// Aggregate every owned execution role. A single live/unknown role makes the
/// whole observation live/unknown; it is never averaged into false completion.
pub(crate) fn aggregate_execution(
    any_live_terminal: bool,
    any_unknown_terminal: bool,
    outcomes: &[SessionOutcome],
) -> ExecutionObservation {
    if any_live_terminal {
        return ExecutionObservation::Live;
    }
    if any_unknown_terminal || outcomes.is_empty() || outcomes.contains(&SessionOutcome::Missing) {
        return ExecutionObservation::Unknown;
    }
    if outcomes.contains(&SessionOutcome::Interrupted) {
        return ExecutionObservation::StoppedInterrupted;
    }
    if outcomes.contains(&SessionOutcome::Failed) {
        return ExecutionObservation::StoppedFailure;
    }
    ExecutionObservation::StoppedSuccess
}

/// Terminal Aven tasks whose owned execution is still live or unobservable are
/// a visible contradiction, never false completion.
pub(crate) fn contradiction_for(
    status: Option<&str>,
    observation: ExecutionObservation,
) -> Option<&'static str> {
    if !status.is_some_and(status_is_terminal) {
        return None;
    }
    match observation {
        ExecutionObservation::Live => Some("terminal_live_execution"),
        ExecutionObservation::Unknown => Some("terminal_unknown_execution"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Reduction {
    pub(crate) state: String,
    pub(crate) observation: String,
    pub(crate) contradiction: String,
}

const PENDING_ADMISSION_STATES: [&str; 6] = [
    "workspace-pending",
    "session-pending",
    "terminal-pending",
    "prompt-pending",
    "babysitter-session-pending",
    "babysitter-prompt-pending",
];

/// Deterministically reduce acceptance and execution without changing Aven.
pub(crate) fn reduce_state(
    current_state: &str,
    status: Option<&str>,
    observation: ExecutionObservation,
) -> Reduction {
    let terminal_task = status.is_some_and(status_is_terminal);
    let mut contradiction = contradiction_for(status, observation).unwrap_or_default();
    // A durable completed attempt is stable when a repeated observation is
    // temporarily unobservable; only a previously unfinished attempt is a
    // terminal unknown-execution contradiction.
    if terminal_task && current_state == "completed" && observation == ExecutionObservation::Unknown
    {
        contradiction = "";
    }
    // Pending admission checkpoints are local intent that an older API
    // snapshot has not observed yet. Preserve them so recovery can admit the
    // exact saved prompt instead of downgrading and duplicating it.
    if PENDING_ADMISSION_STATES.contains(&current_state) && !status.is_some_and(status_is_terminal)
    {
        return Reduction {
            state: current_state.into(),
            observation: observation.as_str().into(),
            contradiction: contradiction.into(),
        };
    }
    let state = if terminal_task {
        match observation {
            ExecutionObservation::StoppedSuccess => "completed",
            ExecutionObservation::Unknown if current_state == "completed" => "completed",
            ExecutionObservation::StoppedFailure
            | ExecutionObservation::StoppedInterrupted
            | ExecutionObservation::Live
            | ExecutionObservation::Unknown => "needs-review",
        }
    } else {
        match observation {
            ExecutionObservation::Live => "running",
            ExecutionObservation::StoppedSuccess => "needs-review",
            ExecutionObservation::StoppedFailure => "failed",
            ExecutionObservation::StoppedInterrupted => "interrupted",
            // Missing evidence is unknown; retain a durable completion or a
            // running checkpoint instead of inventing a stopped fact.
            ExecutionObservation::Unknown => match current_state {
                "completed" | "needs-review" | "failed" | "interrupted" => current_state,
                _ => "running",
            },
        }
    };
    // Completed stays stable on unchanged repeated observations.
    let stable_completed = current_state == "completed" && state == "completed";
    Reduction {
        state: if stable_completed {
            "completed".into()
        } else {
            state.into()
        },
        observation: observation.as_str().into(),
        contradiction: contradiction.into(),
    }
}

/// Apply a reduction to a durable attempt, bumping the revision only when a
/// durable fact changed. Returns whether the record changed.
pub(crate) fn apply_reduction(
    attempt: &mut Attempt,
    status: Option<&str>,
    observation: ExecutionObservation,
) -> bool {
    let reduced = reduce_state(&attempt.state, status, observation);
    let next = crate::model::LifecycleState {
        observation: reduced.observation,
        contradiction: reduced.contradiction,
        revision: attempt.lifecycle.revision,
        reduced_at: crate::process::now(),
    };
    let changed = attempt.state != reduced.state
        || attempt.lifecycle.observation != next.observation
        || attempt.lifecycle.contradiction != next.contradiction;
    if changed {
        attempt.state = reduced.state;
        attempt.lifecycle = crate::model::LifecycleState {
            revision: attempt.lifecycle.revision.saturating_add(1),
            ..next
        };
    } else {
        attempt.lifecycle.reduced_at = next.reduced_at;
    }
    changed
}

/// Terminal owned execution is proven stopped only when every recorded role
/// has a stopped/terminal observation.
fn terminal_observation_is_live(observation: &crate::model::TerminalObservation) -> bool {
    observation.state == "live"
        && !(observation.program == "opencode" && observation.status == "idle")
}

pub(crate) fn terminal_observation_flags(attempt: &Attempt) -> (bool, bool) {
    let mut live = false;
    let mut unknown = false;
    for observation in attempt.terminals.values() {
        if observation.address.is_empty() {
            continue;
        }
        match observation.state.as_str() {
            "live" if terminal_observation_is_live(observation) => live = true,
            "live" => {}
            "finished" | "removed" => {}
            _ => unknown = true,
        }
    }
    (live, unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn invocation() -> Invocation {
        Invocation {
            aven_exe: String::new(),
            db_path: None,
            workspace: None,
            origin_cwd: String::new(),
        }
    }

    #[test]
    fn terminal_and_deleted_targets_are_rejected() {
        for status in ["done", "canceled"] {
            let error = validate_dispatch_target(
                &json!({"task":{"id":"one","status":status,"deleted":false},"project":{"key":"app"}}),
                "one",
                &invocation(),
            )
            .unwrap_err();
            assert!(error.to_string().contains("terminal"));
        }
        let error = validate_dispatch_target(
            &json!({"task":{"id":"one","status":"todo","deleted":true},"project":{"key":"app"}}),
            "one",
            &invocation(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("deleted"));
    }

    #[test]
    fn unknown_status_and_scope_mismatch_are_rejected() {
        assert!(
            validate_dispatch_target(
                &json!({"task":{"id":"one","status":"weird","deleted":false},"project":{"key":"app"}}),
                "one",
                &invocation(),
            )
            .is_err()
        );
        let mut scoped = invocation();
        scoped.workspace = Some("other".into());
        assert!(
            validate_dispatch_target(
                &json!({"task":{"id":"one","status":"todo","deleted":false},"workspace":{"key":"default"},"project":{"key":"app"}}),
                "one",
                &scoped,
            )
            .is_err()
        );
    }

    #[test]
    fn terminal_acceptance_with_live_execution_is_a_contradiction() {
        let reduction = reduce_state("running", Some("done"), ExecutionObservation::Live);
        assert_eq!(reduction.state, "needs-review");
        assert_eq!(reduction.contradiction, "terminal_live_execution");
        let reduction = reduce_state("running", Some("done"), ExecutionObservation::Unknown);
        assert_eq!(reduction.state, "needs-review");
        assert_eq!(reduction.contradiction, "terminal_unknown_execution");
    }

    #[test]
    fn idle_opencode_terminal_is_not_live_execution_but_working_is() {
        let mut observation = crate::model::TerminalObservation {
            address: "t1".into(),
            state: "live".into(),
            program: "opencode".into(),
            status: "idle".into(),
            ..Default::default()
        };
        assert!(!terminal_observation_is_live(&observation));
        observation.status = "working".into();
        assert!(terminal_observation_is_live(&observation));
        observation.status.clear();
        assert!(terminal_observation_is_live(&observation));
    }

    #[test]
    fn stopped_success_converges_completed_and_missing_evidence_is_unknown() {
        assert_eq!(
            reduce_state(
                "running",
                Some("done"),
                ExecutionObservation::StoppedSuccess
            )
            .state,
            "completed"
        );
        assert_eq!(
            reduce_state("completed", Some("done"), ExecutionObservation::Unknown).state,
            "completed"
        );
        assert_eq!(
            reduce_state("running", Some("todo"), ExecutionObservation::Unknown).state,
            "running"
        );
        assert_eq!(
            reduce_state(
                "prompt-pending",
                Some("active"),
                ExecutionObservation::Unknown
            )
            .state,
            "prompt-pending"
        );
        assert_eq!(
            reduce_state(
                "terminal-pending",
                Some("done"),
                ExecutionObservation::StoppedSuccess
            )
            .state,
            "completed"
        );
    }

    #[test]
    fn one_missing_or_live_role_prevents_false_success() {
        assert_eq!(
            aggregate_execution(
                false,
                false,
                &[SessionOutcome::Succeeded, SessionOutcome::Missing]
            ),
            ExecutionObservation::Unknown
        );
        assert_eq!(
            aggregate_execution(true, false, &[SessionOutcome::Succeeded]),
            ExecutionObservation::Live
        );
        assert_eq!(
            aggregate_execution(false, true, &[SessionOutcome::Succeeded]),
            ExecutionObservation::Unknown
        );
        assert_eq!(
            aggregate_execution(
                false,
                false,
                &[SessionOutcome::Succeeded, SessionOutcome::Succeeded]
            ),
            ExecutionObservation::StoppedSuccess
        );
    }

    #[test]
    fn pending_admission_never_readmits_for_a_terminal_task() {
        let mut attempt: Attempt = serde_json::from_value(json!({
            "task_id":"one","task_ref":"APP-1","workflow":"implementation","attempt_id":"att",
            "branch":"b","worktree":"/tmp","prompt_id":"msg","state":"prompt-pending",
            "aven":{},"created_at":0
        }))
        .unwrap();
        assert!(
            ensure_pending_admission_open(&json!({"task":{"status":"todo"}}), &attempt).is_ok()
        );
        attempt.state = "prompt-pending".into();
        assert!(
            ensure_pending_admission_open(&json!({"task":{"status":"done"}}), &attempt).is_err()
        );
        // Reconciliation first reduces confirmed completion, then applies the
        // guard; it can publish the completed state without re-admitting the
        // saved prompt.
        attempt.state = reduce_state(
            "terminal-pending",
            Some("done"),
            ExecutionObservation::StoppedSuccess,
        )
        .state;
        assert_eq!(attempt.state, "completed");
        assert!(
            ensure_pending_admission_open(&json!({"task":{"status":"done"}}), &attempt).is_ok()
        );
    }
}
