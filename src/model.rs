//! Dispatcher data model and Aven command-context parsing.
//!
//! Attempts are the serde payload of the central SQLite store; Aven metadata
//! keeps the task-facing recovery snapshot.

use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
pub(crate) struct CommandContext {
    pub(crate) version: u32,
    pub(crate) invocation: Invocation,
    #[serde(default)]
    pub(crate) targeting: Targeting,
    #[serde(default)]
    pub(crate) selection: Selection,
}
#[derive(Debug, Deserialize, Default)]
pub(crate) struct Targeting {
    #[serde(default)]
    pub(crate) targets: Vec<Target>,
}
#[derive(Debug, Deserialize)]
pub(crate) struct Target {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) reference: String,
    #[serde(rename = "ref", default)]
    pub(crate) short_ref: String,
}
impl Target {
    pub(crate) fn reference(&self) -> &str {
        if self.reference.is_empty() {
            &self.short_ref
        } else {
            &self.reference
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Invocation {
    #[serde(default)]
    pub(crate) aven_exe: String,
    #[serde(default)]
    pub(crate) db_path: Option<String>,
    #[serde(default)]
    pub(crate) workspace: Option<String>,
    #[serde(default)]
    pub(crate) origin_cwd: String,
}
#[derive(Debug, Deserialize, Default)]
pub(crate) struct Selection {
    #[serde(default)]
    pub(crate) primary: Option<Selected>,
}
#[derive(Debug, Deserialize)]
pub(crate) struct Selected {
    #[serde(default)]
    pub(crate) reference: String,
    #[serde(rename = "ref", default)]
    pub(crate) short_ref: String,
    pub(crate) task: SelectedTask,
    #[serde(default)]
    pub(crate) project: Project,
}
impl Selected {
    pub(crate) fn reference(&self) -> &str {
        if self.reference.is_empty() {
            &self.short_ref
        } else {
            &self.reference
        }
    }
}
#[derive(Debug, Deserialize)]
pub(crate) struct SelectedTask {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) title: String,
}
#[derive(Debug, Deserialize, Default)]
pub(crate) struct Project {
    #[serde(default)]
    pub(crate) key: String,
}

/// Where an attempt's OpenCode terminal lives. `address` is only durable
/// together with `core_id`: terminal addresses restart with a new core, and a
/// bare `t7` is never proof that a terminal this attempt owns still exists.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct TerminalRef {
    #[serde(default)]
    pub(crate) core_id: String,
    #[serde(default)]
    pub(crate) core_name: String,
    #[serde(default)]
    pub(crate) address: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) role: String,
    /// True only when this attempt created the terminal. A reused terminal is
    /// user-owned and must never be killed or removed automatically.
    #[serde(default)]
    pub(crate) created_by_attempt: bool,
}
impl TerminalRef {
    pub(crate) fn is_empty(&self) -> bool {
        self.address.is_empty()
    }
    pub(crate) fn matches_core(&self, core_id: &str) -> bool {
        !self.address.is_empty() && (self.core_id.is_empty() || self.core_id == core_id)
    }
}

/// The latest fact herdr-core reported for one attempt terminal. This is an
/// observation, never acceptance: Aven status and OpenCode API outcomes remain
/// authoritative.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct TerminalObservation {
    #[serde(default)]
    pub(crate) core_id: String,
    #[serde(default)]
    pub(crate) address: String,
    /// live / finished / removed / unknown
    #[serde(default)]
    pub(crate) state: String,
    /// idle / working / done / blocked / error, or empty when never reported.
    #[serde(default)]
    pub(crate) status: String,
    /// permission / question / auth when the program reported a blocked kind.
    #[serde(default)]
    pub(crate) status_kind: String,
    #[serde(default)]
    pub(crate) program: String,
    #[serde(default)]
    pub(crate) reason: String,
    #[serde(default)]
    pub(crate) turn: u64,
    #[serde(default)]
    pub(crate) seq: u64,
    #[serde(default)]
    pub(crate) updated_at: u64,
    /// finished / lost / restarted / removed / recovered-shell, empty when normal.
    #[serde(default)]
    pub(crate) recovery: String,
}

/// In-memory working set loaded from the central SQLite `attempts` table.
#[derive(Debug, Default)]
pub(crate) struct Store {
    pub(crate) attempts: BTreeMap<String, Attempt>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Attempt {
    pub(crate) task_id: String,
    pub(crate) task_ref: String,
    #[serde(default = "default_workflow")]
    pub(crate) workflow: String,
    pub(crate) attempt_id: String,
    pub(crate) branch: String,
    pub(crate) worktree: String,
    /// A checkout opened from an existing branch is user-owned. Only a
    /// checkout created for this exact attempt is eligible for best-effort
    /// automatic cleanup.
    #[serde(default)]
    pub(crate) worktree_created_by_attempt: bool,
    /// Empty on legacy records, which are read-only evidence from the retired
    /// `herdr` runtime. New attempts record `hc`.
    #[serde(default)]
    pub(crate) backend: String,
    /// Durable herdr-core identity and the build terminal address.
    #[serde(default)]
    pub(crate) core_id: String,
    #[serde(default)]
    pub(crate) core_name: String,
    #[serde(default)]
    pub(crate) terminal: TerminalRef,
    /// Legacy Herdr pane id, retained as historical evidence for old attempts.
    #[serde(default)]
    pub(crate) pane: String,
    #[serde(default)]
    pub(crate) agent: String,
    #[serde(default)]
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) execution_mode: ExecutionMode,
    #[serde(default)]
    pub(crate) coordinator_session_id: String,
    #[serde(default)]
    pub(crate) coordinator_agent: String,
    #[serde(default)]
    pub(crate) coordinator_model: String,
    #[serde(default)]
    pub(crate) coordinator_terminal: TerminalRef,
    #[serde(default)]
    pub(crate) auto_permissions: bool,
    #[serde(default)]
    pub(crate) phases: Vec<PhaseAttempt>,
    /// Keyed by role (`builder`, `coordinator`, `babysitter`, `phase:<task_id>`).
    #[serde(default)]
    pub(crate) terminals: BTreeMap<String, TerminalObservation>,
    /// Last herdr-core event sequence this attempt has reconciled through.
    #[serde(default)]
    pub(crate) last_event_seq: u64,
    #[serde(default)]
    pub(crate) session_id: String,
    pub(crate) prompt_id: String,
    #[serde(default)]
    pub(crate) pending_prompt: String,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) aven_update_pending: bool,
    #[serde(default)]
    pub(crate) log_cursor: String,
    #[serde(default)]
    pub(crate) log_task_ref: String,
    /// Task-scoped reset generation. Missing values are legacy generation zero.
    #[serde(default)]
    pub(crate) generation: u64,
    #[serde(default)]
    pub(crate) babysitter: bool,
    #[serde(default)]
    pub(crate) babysitter_terminal: TerminalRef,
    #[serde(default)]
    pub(crate) babysitter_pane: String,
    #[serde(default)]
    pub(crate) babysitter_session_id: String,
    #[serde(default)]
    pub(crate) babysitter_prompt_id: String,
    pub(crate) aven: Invocation,
    pub(crate) created_at: u64,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ValueEnum, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ExecutionMode {
    #[default]
    SingleSession,
    Subsessions,
    Worktrees,
}
impl ExecutionMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::SingleSession => "single-session",
            Self::Subsessions => "subsessions",
            Self::Worktrees => "worktrees",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct PhaseAttempt {
    pub(crate) task_id: String,
    pub(crate) task_ref: String,
    pub(crate) title: String,
    pub(crate) branch: String,
    pub(crate) worktree: String,
    #[serde(default)]
    pub(crate) worktree_created_by_attempt: bool,
    #[serde(default)]
    pub(crate) terminal: TerminalRef,
    /// Legacy Herdr pane id, retained as historical evidence.
    pub(crate) pane: String,
    pub(crate) session_id: String,
    pub(crate) prompt_id: String,
    /// Durable prompt body for crash-safe re-admission with the same message id.
    #[serde(default)]
    pub(crate) pending_prompt: String,
    pub(crate) commit: String,
    pub(crate) integrated_commit: String,
    pub(crate) state: String,
}
#[derive(Debug, Clone)]
pub(crate) struct EpicPhase {
    pub(crate) task_id: String,
    pub(crate) task_ref: String,
    pub(crate) title: String,
}
pub(crate) fn default_workflow() -> String {
    "default".into()
}
pub(crate) fn workflow_for_skill(skill: Option<&str>) -> &'static str {
    match skill {
        Some("aven/sdd-plan") => "planning",
        Some("aven/sdd-implement" | "aven/sdd-plan-implement") => "implementation",
        _ => "default",
    }
}
pub(crate) fn attempt_key(task_id: &str, workflow: &str) -> String {
    format!("{task_id}:{workflow}")
}

/// Repeatable conversion of a persisted record. Legacy records keep their pane
/// as readable evidence and are explicitly marked with the retired backend;
/// they are never reinterpreted as herdr-core terminals.
pub(crate) fn normalize_attempt(mut attempt: Attempt) -> Attempt {
    if attempt.backend.is_empty() {
        attempt.backend = if attempt.pane.is_empty() && attempt.terminal.is_empty() {
            "hc".into()
        } else {
            "herdr".into()
        };
    } else if attempt.backend != "hc" && !attempt.pane.is_empty() && attempt.terminal.is_empty() {
        // Older `opencode-v2` records still addressed Herdr panes. They are
        // historical evidence exactly like a bare `herdr` record.
        attempt.backend = "herdr".into();
    }
    if attempt.terminals.is_empty() {
        let roles = attempt_terminal_roles(&attempt)
            .into_iter()
            .map(|(role, terminal)| (role.to_owned(), terminal.clone()))
            .collect::<Vec<_>>();
        for (role, terminal) in roles {
            attempt.terminals.insert(
                role,
                TerminalObservation {
                    core_id: terminal.core_id,
                    address: terminal.address,
                    state: "unknown".into(),
                    ..TerminalObservation::default()
                },
            );
        }
    }
    attempt
}

pub(crate) fn attempt_terminal_roles(attempt: &Attempt) -> Vec<(&'static str, &TerminalRef)> {
    let mut roles = vec![("builder", &attempt.terminal)];
    if !attempt.coordinator_terminal.is_empty() {
        roles.push(("coordinator", &attempt.coordinator_terminal));
    }
    if !attempt.babysitter_terminal.is_empty() {
        roles.push(("babysitter", &attempt.babysitter_terminal));
    }
    roles
}

pub(crate) fn attempt_is_legacy(attempt: &Attempt) -> bool {
    attempt.backend != "hc" && !attempt.pane.is_empty()
}
