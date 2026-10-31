//! Watcher ownership, durable supervision state, and the read-only terminal
//! inventory shared with the dashboard.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::core;
use crate::model::{Attempt, Store};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct WatchState {
    pub(crate) schema: String,
    pub(crate) pid: u32,
    pub(crate) started_at: u64,
    pub(crate) updated_at: u64,
    #[serde(default)]
    pub(crate) core_id: String,
    #[serde(default)]
    pub(crate) core_name: String,
    #[serde(default)]
    pub(crate) last_seq: u64,
    #[serde(default)]
    pub(crate) gaps: u64,
    #[serde(default)]
    pub(crate) reconciliations: u64,
    #[serde(default)]
    pub(crate) last_trigger: String,
    #[serde(default)]
    pub(crate) last_error: String,
    #[serde(default)]
    pub(crate) running: bool,
}

pub(crate) fn state_path(store: &Path) -> PathBuf {
    store.with_file_name("watch.json")
}
pub(crate) fn lock_path(store: &Path) -> PathBuf {
    store.with_file_name("watch.lock")
}
pub(crate) fn inventory_path(store: &Path) -> PathBuf {
    store.with_file_name("terminals.json")
}

pub(crate) fn read_state(store: &Path) -> Option<WatchState> {
    let text = fs::read_to_string(state_path(store)).ok()?;
    serde_json::from_str(&text).ok()
}

pub(crate) fn write_state(store: &Path, state: &WatchState) -> Result<()> {
    write_atomic(&state_path(store), &serde_json::to_vec_pretty(state)?)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!(
        "{}.new",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("tmp")
    ));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    {
        let mut file = fs::File::create(&temporary)
            .with_context(|| format!("write {}", temporary.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&temporary, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if Path::new(&format!("/proc/{pid}")).exists() {
        return true;
    }
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

/// Exactly one watcher owns a store. A stale lock is reported, never stolen
/// implicitly; the operator can inspect and use `watch --stop`.
pub(crate) struct WatcherGuard {
    pub(crate) path: PathBuf,
    pub(crate) state: WatchState,
}
impl WatcherGuard {
    pub(crate) fn acquire(store: &Path) -> Result<Self> {
        let lock = lock_path(store);
        if let Ok(text) = fs::read_to_string(&lock)
            && let Ok(pid) = text.trim().parse::<u32>()
            && pid != std::process::id()
            && process_alive(pid)
        {
            bail!(
                "another dispatcher watcher (pid {pid}) already owns {}",
                store.display()
            );
        }
        if let Some(parent) = lock.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&lock, std::process::id().to_string())
            .with_context(|| format!("claim watcher lock {}", lock.display()))?;
        let now = now_ms();
        let state = WatchState {
            schema: "aven-dispatch-watch/v1".into(),
            pid: std::process::id(),
            started_at: now,
            updated_at: now,
            core_id: String::new(),
            core_name: String::new(),
            last_seq: 0,
            gaps: 0,
            reconciliations: 0,
            last_trigger: "started".into(),
            last_error: String::new(),
            running: true,
        };
        write_state(store, &state)?;
        Ok(Self { path: lock, state })
    }
    pub(crate) fn record(&mut self, store: &Path, trigger: &str) -> Result<()> {
        self.state.updated_at = now_ms();
        self.state.reconciliations = self.state.reconciliations.saturating_add(1);
        self.state.last_trigger = trigger.into();
        write_state(store, &self.state)
    }
    pub(crate) fn error(&mut self, store: &Path, error: &str) -> Result<()> {
        self.state.updated_at = now_ms();
        self.state.last_error = error.into();
        write_state(store, &self.state)
    }
}
impl Drop for WatcherGuard {
    fn drop(&mut self) {
        self.state.updated_at = now_ms();
        self.state.running = false;
        let _ = write_state(&self.path.with_file_name("watch.json"), &self.state);
        let _ = fs::remove_file(&self.path);
    }
}

/// Stop the owner named by the lock. Never guesses: a dead owner is cleaned,
/// a live unrelated process is not signalled.
pub(crate) fn stop(store: &Path) -> Result<String> {
    let lock = lock_path(store);
    let text = fs::read_to_string(&lock)
        .with_context(|| format!("no watcher lock at {}", lock.display()))?;
    let pid = text
        .trim()
        .parse::<u32>()
        .context("watcher lock is malformed")?;
    if !process_alive(pid) {
        let _ = fs::remove_file(&lock);
        return Ok(format!("removed stale watcher lock for pid {pid}"));
    }
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .context("signal watcher")?;
    if !status.success() {
        bail!("could not stop watcher pid {pid}");
    }
    // A process stopped by SIGTERM does not run Drop. Wait for it to exit,
    // then clear the ownership lock this command asked it to release.
    for _ in 0..200 {
        if !process_alive(pid) {
            let _ = fs::remove_file(&lock);
            if let Some(mut state) = read_state(store) {
                state.running = false;
                state.updated_at = now_ms();
                let _ = write_state(store, &state);
            }
            return Ok(format!("stopped dispatcher watcher pid {pid}"));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    bail!("watcher pid {pid} did not exit after SIGTERM; inspect it before forcing cleanup")
}

pub(crate) fn status(store: &Path) -> Value {
    let lock = fs::read_to_string(lock_path(store)).ok();
    let state = read_state(store);
    json!({
        "store": store.display().to_string(),
        "lock": lock.map(|value| value.trim().to_owned()),
        "state": state,
    })
}

/// Write the bounded core-terminal inventory the read-only dashboard serves.
pub(crate) fn write_inventory(
    store: &Path,
    core: &core::CoreIdentity,
    terminals: &[core::Terminal],
) -> Result<()> {
    let terminals = terminals
        .iter()
        .map(|terminal| {
            json!({
                "address": terminal.address,
                "name": terminal.name,
                "state": terminal.state,
                "status": terminal.status,
                "status_kind": terminal.status_kind,
                "program": terminal.program,
                "reason": terminal.reason,
                "turn": terminal.turn,
                "reported": terminal.reported,
                "recovered_shell": terminal.recovered_shell(),
                "labels": terminal.labels.iter().cloned().collect::<std::collections::BTreeMap<_, _>>(),
            })
        })
        .collect::<Vec<_>>();
    let value = json!({
        "schema": "aven-dispatch-terminals/v1",
        "observed_at": now_ms(),
        "core": {
            "id": core.id,
            "name": core.name,
            "version": core.version,
            "machine": core.machine,
        },
        "terminals": terminals,
    });
    write_atomic(&inventory_path(store), &serde_json::to_vec(&value)?)
}

/// Refresh the inventory from herdr-core. A missing core is not fatal; it is
/// recorded as an unavailable observation rather than stale success.
pub(crate) fn refresh_inventory(store: &Path) -> Result<()> {
    let core = core::identity()?;
    let terminals = core::snapshot(&[("aven.dispatch".into(), "1".into())])?;
    write_inventory(store, &core, &terminals)
}

/// Roles that currently claim a terminal in this attempt. Used by the watcher
/// to correlate a core fact with persisted ownership, never to infer that a
/// task or phase succeeded.
pub(crate) fn attempt_terminal_roles(
    attempt: &Attempt,
) -> Vec<(String, crate::model::TerminalRef)> {
    let mut roles = Vec::new();
    if !attempt.terminal.is_empty() {
        roles.push(("builder".into(), attempt.terminal.clone()));
    }
    if !attempt.coordinator_terminal.is_empty() {
        roles.push(("coordinator".into(), attempt.coordinator_terminal.clone()));
    }
    if !attempt.babysitter_terminal.is_empty() {
        roles.push(("babysitter".into(), attempt.babysitter_terminal.clone()));
    }
    for phase in &attempt.phases {
        if !phase.terminal.is_empty() {
            roles.push((format!("phase:{}", phase.task_id), phase.terminal.clone()));
        }
    }
    roles
}

pub(crate) fn find_attempt_for_terminal<'a>(
    store: &'a Store,
    core_id: &str,
    address: &str,
) -> Vec<(&'a Attempt, Vec<String>)> {
    let mut matches = Vec::new();
    for attempt in store.attempts.values() {
        let roles = attempt_terminal_roles(attempt)
            .into_iter()
            .filter(|(_, terminal)| terminal.address == address && terminal.matches_core(core_id))
            .map(|(role, _)| role)
            .collect::<Vec<_>>();
        if !roles.is_empty() {
            matches.push((attempt, roles));
        }
    }
    matches
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
