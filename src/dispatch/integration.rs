//! Human-triggered integration. Git mutations happen in an isolated worktree;
//! only a tested/reviewed combined commit can fast-forward main. A SQLite
//! effect journals each boundary, including metadata-only recovery after merge.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::BTreeSet,
    fs::File,
    path::{Path, PathBuf},
};

use super::{
    approval::{self, Approval, canonical, git, repository, require_clean},
    closeout,
};
use crate::{core, model::EffectRecord, process::now, store::LockedStore, worktrees};

pub(crate) struct MergeArgs {
    pub(crate) tasks: Vec<String>,
    pub(crate) list: bool,
    pub(crate) yes: bool,
    pub(crate) operation: Option<String>,
    pub(crate) publish: bool,
    pub(crate) review_commit: Option<String>,
    pub(crate) review: Option<String>,
    pub(crate) workspace: Option<String>,
}

/// OS-backed advisory ownership: released even on a crash, unlike a stale PID
/// file. All approval/integration operations in one repository share this lock.
pub(crate) struct RepositoryGuard {
    _file: File,
}
impl RepositoryGuard {
    pub(crate) fn acquire(common_dir: &str) -> Result<Self> {
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(Path::new(common_dir).join("aven-merge.lock"))?;
        file.try_lock().context(
            "another approval/merge operation owns this repository; retry when it finishes",
        )?;
        Ok(Self { _file: file })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Integration {
    schema: String,
    id: String,
    repository: String,
    main_worktree: String,
    baseline: String,
    worktree: String,
    branch: String,
    approvals: Vec<Approval>,
    next: usize,
    allowed_paths: BTreeSet<String>,
    /// Written before updating main, so a crash cannot lose delivery identity.
    publish_commit: String,
    review: String,
}

fn checkpoint(
    store: &mut LockedStore,
    record: &EffectRecord,
    operation: &Integration,
    state: &str,
) -> Result<()> {
    store.checkpoint_effect(record, state, &serde_json::to_string(operation)?);
    store.save()
}

fn main_worktree(cwd: &str) -> Result<String> {
    let inventory = worktrees::list(cwd)?;
    let mains = inventory
        .iter()
        .filter(|tree| tree.branch_name() == Some("main"))
        .collect::<Vec<_>>();
    let [main] = mains.as_slice() else {
        bail!("exactly one clean checkout of local main is required");
    };
    let main = canonical(&main.path)?;
    require_clean(&main)?;
    if git(&main, &["branch", "--show-current"])? != "main" {
        bail!("target checkout changed branch");
    }
    Ok(main)
}

fn paths(cwd: &str, from: &str, to: &str) -> Result<BTreeSet<String>> {
    Ok(git(cwd, &["diff", "--name-only", "-z", from, to])?
        .split('\0')
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .collect())
}

fn is_ancestor(cwd: &str, source: &str, target: &str) -> Result<bool> {
    let (success, _, stderr) = core::git_status(
        cwd,
        &[
            "merge-base".into(),
            "--is-ancestor".into(),
            source.into(),
            target.into(),
        ],
    )?;
    if !success && !stderr.is_empty() {
        bail!("cannot inspect ancestry: {stderr}");
    }
    Ok(success)
}

fn validate_sources(store: &LockedStore, operation: &Integration) -> Result<()> {
    for approval in &operation.approvals {
        let invocation = closeout::invocation(Some(approval.workspace.clone()));
        let current = approval::load(store, &invocation, &approval.task_ref)?;
        if current != *approval {
            bail!(
                "approval for {} changed; prepare a new integration",
                approval.task_ref
            );
        }
        if current.repository != operation.repository {
            bail!("cannot merge approvals from different repositories");
        }
    }
    Ok(())
}

fn validate_target(operation: &Integration, expected: &str) -> Result<()> {
    if repository(&operation.main_worktree)? != operation.repository
        || git(&operation.main_worktree, &["branch", "--show-current"])? != "main"
    {
        bail!("target checkout no longer belongs to this repository/main");
    }
    require_clean(&operation.main_worktree)?;
    if git(&operation.main_worktree, &["rev-parse", "HEAD"])? != expected {
        bail!("main changed since preparation; prepare a new integration and rerun its checks");
    }
    Ok(())
}

fn validate_integration(operation: &Integration) -> Result<String> {
    if repository(&operation.worktree)? != operation.repository
        || git(&operation.worktree, &["branch", "--show-current"])? != operation.branch
    {
        bail!("integration worktree/branch was replaced");
    }
    require_clean(&operation.worktree)?;
    let commit = git(&operation.worktree, &["rev-parse", "HEAD"])?;
    if !is_ancestor(&operation.worktree, &operation.baseline, &commit)? {
        bail!("integration no longer preserves the original main history");
    }
    for approval in &operation.approvals {
        if !is_ancestor(&operation.worktree, &approval.commit, &commit)? {
            bail!(
                "integration is missing approved source {}",
                approval.task_ref
            );
        }
    }
    let changed = paths(&operation.worktree, &operation.baseline, &commit)?;
    if !changed.is_subset(&operation.allowed_paths) {
        bail!(
            "integration contains changes outside the approved paths; preserve it and obtain a new approval"
        );
    }
    Ok(commit)
}

fn prepare(
    store: &mut LockedStore,
    cwd: &str,
    args: &MergeArgs,
) -> Result<(EffectRecord, Integration)> {
    if !args.yes || args.tasks.is_empty() {
        bail!(
            "supply approved task IDs and --yes to authorize this merge; /ha-merge is the human trigger"
        );
    }
    if args.publish {
        bail!("prepare first, then review the combined result before --publish");
    }
    let invocation = closeout::invocation(args.workspace.clone());
    let approvals = args
        .tasks
        .iter()
        .map(|reference| approval::load(store, &invocation, reference))
        .collect::<Result<Vec<_>>>()?;
    let repo = repository(cwd)?;
    let mut identities = BTreeSet::new();
    for approval in &approvals {
        if !identities.insert(approval.task_id.clone()) {
            bail!("duplicate task in merge batch");
        }
        if approval.repository != repo {
            bail!(
                "task {} belongs to a different repository",
                approval.task_ref
            );
        }
    }
    let main = main_worktree(cwd)?;
    let baseline = git(&main, &["rev-parse", "HEAD"])?;
    let mut allowed_paths = BTreeSet::new();
    for approval in &approvals {
        let base = git(&main, &["merge-base", &baseline, &approval.commit])?;
        allowed_paths.extend(paths(&main, &base, &approval.commit)?);
    }
    let id = format!("ha-merge_{:x}_{}", now(), std::process::id());
    let branch = format!("ha/integration/{id}");
    let worktree = worktrees::worktree_path(&worktrees::primary_checkout(cwd)?, &branch)?
        .to_string_lossy()
        .into_owned();
    let operation = Integration {
        schema: "aven-integration/v1".into(),
        id: id.clone(),
        repository: repo,
        main_worktree: main,
        baseline,
        worktree,
        branch,
        approvals,
        next: 0,
        allowed_paths,
        publish_commit: String::new(),
        review: String::new(),
    };
    let record = store.begin_effect(approval::effect(
        &operation.approvals[0],
        "integration",
        &id,
        serde_json::to_string(&operation)?,
    ));
    store.save()?;
    Ok((record, operation))
}

fn load(store: &LockedStore, id: &str) -> Result<(EffectRecord, Integration)> {
    let matches = store
        .store
        .effects
        .values()
        .filter(|record| record.kind == "integration" && record.operation_id == id)
        .collect::<Vec<_>>();
    let [record] = matches.as_slice() else {
        bail!("no unambiguous integration operation {id}");
    };
    let operation: Integration = serde_json::from_str(&record.payload)?;
    if operation.schema != "aven-integration/v1"
        || operation.id != id
        || operation.approvals.is_empty()
        || operation.next > operation.approvals.len()
    {
        bail!("unsupported/malformed integration journal");
    }
    Ok(((*record).clone(), operation))
}

fn emit(operation: &Integration, state: &str, commit: &str) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "operation": operation.id, "state": state, "worktree": operation.worktree,
            "branch": operation.branch, "main_worktree": operation.main_worktree,
            "baseline": operation.baseline, "commit": commit, "next": operation.next,
            "tasks": operation.approvals.iter().map(|approval| json!({"task": approval.task_ref,
                "commit": approval.commit, "checks": approval.checks})).collect::<Vec<_>>(),
        }))?
    );
    Ok(())
}

fn advance(
    store: &mut LockedStore,
    record: &EffectRecord,
    operation: &mut Integration,
) -> Result<bool> {
    validate_sources(store, operation)?;
    validate_target(operation, &operation.baseline)?;
    // Provisioning intent was persisted before Git. A retry adopts only the
    // exact registered branch/path; no broad cleanup or force is ever used.
    let resource = worktrees::create(
        &operation.main_worktree,
        &operation.branch,
        Some(&operation.baseline),
    )?;
    if canonical(&resource.path)? != canonical(&operation.worktree)? {
        bail!("integration worktree placement changed");
    }
    if repository(&operation.worktree)? != operation.repository
        || git(&operation.worktree, &["branch", "--show-current"])? != operation.branch
    {
        bail!("integration worktree identity changed");
    }
    while operation.next < operation.approvals.len() {
        let source = operation.approvals[operation.next].commit.clone();
        let merge_head = git(
            &operation.worktree,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "MERGE_HEAD",
            ],
        )?;
        if Path::new(&merge_head).exists() {
            if std::fs::read_to_string(&merge_head)?.trim() != source {
                bail!("pending merge does not match the journaled approved commit");
            }
            checkpoint(store, record, operation, "conflicts")?;
            emit(
                operation,
                "conflicts",
                &git(&operation.worktree, &["rev-parse", "HEAD"])?,
            )?;
            return Ok(false);
        }
        require_clean(&operation.worktree)?;
        if !is_ancestor(&operation.worktree, &source, "HEAD")? {
            checkpoint(store, record, operation, "merging")?;
            let (success, _, stderr) = core::git_status(
                &operation.worktree,
                &[
                    "merge".into(),
                    "--no-ff".into(),
                    "--no-edit".into(),
                    source.clone(),
                ],
            )?;
            if !success {
                if Path::new(&merge_head).exists() {
                    checkpoint(store, record, operation, "conflicts")?;
                    emit(
                        operation,
                        "conflicts",
                        &git(&operation.worktree, &["rev-parse", "HEAD"])?,
                    )?;
                    return Ok(false);
                }
                bail!(
                    "integration failed; retained {}: {stderr}",
                    operation.worktree
                );
            }
        }
        require_clean(&operation.worktree)?;
        if !is_ancestor(&operation.worktree, &source, "HEAD")? {
            bail!("source ancestry was not preserved");
        }
        operation.next += 1;
        checkpoint(store, record, operation, "merging")?;
    }
    let commit = validate_integration(operation)?;
    checkpoint(store, record, operation, "prepared")?;
    emit(operation, "prepared", &commit)?;
    Ok(true)
}

fn finalize(
    path: &Path,
    store: &mut LockedStore,
    record: &EffectRecord,
    operation: &Integration,
) -> Result<()> {
    if operation.publish_commit.is_empty() {
        bail!("no journaled, verified merge to finalize");
    }
    let main = main_worktree(&operation.main_worktree)?;
    if main != operation.main_worktree
        || repository(&main)? != operation.repository
        || !is_ancestor(&main, &operation.publish_commit, "HEAD")?
    {
        bail!("journaled merge is not on clean local main; delivery remains pending");
    }
    validate_sources(store, operation)?;
    // Replays skip already-recorded closeouts for this exact operation/commit.
    // The existing closeout verifier rechecks Git and resolves only matching
    // obligations; a root never attempts to close its children implicitly.
    for approval in &operation.approvals {
        for child in &approval.children {
            if child.status != "done" || !child.disposition.is_empty() {
                continue;
            }
            close_once(
                path,
                store,
                approval,
                &operation.id,
                DeliveryTarget {
                    task_id: &child.id,
                    reference: &child.reference,
                    commit: &child.commit,
                    aggregate: child.aggregate,
                },
            )?;
        }
        close_once(
            path,
            store,
            approval,
            &operation.id,
            DeliveryTarget {
                task_id: &approval.task_id,
                reference: &approval.task_ref,
                commit: &approval.commit,
                aggregate: !approval.children.is_empty(),
            },
        )?;
        record_handoff(store, approval, operation)?;
    }
    validate_sources(store, operation)?;
    main_worktree(&operation.main_worktree)?;
    checkpoint(store, record, operation, "completed")?;
    emit(operation, "merged", &operation.publish_commit)
}

struct DeliveryTarget<'a> {
    task_id: &'a str,
    reference: &'a str,
    commit: &'a str,
    aggregate: bool,
}

fn close_once(
    path: &Path,
    store: &mut LockedStore,
    approval: &Approval,
    operation: &str,
    target: DeliveryTarget<'_>,
) -> Result<()> {
    let DeliveryTarget {
        task_id,
        reference,
        commit,
        aggregate,
    } = target;
    let id = format!("{operation}:closeout:{reference}:{commit}");
    if store.effect_completed(&approval.task_id, &approval.workflow, &id)
        && delivery_recorded(approval, task_id, reference, commit, aggregate)?
    {
        return Ok(());
    }
    let record = store.begin_effect(approval::effect(
        approval,
        "integration-closeout",
        &id,
        commit.to_owned(),
    ));
    store.save()?;
    closeout::run(
        path.to_path_buf(),
        approval::closeout_args(approval, reference, commit),
    )?;
    if !delivery_recorded(approval, task_id, reference, commit, aggregate)? {
        bail!("delivery read-back for {reference} is incomplete; recording remains pending");
    }
    store.complete_effect(&record, None);
    store.save()
}

fn delivery_recorded(
    approval: &Approval,
    task_id: &str,
    reference: &str,
    commit: &str,
    aggregate: bool,
) -> Result<bool> {
    let invocation = closeout::invocation(Some(approval.workspace.clone()));
    let readback = super::aven::refresh_task_by_ref(&invocation, reference)?;
    let expected = if aggregate {
        "not-applicable"
    } else {
        "merged"
    };
    if readback
        .pointer("/task/id")
        .and_then(serde_json::Value::as_str)
        != Some(task_id)
        || readback
            .pointer("/task/status")
            .and_then(serde_json::Value::as_str)
            != Some("done")
        || readback
            .pointer("/metadata/delivery.state")
            .and_then(serde_json::Value::as_str)
            != Some(expected)
        || (!aggregate
            && readback
                .pointer("/metadata/delivery.commit")
                .and_then(serde_json::Value::as_str)
                != Some(commit))
    {
        return Ok(false);
    }
    if !aggregate {
        let Some(target) = readback
            .pointer("/metadata/delivery.merged")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            return Ok(false);
        };
        if !is_ancestor(&approval.worktree, target, "main")? {
            return Ok(false);
        }
        if let Some(obligation_ref) = readback
            .pointer("/metadata/delivery.obligation")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        {
            let obligation = super::aven::refresh_task_by_ref(&invocation, obligation_ref)?;
            if obligation
                .pointer("/task/status")
                .and_then(serde_json::Value::as_str)
                != Some("done")
                || obligation
                    .pointer("/metadata/delivery.obligation-for")
                    .and_then(serde_json::Value::as_str)
                    != Some(reference)
                || obligation
                    .pointer("/metadata/delivery.state")
                    .and_then(serde_json::Value::as_str)
                    != Some("merged")
                || obligation
                    .pointer("/metadata/delivery.commit")
                    .and_then(serde_json::Value::as_str)
                    != Some(commit)
            {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn record_handoff(
    store: &mut LockedStore,
    approval: &Approval,
    operation: &Integration,
) -> Result<()> {
    let id = format!("{}:handoff:{}", operation.id, approval.task_id);
    if store.effect_completed(&approval.task_id, &approval.workflow, &id) {
        return Ok(());
    }
    let marker = format!("<!-- aven-integration:{id} -->");
    let record = store.begin_effect(approval::effect(
        approval,
        "integration-handoff",
        &id,
        marker.clone(),
    ));
    store.save()?;
    let invocation = closeout::invocation(Some(approval.workspace.clone()));
    let contains = |task: &serde_json::Value| {
        task.get("notes")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|notes| {
                notes.iter().any(|note| {
                    note.get("body")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|body| body.contains(&marker))
                })
            })
    };
    if !contains(&super::aven::refresh_task_by_ref(
        &invocation,
        &approval.task_ref,
    )?) {
        crate::process::aven(
            &invocation,
            &["note", &approval.task_ref, "--stdin"],
            Some(&format!(
                "## Integrated into local main\n\n{marker}\n\nApproved source: `{}`. Combined result: `{}`.\n\nCombined checks passed: {}.\n\nReview: {}\n\nDelivery was verified and recorded child-first. No push or teardown was performed.",
                approval.commit,
                operation.publish_commit,
                combined_checks(operation).join(", "),
                operation.review
            )),
        )?;
    }
    if !contains(&super::aven::refresh_task_by_ref(
        &invocation,
        &approval.task_ref,
    )?) {
        bail!("integration handoff read-back is incomplete; recording remains pending");
    }
    store.complete_effect(&record, None);
    store.save()
}

pub(crate) fn run(path: PathBuf, args: MergeArgs) -> Result<()> {
    let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
    let repo = repository(&cwd)?;
    if args.list {
        let records = if path.exists() {
            crate::store::read_only::read_only_effects(&path, 10_000)?
        } else {
            Vec::new()
        };
        let mut operations = Vec::new();
        for record in records.iter().filter(|record| record.kind == "integration") {
            let operation: Integration = serde_json::from_str(&record.payload)?;
            if operation.repository == repo
                && record.scope == args.workspace.as_deref().unwrap_or("default")
            {
                operations.push(json!({"operation": operation.id, "state": record.state,
                    "worktree": operation.worktree, "main_worktree": operation.main_worktree,
                    "baseline": operation.baseline, "publish_commit": operation.publish_commit,
                    "tasks": operation.approvals.iter().map(|approval| &approval.task_ref).collect::<Vec<_>>(),
                    "updated_at": record.updated_at}));
            }
        }
        println!("{}", serde_json::to_string_pretty(&operations)?);
        return Ok(());
    }
    let _guard = RepositoryGuard::acquire(&repo)?;
    let mut store = LockedStore::open(path.clone())?;
    let (record, mut operation) = match &args.operation {
        Some(id) => {
            if !args.tasks.is_empty() || args.yes {
                bail!("resume by operation ID only; do not supply replacement tasks/authorization");
            }
            load(&store, id)?
        }
        None => prepare(&mut store, &cwd, &args)?,
    };
    if operation.repository != repo
        || args.workspace.as_deref().is_some_and(|workspace| {
            operation
                .approvals
                .iter()
                .any(|approval| approval.workspace != workspace)
        })
    {
        bail!("integration belongs to a different repository/workspace");
    }
    if record.state == "completed" {
        main_worktree(&operation.main_worktree)?;
        if !is_ancestor(&operation.main_worktree, &operation.publish_commit, "main")? {
            bail!("historical integration is no longer on local main");
        }
        return emit(&operation, "merged", &operation.publish_commit);
    }
    if !operation.publish_commit.is_empty() {
        if !is_ancestor(&operation.main_worktree, &operation.publish_commit, "main")? {
            // A publish intent without ancestry is not delivery. Only a resumed
            // human-triggered command, never the watcher, may execute it.
            validate_target(&operation, &operation.baseline)?;
            validate_sources(&store, &operation)?;
            if validate_integration(&operation)? != operation.publish_commit {
                bail!("reviewed integration changed");
            }
            approval::run_checks(&operation.worktree, &combined_checks(&operation))?;
            validate_target(&operation, &operation.baseline)?;
            if validate_integration(&operation)? != operation.publish_commit {
                bail!("integration changed during recovery checks");
            }
            git(
                &operation.main_worktree,
                &["merge", "--ff-only", &operation.publish_commit],
            )?;
        }
        return finalize(&path, &mut store, &record, &operation);
    }
    if !args.publish {
        advance(&mut store, &record, &mut operation)?;
        return Ok(());
    }
    if operation.next != operation.approvals.len() {
        bail!("resolve and commit conflicts, then resume preparation before publishing");
    }
    let review = args
        .review
        .as_deref()
        .filter(|review| !review.trim().is_empty())
        .context("publish requires combined acceptance/code-review evidence via --review")?;
    let commit = validate_integration(&operation)?;
    if args.review_commit.as_deref() != Some(&commit) {
        bail!("--review-commit must match the exact combined commit");
    }
    validate_sources(&store, &operation)?;
    validate_target(&operation, &operation.baseline)?;
    approval::run_checks(&operation.worktree, &combined_checks(&operation))?;
    // Tests may write files, or another tool may change a source/target; recheck
    // all identities immediately before the only mutation of main.
    validate_sources(&store, &operation)?;
    validate_target(&operation, &operation.baseline)?;
    if validate_integration(&operation)? != commit {
        bail!("combined commit changed during verification; review it again");
    }
    operation.publish_commit = commit.clone();
    operation.review = review.to_owned();
    checkpoint(&mut store, &record, &operation, "publishing")?;
    git(&operation.main_worktree, &["merge", "--ff-only", &commit])?;
    validate_target(&operation, &commit)?;
    checkpoint(&mut store, &record, &operation, "merged")?;
    finalize(&path, &mut store, &record, &operation)
}

fn combined_checks(operation: &Integration) -> Vec<String> {
    let mut seen = BTreeSet::new();
    operation
        .approvals
        .iter()
        .flat_map(|approval| approval.checks.iter())
        .filter(|check| seen.insert((*check).clone()))
        .cloned()
        .collect()
}

/// The watcher retries metadata only, and only for a journaled publish result
/// already proven on main. It never starts a merge or accepts unapproved work.
pub(crate) fn retry_pending(path: &Path) -> Result<()> {
    let mut store = LockedStore::open(path.to_path_buf())?;
    let records = store
        .store
        .effects
        .values()
        .filter(|record| {
            record.kind == "integration" && matches!(record.state.as_str(), "publishing" | "merged")
        })
        .cloned()
        .collect::<Vec<_>>();
    for record in records {
        let operation: Integration = serde_json::from_str(&record.payload)?;
        let _guard = RepositoryGuard::acquire(&operation.repository)?;
        if !operation.publish_commit.is_empty()
            && is_ancestor(&operation.main_worktree, &operation.publish_commit, "main")?
        {
            finalize(path, &mut store, &record, &operation)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_ownership_is_exclusive_and_released() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_str().unwrap();
        let guard = RepositoryGuard::acquire(path).unwrap();
        assert!(RepositoryGuard::acquire(path).is_err());
        drop(guard);
        assert!(RepositoryGuard::acquire(path).is_ok());
    }
}
