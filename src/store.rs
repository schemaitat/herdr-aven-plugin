//! Durable dispatcher SQLite persistence and explicitly read-only access.

pub(crate) mod read_only;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use std::{collections::BTreeSet, env, ffi::OsStr, fs, path::PathBuf, time::Duration};

use crate::model::{Attempt, EffectRecord, Store, attempt_key};
use crate::process::now;

pub(crate) const SCHEMA_VERSION: i64 = 2;
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
const UPSERT_EFFECT: &str = "INSERT INTO effects (scope, task_id, task_ref, workflow, attempt_id, operation_id, kind, state, payload, generation, revision, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(task_id, workflow, operation_id) DO UPDATE SET
       scope = excluded.scope,
       task_ref = excluded.task_ref,
       attempt_id = excluded.attempt_id,
       kind = excluded.kind,
       state = excluded.state,
       payload = excluded.payload,
       generation = excluded.generation,
       revision = excluded.revision,
       updated_at = excluded.updated_at";

pub(crate) fn effect_key(task_id: &str, workflow: &str, operation_id: &str) -> String {
    format!("{task_id}:{workflow}:{operation_id}")
}

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
    dirty_effects: BTreeSet<String>,
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
        {
            let mut statement = connection.prepare(
                "SELECT scope, task_id, task_ref, workflow, attempt_id, operation_id, kind, state, payload, generation, revision, created_at, updated_at FROM effects ORDER BY created_at, task_id, workflow, operation_id",
            )?;
            let rows = statement.query_map([], |row| {
                Ok(EffectRecord {
                    scope: row.get(0)?,
                    task_id: row.get(1)?,
                    task_ref: row.get(2)?,
                    workflow: row.get(3)?,
                    attempt_id: row.get(4)?,
                    operation_id: row.get(5)?,
                    kind: row.get(6)?,
                    state: row.get(7)?,
                    payload: row.get(8)?,
                    generation: row.get::<_, i64>(9)? as u64,
                    revision: row.get::<_, i64>(10)? as u64,
                    created_at: row.get::<_, i64>(11)? as u64,
                    updated_at: row.get::<_, i64>(12)? as u64,
                })
            })?;
            for row in rows {
                let effect = row?;
                store.effects.insert(
                    effect_key(&effect.task_id, &effect.workflow, &effect.operation_id),
                    effect,
                );
            }
        }
        Ok(Self {
            connection,
            store,
            dirty: BTreeSet::new(),
            dirty_effects: BTreeSet::new(),
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
        if self.dirty.is_empty() && self.dirty_effects.is_empty() {
            return Ok(());
        }
        let keys = self.dirty.iter().cloned().collect::<Vec<_>>();
        let effect_keys = self.dirty_effects.iter().cloned().collect::<Vec<_>>();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let updated_at = now();
        {
            let mut statement = transaction.prepare_cached(UPSERT_ATTEMPT)?;
            for key in &keys {
                let Some(attempt) = self.store.attempts.get(key) else {
                    continue;
                };
                upsert_attempt(&mut statement, attempt, updated_at)?;
            }
        }
        {
            let mut statement = transaction.prepare_cached(UPSERT_EFFECT)?;
            for key in &effect_keys {
                let Some(effect) = self.store.effects.get(key) else {
                    continue;
                };
                upsert_effect(&mut statement, effect)?;
            }
        }
        transaction.commit()?;
        #[cfg(test)]
        {
            self.transactions += 1;
        }
        self.dirty.clear();
        self.dirty_effects.clear();
        Ok(())
    }

    fn put_effect(&mut self, effect: EffectRecord) {
        let key = effect_key(&effect.task_id, &effect.workflow, &effect.operation_id);
        self.dirty_effects.insert(key.clone());
        self.store.effects.insert(key, effect);
    }

    /// Record durable intent before an external effect. Returns the existing
    /// record when the same logical operation was already started.
    pub(crate) fn begin_effect(&mut self, mut effect: EffectRecord) -> EffectRecord {
        let key = effect_key(&effect.task_id, &effect.workflow, &effect.operation_id);
        if let Some(existing) = self.store.effects.get(&key) {
            return existing.clone();
        }
        if effect.created_at == 0 {
            effect.created_at = now();
        }
        effect.updated_at = now();
        self.put_effect(effect.clone());
        effect
    }

    /// Mark a journaled effect completed only after read-back succeeded.
    pub(crate) fn complete_effect(&mut self, effect: &EffectRecord, payload: Option<&str>) {
        let key = effect_key(&effect.task_id, &effect.workflow, &effect.operation_id);
        if let Some(existing) = self.store.effects.get_mut(&key) {
            existing.state = "completed".into();
            existing.updated_at = now();
            if let Some(payload) = payload {
                existing.payload = payload.to_owned();
            }
            self.dirty_effects.insert(key);
        }
    }

    /// Checkpoint a structured, resumable lifecycle operation without replacing
    /// its identity or the publication intent of unrelated effects.
    pub(crate) fn checkpoint_effect(&mut self, effect: &EffectRecord, state: &str, payload: &str) {
        let mut updated = effect.clone();
        updated.state = state.to_owned();
        updated.payload = payload.to_owned();
        updated.updated_at = now();
        self.put_effect(updated);
    }

    /// Record a non-success outcome without discarding the intent. `unknown`
    /// forces inspection before this operation is retried.
    pub(crate) fn fail_effect(&mut self, effect: &EffectRecord, state: &str, detail: &str) {
        let key = effect_key(&effect.task_id, &effect.workflow, &effect.operation_id);
        if let Some(existing) = self.store.effects.get_mut(&key) {
            existing.state = state.into();
            existing.updated_at = now();
            existing.payload = detail.to_owned();
            self.dirty_effects.insert(key);
        }
    }

    pub(crate) fn effect_completed(
        &self,
        task_id: &str,
        workflow: &str,
        operation_id: &str,
    ) -> bool {
        self.store
            .effects
            .get(&effect_key(task_id, workflow, operation_id))
            .is_some_and(|effect| effect.state == "completed")
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
    /// Remove every execution record owned by one immutable task. Both attempts
    /// and their pending publication journal are deleted, including effects
    /// that outlived their attempt rows.
    pub(crate) fn remove_task_state(&mut self, task_id: &str) -> Result<(usize, usize)> {
        let attempts = self
            .store
            .attempts
            .values()
            .filter(|attempt| attempt.task_id == task_id)
            .cloned()
            .collect::<Vec<_>>();
        // Reset and delete invalidate the whole execution generation, including
        // its pending publication journal, but never Aven history.
        let effects = self
            .store
            .effects
            .values()
            .filter(|effect| effect.task_id == task_id)
            .cloned()
            .collect::<Vec<_>>();
        if attempts.is_empty() && effects.is_empty() {
            return Ok((0, 0));
        }
        if !attempts.is_empty() {
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
        }
        if !effects.is_empty() {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut statement = transaction
                    .prepare_cached("DELETE FROM effects WHERE task_id = ?1 AND workflow = ?2")?;
                for effect in &effects {
                    statement.execute(params![&effect.task_id, &effect.workflow])?;
                }
            }
            transaction.commit()?;
        }
        for effect in &effects {
            let key = effect_key(&effect.task_id, &effect.workflow, &effect.operation_id);
            self.store.effects.remove(&key);
            self.dirty_effects.remove(&key);
        }
        for attempt in &attempts {
            let key = attempt_key(&attempt.task_id, &attempt.workflow);
            self.store.attempts.remove(&key);
            self.dirty.remove(&key);
        }
        Ok((attempts.len(), effects.len()))
    }
    pub(crate) fn remove_attempts_for_task(&mut self, task_id: &str) -> Result<usize> {
        Ok(self.remove_task_state(task_id)?.0)
    }
}

fn upsert_effect(statement: &mut rusqlite::Statement<'_>, effect: &EffectRecord) -> Result<()> {
    statement.execute(params![
        &effect.scope,
        &effect.task_id,
        &effect.task_ref,
        &effect.workflow,
        &effect.attempt_id,
        &effect.operation_id,
        &effect.kind,
        &effect.state,
        &effect.payload,
        effect.generation as i64,
        effect.revision as i64,
        effect.created_at as i64,
        effect.updated_at as i64,
    ])?;
    Ok(())
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
         CREATE TABLE IF NOT EXISTS effects (
           scope TEXT NOT NULL,
           task_id TEXT NOT NULL,
           task_ref TEXT NOT NULL,
           workflow TEXT NOT NULL,
           attempt_id TEXT NOT NULL,
           operation_id TEXT NOT NULL,
           kind TEXT NOT NULL,
           state TEXT NOT NULL,
           payload TEXT NOT NULL,
           generation INTEGER NOT NULL,
           revision INTEGER NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY (task_id, workflow, operation_id)
         );
         CREATE INDEX IF NOT EXISTS effects_state ON effects(state);
         PRAGMA user_version = 2;",
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
            lifecycle: crate::model::LifecycleState::default(),
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
    fn sqlite_store_removes_effects_even_without_attempts() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("dispatch.sqlite");
        let mut store = LockedStore::open(state.clone()).unwrap();
        store.begin_effect(EffectRecord {
            scope: "default".into(),
            task_id: "task-one".into(),
            task_ref: "APP-ONE".into(),
            workflow: "implementation".into(),
            attempt_id: "att_one".into(),
            operation_id: "op_one".into(),
            kind: "aven_metadata".into(),
            state: "pending".into(),
            ..EffectRecord::default()
        });
        store.save().unwrap();
        drop(store);
        let mut reopened = LockedStore::open(state.clone()).unwrap();
        assert!(reopened.store.attempts.is_empty());
        assert_eq!(reopened.remove_task_state("task-one").unwrap(), (0, 1));
        reopened.save().unwrap();
        drop(reopened);
        assert!(LockedStore::open(state).unwrap().store.effects.is_empty());
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
