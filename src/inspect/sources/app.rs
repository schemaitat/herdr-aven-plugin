//! Optional read-only herdr-app placement observation.

use super::scope::source_error;
use crate::{inspect::model::*, process::run_bounded};
use serde::Deserialize;
use std::{env, path::Path, time::Duration};

const SPACE_LIMIT: usize = 200;
const TAB_LIMIT: usize = 100;
const TERMINAL_LIMIT: usize = 1000;
const PLACEMENT_LIMIT: usize = 4000;

#[derive(Debug, Default, Deserialize)]
struct RawApp {
    #[serde(default)]
    spaces: Vec<RawSpace>,
}

#[derive(Debug, Default, Deserialize)]
struct RawSpace {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default)]
    tabs: Vec<RawTab>,
}

#[derive(Debug, Default, Deserialize)]
struct RawTab {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    terminals: Vec<RawTerminal>,
}

#[derive(Debug, Default, Deserialize)]
struct RawTerminal {
    #[serde(default)]
    terminal: String,
    #[serde(default)]
    pane: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

fn value(value: Option<&String>, max: usize, secrets: &[String]) -> String {
    value
        .map(|value| sanitize(value, max, secrets))
        .unwrap_or_default()
}

pub(super) fn read_app(scope: &Scope, secrets: &[String]) -> (AppRecord, SourceHealth) {
    if scope.core_session.is_empty() {
        return (
            AppRecord::default(),
            SourceHealth::unavailable(
                "app",
                "No desktop app session; terminals remain observable headlessly.",
            ),
        );
    }
    let binary = env::var("HERDR_APP_BIN").unwrap_or_else(|_| "herdr-app".into());
    let output = run_bounded(
        &binary,
        &["ls".into()],
        Some(Path::new(&scope.cwd)),
        Duration::from_millis(SOURCE_TIMEOUT_MS),
        SOURCE_OUTPUT_LIMIT,
    );
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            return (
                AppRecord::default(),
                SourceHealth::unavailable(
                    "app",
                    format!(
                        "herdr-app unavailable, closed, or returned unsupported topology; headless mode remains supported: {}",
                        source_error(&error, secrets)
                    ),
                ),
            );
        }
    };
    let raw: RawApp = match serde_json::from_str(&output) {
        Ok(raw) => raw,
        Err(_) => {
            return (
                AppRecord::default(),
                SourceHealth::unavailable(
                    "app",
                    "herdr-app returned unsupported topology; headless mode remains supported.",
                ),
            );
        }
    };
    let mut capped = raw.spaces.len() > SPACE_LIMIT;
    let mut spaces = Vec::new();
    let mut placements = Vec::new();
    for space in raw.spaces.into_iter().take(SPACE_LIMIT) {
        if space.id.is_empty() {
            continue;
        }
        let space_id = sanitize(&space.id, 256, secrets);
        let space_name = sanitize(&space.name, 256, secrets);
        spaces.push(AppSpace {
            id: space_id.clone(),
            name: space_name.clone(),
            folder: space
                .folder
                .as_ref()
                .filter(|folder| !folder.is_empty())
                .map(|folder| sanitize(folder, 4096, secrets)),
        });
        capped |= space.tabs.len() > TAB_LIMIT;
        for tab in space.tabs.into_iter().take(TAB_LIMIT) {
            let tab_id = sanitize(&tab.id, 256, secrets);
            let tab_name = sanitize(&tab.name, 256, secrets);
            capped |= tab.terminals.len() > TERMINAL_LIMIT;
            for terminal in tab.terminals.into_iter().take(TERMINAL_LIMIT) {
                if terminal.terminal.is_empty() {
                    continue;
                }
                if placements.len() >= PLACEMENT_LIMIT {
                    capped = true;
                    break;
                }
                placements.push(AppPlacement {
                    terminal: sanitize(&terminal.terminal, 128, secrets),
                    pane: value(terminal.pane.as_ref(), 256, secrets),
                    space: space_id.clone(),
                    space_name: space_name.clone(),
                    tab: tab_id.clone(),
                    tab_name: tab_name.clone(),
                    status: value(terminal.status.as_ref(), 256, secrets),
                    app: value(terminal.app.as_ref(), 256, secrets),
                    name: value(terminal.name.as_ref(), 256, secrets),
                });
            }
        }
    }
    (
        AppRecord { spaces, placements },
        if capped {
            SourceHealth::incomplete(
                "app",
                "Optional herdr-app placement capped; remaining topology is unknown.",
            )
        } else {
            SourceHealth::ok("app", "Optional herdr-app placement; not execution state.")
        },
    )
}
