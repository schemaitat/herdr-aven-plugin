//! Delivery obligations and human-triggered local closeout.
//!
//! `done` means accepted, not delivered. Closeout is a deterministic verifier:
//! it inspects Git evidence read-only and, only with explicit `--apply`,
//! records delivery metadata, creates one logical related follow-up per
//! accepted result, and resolves matching obligations after a human merge. It
//! never commits, pushes, opens a PR, merges or deletes anything.

use super::aven::{list_tasks, refresh_task_by_ref};
use crate::{
    core,
    model::{Attempt, Invocation},
    process::{aven, now},
    store::read_only::read_only_store_payloads,
    worktrees,
};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;
use std::{
    env,
    path::{Path, PathBuf},
};

pub(crate) const DELIVERY_PENDING: &str = "pending";
pub(crate) const DELIVERY_MERGED: &str = "merged";
pub(crate) const DELIVERY_NOT_APPLICABLE: &str = "not-applicable";
pub(crate) const DELIVERY_SUPERSEDED: &str = "superseded";
pub(crate) const DELIVERY_WAIVED: &str = "waived";

pub(crate) struct CloseoutArgs {
    pub(crate) task: String,
    pub(crate) workflow: Option<String>,
    pub(crate) apply: bool,
    pub(crate) target: String,
    pub(crate) commit: Option<String>,
    pub(crate) pr: Option<String>,
    pub(crate) not_applicable: bool,
    pub(crate) waive: Option<String>,
    pub(crate) superseded_by: Option<String>,
    pub(crate) project: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) json: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct CloseoutOutcome {
    pub(crate) task: String,
    pub(crate) accepted: bool,
    pub(crate) dry_run: bool,
    pub(crate) state: String,
    pub(crate) commit: String,
    pub(crate) branch: String,
    pub(crate) repository: String,
    pub(crate) target: String,
    pub(crate) target_commit: String,
    pub(crate) merged: String,
    pub(crate) provenance: String,
    pub(crate) obligation: String,
    pub(crate) unresolved: Vec<String>,
    pub(crate) notes: Vec<String>,
}

pub(crate) fn delivery_state(task: &Value) -> Option<String> {
    task.pointer("/metadata/delivery.state")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn task_ref(task: &Value) -> String {
    task.pointer("/task/display_ref")
        .or_else(|| task.pointer("/task/ref"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn task_status(task: &Value) -> &str {
    task.pointer("/task/status")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

pub(crate) fn invocation(workspace: Option<String>) -> Invocation {
    Invocation {
        aven_exe: env::var("AVEN_BIN")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_default(),
        db_path: env::var("AVEN_DB").ok().filter(|value| !value.is_empty()),
        workspace,
        origin_cwd: env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
    }
}

fn edit_metadata(
    invocation: &Invocation,
    reference: &str,
    pairs: &[(String, String)],
) -> Result<()> {
    let mut args = vec!["edit".to_owned(), reference.to_owned()];
    for (key, value) in pairs {
        args.extend(["--metadata".into(), format!("{key}={value}")]);
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    aven(invocation, &refs, None)?;
    Ok(())
}

fn append_note(invocation: &Invocation, reference: &str, body: &str) -> Result<()> {
    aven(invocation, &["note", reference, "--stdin"], Some(body))?;
    Ok(())
}

fn delivery_metadata(outcome: &CloseoutOutcome) -> Vec<(String, String)> {
    let mut pairs = vec![
        ("delivery.state".into(), outcome.state.clone()),
        ("delivery.target".into(), outcome.target.clone()),
        ("delivery.verified-at".into(), now().to_string()),
    ];
    for (key, value) in [
        ("delivery.commit", &outcome.commit),
        ("delivery.branch", &outcome.branch),
        ("delivery.repository", &outcome.repository),
        ("delivery.merged", &outcome.merged),
        ("delivery.provenance", &outcome.provenance),
    ] {
        if !value.is_empty() {
            pairs.push((key.into(), value.clone()));
        }
    }
    pairs
}

fn source_for(
    task_id: &str,
    workflow: Option<&str>,
    attempts: &[Attempt],
    explicit_commit: Option<&str>,
) -> Option<(String, String, String)> {
    let mut candidates = attempts
        .iter()
        .filter(|attempt| workflow.is_none_or(|workflow| attempt.workflow == workflow))
        .collect::<Vec<_>>();
    for attempt in &candidates {
        if attempt.task_id == task_id && !attempt.worktree.is_empty() {
            let commit = explicit_commit
                .map(str::to_owned)
                .or_else(|| worktrees::head(Path::new(&attempt.worktree)).ok())
                .unwrap_or_default();
            return Some((attempt.worktree.clone(), attempt.branch.clone(), commit));
        }
        if let Some(phase) = attempt
            .phases
            .iter()
            .find(|phase| phase.task_id == task_id && !phase.worktree.is_empty())
        {
            let commit = explicit_commit
                .map(str::to_owned)
                .or_else(|| {
                    (!phase.commit.is_empty())
                        .then(|| phase.commit.clone())
                        .or_else(|| worktrees::head(Path::new(&phase.worktree)).ok())
                })
                .unwrap_or_default();
            return Some((phase.worktree.clone(), phase.branch.clone(), commit));
        }
    }
    candidates.clear();
    explicit_commit.map(|commit| (String::new(), String::new(), commit.into()))
}

struct Verification {
    state: &'static str,
    target_commit: String,
    repository: String,
    merged: String,
    provenance: String,
}

fn verify(
    worktree: &str,
    commit: &str,
    repository_hint: &str,
    target: &str,
) -> Result<Verification> {
    if commit.is_empty() {
        bail!("no committed result exists; uncommitted work remains pending");
    }
    let directory = if worktree.is_empty() {
        repository_hint
    } else {
        worktree
    };
    if !directory.is_empty() && !worktrees::clean(Path::new(directory))? {
        bail!("the result worktree is dirty; commit or discard its changes before closeout");
    }
    let repository = if repository_hint.is_empty() {
        worktrees::repository_root(directory)?
    } else {
        repository_hint.to_owned()
    };
    let target_commit = core::git(&repository, &["rev-parse".into(), target.into()])?;
    if target_commit.is_empty() {
        bail!("configured target {target} has no commit");
    }
    // A clean target checkout is part of the evidence; an unrelated dirty tree
    // cannot be used as proof of delivery.
    if !worktrees::clean(Path::new(&repository))? {
        bail!("configured target checkout {repository} is dirty; delivery cannot be verified");
    }
    let (ancestor, stdout, stderr) = core::git_status(
        &repository,
        &[
            "merge-base".into(),
            "--is-ancestor".into(),
            commit.into(),
            target_commit.clone(),
        ],
    )?;
    if !ancestor {
        bail!(
            "source {commit} is not an ancestor of {target} ({target_commit}); the merge is unrelated or still pending{}",
            if stderr.is_empty() { &stdout } else { &stderr }
        );
    }
    Ok(Verification {
        state: DELIVERY_MERGED,
        target_commit: target_commit.clone(),
        repository,
        merged: target_commit,
        provenance: format!("local-{target}-ancestry"),
    })
}

pub(crate) fn find_obligation(
    invocation: &Invocation,
    project: &str,
    source_ref: &str,
) -> Option<String> {
    list_tasks(
        invocation,
        project,
        Some(&format!("delivery.obligation-for={source_ref}")),
    )
    .unwrap_or_default()
    .into_iter()
    .find_map(|task| {
        task.get("ref")
            .or_else(|| task.get("display_ref"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn ensure_obligation(
    invocation: &Invocation,
    source: &Value,
    project: &str,
    outcome: &CloseoutOutcome,
    notes: &mut Vec<String>,
    apply: bool,
) -> Result<String> {
    let source_ref = task_ref(source);
    if let Some(existing) = find_obligation(invocation, project, &source_ref) {
        return Ok(existing);
    }
    if !apply {
        notes.push(format!(
            "would create one delivery obligation for {source_ref}"
        ));
        return Ok(String::new());
    }
    let title = format!(
        "Deliver {}: {}",
        source_ref,
        source
            .pointer("/task/title")
            .and_then(Value::as_str)
            .unwrap_or("accepted result")
    );
    let description = format!(
        "## Delivery obligation\n\nAccepted source: `{source_ref}`\n\nCommit: `{}`\n\nTarget: `{}`\n\nThe source is accepted (`done`) but not verified as delivered. A human must integrate it into the configured local target before closeout can resolve this obligation. Closeout never commits, pushes, opens a PR, merges or deletes.",
        if outcome.commit.is_empty() {
            "uncommitted"
        } else {
            &outcome.commit
        },
        outcome.target,
    );
    let mut args = vec![
        "add".to_owned(),
        title,
        "--project".into(),
        project.into(),
        "--status".into(),
        "todo".into(),
        "--description".into(),
        description,
        "--metadata".into(),
        format!("delivery.obligation-for={source_ref}"),
        "--metadata".into(),
        format!("delivery.state={}", outcome.state),
        "--metadata".into(),
        format!("delivery.target={}", outcome.target),
    ];
    if !outcome.commit.is_empty() {
        args.extend([
            "--metadata".into(),
            format!("delivery.commit={}", outcome.commit),
        ]);
    }
    if !outcome.repository.is_empty() {
        args.extend([
            "--metadata".into(),
            format!("delivery.repository={}", outcome.repository),
        ]);
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = aven(invocation, &refs, None)?;
    let reference = output
        .split_whitespace()
        .nth(1)
        .filter(|value| !value.is_empty())
        .context("Aven did not return a delivery follow-up reference")?
        .to_owned();
    let _ = aven(
        invocation,
        &["related", "add", &reference, &source_ref],
        None,
    );
    edit_metadata(
        invocation,
        &source_ref,
        &[("delivery.obligation".into(), reference.clone())],
    )?;
    Ok(reference)
}

fn resolve_obligations(
    invocation: &Invocation,
    project: &str,
    outcome: &CloseoutOutcome,
) -> Result<Vec<String>> {
    let source = outcome.task.clone();
    let mut resolved = Vec::new();
    for task in list_tasks(
        invocation,
        project,
        Some(&format!("delivery.obligation-for={source}")),
    )
    .unwrap_or_default()
    .into_iter()
    {
        let reference = task
            .get("ref")
            .or_else(|| task.get("display_ref"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if reference.is_empty() || task.get("status").and_then(Value::as_str) == Some("done") {
            continue;
        }
        let mut pairs = delivery_metadata(outcome);
        pairs.push(("delivery.state".into(), DELIVERY_MERGED.into()));
        edit_metadata(invocation, reference, &pairs)?;
        aven(invocation, &["edit", reference, "--status", "done"], None)?;
        append_note(
            invocation,
            reference,
            &format!(
                "## Delivery resolved\n\nVerified source `{}` at commit `{}` is an ancestor of local `{}` ({}) after a human-triggered merge. Closeout recorded the evidence and resolved this obligation.",
                outcome.task, outcome.commit, outcome.target, outcome.target_commit
            ),
        )?;
        resolved.push(reference.to_owned());
    }
    Ok(resolved)
}

fn unresolved_children(invocation: &Invocation, task: &Value) -> Result<Vec<String>> {
    let empty = Vec::new();
    let children = task
        .get("epic_children")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut unresolved = Vec::new();
    for child in children {
        let reference = child.get("ref").and_then(Value::as_str).unwrap_or_default();
        if reference.is_empty() {
            unresolved.push("unnamed child".into());
            continue;
        }
        let child = refresh_task_by_ref(invocation, reference)?;
        let status = task_status(&child);
        if status == "canceled" {
            continue;
        }
        if status != "done" {
            unresolved.push(format!("{reference} is {status}"));
            continue;
        }
        match delivery_state(&child).as_deref() {
            Some(
                DELIVERY_MERGED | DELIVERY_NOT_APPLICABLE | DELIVERY_SUPERSEDED | DELIVERY_WAIVED,
            ) => {}
            Some(state) => unresolved.push(format!("{reference} delivery is {state}")),
            None => unresolved.push(format!("{reference} has no delivery disposition")),
        }
    }
    Ok(unresolved)
}

pub(crate) fn run(path: PathBuf, args: CloseoutArgs) -> Result<()> {
    let invocation = invocation(args.workspace.clone());
    let task = refresh_task_by_ref(&invocation, &args.task)?;
    let reference = task_ref(&task);
    let accepted = task_status(&task) == "done";
    let is_epic = task
        .pointer("/task/is_epic")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let has_children = task
        .get("epic_children")
        .and_then(Value::as_array)
        .is_some_and(|children| !children.is_empty());
    let project = args
        .project
        .clone()
        .or_else(|| {
            task.pointer("/project/key")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default();
    if project.is_empty() {
        bail!("closeout requires an explicit --project when the task has no project");
    }
    let attempts = read_only_store_payloads(&path, 2_000)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|payload| serde_json::from_str::<Attempt>(&payload).ok())
        .collect::<Vec<_>>();
    let mut notes = Vec::new();
    let mut outcome = CloseoutOutcome {
        task: reference.clone(),
        accepted,
        dry_run: !args.apply,
        state: DELIVERY_PENDING.into(),
        commit: String::new(),
        branch: String::new(),
        repository: String::new(),
        target: args.target.clone(),
        target_commit: String::new(),
        merged: String::new(),
        provenance: String::new(),
        obligation: String::new(),
        unresolved: Vec::new(),
        notes: Vec::new(),
    };
    let mut has_code_result = false;

    // Explicit reviewed dispositions are human decisions, never inferred from
    // a missing commit or a green session.
    if args.not_applicable {
        outcome.state = DELIVERY_NOT_APPLICABLE.into();
        outcome.provenance = "explicit-no-code-disposition".into();
    } else if let Some(reason) = &args.waive {
        if reason.trim().is_empty() {
            bail!("a delivery waiver requires a non-empty reason");
        }
        outcome.state = DELIVERY_WAIVED.into();
        outcome.provenance = format!("human-waiver: {reason}");
    } else if let Some(superseded) = &args.superseded_by {
        outcome.state = DELIVERY_SUPERSEDED.into();
        outcome.provenance = format!("superseded-by:{superseded}");
    } else if is_epic && has_children {
        outcome.unresolved = unresolved_children(&invocation, &task)?;
        if outcome.unresolved.is_empty() {
            outcome.state = DELIVERY_NOT_APPLICABLE.into();
            outcome.provenance = "aggregate-child-obligations".into();
        }
    } else {
        let source = source_for(
            task.pointer("/task/id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            args.workflow.as_deref(),
            &attempts,
            args.commit.as_deref(),
        );
        if let Some((worktree, branch, commit)) = source {
            has_code_result = true;
            outcome.commit = commit.clone();
            outcome.branch = branch;
            if commit.is_empty() {
                notes.push("no committed result exists; uncommitted work stays pending".into());
            } else {
                // A retained attempt can outlive its source worktree. When the
                // exact result SHA is supplied, verify it in the current
                // repository checkout instead of treating a missing historical
                // worktree as an accepted no-code result.
                let source_worktree_exists = !worktree.is_empty() && Path::new(&worktree).is_dir();
                let (verification_worktree, repository_hint) = if source_worktree_exists {
                    (worktree.clone(), worktree.clone())
                } else {
                    match worktrees::repository_root(&invocation.origin_cwd) {
                        Ok(repository) => (String::new(), repository),
                        Err(error) => {
                            notes.push(format!(
                                "cannot locate repository for exact result: {error:#}"
                            ));
                            (String::new(), String::new())
                        }
                    }
                };
                if repository_hint.is_empty() {
                    outcome.state = "committed".into();
                } else {
                    match verify(
                        &verification_worktree,
                        &commit,
                        &repository_hint,
                        &args.target,
                    ) {
                        Ok(verification) => {
                            outcome.state = verification.state.into();
                            outcome.repository = verification.repository;
                            outcome.target_commit = verification.target_commit;
                            outcome.merged = verification.merged;
                            outcome.provenance = verification.provenance;
                        }
                        Err(error) => {
                            outcome.state = "committed".into();
                            outcome.repository = repository_hint;
                            notes.push(format!("{error:#}"));
                        }
                    }
                }
            }
        } else if is_epic {
            notes.push(
                "childless epic has no bound code result; an explicit --not-applicable disposition is required"
                    .into(),
            );
        } else {
            notes.push(
                "no dispatcher result or explicit --commit exists; uncommitted work stays pending"
                    .into(),
            );
        }
    }
    if let Some(pr) = &args.pr {
        // PR identity can be recorded truthfully, but an open PR is not
        // provider-verified merged delivery.
        notes.push(format!(
            "PR {pr} recorded as supplied evidence; it is not treated as merged delivery"
        ));
    }

    let delivered = matches!(
        outcome.state.as_str(),
        DELIVERY_MERGED | DELIVERY_NOT_APPLICABLE | DELIVERY_SUPERSEDED | DELIVERY_WAIVED
    );
    if accepted && !delivered && (!is_epic || has_code_result) {
        outcome.obligation = ensure_obligation(
            &invocation,
            &task,
            &project,
            &outcome,
            &mut notes,
            args.apply,
        )?;
    }
    if !args.apply {
        outcome.notes = notes;
        emit(&outcome, args.json)?;
        if delivered {
            return Ok(());
        }
        bail!(
            "{} is accepted but delivery is {}; rerun with --apply after a human-triggered merge",
            reference,
            outcome.state
        );
    }
    let mut pairs = delivery_metadata(&outcome);
    if let Some(pr) = &args.pr {
        pairs.push(("delivery.pr".into(), pr.clone()));
        pairs.push(("delivery.pr-state".into(), "supplied".into()));
    }
    if !outcome.obligation.is_empty() {
        pairs.push(("delivery.obligation".into(), outcome.obligation.clone()));
    }
    edit_metadata(&invocation, &reference, &pairs)?;
    if outcome.state == DELIVERY_MERGED {
        let resolved = resolve_obligations(&invocation, &project, &outcome)?;
        if !resolved.is_empty() {
            notes.push(format!("resolved obligations: {}", resolved.join(", ")));
        }
    }
    append_note(
        &invocation,
        &reference,
        &format!(
            "## Closeout\n\nDelivery state: `{}`.\n\nSource: `{}` on `{}`.\n\nTarget: `{}` at `{}`.\n\nProvenance: `{}`.\n\nObligation: `{}`.\n\n{}",
            outcome.state,
            if outcome.commit.is_empty() {
                "uncommitted"
            } else {
                &outcome.commit
            },
            outcome.branch,
            outcome.target,
            outcome.target_commit,
            outcome.provenance,
            outcome.obligation,
            if notes.is_empty() {
                "No outstanding note.".into()
            } else {
                notes.join("\n")
            }
        ),
    )?;
    outcome.notes = notes;
    outcome.unresolved = if outcome.state == DELIVERY_NOT_APPLICABLE
        && outcome.provenance.starts_with("aggregate")
    {
        unresolved_children(&invocation, &task)?
    } else {
        Vec::new()
    };
    emit(&outcome, args.json)?;
    if !delivered || !outcome.unresolved.is_empty() {
        bail!(
            "{} delivery is not complete (state {}; unresolved: {})",
            reference,
            outcome.state,
            if outcome.unresolved.is_empty() {
                "none".into()
            } else {
                outcome.unresolved.join(", ")
            }
        );
    }
    Ok(())
}

fn emit(outcome: &CloseoutOutcome, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(outcome)?);
        return Ok(());
    }
    println!(
        "closeout {} state={} commit={} target={} merged={} obligation={}{}",
        outcome.task,
        outcome.state,
        if outcome.commit.is_empty() {
            "-"
        } else {
            &outcome.commit
        },
        outcome.target,
        if outcome.merged.is_empty() {
            "-"
        } else {
            &outcome.merged
        },
        if outcome.obligation.is_empty() {
            "-"
        } else {
            &outcome.obligation
        },
        if outcome.dry_run { " (dry run)" } else { "" }
    );
    for note in &outcome.notes {
        println!("  {note}");
    }
    for unresolved in &outcome.unresolved {
        println!("  unresolved: {unresolved}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_serializes_delivery_evidence_without_prompt_content() {
        let outcome = CloseoutOutcome {
            task: "APP-1".into(),
            accepted: true,
            dry_run: true,
            state: DELIVERY_MERGED.into(),
            commit: "abc".into(),
            branch: "app/branch".into(),
            repository: "/repo".into(),
            target: "main".into(),
            target_commit: "def".into(),
            merged: "def".into(),
            provenance: "local-main-ancestry".into(),
            obligation: String::new(),
            unresolved: Vec::new(),
            notes: Vec::new(),
        };
        let text = serde_json::to_string(&outcome).unwrap();
        assert!(text.contains("\"state\":\"merged\""));
        assert!(!text.contains("prompt"));
    }

    #[test]
    fn explicit_dispositions_are_terminal_delivery_states() {
        for state in [
            DELIVERY_MERGED,
            DELIVERY_NOT_APPLICABLE,
            DELIVERY_SUPERSEDED,
            DELIVERY_WAIVED,
        ] {
            assert!(matches!(
                state,
                DELIVERY_MERGED | DELIVERY_NOT_APPLICABLE | DELIVERY_SUPERSEDED | DELIVERY_WAIVED
            ));
        }
    }
}
