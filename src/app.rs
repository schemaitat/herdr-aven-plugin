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

/// herdr-app adopts any core terminal labelled with a `herdr.space`/`herdr.tab`
/// pair: an id it does not know becomes a new place for that terminal. A
/// dispatcher running on a remote machine cannot reach the person's app, so it
/// writes those labels on its own core instead and the app follows them.
///
/// Ids are derived from the machine-local worktree path. Every terminal for one
/// worktree (worker, babysitter, coordinator, phase workers) and every later
/// re-dispatch therefore resolves to the same space and tab instead of adding
/// duplicates.
fn adopted_id(prefix: &str, folder: &str) -> String {
    // FNV-1a (128 bit): stable across runs and Rust versions, unlike
    // DefaultHasher, and this is only an opaque key, not a security primitive.
    let mut hash: u128 = 0x6c62272e07bb014262b821756295c58d;
    for byte in folder.as_bytes() {
        hash ^= u128::from(*byte);
        hash = hash.wrapping_mul(0x0000_0000_0100_0000_0000_0000_0000_013b);
    }
    format!("{prefix}{hash:032x}")
}

/// The app-facing placement for an adopted terminal: one space and one tab per
/// worktree path, matching what `space.new` would have created.
fn adoption_labels(folder: &str) -> Vec<(String, String)> {
    vec![
        ("herdr.space".into(), adopted_id("sp", folder)),
        ("herdr.tab".into(), adopted_id("tb", folder)),
    ]
}

/// Adoption is the reveal of last resort: it only runs when herdr-app is not
/// running where the dispatcher runs, so it can never compete with `space.new`.
fn adopt(address: &str, folder: &str) -> bool {
    core::label(address, &adoption_labels(folder)).is_ok()
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

/// Make a worktree visible in the desktop app by ensuring it has a space and
/// a label for this attempt's core terminal. This is optional presentation
/// only: failures leave the terminal headless and never fail dispatch. The
/// terminal must already exist.
pub(crate) fn show_worktree(
    address: &str,
    anchor_address: &str,
    folder: &str,
    name: &str,
    task_ref: &str,
) -> bool {
    if address.is_empty() || folder.is_empty() {
        return false;
    }
    let Some(before) = spaces() else {
        // No answering window here (a dispatch on a remote machine, or a host
        // with the app closed). An app that is merely slow keeps the previous
        // best-effort no-op so an inventory hiccup cannot fork a second space.
        return match status() {
            Availability::Unavailable(_) => adopt(address, folder),
            Availability::Available => false,
        };
    };
    // A sidecar is not present in the app inventory until after it is labelled.
    // Anchor it to the already-adopted worker instead of whichever tab happened
    // to be active when it started. For primary and phase terminals the address
    // itself is the anchor.
    let anchor = if anchor_address.is_empty() {
        address
    } else {
        anchor_address
    };
    let existing = before
        .iter()
        .filter(|space| space.get("folder").and_then(Value::as_str) == Some(folder))
        .find_map(|space| space_target(space, anchor));
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
            find_space(&after, folder, &previous, anchor)
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
    if labelled
        && let Some(placeholder) = target.placeholder.as_deref()
        && placeholder != address
    {
        // `space.new` starts an empty shell for the space's first tab. The
        // labelled agent is now adopted, so the placeholder can go and leave
        // only the agent terminal.
        let _ = core::kill(placeholder);
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
    fn adopted_ids_are_stable_shape_and_worktree_scoped() {
        let space = adopted_id(
            "sp",
            "/home/dev/.herdr/worktrees/apo/feat-apo-1-dispatch-id",
        );
        let tab = adopted_id(
            "tb",
            "/home/dev/.herdr/worktrees/apo/feat-apo-1-dispatch-id",
        );
        assert_eq!(
            space,
            adopted_id(
                "sp",
                "/home/dev/.herdr/worktrees/apo/feat-apo-1-dispatch-id"
            )
        );
        assert_eq!(space.len(), 34);
        assert!(space.starts_with("sp"));
        assert!(
            space[2..]
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert!(tab.starts_with("tb"));
        assert_eq!(&space[2..], &tab[2..]);
        assert_ne!(
            space,
            adopted_id(
                "sp",
                "/home/dev/.herdr/worktrees/apo/feat-apo-2-dispatch-other"
            )
        );
        assert_ne!(
            adopted_id("sp", "/home/dev/worktrees/apo/feat-apo-1"),
            adopted_id("sp", "/home/dev/.herdr/worktrees/apo/feat-apo-1")
        );
    }

    #[test]
    fn adoption_labels_place_a_worktree_in_one_space_and_tab() {
        let labels = adoption_labels("/home/dev/.herdr/worktrees/apo/feat-apo-1");
        let value = |key: &str| {
            labels
                .iter()
                .find(|(label, _)| label == key)
                .map(|(_, value)| value.clone())
                .expect("adoption label")
        };
        assert_eq!(labels.len(), 2);
        assert_eq!(
            value("herdr.space"),
            adopted_id("sp", "/home/dev/.herdr/worktrees/apo/feat-apo-1")
        );
        assert_eq!(
            value("herdr.tab"),
            adopted_id("tb", "/home/dev/.herdr/worktrees/apo/feat-apo-1")
        );
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
