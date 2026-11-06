//! Supervision attempt selection.

use crate::{
    core,
    dispatch::{
        aven::{
            ensure_attempt_current, ensure_log_task, refresh_task_by_ref, write_aven_links,
            write_debug_event,
        },
        phases::advance_worktree_phases,
        reset::{
            attempt_session_ids, interrupt_and_drain_sessions, refresh_attempt_execution_state,
        },
    },
    model::{Attempt, ExecutionMode, attempt_is_legacy, attempt_key},
    process::{opencode, opencode_text},
    store::{LockedStore, store_attempt},
    watch,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) fn find_attempt<'a>(
    store: &'a LockedStore,
    task: &str,
    workflow: Option<&str>,
) -> Result<&'a Attempt> {
    let matches = store
        .store
        .attempts
        .values()
        .filter(|a| {
            (a.task_id == task || a.task_ref == task)
                && workflow.is_none_or(|workflow| a.workflow == workflow)
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => bail!("no dispatcher attempt for task"),
        [attempt] => Ok(*attempt),
        _ => bail!("multiple dispatcher workflows exist for {task}; retry with --workflow <name>"),
    }
}

// Read-only task status command.
pub(crate) fn status(path: PathBuf, task: &str, workflow: Option<&str>) -> Result<()> {
    let store = LockedStore::open(path)?;
    let attempt = find_attempt(&store, task, workflow)?;
    let snapshot = opencode("GET", &format!("/api/session/{}", attempt.session_id), None)?;
    let permissions = opencode(
        "GET",
        &format!("/api/session/{}/permission", attempt.session_id),
        None,
    )?;
    let forms = opencode(
        "GET",
        &format!("/api/session/{}/form", attempt.session_id),
        None,
    )?;
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"attempt": attempt, "session": snapshot, "pending_permissions": permissions, "pending_forms": forms})
        )?
    );
    Ok(())
}

const SUMMARY_DEFAULT_LIMIT: usize = 500;
const LIST_LIMIT_MAX: usize = 2_000;

fn list_limit(limit: Option<usize>) -> Result<usize> {
    let limit = limit.unwrap_or(SUMMARY_DEFAULT_LIMIT);
    if limit == 0 || limit > LIST_LIMIT_MAX {
        bail!("list limit must be between 1 and {LIST_LIMIT_MAX}");
    }
    Ok(limit)
}

fn summary_values(attempts: &[Attempt]) -> Result<Vec<Value>> {
    attempts
        .iter()
        .map(|attempt| {
            let mut value = serde_json::to_value(attempt)?;
            if let Some(object) = value.as_object_mut() {
                object.remove("pending_prompt");
                object.remove("aven");
            }
            Ok(value)
        })
        .collect()
}

// Supervisor attempt list command. Summary reads are bounded, read-only and
// prompt-free; exceeding the cap is an error instead of silent truncation.
pub(crate) fn list(
    path: PathBuf,
    running: bool,
    limit: Option<usize>,
    summary: bool,
) -> Result<()> {
    if summary && !running {
        let limit = list_limit(limit)?;
        let payloads = if path.exists() {
            crate::store::read_only::read_only_store_payloads(&path, limit)?
        } else {
            Vec::new()
        };
        let attempts = payloads
            .into_iter()
            .map(|payload| {
                serde_json::from_str::<Attempt>(&payload).context("invalid attempt payload")
            })
            .collect::<Result<Vec<_>>>()?;
        println!(
            "{}",
            serde_json::to_string_pretty(&summary_values(&attempts)?)?
        );
        return Ok(());
    }

    let mut store = LockedStore::open(path)?;
    let mut attempts = store.store.attempts.values().cloned().collect::<Vec<_>>();
    if running {
        for attempt in &mut attempts {
            refresh_attempt_execution_state(attempt, None)?;
            store_attempt(&mut store, attempt.clone());
        }
        store.save()?;
        attempts.retain(|attempt| {
            matches!(
                attempt.state.as_str(),
                "running"
                    | "waiting"
                    | "workspace-pending"
                    | "session-pending"
                    | "terminal-pending"
                    | "prompt-pending"
                    | "babysitter-session-pending"
                    | "babysitter-prompt-pending"
            )
        });
    }
    if let Some(limit) = limit {
        let limit = list_limit(Some(limit))?;
        if summary && attempts.len() > limit {
            bail!("dispatcher store exceeds the {limit}-attempt limit");
        }
        attempts.truncate(limit);
    } else if summary && attempts.len() > SUMMARY_DEFAULT_LIMIT {
        bail!("dispatcher store exceeds the {SUMMARY_DEFAULT_LIMIT}-attempt limit");
    }
    if summary {
        println!(
            "{}",
            serde_json::to_string_pretty(&summary_values(&attempts)?)?
        );
    } else {
        println!("{}", serde_json::to_string_pretty(&attempts)?);
    }
    Ok(())
}

// Supervisor interruption command.
pub(crate) fn interrupt(path: PathBuf, task: &str, workflow: Option<&str>) -> Result<()> {
    let mut store = LockedStore::open(path.clone())?;
    let attempt = find_attempt(&store, task, workflow)?.clone();
    let sessions = attempt_session_ids(&attempt)
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    interrupt_and_drain_sessions(&sessions)?;
    let mut changed = attempt;
    changed.state = "interrupted".into();
    store_attempt(&mut store, changed);
    store.save()?;
    println!("interrupted owned OpenCode execution sessions; Aven task status was not changed");
    Ok(())
}

// Reconciliation commands and watcher-owned observation helpers.
pub(crate) fn reconcile_attempt(store: &mut LockedStore, mut attempt: Attempt) -> Result<Attempt> {
    let task = refresh_task_by_ref(&attempt.aven, &attempt.task_ref)?;
    // Reconciliation may repair metadata for terminal tasks, but it must
    // never re-admit a saved prompt for one. Reopening is a separate reviewed
    // Aven transition plus a fresh fenced generation.
    crate::dispatch::lifecycle::ensure_pending_admission_open(&task, &attempt)?;
    ensure_attempt_current(&task, &attempt)?;
    refresh_attempt_execution_state(&mut attempt, Some(&task))?;
    // Log closure follows proven execution termination, never source
    // acceptance alone. Failure leaves the log visibly open.
    if let Err(error) = crate::dispatch::disposition::reconcile_log(&mut attempt, store) {
        eprintln!(
            "log reconciliation for {} remains pending: {error:#}",
            attempt.task_ref
        );
    }
    // Stage authoritative execution state even when no Aven repair is due;
    // task acceptance remains exclusively under the task workflow. Callers
    // flush the staged attempts once for the whole reconciliation pass.
    store_attempt(store, attempt.clone());
    if attempt.execution_mode == ExecutionMode::Worktrees
        && advance_worktree_phases(&mut attempt, store)?
    {
        store_attempt(store, attempt.clone());
        println!("advanced cumulative worktree phases");
    }
    if !attempt.aven_update_pending
        && !crate::dispatch::aven::aven_snapshot_matches(&task, &attempt)?
    {
        attempt.aven_update_pending = true;
        store_attempt(store, attempt.clone());
    }
    if attempt.aven_update_pending {
        match write_aven_links(&attempt.aven, &attempt, store) {
            Ok(()) => {
                attempt.aven_update_pending = false;
                store_attempt(store, attempt.clone());
                println!("repaired pending Aven status, metadata, and handoff update");
            }
            Err(error) => {
                attempt.aven_update_pending = true;
                store_attempt(store, attempt.clone());
                eprintln!("pending Aven update remains visibly pending: {error:#}");
            }
        }
    }
    let log = opencode_text(
        "GET",
        &format!(
            "/api/experimental/session/{}/log?after={}&follow=false",
            attempt.session_id, attempt.log_cursor
        ),
        None,
    );
    if let Ok(events) = log
        && let Some(cursor) = events
            .lines()
            .filter_map(|line| line.strip_prefix("id: "))
            .next_back()
    {
        attempt.log_cursor = cursor.to_owned();
        store_attempt(store, attempt.clone());
        println!("replayed durable session log through cursor {cursor}");
    }
    Ok(attempt)
}

pub(crate) fn reconcile(path: PathBuf, task: &str, workflow: Option<&str>) -> Result<()> {
    let mut store = LockedStore::open(path)?;
    let attempt = find_attempt(&store, task, workflow)?.clone();
    let result = reconcile_attempt(&mut store, attempt);
    let flush = store.save();
    let attempt = result?;
    flush?;
    println!(
        "attempt {} state={} aven_update_pending={}",
        attempt.attempt_id, attempt.state, attempt.aven_update_pending
    );
    Ok(())
}

fn reconcile_batch<F>(
    store: &mut LockedStore,
    attempts: Vec<Attempt>,
    mut reconcile_one: F,
) -> Result<usize>
where
    F: FnMut(&mut LockedStore, Attempt) -> Result<()>,
{
    let mut reconciled = 0;
    for attempt in attempts {
        if attempt_is_legacy(&attempt) {
            continue;
        }
        match reconcile_one(store, attempt.clone()) {
            Ok(()) => reconciled += 1,
            Err(error) => eprintln!(
                "supervision left {} ({}) unchanged: {error:#}",
                attempt.task_ref, attempt.attempt_id
            ),
        }
    }
    // Flush once for the whole pass. Earlier repairs survive a later
    // attempt's Aven/OpenCode outage instead of being rolled back with it.
    store.save()?;
    Ok(reconciled)
}

/// Bounded periodic reconciliation for changes Aven/OpenCode make without a
/// core event. Stops at the first Aven/API outage instead of guessing.
pub(crate) fn reconcile_all(path: &Path) -> Result<usize> {
    let mut store = LockedStore::open(path.to_path_buf())?;
    reconcile_all_with(&mut store, path)
}

/// Reconcile every durable attempt against an already-open store so callers can
/// reuse one connection across the rest of an event batch.
pub(crate) fn reconcile_all_with(store: &mut LockedStore, path: &Path) -> Result<usize> {
    let attempts = store.store.attempts.values().cloned().collect::<Vec<_>>();
    let reconciled = reconcile_batch(store, attempts, |store, attempt| {
        reconcile_attempt(store, attempt).map(|_| ())
    })?;
    if let Err(error) = watch::refresh_inventory(path) {
        eprintln!("core inventory unavailable: {error:#}");
    }
    Ok(reconciled)
}
fn message_terminal<'a>(
    attempt: &'a Attempt,
    role: &str,
    expected_attempt_id: Option<&str>,
    expected_generation: Option<u64>,
    expected_terminal: Option<&str>,
) -> Result<&'a crate::model::TerminalRef> {
    if expected_attempt_id.is_some_and(|expected| expected != attempt.attempt_id) {
        bail!(
            "attempt ID changed for {}; expected {:?}, found {:?}; refusing to message a replacement attempt",
            attempt.task_ref,
            expected_attempt_id.unwrap_or_default(),
            attempt.attempt_id
        );
    }
    if expected_generation.is_some_and(|expected| expected != attempt.generation) {
        bail!(
            "reset generation changed for {}; expected {:?}, found {}; refusing to message a replacement attempt",
            attempt.task_ref,
            expected_generation,
            attempt.generation
        );
    }
    let terminal = match role {
        "builder" => &attempt.terminal,
        "coordinator" => &attempt.coordinator_terminal,
        "babysitter" => &attempt.babysitter_terminal,
        phase => {
            let phase = phase.strip_prefix("phase:").unwrap_or(phase);
            attempt
                .phases
                .iter()
                .find(|candidate| {
                    candidate.task_id == phase
                        || candidate.task_ref == phase
                        || candidate.task_id == format!("phase:{phase}")
                })
                .map(|candidate| &candidate.terminal)
                .context("no phase terminal for that role")?
        }
    };
    if terminal.is_empty() {
        bail!(
            "attempt {} has no herdr-core terminal for role {role}",
            attempt.attempt_id
        );
    }
    if expected_terminal.is_some_and(|expected| expected != terminal.address) {
        bail!(
            "terminal changed for {} role {role}; expected {:?}, found {:?}; refusing to message a replacement attempt",
            attempt.task_ref,
            expected_terminal.unwrap_or_default(),
            terminal.address
        );
    }
    Ok(terminal)
}

pub(crate) fn message(
    path: PathBuf,
    task: &str,
    workflow: Option<&str>,
    role: &str,
    text: &str,
    expected_attempt_id: Option<&str>,
    expected_generation: Option<u64>,
    expected_terminal: Option<&str>,
    wait: bool,
) -> Result<()> {
    // Keep the store lock through validation and send so a reset/re-dispatch
    // cannot replace the selected attempt between the check and the effect.
    let store = LockedStore::open(path)?;
    let attempt = find_attempt(&store, task, workflow)?;
    let terminal = message_terminal(
        attempt,
        role,
        expected_attempt_id,
        expected_generation,
        expected_terminal,
    )?;
    let core = core::identity()?;
    if !terminal.matches_core(&core.id) {
        bail!(
            "terminal {} belongs to a different herdr-core identity; inspect before messaging",
            terminal.address
        );
    }
    let result = core::send_if_idle(&terminal.address, text, wait)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

pub(crate) fn apply_terminal_fact(
    store: &mut LockedStore,
    core: &core::CoreIdentity,
    terminal: &core::Terminal,
    kind: &str,
    seq: u64,
) -> Result<Vec<String>> {
    let matches = watch::find_attempt_for_terminal(&store.store, &core.id, &terminal.address)
        .into_iter()
        .map(|(attempt, roles)| (attempt_key(&attempt.task_id, &attempt.workflow), roles))
        .collect::<Vec<_>>();
    let mut keys = Vec::new();
    for (key, roles) in matches {
        let Some(mut attempt) = store.store.attempts.get(&key).cloned() else {
            continue;
        };
        let recovery = match kind {
            "finished" => "finished",
            "lost" => "lost",
            "removed" => "removed",
            "restarted" if terminal.recovered_shell() => "recovered-shell",
            _ if terminal.recovered_shell() => "recovered-shell",
            "snapshot" if terminal.state == "finished" && terminal.reason == "holder_lost" => {
                "lost"
            }
            "snapshot" if terminal.state == "finished" => "finished",
            _ => "",
        };
        for role in roles {
            attempt
                .terminals
                .insert(role, terminal.observe(core, seq, recovery));
        }
        attempt.core_id = core.id.clone();
        attempt.core_name = core.name.clone();
        attempt.last_event_seq = attempt.last_event_seq.max(seq);
        store_attempt(store, attempt);
        keys.push(key);
    }
    if !keys.is_empty() {
        store.save()?;
    }
    Ok(keys)
}

pub(crate) fn reconcile_keys(store: &mut LockedStore, keys: &[String]) {
    let attempts = keys
        .iter()
        .filter_map(|key| store.store.attempts.get(key).cloned())
        .collect();
    if let Err(error) = reconcile_batch(store, attempts, |store, attempt| {
        reconcile_attempt(store, attempt).map(|_| ())
    }) {
        eprintln!("supervision batch reconciliation failed: {error:#}");
    }
}

pub(crate) fn watch_command(
    path: PathBuf,
    once: bool,
    stop: bool,
    status: bool,
    interval: u64,
    reconcile_all_flag: bool,
) -> Result<()> {
    if status {
        println!("{}", serde_json::to_string_pretty(&watch::status(&path))?);
        return Ok(());
    }
    if stop {
        println!("{}", watch::stop(&path)?);
        return Ok(());
    }
    if once || reconcile_all_flag {
        let reconciled = reconcile_all(&path)?;
        println!("reconciled {reconciled} dispatch attempt(s)");
        return Ok(());
    }
    let mut guard = watch::WatcherGuard::acquire(&path)?;
    let core = core::identity()?;
    guard.state.core_id = core.id.clone();
    guard.state.core_name = core.name.clone();
    watch::write_state(&path, &guard.state)?;
    let labels = vec![("aven.dispatch".to_string(), "1".to_string())];
    let mut stream: Option<core::EventStream> = None;
    let mut last_periodic = std::time::Instant::now();
    let interval = interval.max(15);
    loop {
        if stream.is_none() {
            match core::EventStream::subscribe(&labels) {
                Ok(next) => stream = Some(next),
                Err(error) => {
                    guard.error(&path, &format!("subscribe failed: {error:#}"))?;
                    eprintln!("watcher could not subscribe to herdr-core events: {error:#}");
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
            }
        }
        let event = match stream.as_mut() {
            Some(stream) => stream.next(),
            None => Ok(None),
        };
        match event {
            Ok(Some(core::EventLine::Snapshot { seq, terminals })) => {
                let mut store = LockedStore::open(path.clone())?;
                let mut keys = Vec::new();
                for value in terminals {
                    if let Ok(terminal) = core::get(
                        value
                            .get("address")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    ) {
                        keys.extend(apply_terminal_fact(
                            &mut store, &core, &terminal, "snapshot", seq,
                        )?);
                    }
                }
                reconcile_keys(&mut store, &keys);
                // Reconcile every durable attempt from the initial snapshot so
                // a terminated phase or lost terminal surfaces even when it is
                // no longer part of the live subscription.
                let _ = reconcile_all_with(&mut store, &path);
                guard.state.last_seq = seq;
                guard.record(&path, "snapshot")?;
            }
            Ok(Some(core::EventLine::Notification {
                seq,
                terminal,
                kind,
                data,
            })) => {
                let observed = core::get(&terminal).unwrap_or_else(|_| core::Terminal {
                    address: terminal.clone(),
                    name: String::new(),
                    state: if kind == "removed" {
                        "removed".into()
                    } else {
                        "unknown".into()
                    },
                    status: data
                        .pointer("/status/state")
                        .or_else(|| data.pointer("/state"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    status_kind: data
                        .pointer("/status/kind")
                        .or_else(|| data.pointer("/kind"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    program: data
                        .pointer("/foreground/name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    reason: data
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    turn: data.get("turn").and_then(Value::as_u64).unwrap_or_default(),
                    labels: Vec::new(),
                    reported: false,
                });
                let mut store = LockedStore::open(path.clone())?;
                let keys = apply_terminal_fact(&mut store, &core, &observed, &kind, seq)?;
                if !matches!(kind.as_str(), "foreground" | "size" | "doc" | "title") {
                    reconcile_keys(&mut store, &keys);
                }
                guard.state.last_seq = seq;
                if matches!(
                    kind.as_str(),
                    "created" | "finished" | "lost" | "restarted" | "removed"
                ) {
                    guard.record(&path, &kind)?;
                }
            }
            Ok(Some(core::EventLine::Missed { seq, terminals })) => {
                // Never trust a partial stream: drop it, record the gap, and
                // start again from a fresh snapshot.
                guard.state.gaps = guard.state.gaps.saturating_add(1);
                guard.state.last_seq = seq;
                guard.error(
                    &path,
                    &format!("missed events through seq {seq}; resubscribing"),
                )?;
                let _ = terminals;
                stream = None;
                let _ = reconcile_all(&path);
            }
            Ok(Some(core::EventLine::Heartbeat)) => {}
            Ok(None) => {
                stream = None;
                guard.error(&path, "herdr-core event stream ended; reconnecting")?;
                let _ = reconcile_all(&path);
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(error) => {
                stream = None;
                guard.error(&path, &format!("event stream error: {error:#}"))?;
                eprintln!("watcher event stream error: {error:#}");
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        if last_periodic.elapsed() >= Duration::from_secs(interval) {
            let _ = reconcile_all(&path);
            guard.record(&path, "periodic")?;
            last_periodic = std::time::Instant::now();
        }
    }
}

// Durable dispatcher event logging.
pub(crate) fn log_event(
    path: PathBuf,
    task: &str,
    workflow: Option<&str>,
    event: &str,
    detail: &str,
) -> Result<()> {
    let mut store = LockedStore::open(path)?;
    let mut attempt = find_attempt(&store, task, workflow)?.clone();
    ensure_log_task(&mut attempt, &mut store)?;
    let record = write_debug_event(&attempt, event, detail);
    store_attempt(&mut store, attempt.clone());
    store.save()?;
    println!(
        "logged {event} for {} in {}",
        attempt.task_ref, attempt.log_task_ref
    );
    if let Some(record) = record {
        println!("{}", serde_json::to_string(&record)?);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_attempt(task_id: &str) -> Attempt {
        serde_json::from_value(json!({
            "task_id": task_id,
            "task_ref": format!("APP-{}", task_id.to_uppercase()),
            "workflow": "implementation",
            "attempt_id": format!("att_{task_id}"),
            "branch": format!("app/{task_id}"),
            "worktree": "",
            "prompt_id": "",
            "state": "running",
            "aven": {"aven_exe": "", "db_path": null, "workspace": null, "origin_cwd": ""},
            "created_at": 0
        }))
        .unwrap()
    }

    #[test]
    fn message_identity_expectations_fail_before_a_terminal_can_be_used() {
        let mut attempt = test_attempt("task-one");
        attempt.attempt_id = "att-new".into();
        attempt.generation = 2;
        attempt.terminal.core_id = "core".into();
        attempt.terminal.address = "t-new".into();

        let replaced =
            message_terminal(&attempt, "builder", Some("att-old"), Some(2), Some("t-new"))
                .unwrap_err()
                .to_string();
        assert!(replaced.contains("attempt ID changed"));
        let generation =
            message_terminal(&attempt, "builder", Some("att-new"), Some(1), Some("t-new"))
                .unwrap_err()
                .to_string();
        assert!(generation.contains("reset generation changed"));
        let terminal =
            message_terminal(&attempt, "builder", Some("att-new"), Some(2), Some("t-old"))
                .unwrap_err()
                .to_string();
        assert!(terminal.contains("terminal changed"));
        assert_eq!(
            message_terminal(&attempt, "builder", Some("att-new"), Some(2), Some("t-new"))
                .unwrap()
                .address,
            "t-new"
        );
    }

    #[test]
    fn summary_values_omit_prompt_and_invocation_details() {
        let mut attempt = test_attempt("task-one");
        attempt.pending_prompt = "SECRET PROMPT".into();
        attempt.aven.origin_cwd = "/private/checkout".into();
        let values = summary_values(&[attempt]).unwrap();
        let serialized = serde_json::to_string(&values).unwrap();
        assert!(!serialized.contains("SECRET PROMPT"));
        assert!(!serialized.contains("/private/checkout"));
        assert!(values[0].get("pending_prompt").is_none());
        assert!(values[0].get("aven").is_none());
    }

    #[test]
    fn running_list_excludes_non_running_attempts() {
        let attempts = ["running", "interrupted"];
        assert_eq!(
            attempts.iter().filter(|state| **state == "running").count(),
            1
        );
    }

    #[test]
    fn batch_reconcile_flushes_once_and_keeps_partial_repairs() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("dispatch.sqlite");
        let mut store = LockedStore::open(path.clone()).unwrap();
        store_attempt(&mut store, test_attempt("task-one"));
        store_attempt(&mut store, test_attempt("task-two"));
        store.save().unwrap();
        let transactions = store.transaction_count();

        let attempts = store.store.attempts.values().cloned().collect::<Vec<_>>();
        let reconciled = reconcile_batch(&mut store, attempts, |store, mut attempt| {
            if attempt.task_id == "task-two" {
                bail!("simulated Aven outage");
            }
            attempt.state = "reconciled".into();
            store_attempt(store, attempt);
            Ok(())
        })
        .unwrap();

        assert_eq!(reconciled, 1);
        assert_eq!(store.transaction_count() - transactions, 1);

        let after_pass = store.transaction_count();
        assert_eq!(
            reconcile_batch(&mut store, Vec::new(), |_, _| Ok(())).unwrap(),
            0
        );
        assert_eq!(store.transaction_count(), after_pass);

        drop(store);
        let reopened = LockedStore::open(path).unwrap();
        assert_eq!(
            reopened.store.attempts[&attempt_key("task-one", "implementation")].state,
            "reconciled"
        );
        assert_eq!(
            reopened.store.attempts[&attempt_key("task-two", "implementation")].state,
            "running"
        );
    }
}
