//! External command execution and the central dispatcher SQLite store.

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    env,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::model::{Attempt, Invocation, Store, attempt_key};

const SCHEMA_VERSION: i64 = 1;
const UPSERT_ATTEMPT: &str = "INSERT INTO attempts (task_id, workflow, attempt_id, task_ref, state, generation, session_id, created_at, updated_at, payload)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(task_id, workflow) DO UPDATE SET
       attempt_id = excluded.attempt_id,
       task_ref = excluded.task_ref,
       state = excluded.state,
       generation = excluded.generation,
       session_id = excluded.session_id,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       payload = excluded.payload";

pub(crate) fn store_attempt(store: &mut LockedStore, attempt: Attempt) {
    store.put(attempt);
}
pub(crate) struct LockedStore {
    connection: Connection,
    // In-memory working set for the current command. Every mutation is
    // checkpointed to SQLite by save(); rows are written individually so
    // unrelated tasks/projects never serialize or overwrite each other.
    pub(crate) store: Store,
    dirty: BTreeSet<String>,
}
impl LockedStore {
    pub(crate) fn open(path: PathBuf) -> Result<Self> {
        let parent = path.parent().context("store path has no parent")?;
        fs::create_dir_all(parent).context("create dispatcher state directory")?;
        let connection = Connection::open(&path)
            .with_context(|| format!("open dispatcher store {}", path.display()))?;
        connection.busy_timeout(Duration::from_millis(5000))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        migrate(&connection)?;
        let mut store = Store::default();
        {
            let mut statement = connection
                .prepare("SELECT payload FROM attempts ORDER BY created_at, task_id, workflow")?;
            let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
            for row in rows {
                let attempt: Attempt = serde_json::from_str(&row?)?;
                store
                    .attempts
                    .insert(attempt_key(&attempt.task_id, &attempt.workflow), attempt);
            }
        }
        Ok(Self {
            connection,
            store,
            dirty: BTreeSet::new(),
        })
    }
    fn put(&mut self, attempt: Attempt) {
        let key = attempt_key(&attempt.task_id, &attempt.workflow);
        self.dirty.insert(key.clone());
        self.store.attempts.insert(key, attempt);
    }
    pub(crate) fn save(&mut self) -> Result<()> {
        if self.dirty.is_empty() {
            return Ok(());
        }
        let keys = self.dirty.iter().cloned().collect::<Vec<_>>();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        {
            let mut statement = transaction.prepare_cached(UPSERT_ATTEMPT)?;
            let updated_at = now();
            for key in &keys {
                let Some(attempt) = self.store.attempts.get(key) else {
                    continue;
                };
                let payload = serde_json::to_string(attempt)?;
                statement.execute(params![
                    &attempt.task_id,
                    &attempt.workflow,
                    &attempt.attempt_id,
                    &attempt.task_ref,
                    &attempt.state,
                    attempt.generation as i64,
                    &attempt.session_id,
                    attempt.created_at as i64,
                    updated_at as i64,
                    payload,
                ])?;
            }
        }
        transaction.commit()?;
        self.dirty.clear();
        Ok(())
    }
    /// Atomically reserve (task_id, workflow). Returns the existing attempt when
    /// another dispatcher already owns that key.
    pub(crate) fn reserve(&mut self, attempt: Attempt) -> Result<Option<Attempt>> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT payload FROM attempts WHERE task_id = ?1 AND workflow = ?2",
                params![&attempt.task_id, &attempt.workflow],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let Some(payload) = existing {
            transaction.commit()?;
            let parsed: Attempt = serde_json::from_str(&payload)?;
            self.store.attempts.insert(
                attempt_key(&parsed.task_id, &parsed.workflow),
                parsed.clone(),
            );
            return Ok(Some(parsed));
        }
        {
            let mut statement = transaction.prepare_cached(UPSERT_ATTEMPT)?;
            let payload = serde_json::to_string(&attempt)?;
            statement.execute(params![
                &attempt.task_id,
                &attempt.workflow,
                &attempt.attempt_id,
                &attempt.task_ref,
                &attempt.state,
                attempt.generation as i64,
                &attempt.session_id,
                attempt.created_at as i64,
                now() as i64,
                payload,
            ])?;
        }
        transaction.commit()?;
        self.put(attempt);
        Ok(None)
    }
    pub(crate) fn remove_attempts_for_task(&mut self, task_id: &str) -> Result<usize> {
        let attempts = self
            .store
            .attempts
            .values()
            .filter(|attempt| attempt.task_id == task_id)
            .cloned()
            .collect::<Vec<_>>();
        if attempts.is_empty() {
            return Ok(0);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        {
            let mut statement = transaction
                .prepare_cached("DELETE FROM attempts WHERE task_id = ?1 AND workflow = ?2")?;
            for attempt in &attempts {
                statement.execute(params![&attempt.task_id, &attempt.workflow])?;
            }
        }
        transaction.commit()?;
        for attempt in &attempts {
            let key = attempt_key(&attempt.task_id, &attempt.workflow);
            self.store.attempts.remove(&key);
            self.dirty.remove(&key);
        }
        Ok(attempts.len())
    }
}
fn migrate(connection: &Connection) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        bail!(
            "dispatcher store schema version {version} is newer than supported version {SCHEMA_VERSION}"
        );
    }
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS attempts (
           task_id TEXT NOT NULL,
           workflow TEXT NOT NULL,
           attempt_id TEXT NOT NULL,
           task_ref TEXT NOT NULL,
           state TEXT NOT NULL,
           generation INTEGER NOT NULL,
           session_id TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           payload TEXT NOT NULL,
           PRIMARY KEY (task_id, workflow)
         );
         CREATE INDEX IF NOT EXISTS attempts_task_ref ON attempts(task_ref);
         PRAGMA user_version = 1;",
    )?;
    Ok(())
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn identifier(prefix: &str) -> String {
    format!("{prefix}_{:x}", now())
}
/// Resolve the one central store shared by every checkout, worktree and
/// project. `--store`/`AVEN_DISPATCH_STORE` still wins for tests and isolation.
pub(crate) fn store_path(value: Option<PathBuf>) -> PathBuf {
    value.unwrap_or_else(|| {
        default_store_path(
            env::var_os("XDG_STATE_HOME").as_deref(),
            env::var_os("HOME").as_deref(),
        )
    })
}
pub(crate) fn default_store_path(xdg_state_home: Option<&OsStr>, home: Option<&OsStr>) -> PathBuf {
    let base = xdg_state_home
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join(".local/state"))
        })
        .unwrap_or_else(|| PathBuf::from(".local/state"));
    base.join("aven/dispatch.sqlite")
}
pub(crate) fn absolute_path(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

/// Resolve a caller-provided directory to the root of its current Git
/// worktree. Dispatcher commands can be invoked from any subdirectory, while
/// Herdr workspace creation needs a stable checkout path.
pub(crate) fn repository_root(directory: &str) -> Result<String> {
    let root = run(
        "git",
        &[
            "-C".into(),
            directory.into(),
            "rev-parse".into(),
            "--show-toplevel".into(),
        ],
        None,
    )?;
    if root.is_empty() {
        bail!("Git did not return a repository root for {directory}");
    }
    Ok(root)
}

/// Resolve the repository's primary checkout. Herdr's worktree create/open
/// actions must start there even when the dispatcher runs inside a linked
/// worktree.
pub(crate) fn primary_checkout(directory: &str) -> Result<String> {
    let listing = run(
        "git",
        &[
            "-C".into(),
            directory.into(),
            "worktree".into(),
            "list".into(),
            "--porcelain".into(),
        ],
        None,
    )?;
    Ok(listing
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .map(str::to_owned)
        .unwrap_or_else(|| directory.to_owned()))
}

pub(crate) fn run_in(
    program: &str,
    args: &[String],
    input: Option<&str>,
    directory: Option<&Path>,
) -> Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    if input.is_some() {
        command.stdin(std::process::Stdio::piped());
    }
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .with_context(|| format!("start {program}"))?;
    if let Some(text) = input {
        use std::io::Write;
        child.stdin.as_mut().unwrap().write_all(text.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "{} failed: {}",
            program,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}
pub(crate) fn run(program: &str, args: &[String], input: Option<&str>) -> Result<String> {
    run_in(program, args, input, None)
}
pub(crate) fn aven_args(invocation: &Invocation, command: &[&str]) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(db) = &invocation.db_path {
        args.extend(["--db".into(), db.clone()]);
    }
    if let Some(workspace) = &invocation.workspace {
        args.extend(["--workspace".into(), workspace.clone()]);
    }
    args.extend(command.iter().map(|x| (*x).into()));
    args
}
pub(crate) fn aven(
    invocation: &Invocation,
    command: &[&str],
    input: Option<&str>,
) -> Result<String> {
    run(
        if invocation.aven_exe.is_empty() {
            "aven"
        } else {
            &invocation.aven_exe
        },
        &aven_args(invocation, command),
        input,
    )
}
pub(crate) fn opencode(method: &str, path: &str, data: Option<Value>) -> Result<Value> {
    let output = opencode_text(method, path, data)?;
    serde_json::from_str(&output).with_context(|| format!("OpenCode returned non-JSON for {path}"))
}
/// Issue an OpenCode request in a worktree's configuration scope. Session
/// creation resolves an agent before it reads the session `location`, so the
/// request itself must carry this scope for worktree-local agents.
pub(crate) fn opencode_in(
    method: &str,
    path: &str,
    data: Option<Value>,
    directory: &Path,
) -> Result<Value> {
    let output = opencode_text_in(method, path, data, Some(directory))?;
    serde_json::from_str(&output).with_context(|| format!("OpenCode returned non-JSON for {path}"))
}
pub(crate) fn opencode_text(method: &str, path: &str, data: Option<Value>) -> Result<String> {
    opencode_text_in(method, path, data, None)
}
pub(crate) fn header_value(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                vec![byte as char]
            }
            byte => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}
pub(crate) fn opencode_text_in(
    method: &str,
    path: &str,
    data: Option<Value>,
    directory: Option<&Path>,
) -> Result<String> {
    let mut args = vec!["api".into(), method.into(), path.into()];
    if let Some(directory) = directory {
        // The OpenCode CLI's working directory is not used as the API request
        // location. Scope this request explicitly so worktree-local agents
        // (including the bundled babysitter) are discovered.
        args.extend([
            "--header".into(),
            format!(
                "x-opencode-directory:{}",
                header_value(&directory.to_string_lossy())
            ),
        ]);
    }
    if let Some(data) = data {
        args.extend(["--data".into(), serde_json::to_string(&data)?]);
    }
    run_in("opencode", &args, None, directory)
}
pub(crate) fn field<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .context(pointer.to_owned())
}
