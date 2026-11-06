//! Read-only Git worktree inventory through `hc exec`.

use super::scope::source_error;
use crate::{inspect::model::*, process::run_bounded, worktrees::parse_listing};
use std::{env, path::Path, time::Duration};

pub(super) fn read_worktrees(
    scope: &Scope,
    secrets: &[String],
) -> (Vec<WorktreeRecord>, String, SourceHealth) {
    let binary = env::var("HC_BIN").unwrap_or_else(|_| "hc".into());
    let output = run_bounded(
        &binary,
        &[
            "exec".into(),
            "--cwd".into(),
            scope.repository.clone(),
            "git".into(),
            "worktree".into(),
            "list".into(),
            "--porcelain".into(),
        ],
        Some(Path::new(&scope.cwd)),
        Duration::from_millis(SOURCE_TIMEOUT_MS),
        SOURCE_OUTPUT_LIMIT,
    );
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            return (
                Vec::new(),
                scope.repository.clone(),
                SourceHealth::unavailable(
                    "worktrees",
                    format!(
                        "Worktree inventory unavailable: hc exec, Git, or repository scope failed: {}",
                        source_error(&error, secrets)
                    ),
                ),
            );
        }
    };
    let parsed = parse_listing(&output);
    let root = parsed
        .first()
        .map(|tree| tree.path.clone())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| scope.repository.clone());
    if parsed.is_empty() {
        return (
            Vec::new(),
            root,
            SourceHealth::unavailable(
                "worktrees",
                "Worktree inventory unavailable: Git returned no registered checkouts.",
            ),
        );
    }
    let records = parsed
        .into_iter()
        .take(WORKSPACE_LIMIT)
        .map(|tree| WorktreeRecord {
            primary: tree.path == root,
            path: sanitize(&tree.path, 4096, secrets),
            branch: sanitize(&tree.branch, 512, secrets),
            head: sanitize(&tree.head, 128, secrets),
            detached: tree.detached,
            open_workspace_id: None,
            origin: WorktreeOrigin::Core,
        })
        .collect();
    (
        records,
        sanitize(&root, 4096, secrets),
        SourceHealth::ok(
            "worktrees",
            "Git worktree inventory through hc exec; read-only.",
        ),
    )
}
