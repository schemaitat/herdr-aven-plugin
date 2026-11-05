//! Bounded, non-mutating dispatcher-store reader for inspector sources.

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension};
use std::{path::Path, time::Duration};

use super::SCHEMA_VERSION;

/// Read dispatcher attempt payloads without creating directories, configuring
/// SQLite or migrating the schema. Inspector paths must never enter
/// [`LockedStore::open`].
pub(crate) fn read_only_store_payloads(path: &Path, limit: usize) -> Result<Vec<String>> {
    if !path.exists() {
        bail!("dispatcher store {} does not exist", path.display());
    }
    if !path.is_file() {
        bail!("dispatcher store {} is not a file", path.display());
    }
    let connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open dispatcher store {} read-only", path.display()))?;
    connection.busy_timeout(Duration::from_millis(1000))?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        bail!(
            "dispatcher store schema version {version} is newer than supported version {SCHEMA_VERSION}"
        );
    }
    if version == 0 {
        let table: Option<String> = connection
            .query_row(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attempts'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if table.is_none() {
            bail!("dispatcher store schema version 0 has no attempts table");
        }
    }
    let mut statement = connection
        .prepare("SELECT payload FROM attempts ORDER BY created_at, task_id, workflow LIMIT ?1")?;
    let rows = statement.query_map([(limit + 1) as i64], |row| row.get::<_, String>(0))?;
    let mut payloads = Vec::new();
    for row in rows {
        payloads.push(row?);
        if payloads.len() > limit {
            bail!("dispatcher store exceeds the {limit}-attempt limit");
        }
    }
    Ok(payloads)
}

/// Read the durable effect journal without configuring or migrating SQLite.
pub(crate) fn read_only_effects(
    path: &Path,
    limit: usize,
) -> Result<Vec<crate::model::EffectRecord>> {
    if !path.exists() {
        bail!("dispatcher store {} does not exist", path.display());
    }
    let connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open dispatcher store {} read-only", path.display()))?;
    connection.busy_timeout(Duration::from_millis(1000))?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > SCHEMA_VERSION {
        bail!(
            "dispatcher store schema version {version} is newer than supported version {SCHEMA_VERSION}"
        );
    }
    if version < 2 {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(
        "SELECT scope, task_id, task_ref, workflow, attempt_id, operation_id, kind, state, payload, generation, revision, created_at, updated_at FROM effects ORDER BY created_at LIMIT ?1",
    )?;
    let rows = statement.query_map([(limit + 1) as i64], |row| {
        Ok(crate::model::EffectRecord {
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
    let mut effects = Vec::new();
    for row in rows {
        effects.push(row?);
        if effects.len() > limit {
            bail!("dispatcher effect journal exceeds the {limit}-record limit");
        }
    }
    Ok(effects)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn malformed_and_newer_stores_do_not_panic_or_create_files() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.sqlite");
        assert!(read_only_store_payloads(&missing, 10).is_err());
        assert!(!missing.exists());
        let newer = directory.path().join("newer.sqlite");
        let connection = Connection::open(&newer).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);
        assert!(read_only_store_payloads(&newer, 10).is_err());
        let malformed = directory.path().join("malformed.sqlite");
        fs::write(&malformed, b"not sqlite").unwrap();
        assert!(read_only_store_payloads(&malformed, 10).is_err());
    }
}
