//! Commit-bound acceptance. Aven exposes the approval identity; the central
//! SQLite journal retains the executed checks, reviewed specification and exact
//! artifacts. Execution/terminal observations never grant or revoke approval.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    os::fd::AsFd,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use super::{aven::ensure_attempt_current, closeout};
use crate::{
    core,
    model::{Attempt, EffectRecord, ExecutionMode, Invocation},
    process::{aven, now},
    store::LockedStore,
    worktrees,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct AcceptedChild {
    pub(crate) id: String,
    pub(crate) reference: String,
    pub(crate) status: String,
    pub(crate) commit: String,
    pub(crate) worktree: String,
    pub(crate) disposition: String,
    pub(crate) aggregate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Approval {
    pub(crate) schema: String,
    pub(crate) id: String,
    pub(crate) task_id: String,
    pub(crate) task_ref: String,
    pub(crate) project: String,
    pub(crate) workspace: String,
    pub(crate) workflow: String,
    pub(crate) attempt_id: String,
    pub(crate) generation: u64,
    pub(crate) repository: String,
    /// Non-secret provider identity captured at approval; old journals lack it.
    #[serde(default)]
    pub(crate) github_repository: String,
    pub(crate) worktree: String,
    pub(crate) branch: String,
    pub(crate) commit: String,
    pub(crate) checks: Vec<String>,
    pub(crate) review: String,
    pub(crate) specification: Value,
    pub(crate) children: Vec<AcceptedChild>,
}

pub(crate) fn git(cwd: &str, args: &[&str]) -> Result<String> {
    core::git(
        cwd,
        &args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>(),
    )
}

pub(crate) fn canonical(path: &str) -> Result<String> {
    Ok(std::fs::canonicalize(path)?.to_string_lossy().into_owned())
}

pub(crate) fn repository(cwd: &str) -> Result<String> {
    canonical(&git(
        cwd,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?)
}

/// Approval fingerprints must use complete notes, not the rotating recent-note
/// window: appending a handoff must not make an unchanged plan appear stale.
fn refresh_task_by_ref(invocation: &Invocation, reference: &str) -> Result<Value> {
    let output = aven(
        invocation,
        &["context", reference, "--full", "--json"],
        None,
    )?;
    serde_json::from_str(&output).context("complete Aven approval context")
}

pub(crate) fn require_clean(cwd: &str) -> Result<()> {
    if !worktrees::clean(Path::new(cwd))? {
        bail!(
            "worktree {cwd} is dirty (including untracked files); preserve changes and commit only owned work"
        );
    }
    // An empty index does not by itself rule out a pending merge/rebase.
    for name in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-merge",
        "rebase-apply",
    ] {
        let path = git(
            cwd,
            &["rev-parse", "--path-format=absolute", "--git-path", name],
        )?;
        if Path::new(&path).exists() {
            bail!("worktree {cwd} has an in-progress Git operation ({name})");
        }
    }
    Ok(())
}

/// Commands are explicitly selected by the approving agent/user, never parsed
/// and executed from arbitrary task text. hc bounds the entire process tree;
/// inherit output to avoid deadlocking on a large test suite's piped output.
pub(crate) fn run_checks(cwd: &str, checks: &[String]) -> Result<()> {
    if checks.is_empty() || checks.iter().any(|check| check.trim().is_empty()) {
        bail!("approval requires at least one non-empty verification command");
    }
    for check in checks {
        eprintln!("verify in {cwd}: {check}");
        let status = Command::new(core::binary())
            .args(["exec", "--timeout", "600", "--cwd", cwd, "sh", "-c", check])
            .stdin(Stdio::null())
            .stdout(Stdio::from(std::io::stderr().as_fd().try_clone_to_owned()?))
            .stderr(Stdio::inherit())
            .status()
            .context("start verification through herdr-core")?;
        if !status.success() {
            bail!("verification failed: {check}; approval/main were not updated");
        }
    }
    Ok(())
}

fn field<'a>(task: &'a Value, path: &str) -> Result<&'a str> {
    task.pointer(path)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("Aven context is missing {path}"))
}

fn definition(task: &Value) -> Value {
    let plan_notes = task
        .get("notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|note| note.get("body").and_then(Value::as_str))
        .filter(|body| body.starts_with("## Plan"))
        .collect::<Vec<_>>();
    json!({
        "id": task.pointer("/task/id"), "title": task.pointer("/task/title"),
        "description": task.pointer("/task/description"),
        "epic": task.pointer("/task/is_epic"), "deleted": task.pointer("/task/deleted"),
        "plan": plan_notes, "plan_worked_out": task.pointer("/metadata/sdd.plan-worked-out"),
        "dependencies": task.pointer("/dependencies/depends_on"),
    })
}

struct TaskGraph {
    nodes: Vec<AcceptedChild>,
    definitions: Vec<Value>,
    seen: BTreeSet<String>,
}

fn children(
    invocation: &Invocation,
    task: &Value,
    attempt: &Attempt,
    commit: &str,
    graph: &mut TaskGraph,
    depth: usize,
) -> Result<()> {
    if depth > 16 || graph.seen.len() > 500 {
        bail!("approval task graph exceeds its bounded coverage");
    }
    let refs = task
        .get("epic_children")
        .and_then(Value::as_array)
        .context("Aven context is missing its child-task coverage")?;
    for child in refs {
        let reference = child
            .get("ref")
            .or_else(|| child.get("display_ref"))
            .and_then(Value::as_str)
            .context("child task has no reference")?;
        let child = refresh_task_by_ref(invocation, reference)?;
        let id = field(&child, "/task/id")?.to_owned();
        if !graph.seen.insert(id.clone()) {
            bail!("duplicate/cyclic child {reference}");
        }
        if graph.seen.len() > 500 {
            bail!("approval task graph exceeds its bounded coverage");
        }
        let status = field(&child, "/task/status")?;
        if child.pointer("/task/deleted").and_then(Value::as_bool) != Some(false)
            || !matches!(status, "done" | "canceled")
        {
            bail!(
                "child {reference} is not accepted/canceled; verify its criteria before approval"
            );
        }
        graph.definitions.push(definition(&child));
        let aggregate = child
            .get("epic_children")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty());
        if status != "canceled" {
            children(invocation, &child, attempt, commit, graph, depth + 1)?;
        }
        let phase = attempt.phases.iter().find(|phase| phase.task_id == id);
        let (source, result) = match phase {
            Some(phase) if status != "canceled" => {
                if phase.state != "integrated"
                    || phase.commit.is_empty()
                    || phase.integrated_commit.is_empty()
                {
                    bail!("phase {reference} is not fully integrated");
                }
                require_clean(&phase.worktree)?;
                if repository(&phase.worktree)? != repository(&attempt.worktree)?
                    || git(&phase.worktree, &["branch", "--show-current"])? != phase.branch
                {
                    bail!("phase {reference} worktree/repository/branch changed after integration");
                }
                if git(&phase.worktree, &["rev-parse", "HEAD"])? != phase.commit {
                    bail!(
                        "phase {reference} changed after integration; reconcile it before approval"
                    );
                }
                git(
                    &attempt.worktree,
                    &[
                        "merge-base",
                        "--is-ancestor",
                        &phase.commit,
                        &phase.integrated_commit,
                    ],
                )?;
                git(
                    &attempt.worktree,
                    &[
                        "merge-base",
                        "--is-ancestor",
                        &phase.integrated_commit,
                        commit,
                    ],
                )?;
                (phase.worktree.clone(), phase.commit.clone())
            }
            _ => (attempt.worktree.clone(), commit.to_owned()),
        };
        graph.nodes.push(AcceptedChild {
            id,
            reference: reference.to_owned(),
            status: status.to_owned(),
            worktree: source,
            commit: result,
            aggregate,
            disposition: child
                .pointer("/metadata/delivery.state")
                .and_then(Value::as_str)
                .filter(|state| matches!(*state, "not-applicable" | "waived" | "superseded"))
                .filter(|_| !aggregate)
                .unwrap_or_default()
                .to_owned(),
        });
    }
    Ok(())
}

fn snapshot(
    invocation: &Invocation,
    task: &Value,
    attempt: &Attempt,
    commit: &str,
) -> Result<(Value, Vec<AcceptedChild>)> {
    if task.pointer("/task/deleted").and_then(Value::as_bool) != Some(false)
        || !matches!(field(task, "/task/status")?, "active" | "todo" | "done")
    {
        bail!("task is deleted, canceled or not eligible for approval");
    }
    if task
        .pointer("/epic_parent")
        .is_some_and(|parent| !parent.is_null())
    {
        bail!("approve the complete root/final worktree, not a partial phase");
    }
    ensure_attempt_current(task, attempt)?;
    if attempt.workflow == "planning" {
        bail!("planning-only attempts cannot approve code delivery");
    }
    if attempt.execution_mode == ExecutionMode::Worktrees
        && (attempt.phases.is_empty()
            || attempt
                .phases
                .iter()
                .any(|phase| phase.state != "integrated"))
    {
        bail!("every phase must be integrated before root approval");
    }
    let mut graph = TaskGraph {
        nodes: Vec::new(),
        definitions: vec![definition(task)],
        seen: BTreeSet::from([attempt.task_id.clone()]),
    };
    children(invocation, task, attempt, commit, &mut graph, 0)?;
    Ok((json!(graph.definitions), graph.nodes))
}

pub(crate) fn effect(
    approval: &Approval,
    kind: &str,
    operation: &str,
    payload: String,
) -> EffectRecord {
    EffectRecord {
        scope: approval.workspace.clone(),
        task_id: approval.task_id.clone(),
        task_ref: approval.task_ref.clone(),
        workflow: approval.workflow.clone(),
        attempt_id: approval.attempt_id.clone(),
        operation_id: operation.to_owned(),
        kind: kind.to_owned(),
        state: "pending".into(),
        payload,
        generation: approval.generation,
        revision: 0,
        created_at: now(),
        updated_at: now(),
    }
}

pub(crate) fn closeout_args(
    approval: &Approval,
    reference: &str,
    commit: &str,
) -> closeout::CloseoutArgs {
    closeout::CloseoutArgs {
        task: reference.to_owned(),
        workflow: Some(approval.workflow.clone()),
        apply: true,
        target: "main".into(),
        commit: Some(commit.to_owned()),
        pr: None,
        not_applicable: false,
        waive: None,
        superseded_by: None,
        project: Some(approval.project.clone()),
        workspace: Some(approval.workspace.clone()),
        json: false,
    }
}

pub(crate) fn run(
    path: PathBuf,
    task: Option<String>,
    workflow: Option<String>,
    checks: Vec<String>,
    review: String,
    workspace: Option<String>,
) -> Result<()> {
    if review.trim().is_empty() {
        bail!("approval requires acceptance/review evidence");
    }
    let cwd = canonical(&std::env::current_dir()?.to_string_lossy())?;
    let invocation = closeout::invocation(workspace);
    let mut store = LockedStore::open(path.clone())?;
    let explicit = task
        .as_deref()
        .map(|reference| refresh_task_by_ref(&invocation, reference))
        .transpose()?;
    let mut candidates = store
        .store
        .attempts
        .values()
        .filter(|attempt| {
            explicit.as_ref().is_none_or(|task| {
                task.pointer("/task/id").and_then(Value::as_str) == Some(&attempt.task_id)
            }) && workflow
                .as_deref()
                .is_none_or(|name| attempt.workflow == name)
                && canonical(&attempt.worktree).is_ok_and(|worktree| worktree == cwd)
                && attempt.workflow != "planning"
        })
        .cloned()
        .collect::<Vec<_>>();
    if candidates.len() != 1 {
        bail!(
            "no unambiguous dispatch for this final worktree; supply the root task and --workflow"
        );
    }
    let attempt = candidates.remove(0);
    let task = refresh_task_by_ref(&invocation, &attempt.task_ref)?;
    if field(&task, "/task/id")? != attempt.task_id {
        bail!("task identity changed");
    }
    let repo = repository(&cwd)?;
    let _guard = super::integration::RepositoryGuard::acquire(&repo)?;
    require_clean(&cwd)?;
    if git(&cwd, &["branch", "--show-current"])? != attempt.branch || attempt.branch == "main" {
        bail!("approval requires the attempt's final feature branch, not main/detached HEAD");
    }
    let commit = git(&cwd, &["rev-parse", "HEAD"])?;
    let (specification, accepted_children) = snapshot(&invocation, &task, &attempt, &commit)?;
    let reapproving = task
        .pointer("/metadata/approval.id")
        .and_then(Value::as_str)
        .is_some();
    if reapproving {
        // A failed newer verification must not leave the previous readiness
        // usable, even when the source SHA itself did not change.
        aven(
            &invocation,
            &[
                "edit",
                &attempt.task_ref,
                "--metadata",
                "approval.state=checking",
            ],
            None,
        )?;
    }
    if let Err(error) = run_checks(&cwd, &checks) {
        if reapproving {
            aven(
                &invocation,
                &[
                    "edit",
                    &attempt.task_ref,
                    "--metadata",
                    "approval.state=failed",
                ],
                None,
            )?;
        }
        return Err(error);
    }
    require_clean(&cwd)?;
    if git(&cwd, &["rev-parse", "HEAD"])? != commit {
        bail!("source commit changed during verification; rerun approval");
    }
    let refreshed = refresh_task_by_ref(&invocation, &attempt.task_ref)?;
    if snapshot(&invocation, &refreshed, &attempt, &commit)?
        != (specification.clone(), accepted_children.clone())
    {
        bail!("task specification/children changed during verification; rerun approval");
    }
    let approval = Approval {
        schema: "aven-approval/v1".into(),
        id: format!("approval_{:x}_{}", now(), std::process::id()),
        task_id: attempt.task_id.clone(),
        task_ref: attempt.task_ref.clone(),
        project: field(&task, "/project/key")?.into(),
        workspace: field(&task, "/workspace/key")?.into(),
        workflow: attempt.workflow.clone(),
        attempt_id: attempt.attempt_id.clone(),
        generation: attempt.generation,
        repository: repo,
        github_repository: git(&attempt.worktree, &["remote", "get-url", "origin"])
            .ok()
            .and_then(|origin| super::pr_delivery::origin_repository(&origin).ok())
            .unwrap_or_default(),
        worktree: cwd,
        branch: attempt.branch,
        commit,
        checks,
        review,
        specification,
        children: accepted_children,
    };
    let record = store.begin_effect(effect(
        &approval,
        "approval",
        &approval.id,
        serde_json::to_string(&approval)?,
    ));
    store.save()?;
    // Acceptance precedes delivery. Children already passed their own criteria;
    // root approval accepts the complete result, without waiting for main.
    aven(
        &invocation,
        &[
            "edit",
            &approval.task_ref,
            "--status",
            "done",
            "--metadata",
            "approval.state=approved",
            "--metadata",
            &format!("approval.id={}", approval.id),
            "--metadata",
            &format!("approval.commit={}", approval.commit),
            "--metadata",
            &format!("approval.workflow={}", approval.workflow),
            "--metadata",
            "delivery.state=committed",
        ],
        None,
    )?;
    for child in &approval.children {
        if child.status == "done" && !child.aggregate && child.disposition.is_empty() {
            closeout::checkpoint(
                path.clone(),
                closeout_args(&approval, &child.reference, &child.commit),
            )?;
        }
    }
    if approval.children.is_empty() {
        closeout::checkpoint(
            path.clone(),
            closeout_args(&approval, &approval.task_ref, &approval.commit),
        )?;
    }
    aven(
        &invocation,
        &["note", &approval.task_ref, "--stdin"],
        Some(&format!(
            "## Approved for merge\n\nCommit: `{}`. Branch: `{}`. Checks passed: {}.\n\nReview: {}\n\nAcceptance is done; delivery is separate. Run `/ha-merge {}` from this task's agent session (or main).",
            approval.commit,
            approval.branch,
            approval.checks.join(", "),
            approval.review,
            approval.task_ref
        )),
    )?;
    verify_marker(
        &refresh_task_by_ref(&invocation, &approval.task_ref)?,
        &approval,
    )?;
    store.complete_effect(&record, None);
    store.save()?;
    println!(
        "approved {} commit={} approval={}; accepted, ready to merge",
        approval.task_ref, approval.commit, approval.id
    );
    Ok(())
}

fn verify_marker(task: &Value, approval: &Approval) -> Result<()> {
    if field(task, "/task/id")? != approval.task_id
        || field(task, "/task/status")? != "done"
        || field(task, "/project/key")? != approval.project
        || field(task, "/workspace/key")? != approval.workspace
        || task
            .pointer("/metadata/approval.state")
            .and_then(Value::as_str)
            != Some("approved")
        || task
            .pointer("/metadata/approval.id")
            .and_then(Value::as_str)
            != Some(&approval.id)
        || task
            .pointer("/metadata/approval.commit")
            .and_then(Value::as_str)
            != Some(&approval.commit)
        || task
            .pointer("/metadata/approval.workflow")
            .and_then(Value::as_str)
            != Some(&approval.workflow)
    {
        bail!(
            "{} has no matching completed approval; run /approve in its final worktree",
            approval.task_ref
        );
    }
    Ok(())
}

pub(crate) fn load(
    store: &LockedStore,
    invocation: &Invocation,
    reference: &str,
) -> Result<Approval> {
    let task = refresh_task_by_ref(invocation, reference)?;
    let id = field(&task, "/metadata/approval.id")?;
    let matches = store
        .store
        .effects
        .values()
        .filter(|record| {
            record.kind == "approval"
                && record.state == "completed"
                && record.operation_id == id
                && record.scope == invocation.workspace.as_deref().unwrap_or("default")
                && record.task_id
                    == task
                        .pointer("/task/id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let [record] = matches.as_slice() else {
        bail!("no complete local approval journal for {reference}; rerun /approve");
    };
    let approval: Approval = serde_json::from_str(&record.payload)?;
    if approval.schema != "aven-approval/v1" || approval.id != id {
        bail!("unsupported/mismatching approval journal");
    }
    verify_marker(&task, &approval)?;
    validate(store, invocation, &approval)?;
    Ok(approval)
}

pub(crate) fn validate(
    store: &LockedStore,
    invocation: &Invocation,
    approval: &Approval,
) -> Result<()> {
    let task = refresh_task_by_ref(invocation, &approval.task_ref)?;
    verify_marker(&task, approval)?;
    let attempt = store
        .store
        .attempts
        .values()
        .find(|attempt| {
            attempt.task_id == approval.task_id && attempt.workflow == approval.workflow
        })
        .context("approved dispatch no longer exists")?;
    if attempt.attempt_id != approval.attempt_id
        || attempt.generation != approval.generation
        || canonical(&attempt.worktree)? != approval.worktree
        || attempt.branch != approval.branch
    {
        bail!("approved attempt was replaced/reset; rerun /approve");
    }
    require_clean(&approval.worktree)?;
    if repository(&approval.worktree)? != approval.repository
        || git(&approval.worktree, &["branch", "--show-current"])? != approval.branch
        || git(&approval.worktree, &["rev-parse", "HEAD"])? != approval.commit
    {
        bail!("approved source changed; rerun /approve");
    }
    let (specification, children) = snapshot(invocation, &task, attempt, &approval.commit)?;
    if specification != approval.specification || children != approval.children {
        bail!(
            "approved specification, phase artifacts or child acceptance changed; rerun /approve"
        );
    }
    Ok(())
}
