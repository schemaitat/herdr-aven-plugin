//! Read-only herdr-core topology observation.
//!
//! The inspector prefers the bounded terminal inventory written by the watcher
//! and falls back to a live `hc ls --json` listing. A stale inventory is
//! observation, never acceptance, and never permission to control a terminal.

use super::scope::source_error;
use crate::{inspect::model::*, process::run_bounded};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::Path,
    time::Duration,
};

#[derive(Debug, Default, Deserialize)]
struct RawCore {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    machine: String,
}

#[derive(Debug, Default, Deserialize)]
struct RawTerminal {
    #[serde(default)]
    address: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    status: Value,
    #[serde(default)]
    status_kind: String,
    #[serde(default)]
    program: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    agent: String,
    #[serde(default, rename = "where")]
    location: String,
    #[serde(default)]
    turn: u64,
    #[serde(default)]
    reported: bool,
    #[serde(default)]
    recovered_shell: bool,
    #[serde(default)]
    labels: BTreeMap<String, String>,
}

fn status_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Object(map) => map
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    }
}

fn program_for(raw: &RawTerminal) -> String {
    if !raw.program.is_empty() {
        raw.program.clone()
    } else {
        raw.agent.clone()
    }
}

fn read_inventory(store: &Path) -> Option<(CoreRecord, Vec<RawTerminal>, u64)> {
    let path = store.with_file_name("terminals.json");
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > SOURCE_OUTPUT_LIMIT as u64 {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let observed_at = value
        .get("observed_at")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let terminals = value.get("terminals")?.as_array()?.clone();
    let mut parsed = Vec::new();
    for terminal in terminals {
        let raw: RawTerminal = serde_json::from_value(terminal).ok()?;
        if raw.address.is_empty() {
            continue;
        }
        parsed.push(raw);
    }
    let core = value
        .get("core")
        .cloned()
        .and_then(|core| serde_json::from_value::<RawCore>(core).ok())
        .unwrap_or_default();
    Some((
        CoreRecord {
            id: core.id,
            name: core.name,
            version: core.version,
            machine: core.machine,
        },
        parsed,
        observed_at,
    ))
}

fn read_live(scope: &Scope, secrets: &[String]) -> Result<(CoreRecord, Vec<RawTerminal>), String> {
    let binary = env::var("HC_BIN").unwrap_or_else(|_| "hc".into());
    let output = run_bounded(
        &binary,
        &["ls".into(), "--json".into()],
        Some(Path::new(&scope.cwd)),
        Duration::from_millis(SOURCE_TIMEOUT_MS),
        SOURCE_OUTPUT_LIMIT,
    )
    .map_err(|error| source_error(&error, secrets))?;
    let value: Value = serde_json::from_str(&output)
        .map_err(|_| "herdr-core returned an unsupported terminal list".to_owned())?;
    let terminals = value
        .get("terminals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut parsed = Vec::new();
    for terminal in terminals {
        let mut raw: RawTerminal = serde_json::from_value(terminal)
            .map_err(|_| "herdr-core returned an unsupported terminal".to_owned())?;
        if raw.address.is_empty() {
            continue;
        }
        if raw.status_kind.is_empty()
            && let Value::Object(map) = &raw.status
        {
            raw.status_kind = map
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
        }
        parsed.push(raw);
    }
    let core = run_bounded(
        &binary,
        &["server".into(), "status".into(), "--json".into()],
        Some(Path::new(&scope.cwd)),
        Duration::from_millis(SOURCE_TIMEOUT_MS),
        SOURCE_OUTPUT_LIMIT,
    )
    .ok()
    .and_then(|output| serde_json::from_str::<Value>(&output).ok())
    .map(|value| CoreRecord {
        id: value
            .pointer("/core/id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        name: value
            .pointer("/core/name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        version: value
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        machine: env::var("HOSTNAME").unwrap_or_default(),
    })
    .unwrap_or_default();
    Ok((core, parsed))
}

pub(super) fn read_core(
    scope: &Scope,
    attempts: &[AttemptRecord],
    store: &Path,
    secrets: &[String],
) -> (
    CoreRecord,
    Vec<PaneRecord>,
    Vec<WorkspaceRecord>,
    SourceHealth,
) {
    let inventory = read_inventory(store);
    let (core, mut values, health) = match inventory {
        Some((core, values, observed_at)) => (
            core,
            values,
            SourceHealth::new(
                "core",
                HealthStatus::Ok,
                if observed_at == 0 {
                    "Bounded herdr-core terminal inventory; status is observation, not API activity or acceptance."
                        .to_owned()
                } else {
                    format!(
                        "Bounded herdr-core terminal inventory observed at {observed_at} ms; status is observation, not API activity or acceptance."
                    )
                },
            ),
        ),
        None => match read_live(scope, secrets) {
            Ok((core, values)) => (
                core,
                values,
                SourceHealth::incomplete(
                    "core",
                    "Live herdr-core listing without dispatcher ownership labels; status is observation, not acceptance.",
                ),
            ),
            Err(error) => {
                return (
                    CoreRecord::default(),
                    Vec::new(),
                    Vec::new(),
                    SourceHealth::unavailable(
                        "core",
                        format!(
                            "herdr-core is unavailable; terminal observations are unknown: {error}"
                        ),
                    ),
                );
            }
        },
    };
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
    for terminal in values {
        let in_scope = referenced.contains(terminal.address.as_str())
            || paths.iter().any(|path| {
                terminal.cwd == *path
                    || (!path.is_empty()
                        && terminal
                            .cwd
                            .starts_with(&format!("{}/", path.trim_end_matches('/'))))
            })
            || terminal
                .labels
                .get("aven.task")
                .is_some_and(|task| !task.is_empty());
        if !in_scope {
            continue;
        }
        let status = status_text(&terminal.status);
        let program = program_for(&terminal);
        panes.push(PaneRecord {
            pane_id: sanitize(&terminal.address, 128, secrets),
            workspace_id: sanitize(
                if terminal.location.is_empty() {
                    "core"
                } else {
                    &terminal.location
                },
                256,
                secrets,
            ),
            tab_id: String::new(),
            cwd: sanitize(&terminal.cwd, 4096, secrets),
            agent_profile: (!program.is_empty()).then(|| sanitize(&program, 128, secrets)),
            agent_status: sanitize(
                if !status.is_empty() {
                    &status
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
            core_id: sanitize(&core.id, 128, secrets),
            name: sanitize(&terminal.name, 256, secrets),
            state: sanitize(&terminal.state, 64, secrets),
            status: sanitize(&status, 64, secrets),
            status_kind: sanitize(&terminal.status_kind, 64, secrets),
            program: sanitize(&program, 128, secrets),
            reason: sanitize(&terminal.reason, 256, secrets),
            turn: terminal.turn,
            reported: terminal.reported,
            recovered_shell: terminal.recovered_shell,
            labels: terminal
                .labels
                .into_iter()
                .map(|(key, value)| {
                    (
                        sanitize(&key, 256, secrets),
                        sanitize(&value, 1024, secrets),
                    )
                })
                .collect(),
        });
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
        health
    };
    (core, panes, workspaces.into_values().collect(), health)
}
