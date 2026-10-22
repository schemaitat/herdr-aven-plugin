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
    pub(crate) auto_permissions: bool,
    #[serde(default)]
    pub(crate) phases: Vec<PhaseAttempt>,
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
    pub(crate) pane: String,
    pub(crate) session_id: String,
    pub(crate) prompt_id: String,
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
#[derive(Debug, Clone)]
pub(crate) struct WorktreeResource {
    pub(crate) path: String,
    pub(crate) pane: String,
    pub(crate) created_by_attempt: bool,
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
