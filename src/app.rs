//! Optional herdr-app integration: reveal and focus only.
//!
//! The desktop app is never on the dispatch path. A missing, closed, or slow
//! app is reported as "unavailable" and never invalidates a successful core
//! dispatch or worktree operation. Every call is bounded so a wedged window
//! cannot hold the dispatcher.

use serde_json::Value;
use std::{
    collections::BTreeSet,
    env,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use crate::core;

const APP_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) fn binary() -> String {
    env::var("HERDR_APP_BIN").unwrap_or_else(|_| "herdr-app".into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Availability {
    Available,
    Unavailable(String),
}

fn bounded(args: &[&str]) -> Option<std::process::Output> {
    let mut child = Command::new(binary())
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if started.elapsed() < APP_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(25))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

pub(crate) fn status() -> Availability {
    match bounded(&["status"]) {
        Some(output) if output.status.success() => Availability::Available,
        Some(output) => Availability::Unavailable(
            String::from_utf8_lossy(&output.stderr)
                .lines()
                .next()
                .unwrap_or("herdr-app is not running")
                .to_owned(),
        ),
        None => Availability::Unavailable("herdr-app is not running or did not answer".into()),
    }
}

/// Best-effort focus. App absence or focus failure is never a dispatch error.
pub(crate) fn focus(address: &str) -> bool {
    !address.is_empty()
        && bounded(&["do", "pane.focus", "--terminal", address])
            .is_some_and(|output| output.status.success())
}

/// Reveal a terminal without taking over its work. Best-effort.
pub(crate) fn peek(address: &str) -> bool {
    !address.is_empty()
        && bounded(&["do", "terminal.peek", "--terminal", address])
            .is_some_and(|output| output.status.success())
}

#[derive(Debug, Clone)]
struct SpaceTarget {
    space: String,
    tab: String,
    /// The empty shell `space.new` starts with a new space. It is removed once
    /// the attempt's own terminal has been adopted into the tab.
    placeholder: Option<String>,
}

fn app_json(args: &[&str]) -> Option<Value> {
    let output = bounded(args)?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn spaces() -> Option<Vec<Value>> {
    let value = app_json(&["ls"])?;
    Some(value.get("spaces")?.as_array()?.clone())
}

fn created_id(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get(key)
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::to_owned)
}

fn created_target(value: Value) -> Option<SpaceTarget> {
    Some(SpaceTarget {
        space: created_id(&value, "space")?,
        tab: created_id(&value, "tab")?,
        placeholder: created_id(&value, "terminal"),
    })
}

fn tab_has_terminal(tab: &Value, address: &str) -> bool {
    !address.is_empty()
        && tab
            .get("terminals")
            .and_then(Value::as_array)
            .is_some_and(|terminals| {
                terminals.iter().any(|terminal| {
                    terminal.get("terminal").and_then(Value::as_str) == Some(address)
                })
            })
}

/// The space's tab that already holds this attempt terminal, else its active
/// tab. Preferring the terminal keeps a re-dispatch there even when the Aven
/// pane or another tab is the one currently shown.
fn space_target(space: &Value, address: &str) -> Option<SpaceTarget> {
    let id = space.get("id")?.as_str()?.to_owned();
    let tabs = space.get("tabs")?.as_array()?;
    let tab = tabs
        .iter()
        .find(|tab| tab_has_terminal(tab, address))
        .or_else(|| {
            tabs.iter()
                .find(|tab| tab.get("active").and_then(Value::as_bool) == Some(true))
        })
        .or_else(|| tabs.first())?;
    let tab = tab.get("id")?.as_str()?.to_owned();
    Some(SpaceTarget {
        space: id,
        tab,
        placeholder: None,
    })
}

fn find_space(
    entries: &[Value],
    folder: &str,
    exclude: &BTreeSet<String>,
    address: &str,
) -> Option<SpaceTarget> {
    entries
        .iter()
        .filter(|space| space.get("folder").and_then(Value::as_str) == Some(folder))
        .filter(|space| {
            space
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| !exclude.contains(id))
        })
        .find_map(|space| space_target(space, address))
}

/// The window's current context, used only to undo a pane/tab selection a mod
/// pane creation might have caused. Focus is never required for dispatch.
fn context() -> Option<(String, String)> {
    let value = app_json(&["status"])?;
    Some((
        value.get("space")?.as_str()?.to_owned(),
        value.get("tab")?.as_str()?.to_owned(),
    ))
}

fn restore_context(before: &(String, String)) {
    if context().as_ref() == Some(before) {
        return;
    }
    let _ = bounded(&["do", "space.select", "--id", before.0.as_str()]);
    let _ = bounded(&["do", "tab.select", "--id", before.1.as_str()]);
}

/// The app-side pane an attempt terminal is shown in. `ls` lists terminals
/// only after the app has adopted the attempt's label, so this is also the
/// proof that splitting beside it addresses the right pane.
fn pane_of(address: &str, space_id: &str, tab_id: &str) -> Option<String> {
    let entries = spaces()?;
    let tab = entries
        .iter()
        .find(|space| space.get("id").and_then(Value::as_str) == Some(space_id))
        .and_then(|space| space.get("tabs").and_then(Value::as_array))
        .and_then(|tabs| {
            tabs.iter()
                .find(|tab| tab.get("id").and_then(Value::as_str) == Some(tab_id))
        })?;
    tab.get("terminals")?
        .as_array()?
        .iter()
        .find(|terminal| terminal.get("terminal").and_then(Value::as_str) == Some(address))?
        .get("pane")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn agent_pane(address: &str, space_id: &str, tab_id: &str) -> Option<String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(pane) = pane_of(address, space_id, tab_id) {
            return Some(pane);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Split the worktree's agent pane with the Aven panel. The mod resolves the
/// epic and task from Aven and the persisted dispatcher attempt, so dispatch
/// only passes the immutable task ref it already selected. The agent keeps
/// keyboard focus; a window that was showing another space is left there.
fn show_aven_pane(space: &str, tab: &str, address: &str, task_ref: &str) -> bool {
    let Some(pane) = agent_pane(address, space, tab) else {
        return false;
    };
    let payload = serde_json::json!({
        "direction": "right",
        "pane": pane,
        "mod": "aven-worktree",
        "props": { "ref": task_ref, "space": space },
    });
    let before = context();
    let created = bounded(&["do", "pane.split", &payload.to_string()]);
    let _ = bounded(&["do", "pane.focus", "--terminal", address]);
    if let Some(before) = before {
        restore_context(&before);
    }
    created.is_some_and(|output| output.status.success())
}

/// Make a worktree visible in the desktop app by ensuring it has a space, a
/// live Aven task panel, and a label for this attempt's core terminal. This is
/// optional presentation only: failures leave the terminal headless and never
/// fail dispatch. The terminal must already exist.
pub(crate) fn show_worktree(
    address: &str,
    folder: &str,
    name: &str,
    task_ref: &str,
    aven_panel: &mut bool,
) -> bool {
    if address.is_empty() || folder.is_empty() {
        return false;
    }
    let Some(before) = spaces() else {
        return false;
    };
    let existing = before
        .iter()
        .filter(|space| space.get("folder").and_then(Value::as_str) == Some(folder))
        .find_map(|space| space_target(space, address));
    let target = existing.or_else(|| {
        let previous = before
            .iter()
            .filter_map(|space| space.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect::<BTreeSet<_>>();
        let created = bounded(&[
            "do",
            "space.new",
            "--name",
            name,
            "--folder",
            folder,
            "--tab",
            if task_ref.is_empty() { name } else { task_ref },
        ])?;
        if !created.status.success() {
            return None;
        }
        let parsed = serde_json::from_slice::<Value>(&created.stdout)
            .ok()
            .and_then(created_target);
        parsed.or_else(|| {
            let after = spaces()?;
            find_space(&after, folder, &previous, address)
        })
    });
    let Some(target) = target else {
        return false;
    };
    let labelled = core::label(
        address,
        &[
            ("herdr.space".into(), target.space.clone()),
            ("herdr.tab".into(), target.tab.clone()),
        ],
    )
    .is_ok();
    if labelled && !*aven_panel && !task_ref.is_empty() {
        if show_aven_pane(&target.space, &target.tab, address, task_ref) {
            *aven_panel = true;
            // `space.new` starts an empty shell for the space's first tab. The
            // split beside the agent proves the agent was adopted, so the
            // placeholder can go and leave only the agent and Aven.
            if let Some(placeholder) = target.placeholder.as_deref() {
                if placeholder != address {
                    let _ = core::kill(placeholder);
                }
            }
        }
    }
    labelled
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn created_space_keeps_its_placeholder() {
        let value = serde_json::json!({
            "space": "sp1",
            "tab": "tb1",
            "terminal": "t7",
        });
        let target = created_target(value).expect("created target");
        assert_eq!(target.space, "sp1");
        assert_eq!(target.tab, "tb1");
        assert_eq!(target.placeholder.as_deref(), Some("t7"));
    }

    #[test]
    fn space_target_prefers_the_terminal_tab_then_the_active_tab() {
        let value = serde_json::json!({
            "id": "sp1",
            "folder": "/tmp/worktree",
            "tabs": [
                {"id": "tb1", "active": false, "terminals": [{"terminal": "t7", "pane": "p7"}]},
                {"id": "tb2", "active": true, "terminals": []},
            ],
        });
        let target = space_target(&value, "t7").expect("space target");
        assert_eq!(target.tab, "tb1");
        assert!(target.placeholder.is_none());
        let active = space_target(&value, "t9").expect("space target");
        assert_eq!(active.tab, "tb2");
    }
}
