//! Read-only dispatcher-store evidence and Aven recovery merge.

use super::{aven::AvenContext, scope::source_error};
use crate::{inspect::model::*, process::now, store::read_only::read_only_store_payloads};
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Debug, Default, Deserialize)]
struct RawTerminal {
    #[serde(default)]
    core_id: String,
    #[serde(default)]
    address: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    created_by_attempt: bool,
}

impl RawTerminal {
    fn is_empty(&self) -> bool {
        self.address.is_empty()
    }
    fn link(&self, secrets: &[String]) -> TerminalLink {
        TerminalLink {
            core_id: sanitize(&self.core_id, 128, secrets),
            address: sanitize(&self.address, 128, secrets),
            name: sanitize(&self.name, 256, secrets),
            role: sanitize(&self.role, 128, secrets),
            created_by_attempt: self.created_by_attempt,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct RawObservation {
    #[serde(default)]
    core_id: String,
    #[serde(default)]
    address: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    status_kind: String,
    #[serde(default)]
    program: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    turn: u64,
    #[serde(default)]
    seq: u64,
    #[serde(default)]
    updated_at: u64,
    #[serde(default)]
    recovery: String,
}

#[derive(Debug, Default, Deserialize)]
struct RawAttempt {
    #[serde(default)]
    task_id: String,
    #[serde(rename = "ref", default)]
    task_ref: String,
    #[serde(default)]
    workflow: String,
    #[serde(default)]
    attempt_id: String,
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    execution_mode: String,
    #[serde(default)]
    backend: String,
    #[serde(default)]
    core_id: String,
    #[serde(default)]
    terminal: RawTerminal,
    #[serde(default)]
    coordinator_terminal: RawTerminal,
    #[serde(default)]
    babysitter_terminal: RawTerminal,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    worktree: String,
    #[serde(default)]
    worktree_created_by_attempt: bool,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    coordinator_session_id: String,
    #[serde(default)]
    coordinator_agent: String,
    #[serde(default)]
    coordinator_model: String,
    #[serde(default)]
    babysitter: bool,
    #[serde(default)]
    babysitter_session_id: String,
    #[serde(default)]
    babysitter_pane: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    pane: String,
    #[serde(default)]
    log_task_ref: String,
    #[serde(default)]
    terminals: BTreeMap<String, RawObservation>,
    #[serde(default)]
    state: String,
    #[serde(default)]
    created_at: u64,
    #[serde(default)]
    phases: Vec<RawPhase>,
}

#[derive(Debug, Default, Deserialize)]
struct RawPhase {
    #[serde(default)]
    task_id: String,
    #[serde(rename = "ref", default)]
    task_ref: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    worktree: String,
    #[serde(default)]
    terminal: RawTerminal,
    #[serde(default)]
    pane: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    commit: String,
    #[serde(default)]
    integrated_commit: String,
}

pub(super) fn read_attempts(
    store: &Path,
    contexts: &BTreeMap<String, (AvenContext, u64)>,
    secrets: &[String],
) -> (Vec<AttemptRecord>, SourceHealth) {
    let mut accepted: BTreeMap<(String, String, u64), AttemptRecord> = BTreeMap::new();
    let mut rejected = 0_usize;
    // Aven recovery snapshots are imported first so the central store wins
    // equal-generation/created_at ties, matching the dashboard contract.
    for (task_id, (context, observed_at)) in contexts {
        for (key, value) in &context.metadata {
            if key != "dispatch.attempt" && !key.starts_with("dispatch.attempt.") {
                continue;
            }
            let Some(snapshot) = value.as_str() else {
                rejected += 1;
                continue;
            };
            let workflow =
                (key != "dispatch.attempt").then(|| key.trim_start_matches("dispatch.attempt."));
            accept_attempt(
                snapshot,
                Origin::AvenRecovery,
                *observed_at,
                contexts,
                Some(task_id),
                workflow,
                &mut accepted,
                &mut rejected,
                secrets,
            );
        }
    }
    let (health, central_count, store_available) = match read_only_store_payloads(
        store,
        ATTEMPT_LIMIT,
    ) {
        Ok(payloads) => {
            for payload in &payloads {
                accept_attempt(
                    payload,
                    Origin::CentralStore,
                    now(),
                    contexts,
                    None,
                    None,
                    &mut accepted,
                    &mut rejected,
                    secrets,
                );
            }
            (
                SourceHealth::ok(
                    "dispatcher",
                    format!(
                        "Read-only central SQLite store ({} rows); scoped Aven recovery merged; no lock or reconciliation.",
                        payloads.len()
                    ),
                ),
                payloads.len(),
                true,
            )
        }
        Err(error) => (
            SourceHealth::unavailable(
                "dispatcher",
                format!(
                    "Central dispatcher store absent, unsupported or unreadable; scoped Aven recovery snapshots only: {}",
                    source_error(&error, secrets)
                ),
            ),
            0,
            false,
        ),
    };
    let mut attempts = accepted.into_values().collect::<Vec<_>>();
    attempts.sort_by(|left, right| {
        left.task_ref
            .cmp(&right.task_ref)
            .then_with(|| left.workflow.cmp(&right.workflow))
    });
    let mut message = health.message;
    if rejected > 0 {
        message.push_str(&format!(
            "; {rejected} malformed, mismatched, reset-in-progress or obsolete snapshot(s) rejected"
        ));
    }
    let status = if !store_available {
        HealthStatus::Unavailable
    } else if rejected > 0 || (central_count == 0 && !attempts.is_empty()) {
        HealthStatus::Incomplete
    } else {
        health.status
    };
    let health = SourceHealth {
        source: "dispatcher".into(),
        status,
        observed_at_ms: health.observed_at_ms,
        message,
    };
    (attempts, health)
}

#[allow(clippy::too_many_arguments)]
fn accept_attempt(
    payload: &str,
    origin: Origin,
    observed_at: u64,
    contexts: &BTreeMap<String, (AvenContext, u64)>,
    owner: Option<&str>,
    workflow: Option<&str>,
    accepted: &mut BTreeMap<(String, String, u64), AttemptRecord>,
    rejected: &mut usize,
    secrets: &[String],
) {
    let raw: RawAttempt = match serde_json::from_str(payload) {
        Ok(raw) => raw,
        Err(_) => {
            *rejected += 1;
            return;
        }
    };
    if !valid_identifier(&raw.task_id) || raw.attempt_id.is_empty() {
        *rejected += 1;
        return;
    }
    if owner.is_some_and(|owner| owner != raw.task_id) {
        *rejected += 1;
        return;
    }
    if workflow.is_some_and(|workflow| workflow != raw.workflow) {
        *rejected += 1;
        return;
    }
    // Unscoped tasks are never imported, but they are not malformed evidence.
    let Some((context, _)) = contexts.get(&raw.task_id) else {
        return;
    };
    let metadata = context.metadata_strings();
    let Ok(current_generation) = generation(&metadata) else {
        *rejected += 1;
        return;
    };
    if current_generation != raw.generation {
        *rejected += 1;
        return;
    }
    if metadata
        .get("dispatch.reset-state")
        .is_some_and(|state| state != "completed")
    {
        *rejected += 1;
        return;
    }
    let context_reference = context
        .task
        .as_ref()
        .map(|task| task.display_ref.as_str())
        .unwrap_or_default();
    let task_ref = if raw.task_ref.is_empty() {
        context_reference
    } else {
        &raw.task_ref
    };
    if !valid_reference(task_ref)
        || (!context_reference.is_empty() && task_ref != context_reference)
    {
        *rejected += 1;
        return;
    }
    let workflow = if raw.workflow.is_empty() {
        "default".to_owned()
    } else {
        sanitize(&raw.workflow, 128, secrets)
    };
    let attempt = AttemptRecord {
        task_id: raw.task_id.clone(),
        task_ref: sanitize(task_ref, 256, secrets),
        workflow: workflow.clone(),
        attempt_id: sanitize(&raw.attempt_id, 128, secrets),
        generation: raw.generation,
        origin,
        observed_at_ms: observed_at,
        created_at_ms: raw.created_at,
        state: sanitize(&raw.state, 128, secrets),
        execution_mode: sanitize(
            if raw.execution_mode.is_empty() {
                "single-session"
            } else {
                &raw.execution_mode
            },
            64,
            secrets,
        ),
        backend: sanitize(
            if raw.backend.is_empty() {
                if raw.terminal.is_empty() && raw.pane.is_empty() {
                    "hc"
                } else if raw.terminal.is_empty() {
                    "herdr"
                } else {
                    "hc"
                }
            } else {
                &raw.backend
            },
            32,
            secrets,
        ),
        core_id: sanitize(
            if raw.core_id.is_empty() {
                &raw.terminal.core_id
            } else {
                &raw.core_id
            },
            128,
            secrets,
        ),
        terminal: raw.terminal.link(secrets),
        coordinator_terminal: raw.coordinator_terminal.link(secrets),
        babysitter_terminal: raw.babysitter_terminal.link(secrets),
        branch: sanitize(&raw.branch, 512, secrets),
        worktree: sanitize(&raw.worktree, 4096, secrets),
        worktree_created_by_attempt: raw.worktree_created_by_attempt,
        agent: sanitize(&raw.agent, 128, secrets),
        model: sanitize(&raw.model, 256, secrets),
        coordinator_agent: sanitize(&raw.coordinator_agent, 128, secrets),
        coordinator_model: sanitize(&raw.coordinator_model, 256, secrets),
        coordinator_session_id: sanitize(&raw.coordinator_session_id, 132, secrets),
        babysitter: raw.babysitter,
        babysitter_session_id: sanitize(&raw.babysitter_session_id, 132, secrets),
        babysitter_pane: sanitize(&raw.babysitter_pane, 128, secrets),
        session_id: sanitize(&raw.session_id, 132, secrets),
        pane: sanitize(&raw.pane, 128, secrets),
        log_task_ref: sanitize(&raw.log_task_ref, 256, secrets),
        terminals: raw
            .terminals
            .into_iter()
            .map(|(key, observation)| {
                (
                    sanitize(&key, 256, secrets),
                    TerminalObservationRecord {
                        core_id: sanitize(&observation.core_id, 128, secrets),
                        address: sanitize(&observation.address, 128, secrets),
                        state: sanitize(&observation.state, 64, secrets),
                        status: sanitize(&observation.status, 256, secrets),
                        status_kind: sanitize(&observation.status_kind, 64, secrets),
                        program: sanitize(&observation.program, 128, secrets),
                        reason: sanitize(&observation.reason, 256, secrets),
                        turn: observation.turn,
                        seq: observation.seq,
                        updated_at: observation.updated_at,
                        recovery: sanitize(&observation.recovery, 256, secrets),
                    },
                )
            })
            .collect(),
        phases: raw
            .phases
            .iter()
            .map(|phase| PhaseRecord {
                task_id: sanitize(&phase.task_id, 128, secrets),
                reference: sanitize(&phase.task_ref, 256, secrets),
                title: sanitize(&phase.title, 512, secrets),
                branch: sanitize(&phase.branch, 512, secrets),
                worktree: sanitize(&phase.worktree, 4096, secrets),
                terminal: phase.terminal.link(secrets),
                pane: sanitize(&phase.pane, 128, secrets),
                session_id: sanitize(&phase.session_id, 132, secrets),
                state: sanitize(&phase.state, 128, secrets),
                commit: sanitize(&phase.commit, 128, secrets),
                integrated_commit: sanitize(&phase.integrated_commit, 128, secrets),
            })
            .collect(),
    };
    let key = (attempt.task_id.clone(), workflow, attempt.generation);
    match accepted.get(&key) {
        Some(existing) if existing.created_at_ms > attempt.created_at_ms => {}
        Some(existing)
            if existing.created_at_ms == attempt.created_at_ms
                && existing.origin == Origin::CentralStore => {}
        _ => {
            accepted.insert(key, attempt);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inspect::sources::aven::{AvenContext, test_context};
    use serde_json::Value;
    use std::collections::BTreeMap;
    fn context(metadata: &[(&str, &str)]) -> AvenContext {
        let metadata = metadata
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Value::String((*value).to_owned())))
            .collect();
        test_context(metadata)
    }
    fn payload(attempt_id: &str, generation: u64, created_at: u64, state: &str) -> String {
        serde_json::json!({
            "task_id": "task-one",
            "task_ref": "APP-1",
            "workflow": "implementation",
            "attempt_id": attempt_id,
            "generation": generation,
            "session_id": "ses_one",
            "pane": "w1:p1",
            "state": state,
            "created_at": created_at,
            "prompt_id": "msg_secret",
            "pending_prompt": "do not leak this prompt"
        })
        .to_string()
    }
    fn contexts(metadata: &[(&str, &str)]) -> BTreeMap<String, (AvenContext, u64)> {
        BTreeMap::from([("task-one".to_owned(), (context(metadata), 10))])
    }
    #[test]
    fn recovery_only_attempts_are_accepted_with_generation_zero() {
        let contexts = contexts(&[(
            "dispatch.attempt.implementation",
            &payload("a1", 0, 5, "running"),
        )]);
        let store = tempfile::tempdir().unwrap().path().join("missing.sqlite");
        let (attempts, health) = read_attempts(&store, &contexts, &[]);
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].origin, Origin::AvenRecovery);
        assert_eq!(attempts[0].generation, 0);
        assert_eq!(health.status, HealthStatus::Unavailable);
        assert!(
            !store.exists(),
            "inspection must not create a missing store"
        );
    }
    #[test]
    fn newer_central_record_wins_and_equal_ties_favor_central_store() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("dispatch.sqlite");
        let connection = rusqlite::Connection::open(&store).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE attempts (task_id TEXT, workflow TEXT, attempt_id TEXT, task_ref TEXT,
                 state TEXT, generation INTEGER, session_id TEXT, created_at INTEGER,
                 updated_at INTEGER, payload TEXT, PRIMARY KEY (task_id, workflow));
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        for (workflow, attempt_id, created, state) in [
            ("implementation", "central", 20, "needs-review"),
            ("planning", "tie", 10, "running"),
        ] {
            connection
                .execute(
                    "INSERT INTO attempts (task_id, workflow, attempt_id, task_ref, state, generation, session_id, created_at, updated_at, payload)
                     VALUES (?1, ?2, ?3, ?4, ?5, 1, 'ses_central', ?6, ?6, ?7)",
                    rusqlite::params![
                        "task-one",
                        workflow,
                        attempt_id,
                        "APP-1",
                        state,
                        created as i64,
                        payload(attempt_id, 1, created, state)
                            .replace("\"workflow\":\"implementation\"", &format!("\"workflow\":\"{workflow}\""))
                    ],
                )
                .unwrap();
        }
        drop(connection);
        let contexts = contexts(&[
            ("dispatch.reset-generation", "1"),
            (
                "dispatch.attempt.implementation",
                &payload("recovery-newer", 1, 30, "running"),
            ),
            (
                "dispatch.attempt.planning",
                &payload("tie", 1, 10, "running"),
            ),
        ]);
        let (attempts, _) = read_attempts(&store, &contexts, &[]);
        let implementation = attempts
            .iter()
            .find(|attempt| attempt.workflow == "implementation")
            .unwrap();
        assert_eq!(implementation.attempt_id, "recovery-newer");
        let planning = attempts
            .iter()
            .find(|attempt| attempt.workflow == "planning")
            .unwrap();
        assert_eq!(planning.origin, Origin::CentralStore);
    }
    #[test]
    fn reset_in_progress_and_obsolete_generations_are_rejected() {
        let contexts = contexts(&[
            ("dispatch.reset-generation", "2"),
            ("dispatch.reset-state", "in_progress"),
            (
                "dispatch.attempt.implementation",
                &payload("stale", 1, 5, "running"),
            ),
        ]);
        let store = tempfile::tempdir().unwrap().path().join("missing.sqlite");
        let (attempts, health) = read_attempts(&store, &contexts, &[]);
        assert!(attempts.is_empty());
        assert_eq!(health.status, HealthStatus::Unavailable);
        assert!(health.message.contains("rejected"));
    }
    #[test]
    fn schema_is_serialized_without_prompts_or_invocation_details() {
        let attempts = vec![AttemptRecord {
            task_id: "task-one".into(),
            task_ref: "APP-1".into(),
            workflow: "implementation".into(),
            attempt_id: "a1".into(),
            generation: 0,
            origin: Origin::CentralStore,
            observed_at_ms: 1,
            created_at_ms: 1,
            state: "running".into(),
            execution_mode: "single-session".into(),
            backend: "hc".into(),
            core_id: "core".into(),
            terminal: TerminalLink::default(),
            coordinator_terminal: TerminalLink::default(),
            babysitter_terminal: TerminalLink::default(),
            branch: String::new(),
            worktree: String::new(),
            worktree_created_by_attempt: false,
            agent: String::new(),
            model: String::new(),
            coordinator_agent: String::new(),
            coordinator_model: String::new(),
            coordinator_session_id: String::new(),
            babysitter: false,
            babysitter_session_id: String::new(),
            babysitter_pane: String::new(),
            session_id: "ses_one".into(),
            pane: "w1:p1".into(),
            log_task_ref: String::new(),
            terminals: BTreeMap::new(),
            phases: Vec::new(),
        }];
        let serialized = serde_json::to_string(&attempts).unwrap();
        assert!(!serialized.contains("prompt"));
        assert!(!serialized.contains("aven"));
    }
}
