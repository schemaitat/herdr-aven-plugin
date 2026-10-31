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

fn created_target(value: &Value) -> Option<SpaceTarget> {
    Some(SpaceTarget {
        space: created_id(value, "space")?,
        tab: created_id(value, "tab")?,
    })
}

fn space_target(space: &Value) -> Option<SpaceTarget> {
    let id = space.get("id")?.as_str()?.to_owned();
    let tabs = space.get("tabs")?.as_array()?;
    let tab = tabs
        .iter()
        .find(|tab| tab.get("active").and_then(Value::as_bool) == Some(true))
        .or_else(|| tabs.first())?;
    let tab = tab.get("id")?.as_str()?.to_owned();
    Some(SpaceTarget { space: id, tab })
}

fn find_space(entries: &[Value], folder: &str, exclude: &BTreeSet<String>) -> Option<SpaceTarget> {
    entries
        .iter()
        .filter(|space| space.get("folder").and_then(Value::as_str) == Some(folder))
        .filter(|space| {
            space
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| !exclude.contains(id))
        })
        .find_map(space_target)
}

/// Make a worktree visible in the desktop app by ensuring it has a space and
/// labelling this attempt's core terminal into that space's tab. This is
/// optional presentation only: failures leave the terminal headless and never
/// fail dispatch. The terminal must already exist.
pub(crate) fn show_worktree(address: &str, folder: &str, name: &str) -> bool {
    if address.is_empty() || folder.is_empty() {
        return false;
    }
    let Some(before) = spaces() else {
        return false;
    };
    let existing = before
        .iter()
        .filter(|space| space.get("folder").and_then(Value::as_str) == Some(folder))
        .find_map(space_target);
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
            name,
        ])?;
        if !created.status.success() {
            return None;
        }
        let parsed = serde_json::from_slice::<Value>(&created.stdout)
            .ok()
            .and_then(|value| created_target(&value));
        parsed.or_else(|| {
            let after = spaces()?;
            find_space(&after, folder, &previous)
        })
    });
    let Some(target) = target else {
        return false;
    };
    core::label(
        address,
        &[
            ("herdr.space".into(), target.space),
            ("herdr.tab".into(), target.tab),
        ],
    )
    .is_ok()
}
