//! Read-only dispatcher inspector boundary.
//!
//! `inspect --json` is the nonterminal diagnostic surface for the same
//! immutable snapshot the terminal inspector renders in a later phase. It
//! never mutates Aven, dispatcher records, OpenCode sessions or terminal focus.

pub(crate) mod model;
pub(crate) mod sources;

use anyhow::Result;
use std::{
    io::{self, Write},
    path::PathBuf,
};

pub(crate) struct Args {
    pub(crate) project: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) store: PathBuf,
    pub(crate) json: bool,
}

pub(crate) fn run(args: Args) -> Result<()> {
    let snapshot = sources::collect(&sources::Options {
        project: args.project,
        workspace: args.workspace,
        cwd: args.cwd,
        store: args.store,
        ..Default::default()
    })?;
    let output = if args.json {
        serde_json::to_string_pretty(&snapshot)?
    } else {
        summary(&snapshot)
    };
    emit(&output)
}

// A bounded inspection piped into `head`/`jq` must not panic on a closed
// stdout; other I/O failures are still reported.
fn emit(text: &str) -> Result<()> {
    let mut stdout = io::stdout().lock();
    match stdout
        .write_all(text.as_bytes())
        .and_then(|_| stdout.write_all(b"\n"))
        .and_then(|_| stdout.flush())
    {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn summary(snapshot: &model::Snapshot) -> String {
    use std::fmt::Write as _;
    let mut output = String::new();
    let _ = writeln!(
        output,
        "scope: project={} workspace={} ({}/{})",
        snapshot.scope.project,
        snapshot.scope.workspace,
        snapshot.scope.project_source,
        snapshot.scope.workspace_source
    );
    let _ = writeln!(output, "repository: {}", snapshot.scope.repository);
    let _ = writeln!(output, "observed: {} ms", snapshot.observed_at_ms);
    for health in &snapshot.sources {
        let _ = writeln!(
            output,
            "source {}: {:?} - {}",
            health.source, health.status, health.message
        );
    }
    let _ = writeln!(
        output,
        "{} task(s), {} attempt(s), {} session(s), {} terminal(s), {} workspace(s), {} worktree(s)",
        snapshot.tasks.len(),
        snapshot.attempts.len(),
        snapshot.sessions.len(),
        snapshot.panes.len(),
        snapshot.workspaces.len(),
        snapshot.worktrees.len()
    );
    for attempt in &snapshot.attempts {
        let _ = writeln!(
            output,
            "  {} {} [{}] state={} session={} terminal={} origin={:?}",
            attempt.task_ref,
            attempt.workflow,
            attempt.execution_mode,
            attempt.state,
            if attempt.session_id.is_empty() {
                "-"
            } else {
                &attempt.session_id
            },
            if attempt.pane.is_empty() {
                "-"
            } else {
                &attempt.pane
            },
            attempt.origin
        );
    }
    for conflict in &snapshot.conflicts {
        let _ = writeln!(
            output,
            "conflict {} {}: {}",
            conflict.task_ref, conflict.kind, conflict.message
        );
    }
    for warning in &snapshot.warnings {
        let _ = writeln!(output, "warning: {warning}");
    }
    output
}
