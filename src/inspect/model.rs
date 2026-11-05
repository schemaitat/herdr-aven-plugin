//! Immutable, sanitized inspector snapshot.
//!
//! This is the presentation-neutral read boundary consumed by `inspect
//! --json` and (in later phases) the terminal inspector. It deliberately keeps
//! source evidence, ownership and health separate instead of collapsing them
//! into one "state" field.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(crate) const SCHEMA: &str = "aven-dispatch-inspect/v1";
pub(crate) const AVEN_LIST_LIMIT: usize = 500;
pub(crate) const CONTEXT_ADMISSION_LIMIT: usize = 80;
pub(crate) const ATTEMPT_LIMIT: usize = 2_000;
pub(crate) const LINKED_SESSION_LIMIT: usize = 64;
pub(crate) const WORKSPACE_LIMIT: usize = 2_000;
pub(crate) const PANE_LIMIT: usize = 4_000;
pub(crate) const SOURCE_TIMEOUT_MS: u64 = 4_000;
pub(crate) const SOURCE_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
pub(crate) const SOURCE_WORKERS: usize = 4;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Snapshot {
    pub(crate) schema: String,
    pub(crate) observed_at_ms: u64,
    pub(crate) scope: Scope,
    pub(crate) limits: Limits,
    pub(crate) sources: Vec<SourceHealth>,
    pub(crate) tasks: Vec<TaskRecord>,
    pub(crate) attempts: Vec<AttemptRecord>,
    pub(crate) sessions: Vec<SessionRecord>,
    pub(crate) panes: Vec<PaneRecord>,
    pub(crate) workspaces: Vec<WorkspaceRecord>,
    pub(crate) worktrees: Vec<WorktreeRecord>,
    pub(crate) candidates: Vec<PaneCandidate>,
    pub(crate) relationships: Vec<Relationship>,
    pub(crate) conflicts: Vec<EvidenceConflict>,
    pub(crate) warnings: Vec<String>,
}

/// Contradictory evidence is retained as a separate declaration instead of
/// overwriting Aven acceptance, persisted execution or API observations.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct EvidenceConflict {
    pub(crate) kind: String,
    pub(crate) task_id: String,
    #[serde(rename = "ref")]
    pub(crate) task_ref: String,
    pub(crate) message: String,
    pub(crate) sources: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Scope {
    pub(crate) project: String,
    pub(crate) workspace: String,
    pub(crate) repository: String,
    pub(crate) cwd: String,
    pub(crate) project_source: String,
    pub(crate) workspace_source: String,
    pub(crate) core_session: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Limits {
    pub(crate) aven_list: usize,
    pub(crate) context_admissions: usize,
    pub(crate) attempts: usize,
    pub(crate) linked_sessions: usize,
    pub(crate) workspaces: usize,
    pub(crate) panes: usize,
    pub(crate) source_timeout_ms: u64,
    pub(crate) source_output_bytes: usize,
    pub(crate) source_workers: usize,
    pub(crate) activity_ttl_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            aven_list: AVEN_LIST_LIMIT,
            context_admissions: CONTEXT_ADMISSION_LIMIT,
            attempts: ATTEMPT_LIMIT,
            linked_sessions: LINKED_SESSION_LIMIT,
            workspaces: WORKSPACE_LIMIT,
            panes: PANE_LIMIT,
            source_timeout_ms: SOURCE_TIMEOUT_MS,
            source_output_bytes: SOURCE_OUTPUT_LIMIT,
            source_workers: SOURCE_WORKERS,
            activity_ttl_ms: 4_500,
        }
    }
}

#[allow(dead_code)] // Stale is populated by the long-lived phase-2 collector.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HealthStatus {
    Ok,
    Incomplete,
    Unavailable,
    Stale,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SourceHealth {
    pub(crate) source: String,
    pub(crate) status: HealthStatus,
    pub(crate) observed_at_ms: u64,
    pub(crate) message: String,
}

impl SourceHealth {
    pub(crate) fn new(source: &str, status: HealthStatus, message: impl Into<String>) -> Self {
        Self {
            source: source.into(),
            status,
            observed_at_ms: crate::process::now(),
            message: message.into(),
        }
    }
    pub(crate) fn ok(source: &str, message: impl Into<String>) -> Self {
        Self::new(source, HealthStatus::Ok, message)
    }
    pub(crate) fn incomplete(source: &str, message: impl Into<String>) -> Self {
        Self::new(source, HealthStatus::Incomplete, message)
    }
    pub(crate) fn unavailable(source: &str, message: impl Into<String>) -> Self {
        Self::new(source, HealthStatus::Unavailable, message)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct EntityRef {
    pub(crate) kind: String,
    pub(crate) id: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub(crate) reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<String>,
}

impl EntityRef {
    pub(crate) fn task(id: &str, reference: Option<&str>, label: Option<&str>) -> Self {
        Self {
            kind: "task".into(),
            id: id.into(),
            reference: reference.map(str::to_owned),
            label: label.map(str::to_owned),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct BoundaryRef {
    pub(crate) kind: String,
    pub(crate) id: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub(crate) reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
    pub(crate) hydrated: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub(crate) struct PlanMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan_phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) plan_kind: Option<String>,
    pub(crate) plan_worked_out: bool,
    pub(crate) reset_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reset_state: Option<String>,
}

/// Sanitized delivery facet. Acceptance and delivery remain separate facts.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub(crate) struct DeliveryRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) merged: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) obligation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) provenance: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct TaskRecord {
    pub(crate) id: String,
    #[serde(rename = "ref")]
    pub(crate) reference: String,
    pub(crate) title: String,
    pub(crate) project: String,
    pub(crate) status: String,
    pub(crate) is_epic: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) epic_parent: Option<EntityRef>,
    pub(crate) epic_children: Vec<EntityRef>,
    pub(crate) dependencies: Vec<BoundaryRef>,
    pub(crate) blocks: Vec<BoundaryRef>,
    pub(crate) related: Vec<BoundaryRef>,
    pub(crate) plan: PlanMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) delivery: Option<DeliveryRecord>,
    pub(crate) hydrated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) context_observed_at_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Origin {
    CentralStore,
    AvenRecovery,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub(crate) struct TerminalLink {
    pub(crate) core_id: String,
    pub(crate) address: String,
    pub(crate) name: String,
    pub(crate) role: String,
    pub(crate) created_by_attempt: bool,
}

impl TerminalLink {
    pub(crate) fn is_empty(&self) -> bool {
        self.address.is_empty()
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct PhaseRecord {
    pub(crate) task_id: String,
    #[serde(rename = "ref")]
    pub(crate) reference: String,
    pub(crate) title: String,
    pub(crate) branch: String,
    pub(crate) worktree: String,
    pub(crate) terminal: TerminalLink,
    pub(crate) pane: String,
    pub(crate) session_id: String,
    pub(crate) state: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) commit: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) integrated_commit: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct AttemptRecord {
    pub(crate) task_id: String,
    #[serde(rename = "ref")]
    pub(crate) task_ref: String,
    pub(crate) workflow: String,
    pub(crate) attempt_id: String,
    pub(crate) generation: u64,
    pub(crate) origin: Origin,
    pub(crate) observed_at_ms: u64,
    pub(crate) created_at_ms: u64,
    pub(crate) state: String,
    pub(crate) execution_mode: String,
    pub(crate) backend: String,
    pub(crate) core_id: String,
    pub(crate) terminal: TerminalLink,
    pub(crate) coordinator_terminal: TerminalLink,
    pub(crate) babysitter_terminal: TerminalLink,
    pub(crate) branch: String,
    pub(crate) worktree: String,
    pub(crate) worktree_created_by_attempt: bool,
    pub(crate) agent: String,
    pub(crate) model: String,
    pub(crate) coordinator_agent: String,
    pub(crate) coordinator_model: String,
    pub(crate) coordinator_session_id: String,
    pub(crate) babysitter: bool,
    pub(crate) babysitter_session_id: String,
    pub(crate) babysitter_pane: String,
    pub(crate) session_id: String,
    pub(crate) pane: String,
    pub(crate) phases: Vec<PhaseRecord>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionRole {
    Primary,
    Coordinator,
    Babysitter,
    PhaseWorker,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApiState {
    Working,
    Idle,
    Missing,
    Unknown,
}

#[allow(dead_code)] // Expired is populated when live activity ages out.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Freshness {
    Current,
    Expired,
    Unknown,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Tri {
    Yes,
    No,
    Unknown,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ApiActivity {
    pub(crate) state: ApiState,
    pub(crate) freshness: Freshness,
    pub(crate) observed_at_ms: u64,
    pub(crate) expires_at_ms: u64,
    pub(crate) approval_waiting: Tri,
    pub(crate) input_waiting: Tri,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent_id: Option<String>,
}

impl ApiActivity {
    pub(crate) fn unknown() -> Self {
        Self {
            state: ApiState::Unknown,
            freshness: Freshness::Unknown,
            observed_at_ms: 0,
            expires_at_ms: 0,
            approval_waiting: Tri::Unknown,
            input_waiting: Tri::Unknown,
            parent_id: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct SessionRecord {
    pub(crate) session_id: String,
    pub(crate) roles: Vec<SessionRole>,
    pub(crate) task_ids: Vec<String>,
    pub(crate) task_refs: Vec<String>,
    pub(crate) workflows: Vec<String>,
    pub(crate) attempt_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pane: Option<String>,
    pub(crate) api: ApiActivity,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct PaneRecord {
    pub(crate) pane_id: String,
    pub(crate) workspace_id: String,
    pub(crate) tab_id: String,
    pub(crate) cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_profile: Option<String>,
    pub(crate) agent_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) agent_session_id: Option<String>,
    pub(crate) focused: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WorkspaceRecord {
    pub(crate) workspace_id: String,
    pub(crate) label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) repo_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) checkout_path: Option<String>,
    pub(crate) active_tab_id: String,
    pub(crate) focused: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorktreeOrigin {
    Core,
    Attempt,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct WorktreeRecord {
    pub(crate) path: String,
    pub(crate) branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) open_workspace_id: Option<String>,
    pub(crate) origin: WorktreeOrigin,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct PaneCandidate {
    pub(crate) task_id: String,
    #[serde(rename = "ref")]
    pub(crate) task_ref: String,
    pub(crate) workflow: String,
    pub(crate) attempt_id: String,
    /// Phase child task owned by this worker pane, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phase_task_id: Option<String>,
    pub(crate) role: SessionRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_id: Option<String>,
    pub(crate) pane_id: String,
    #[serde(default)]
    pub(crate) core_id: String,
    pub(crate) labels: Vec<(String, String)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tab_id: Option<String>,
    pub(crate) evidence: String,
    pub(crate) topology_present: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Relationship {
    pub(crate) kind: String,
    pub(crate) from: EntityRef,
    pub(crate) to: EntityRef,
    pub(crate) evidence: String,
}

/// Bounded, terminal-safe text. Source text is untrusted: strip C0/C1
/// controls, OSC/CSI escape sequences, collapse whitespace and redact known
/// credentials before anything reaches a renderer or JSON consumer.
pub(crate) fn sanitize(input: &str, max: usize, secrets: &[String]) -> String {
    let mut clean = String::with_capacity(input.len().min(max * 4));
    let mut chars = input.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\u{1b}' => match chars.peek() {
                Some('[') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if ('\u{40}'..='\u{7e}').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            },
            '\n' | '\t' => clean.push(' '),
            c if c.is_control() => {}
            c => clean.push(c),
        }
    }
    let mut clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    for secret in secrets {
        if secret.len() >= 4 {
            clean = clean.replace(secret, "[redacted]");
        }
    }
    if clean.chars().count() > max {
        let mut truncated = clean
            .chars()
            .take(max.saturating_sub(1))
            .collect::<String>();
        truncated.push('…');
        clean = truncated;
    }
    clean
}

pub(crate) fn valid_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && value.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

pub(crate) fn valid_reference(value: &str) -> bool {
    value.len() <= 256
        && value.split_once('-').is_some_and(|(prefix, suffix)| {
            !prefix.is_empty()
                && !suffix.is_empty()
                && prefix.chars().all(|c| c.is_ascii_alphanumeric())
                && suffix.chars().all(|c| c.is_ascii_alphanumeric())
        })
}

pub(crate) fn valid_session_id(value: &str) -> bool {
    value.len() <= 132
        && value.strip_prefix("ses_").is_some_and(|rest| {
            !rest.is_empty()
                && rest
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        })
}

/// Parse an Aven reset generation. Missing legacy values are generation zero.
pub(crate) fn generation(metadata: &BTreeMap<String, String>) -> Result<u64, ()> {
    match metadata.get("dispatch.reset-generation") {
        None => Ok(0),
        Some(value) if value.is_empty() => Ok(0),
        Some(value) => value.parse::<u64>().map_err(|_| ()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizer_strips_terminal_controls_and_bounds_text() {
        let output = sanitize(
            "ok\u{1b}[31mred\u{1b}[0m\u{1b}]0;title\u{7}\u{0}line\nnext",
            40,
            &[],
        );
        assert_eq!(output, "okredline next");
        let bounded = sanitize(&"x".repeat(80), 10, &[]);
        assert_eq!(bounded.chars().count(), 10);
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn sanitizer_redacts_known_secrets() {
        let output = sanitize(
            "token super-secret-value leaked",
            100,
            &["super-secret-value".into()],
        );
        assert_eq!(output, "token [redacted] leaked");
    }

    #[test]
    fn identifiers_refs_and_sessions_are_validated() {
        assert!(valid_identifier("herdr-aven-plugin"));
        assert!(!valid_identifier("../escape"));
        assert!(!valid_identifier(""));
        assert!(valid_reference("HAP-3TQK"));
        assert!(!valid_reference("HAP"));
        assert!(!valid_reference("HAP-"));
        assert!(valid_session_id("ses_abc123"));
        assert!(!valid_session_id("abc123"));
        assert!(!valid_session_id("ses_"));
    }

    #[test]
    fn missing_generation_is_legacy_zero_and_malformed_is_rejected() {
        assert_eq!(generation(&BTreeMap::new()), Ok(0));
        assert_eq!(
            generation(&BTreeMap::from([(
                "dispatch.reset-generation".into(),
                "2".into()
            )])),
            Ok(2)
        );
        assert_eq!(
            generation(&BTreeMap::from([(
                "dispatch.reset-generation".into(),
                "two".into()
            )])),
            Err(())
        );
    }
}
