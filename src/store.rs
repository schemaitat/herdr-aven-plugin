//! Durable dispatcher SQLite persistence and explicitly read-only access.

pub(crate) mod read_only;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{collections::BTreeSet, env, ffi::OsStr, fs, path::PathBuf, time::Duration};

use crate::model::{Attempt, Store, attempt_key};
use crate::process::now;

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
    #[cfg(test)]
    transactions: usize,
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
                let attempt = crate::model::normalize_attempt(attempt);
                store
                    .attempts
                    .insert(attempt_key(&attempt.task_id, &attempt.workflow), attempt);
            }
        }
        Ok(Self {
            connection,
            store,
            dirty: BTreeSet::new(),
            #[cfg(test)]
            transactions: 0,
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
                upsert_attempt(&mut statement, attempt, updated_at)?;
            }
        }
        transaction.commit()?;
        #[cfg(test)]
        {
            self.transactions += 1;
        }
        self.dirty.clear();
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn transaction_count(&self) -> usize {
        self.transactions
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
            upsert_attempt(&mut statement, &attempt, now())?;
        }
        transaction.commit()?;
        self.put(attempt);
        Ok(None)
    }
    /// Remove exactly one reserved attempt after a failed provisioning step.
    pub(crate) fn remove_attempt(&mut self, task_id: &str, workflow: &str) -> Result<usize> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let removed = transaction.execute(
            "DELETE FROM attempts WHERE task_id = ?1 AND workflow = ?2",
            params![task_id, workflow],
        )?;
        transaction.commit()?;
        let key = attempt_key(task_id, workflow);
        self.store.attempts.remove(&key);
        self.dirty.remove(&key);
        Ok(removed)
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
/// Bind an attempt consistently for both initial reservations and later checkpoints.
/// The callers deliberately retain their separate transaction boundaries.
fn upsert_attempt(
    statement: &mut rusqlite::Statement<'_>,
    attempt: &Attempt,
    updated_at: u64,
) -> Result<()> {
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
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ExecutionMode, Invocation, TerminalRef};
    use std::collections::BTreeMap;

    fn stored_attempt(task_id: &str, workflow: &str, state: &str) -> Attempt {
        Attempt {
            task_id: task_id.into(),
            task_ref: format!("APP-{}", task_id.to_uppercase()),
            workflow: workflow.into(),
            attempt_id: format!("att_{task_id}_{workflow}"),
            branch: format!("app/dispatch-{task_id}"),
            worktree: String::new(),
            worktree_created_by_attempt: false,
            backend: "hc".into(),
            core_id: String::new(),
            core_name: String::new(),
            terminal: TerminalRef::default(),
            pane: String::new(),
            aven_panel: false,
            agent: String::new(),
            model: String::new(),
            execution_mode: ExecutionMode::SingleSession,
            coordinator_session_id: String::new(),
            coordinator_agent: String::new(),
            coordinator_model: String::new(),
            coordinator_terminal: TerminalRef::default(),
            auto_permissions: false,
            phases: Vec::new(),
            terminals: BTreeMap::new(),
            last_event_seq: 0,
            session_id: format!("ses_{task_id}"),
            prompt_id: String::new(),
            pending_prompt: String::new(),
            state: state.into(),
            aven_update_pending: false,
            log_cursor: String::new(),
            log_task_ref: String::new(),
            generation: 0,
            babysitter: false,
            babysitter_model: String::new(),
            babysitter_terminal: TerminalRef::default(),
            babysitter_pane: String::new(),
            babysitter_session_id: String::new(),
            babysitter_prompt_id: String::new(),
            aven: Invocation {
                aven_exe: String::new(),
                db_path: None,
                workspace: None,
                origin_cwd: String::new(),
            },
            created_at: now(),
        }
    }

    #[test]
    fn sqlite_store_persists_and_removes_attempts() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("dispatch.sqlite");
        let mut store = LockedStore::open(state.clone()).unwrap();
        store_attempt(
            &mut store,
            stored_attempt("task-one", "planning", "running"),
        );
        store.save().unwrap();
        drop(store);
        let mut reopened = LockedStore::open(state.clone()).unwrap();
        assert_eq!(
            reopened.store.attempts[&attempt_key("task-one", "planning")].state,
            "running"
        );
        assert_eq!(reopened.remove_attempts_for_task("task-one").unwrap(), 1);
        reopened.save().unwrap();
        drop(reopened);
        assert!(LockedStore::open(state).unwrap().store.attempts.is_empty());
    }

    #[test]
    fn sqlite_store_reserves_task_workflow_atomically() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("dispatch.sqlite");
        let mut first = LockedStore::open(state.clone()).unwrap();
        assert!(
            first
                .reserve(stored_attempt(
                    "task-one",
                    "implementation",
                    "session-pending"
                ))
                .unwrap()
                .is_none()
        );
        first.save().unwrap();
        let mut second = LockedStore::open(state).unwrap();
        assert_eq!(
            second
                .reserve(stored_attempt(
                    "task-one",
                    "implementation",
                    "session-pending"
                ))
                .unwrap()
                .unwrap()
                .task_id,
            "task-one"
        );
        assert!(
            second
                .reserve(stored_attempt("task-one", "planning", "session-pending"))
                .unwrap()
                .is_none()
        );
        assert_eq!(second.store.attempts.len(), 2);
    }

    #[test]
    fn sqlite_store_allows_concurrent_different_task_dispatch() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("dispatch.sqlite");
        let mut first = LockedStore::open(state.clone()).unwrap();
        let mut second = LockedStore::open(state.clone()).unwrap();
        assert!(
            first
                .reserve(stored_attempt(
                    "task-one",
                    "implementation",
                    "session-pending"
                ))
                .unwrap()
                .is_none()
        );
        assert!(
            second
                .reserve(stored_attempt(
                    "task-two",
                    "implementation",
                    "session-pending"
                ))
                .unwrap()
                .is_none()
        );
        first.save().unwrap();
        second.save().unwrap();
        drop((first, second));
        let store = LockedStore::open(state).unwrap();
        assert_eq!(store.store.attempts.len(), 2);
        assert!(
            store
                .store
                .attempts
                .contains_key(&attempt_key("task-one", "implementation"))
        );
        assert!(
            store
                .store
                .attempts
                .contains_key(&attempt_key("task-two", "implementation"))
        );
    }

    #[test]
    fn sqlite_store_refuses_a_newer_schema_version() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("dispatch.sqlite");
        let connection = Connection::open(&state).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);
        assert!(LockedStore::open(state).is_err());
    }

    #[test]
    fn central_store_path_is_xdg_compatible() {
        assert_eq!(
            default_store_path(Some(OsStr::new("/state")), Some(OsStr::new("/home/u"))),
            PathBuf::from("/state/aven/dispatch.sqlite")
        );
        assert_eq!(
            default_store_path(None, Some(OsStr::new("/home/u"))),
            PathBuf::from("/home/u/.local/state/aven/dispatch.sqlite")
        );
        assert_eq!(
            store_path(Some(PathBuf::from("/custom/dispatch.sqlite"))),
            PathBuf::from("/custom/dispatch.sqlite")
        );
    }
}
