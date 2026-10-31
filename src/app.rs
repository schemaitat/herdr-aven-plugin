//! Optional herdr-app integration: reveal and focus only.
//!
//! The desktop app is never on the dispatch path. A missing, closed, or slow
//! app is reported as "unavailable" and never invalidates a successful core
//! dispatch or worktree operation. Every call is bounded so a wedged window
//! cannot hold the dispatcher.

use std::{
    env,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

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
