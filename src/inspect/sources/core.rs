//! Read-only herdr-core topology observation.

use super::scope::source_error;
use crate::{inspect::model::*, process::run_bounded};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    path::Path,
    time::Duration,
};

#[derive(Debug, Default, Deserialize)]
struct HcTerminal {
    #[serde(default)]
    address: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    r#where: String,
    #[serde(default)]
    turn: u64,
}

pub(super) fn read_core(
    scope: &Scope,
    attempts: &[AttemptRecord],
    secrets: &[String],
) -> (
    Vec<PaneRecord>,
    Vec<WorkspaceRecord>,
    Vec<WorktreeRecord>,
    SourceHealth,
) {
    let binary = env::var("HC_BIN").unwrap_or_else(|_| "hc".into());
    let output = run_bounded(
        &binary,
        &["ls".into(), "--json".into()],
        Some(Path::new(&scope.cwd)),
        Duration::from_millis(SOURCE_TIMEOUT_MS),
        SOURCE_OUTPUT_LIMIT,
    );
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            return (
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SourceHealth::unavailable(
                    "core",
                    format!(
                        "herdr-core is unavailable; terminal observations are unknown: {}",
                        source_error(&error, secrets)
                    ),
                ),
            );
        }
    };
    let value: Value = match serde_json::from_str(&output) {
        Ok(value) => value,
        Err(_) => {
            return (
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SourceHealth::unavailable(
                    "core",
                    "herdr-core returned an unsupported terminal list; terminal observations are unknown.",
                ),
            );
        }
    };
    let mut values = value
        .get("terminals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let capped = values.len() > PANE_LIMIT;
    values.truncate(PANE_LIMIT);
    let referenced = attempts
        .iter()
        .flat_map(|attempt| {
            [
                attempt.terminal.address.as_str(),
                attempt.coordinator_terminal.address.as_str(),
                attempt.babysitter_terminal.address.as_str(),
            ]
            .into_iter()
            .chain(
                attempt
                    .phases
                    .iter()
                    .map(|phase| phase.terminal.address.as_str()),
            )
        })
        .filter(|address| !address.is_empty())
        .collect::<BTreeSet<_>>();
    let mut paths = BTreeSet::from([scope.repository.clone()]);
    paths.extend(
        attempts
            .iter()
            .filter(|attempt| !attempt.worktree.is_empty())
            .map(|attempt| attempt.worktree.clone()),
    );
    let mut panes = Vec::new();
    for value in values {
        let Ok(terminal) = serde_json::from_value::<HcTerminal>(value) else {
            continue;
        };
        if terminal.address.is_empty() {
            continue;
        }
        let in_scope = referenced.contains(terminal.address.as_str())
            || paths.iter().any(|path| {
                terminal.cwd == *path
                    || (!path.is_empty()
                        && terminal
                            .cwd
                            .starts_with(&format!("{}/", path.trim_end_matches('/'))))
            });
        if !in_scope {
            continue;
        }
        panes.push(PaneRecord {
            pane_id: sanitize(&terminal.address, 128, secrets),
            workspace_id: sanitize(
                if terminal.r#where.is_empty() {
                    "core"
                } else {
                    &terminal.r#where
                },
                256,
                secrets,
            ),
            tab_id: String::new(),
            cwd: sanitize(&terminal.cwd, 4096, secrets),
            agent_profile: (!terminal.agent.is_empty())
                .then(|| sanitize(&terminal.agent, 128, secrets)),
            agent_status: sanitize(
                if !terminal.status.is_empty() {
                    &terminal.status
                } else if !terminal.state.is_empty() {
                    &terminal.state
                } else {
                    "unknown"
                },
                64,
                secrets,
            ),
            agent_session_id: None,
            focused: false,
        });
        let _ = (&terminal.name, terminal.turn);
    }
    panes.sort_by(|left, right| left.pane_id.cmp(&right.pane_id));
    let mut workspaces = BTreeMap::<String, WorkspaceRecord>::new();
    for pane in &panes {
        workspaces
            .entry(pane.workspace_id.clone())
            .or_insert_with(|| WorkspaceRecord {
                workspace_id: pane.workspace_id.clone(),
                label: pane.workspace_id.clone(),
                repo_root: None,
                checkout_path: None,
                active_tab_id: String::new(),
                focused: false,
            });
    }
    let health = if capped {
        SourceHealth::incomplete(
            "core",
            format!("herdr-core terminal topology capped at {PANE_LIMIT} terminals."),
        )
    } else {
        SourceHealth::ok(
            "core",
            "herdr-core terminal state is separate from OpenCode API activity and Aven acceptance.",
        )
    };
    (
        panes,
        workspaces.into_values().collect(),
        Vec::new(),
        health,
    )
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------
