//! Explicit root-tree deletion and dispatcher-state cleanup.
//!
//! Aven deletes exactly one task at a time. A root epic owns phase children,
//! and the dispatcher store keeps attempts/effects keyed by immutable task IDs,
//! so deleting the root alone would leave both behind. This command inventories
//! the descendant tree first, deletes leaves before parents, and only after
//! every Aven delete succeeds removes the matching execution records. It never
//! touches branches, worktrees, commits, sessions, notes, or Aven history.

use super::{aven::refresh_task_by_ref, closeout::invocation};
use crate::{model::Invocation, process::aven, store::LockedStore};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;
use std::{collections::BTreeSet, path::PathBuf};

/// Bounded discovery keeps a malformed or hostile epic graph from turning one
/// delete into an unbounded process fan-out.
pub(crate) const DELETE_TASK_LIMIT: usize = 500;
pub(crate) const DELETE_DEPTH_LIMIT: usize = 32;

pub(crate) struct DeleteArgs {
    pub(crate) task: String,
    pub(crate) workspace: Option<String>,
    pub(crate) apply: bool,
    pub(crate) json: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct DeleteTask {
    #[serde(rename = "ref")]
    pub(crate) reference: String,
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) is_epic: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct DeleteOutcome {
    pub(crate) applied: bool,
    pub(crate) tasks: Vec<DeleteTask>,
    pub(crate) attempts_removed: usize,
}

fn text(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// Normalize the task identity from an `aven context --json` payload. Context
/// keeps the task under `task` and children at the document root.
pub(crate) fn delete_task(context: &Value) -> Result<DeleteTask> {
    let task = context
        .get("task")
        .context("Aven context has no task object")?;
    let reference = {
        let qualified = text(task, "/display_ref");
        if qualified.is_empty() {
            text(task, "/ref")
        } else {
            qualified
        }
    };
    let id = text(task, "/id");
    if reference.is_empty() || id.is_empty() {
        bail!("Aven context task is missing a ref or immutable id");
    }
    Ok(DeleteTask {
        reference,
        id,
        title: text(task, "/title"),
        status: text(task, "/status"),
        is_epic: task.get("is_epic").and_then(Value::as_bool) == Some(true),
    })
}

pub(crate) fn child_references(context: &Value) -> Result<Vec<String>> {
    let mut references = Vec::new();
    let children = match context.get("epic_children") {
        None | Some(Value::Null) => return Ok(references),
        Some(Value::Array(children)) => children,
        Some(_) => bail!("Aven context epic_children must be an array"),
    };
    for child in children {
        let qualified = text(child, "/display_ref");
        let reference = if qualified.is_empty() {
            text(child, "/ref")
        } else {
            qualified
        };
        if reference.is_empty() {
            bail!("Aven context epic child is missing a ref");
        }
        references.push(reference);
    }
    Ok(references)
}

fn collect_tree(
    invocation: &Invocation,
    reference: &str,
    depth: usize,
    seen: &mut BTreeSet<String>,
    tasks: &mut Vec<DeleteTask>,
) -> Result<()> {
    let reference = reference.trim();
    if reference.is_empty() {
        bail!("delete tree contains an empty task reference");
    }
    if !seen.insert(reference.to_owned()) {
        return Ok(());
    }
    if depth > DELETE_DEPTH_LIMIT {
        bail!("delete tree exceeds {DELETE_DEPTH_LIMIT} levels at {reference}");
    }
    if tasks.len() >= DELETE_TASK_LIMIT {
        bail!("delete tree exceeds the {DELETE_TASK_LIMIT}-task safety limit");
    }
    let context = refresh_task_by_ref(invocation, reference)
        .with_context(|| format!("read {reference} for deletion"))?;
    let task = delete_task(&context).with_context(|| format!("parse {reference}"))?;
    for child in child_references(&context).with_context(|| format!("read {reference} children"))? {
        collect_tree(invocation, &child, depth + 1, seen, tasks)?;
    }
    // Post-order: every descendant is deleted before its parent.
    tasks.push(task);
    Ok(())
}

/// Inventory the target tree leaves-first. Discovery never mutates anything.
pub(crate) fn collect_delete_tasks(
    invocation: &Invocation,
    reference: &str,
) -> Result<Vec<DeleteTask>> {
    let mut tasks = Vec::new();
    let mut seen = BTreeSet::new();
    collect_tree(invocation, reference, 0, &mut seen, &mut tasks)?;
    Ok(tasks)
}

pub(crate) fn run(path: PathBuf, args: DeleteArgs) -> Result<()> {
    let reference = args.task.trim();
    if reference.is_empty() {
        bail!("delete requires a task reference");
    }
    let invocation = invocation(args.workspace);
    let tasks = collect_delete_tasks(&invocation, reference)?;
    let mut attempts_removed = 0;
    if args.apply {
        for task in &tasks {
            aven(&invocation, &["delete", &task.reference], None).with_context(|| {
                format!(
                    "delete {}; earlier descendants may already be soft-deleted, but the root and dispatcher state were not removed",
                    task.reference
                )
            })?;
        }
        // Only purge execution evidence after Aven accepted every delete. A
        // missing store file means there is no dispatcher state to remove, and
        // deleting Aven tasks must not create one as a side effect.
        if path.exists() {
            let mut store = LockedStore::open(path)?;
            for task in &tasks {
                attempts_removed += store.remove_task_state(&task.id)?.0;
            }
            store.save()?;
        }
    }
    let outcome = DeleteOutcome {
        applied: args.apply,
        tasks,
        attempts_removed,
    };
    if args.json {
        println!("{}", serde_json::to_string_pretty(&outcome)?);
        return Ok(());
    }
    if outcome.applied {
        println!(
            "deleted {} task(s) attempts={} root={}",
            outcome.tasks.len(),
            outcome.attempts_removed,
            reference
        );
        for task in &outcome.tasks {
            println!(
                "deleted {} status={} {}",
                task.reference, task.status, task.title
            );
        }
        println!("branches, worktrees, commits, sessions, and notes were preserved");
    } else {
        println!(
            "delete {} tasks={} (inventory only)",
            reference,
            outcome.tasks.len()
        );
        for task in &outcome.tasks {
            println!(
                "would delete {} status={} {}",
                task.reference, task.status, task.title
            );
        }
        println!(
            "no Aven task, dispatcher record, session, worktree, branch, or note was changed; rerun with --apply"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context() -> Value {
        json!({
            "task": {
                "display_ref": "APP-ROOT",
                "id": "id-root",
                "title": "Root epic",
                "status": "todo",
                "is_epic": true
            },
            "epic_children": [
                {"display_ref": "APP-CHILD", "id": "id-child", "title": "Child"},
                {"ref": "APP-OTHER", "id": "id-other", "title": "Other"}
            ]
        })
    }

    #[test]
    fn parses_task_identity_and_top_level_children() {
        let context = context();
        assert_eq!(
            delete_task(&context).unwrap(),
            DeleteTask {
                reference: "APP-ROOT".into(),
                id: "id-root".into(),
                title: "Root epic".into(),
                status: "todo".into(),
                is_epic: true,
            }
        );
        assert_eq!(
            child_references(&context).unwrap(),
            vec!["APP-CHILD".to_owned(), "APP-OTHER".to_owned()]
        );
    }

    #[test]
    fn falls_back_to_short_refs_and_tolerates_absent_children() {
        let context = json!({
            "task": {"ref": "APP-ONE", "id": "id-one", "status": "done", "is_epic": false},
            "epic_children": null
        });
        let task = delete_task(&context).unwrap();
        assert_eq!(task.reference, "APP-ONE");
        assert_eq!(task.status, "done");
        assert!(!task.is_epic);
        assert!(child_references(&context).unwrap().is_empty());
    }

    #[test]
    fn rejects_malformed_context() {
        assert!(delete_task(&json!({})).is_err());
        assert!(delete_task(&json!({"task": {"id": "only-id"}})).is_err());
        assert!(child_references(&json!({"epic_children": "not-a-list"})).is_err());
        assert!(child_references(&json!({"epic_children": [{"id": "id-without-ref"}]})).is_err());
    }

    #[test]
    fn json_contract_uses_qualified_ref_names() {
        let outcome = DeleteOutcome {
            applied: false,
            tasks: vec![DeleteTask {
                reference: "APP-ROOT".into(),
                id: "id-root".into(),
                title: "Root".into(),
                status: "todo".into(),
                is_epic: true,
            }],
            attempts_removed: 0,
        };
        let payload = serde_json::to_value(outcome).unwrap();
        assert_eq!(payload["applied"], false);
        assert_eq!(payload["tasks"][0]["ref"], "APP-ROOT");
        assert_eq!(payload["tasks"][0]["id"], "id-root");
        assert_eq!(payload["attempts_removed"], 0);
    }
}
