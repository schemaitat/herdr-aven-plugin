//! Bounded, read-only source collection facade for the inspector snapshot.
//!
//! Every transport here is deliberately narrower than a lifecycle command:
//! Aven reads are allowlisted `list`/`context`/`project list` calls, the
//! dispatcher store is opened read-only and never migrated, herdr-core is read
//! through its snapshot/worktree read API, and OpenCode is queried through
//! authenticated GET-only V2 endpoints of an already running service.

mod assemble;
mod aven;
mod core;
mod dispatcher;
mod opencode;
mod scope;

use anyhow::Result;
use scope::{configured_secrets, resolve_scope};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

use super::model::*;
use crate::process::now;

const PROJECT_LIMIT: usize = 100;

#[derive(Clone)]
pub(crate) struct Options {
    pub(crate) project: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) store: PathBuf,
    /// Rotating context-hydration offset; the long-lived collector advances it
    /// per cycle so projects above the admission cap eventually gain coverage.
    pub(crate) hydration_offset: usize,
    /// Selected immutable task id to hydrate first in the next bounded cycle.
    pub(crate) priority_task: Option<String>,
}

#[derive(Clone)]
pub(crate) struct BaseRead {
    pub(crate) scope: Scope,
    pub(crate) tasks: Vec<TaskRecord>,
    pub(crate) attempts: Vec<AttemptRecord>,
    pub(crate) sources: Vec<SourceHealth>,
    pub(crate) warnings: Vec<String>,
}

#[derive(Clone, Default)]
pub(crate) struct LiveRead {
    pub(crate) panes: Vec<PaneRecord>,
    pub(crate) workspaces: Vec<WorkspaceRecord>,
    pub(crate) worktrees: Vec<WorktreeRecord>,
    pub(crate) sessions: Vec<SessionRecord>,
    pub(crate) sources: Vec<SourceHealth>,
    pub(crate) warnings: Vec<String>,
}

/// Aven/task/store lane. The long-lived collector calls this on its slower
/// cadence; the one-shot `inspect` command calls it once.
pub(crate) fn read_base(options: &Options) -> Result<BaseRead> {
    let started = Instant::now();
    let secrets = configured_secrets();
    let scope = resolve_scope(options, &secrets)?;
    let (tasks, contexts, aven_health) = aven::read_aven(
        &scope,
        options.hydration_offset,
        options.priority_task.as_deref(),
        &secrets,
    )?;
    let (attempts, store_health) = dispatcher::read_attempts(&options.store, &contexts, &secrets);
    let mut warnings = Vec::new();
    if started.elapsed() > Duration::from_millis(SOURCE_TIMEOUT_MS) {
        warnings.push(format!(
            "Aven/store lane exceeded the {} ms read budget; coverage is incomplete.",
            SOURCE_TIMEOUT_MS
        ));
    }
    Ok(BaseRead {
        scope,
        tasks,
        attempts,
        sources: vec![aven_health, store_health],
        warnings,
    })
}

/// herdr-core/API lane. It consumes only the last-good scoped attempts from the
/// Aven lane and never writes back to it.
pub(crate) fn read_live(scope: &Scope, attempts: &[AttemptRecord]) -> LiveRead {
    let secrets = configured_secrets();
    let (panes, workspaces, worktrees, core_health) = core::read_core(scope, attempts, &secrets);
    let (mut sessions, mut warnings) = assemble::link_sessions(attempts, &panes);
    let api_health = opencode::read_api_activity(&mut sessions, &secrets);
    warnings.truncate(64);
    LiveRead {
        panes,
        workspaces,
        worktrees,
        sessions,
        sources: vec![core_health, api_health],
        warnings,
    }
}

pub(crate) fn assemble(base: &BaseRead, live: &LiveRead) -> Snapshot {
    assemble::assemble(base, live, now())
}

pub(crate) fn collect(options: &Options) -> Result<Snapshot> {
    let base = read_base(options)?;
    let live = read_live(&base.scope, &base.attempts);
    Ok(assemble(&base, &live))
}

// ---------------------------------------------------------------------------
// Dispatcher store merge
// ---------------------------------------------------------------------------
