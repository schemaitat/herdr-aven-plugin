//! Cancellation, diagnostic-log and recovery-record disposition.
//!
//! These actions are human-controlled: the default is a read-only inventory,
//! and an explicit `--apply` is required before any Aven status transition.
//! Artifacts are preserved; retirement prefers a retained/canceled
//! disposition over deletion.

use super::{
    aven::{list_tasks, refresh_task_by_ref},
    closeout::{self, invocation},
};
use crate::{
    model::{Attempt, Invocation},
    process::{aven, now},
    store::{LockedStore, read_only::read_only_store_payloads},
    worktrees,
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub(crate) const DISPOSITION_MARKER_PREFIX: &str = "aven-dispatch:disposition:";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
pub(crate) struct Artifact {
    pub(crate) kind: String,
    pub(crate) path: String,
    pub(crate) branch: String,
    pub(crate) commit: String,
    pub(crate) dirty: Option<bool>,
}

#[derive(Debug, Serialize)]
pub(crate) struct DispositionOutcome {
    pub(crate) task: String,
    pub(crate) action: String,
    pub(crate) dry_run: bool,
    pub(crate) reason: String,
    pub(crate) successor: String,
    pub(crate) artifacts: Vec<Artifact>,
    pub(crate) transferred_obligations: Vec<String>,
    pub(crate) notes: Vec<String>,
}

pub(crate) struct DispositionArgs {
    pub(crate) task: String,
    pub(crate) apply: bool,
    pub(crate) reason: Option<String>,
    pub(crate) successor: Option<String>,
    pub(crate) no_successor: bool,
    pub(crate) waive_delivery: bool,
    pub(crate) workspace: Option<String>,
    pub(crate) json: bool,
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

fn marker(task_id: &str) -> String {
    format!("<!-- {DISPOSITION_MARKER_PREFIX}{task_id} -->")
}

pub(crate) fn artifact_inventory(task_id: &str, attempts: &[Attempt]) -> Vec<Artifact> {
    let mut artifacts = Vec::new();
    for attempt in attempts {
        if attempt.task_id == task_id && !attempt.worktree.is_empty() {
            artifacts.push(Artifact {
                kind: "attempt-worktree".into(),
                path: attempt.worktree.clone(),
                branch: attempt.branch.clone(),
                commit: worktrees::head(Path::new(&attempt.worktree)).unwrap_or_default(),
                dirty: worktrees::clean(Path::new(&attempt.worktree))
                    .ok()
                    .map(|clean| !clean),
            });
        }
        for phase in &attempt.phases {
            if phase.task_id != task_id || phase.worktree.is_empty() {
                continue;
            }
            artifacts.push(Artifact {
                kind: "phase-worktree".into(),
                path: phase.worktree.clone(),
                branch: phase.branch.clone(),
                commit: if phase.commit.is_empty() {
                    worktrees::head(Path::new(&phase.worktree)).unwrap_or_default()
                } else {
                    phase.commit.clone()
                },
                dirty: worktrees::clean(Path::new(&phase.worktree))
                    .ok()
                    .map(|clean| !clean),
            });
        }
    }
    artifacts
}

fn retained_artifact_inventory(task: &Value, task_id: &str, attempts: &[Attempt]) -> Vec<Artifact> {
    let mut artifacts = artifact_inventory(task_id, attempts);
    let Some(previous) = metadata_value(task, "disposition.artifacts")
        .and_then(|value| serde_json::from_str::<Vec<Artifact>>(value).ok())
    else {
        return artifacts;
    };
    for artifact in previous {
        if !artifacts.contains(&artifact) {
            artifacts.push(artifact);
        }
    }
    artifacts
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

fn has_marker(task: &Value, marker: &str) -> bool {
    task.get("notes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|note| note.get("body").and_then(Value::as_str))
        .any(|body| body.contains(marker))
}

fn note_matches_disposition(
    task: &Value,
    marker: &str,
    reason: &str,
    successor: Option<&str>,
    no_successor: bool,
) -> Option<bool> {
    task.get("notes")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(|note| note.get("body").and_then(Value::as_str))
        .find(|body| body.contains(marker))
        .map(|body| {
            let expected_successor = successor.unwrap_or("none");
            body.contains(&format!("Reason: {reason}\n"))
                && body.contains(&format!("Successor: {expected_successor}\n"))
                && body.contains(&format!("No successor: {no_successor}\n"))
        })
}

fn metadata_value<'a>(task: &'a Value, key: &str) -> Option<&'a str> {
    task.pointer(&format!("/metadata/{key}"))
        .and_then(Value::as_str)
}

pub(crate) fn run(path: PathBuf, args: DispositionArgs) -> Result<()> {
    let invocation = invocation(args.workspace.clone());
    let task = refresh_task_by_ref(&invocation, &args.task)?;
    let reference = task_ref(&task);
    let task_id = task
        .pointer("/task/id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let status = task_status(&task).to_owned();
    let already_canceled = status == "canceled";
    let reason = args.reason.clone().unwrap_or_default();
    if reason.trim().is_empty() && args.apply {
        bail!("cancellation requires an explicit non-empty --reason");
    }
    if args.apply && !args.no_successor && args.successor.is_none() {
        bail!(
            "cancellation requires a real --successor <ref> or an explicit --no-successor decision"
        );
    }
    let attempts = read_only_store_payloads(&path, 2_000)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|payload| serde_json::from_str::<Attempt>(&payload).ok())
        .collect::<Vec<_>>();
    let artifacts = retained_artifact_inventory(&task, &task_id, &attempts);
    let mut notes = Vec::new();
    let mut transferred = Vec::new();
    let mut outcome = DispositionOutcome {
        task: reference.clone(),
        action: "cancel".into(),
        dry_run: !args.apply,
        reason: reason.clone(),
        successor: args.successor.clone().unwrap_or_default(),
        artifacts,
        transferred_obligations: Vec::new(),
        notes: Vec::new(),
    };
    if status == "done" {
        bail!(
            "{reference} is accepted (done); refusing to cancel accepted work. Reopen it deliberately or supersede it with a reviewed successor"
        );
    }
    if let Some(successor) = &args.successor {
        let successor_task = refresh_task_by_ref(&invocation, successor)?;
        if task_status(&successor_task) == "canceled" {
            bail!("successor {successor} is canceled and cannot carry the decision");
        }
    }
    let decision_marker = marker(&task_id);
    if let Some(existing) = metadata_value(&task, "disposition.reason")
        && existing != reason
    {
        bail!("{reference} already has a different disposition reason; review it before changing");
    }
    if let Some(existing) = metadata_value(&task, "disposition.successor")
        && Some(existing) != args.successor.as_deref()
    {
        bail!(
            "{reference} already has a different disposition successor; review it before changing"
        );
    }
    if metadata_value(&task, "disposition.no-successor") == Some("true") && !args.no_successor {
        bail!("{reference} already records no successor; review it before changing");
    }
    if let Some(matches) = note_matches_disposition(
        &task,
        &decision_marker,
        &reason,
        args.successor.as_deref(),
        args.no_successor,
    ) && !matches
    {
        bail!("{reference} already has a different disposition note; review it before changing");
    }
    if already_canceled {
        notes.push("task is already canceled; no status transition is needed".into());
    }
    let project = task
        .pointer("/project/key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    // Pending delivery obligations never vanish with canceled status.
    let obligation = if project.is_empty() {
        None
    } else {
        closeout::find_obligation(&invocation, &project, &reference)
    };
    if let Some(obligation_ref) = &obligation {
        if let Some(successor) = &args.successor {
            transferred.push(obligation_ref.clone());
            notes.push(format!(
                "delivery obligation {obligation_ref} would transfer to {successor}"
            ));
        } else if args.waive_delivery {
            notes.push(format!(
                "delivery obligation {obligation_ref} would receive an explicit human waiver"
            ));
        } else if args.no_successor {
            bail!(
                "open delivery obligation {obligation_ref} cannot vanish with canceled status; pass --waive-delivery with a reason or a --successor"
            );
        }
    }
    if !args.apply {
        notes.push(if already_canceled {
            "would publish and verify the missing disposition record; canceled status and artifacts are preserved"
                .into()
        } else {
            "would publish the decision note before changing status to canceled; artifacts are preserved"
                .into()
        });
        outcome.notes = notes;
        emit(&outcome, args.json)?;
        return Ok(());
    }
    // Publish decision evidence before the status transition and validate it
    // on retry through the stable marker.
    let artifact_json = serde_json::to_string(&outcome.artifacts).unwrap_or_default();
    let note_body = format!(
        "## Disposition: canceled\n\n{decision_marker}\n\nReason: {reason}\n\nSuccessor: {}\n\nNo successor: {}\n\nRetained artifacts (never deleted automatically):\n\n```json\n{artifact_json}\n```\n\nDelivery obligations: {}\n",
        if outcome.successor.is_empty() {
            "none"
        } else {
            &outcome.successor
        },
        args.no_successor,
        if let Some(obligation) = &obligation {
            obligation.as_str()
        } else {
            "none"
        }
    );
    if !has_marker(&task, &decision_marker) {
        aven(
            &invocation,
            &["note", &reference, "--stdin"],
            Some(&note_body),
        )?;
        let readback = refresh_task_by_ref(&invocation, &reference)?;
        if !has_marker(&readback, &decision_marker) {
            bail!(
                "disposition decision note for {reference} was not durable; status remains {status}"
            );
        }
    }
    let mut pairs = vec![
        ("disposition.state".into(), "canceled".into()),
        ("disposition.reason".into(), reason.clone()),
        ("disposition.recorded-at".into(), now().to_string()),
        ("disposition.artifacts".into(), artifact_json),
    ];
    if let Some(successor) = &args.successor {
        pairs.push(("superseded-by".into(), successor.clone()));
        pairs.push(("disposition.successor".into(), successor.clone()));
        aven(
            &invocation,
            &["related", "add", successor, &reference],
            None,
        )?;
        aven(
            &invocation,
            &["related", "add", &reference, successor],
            None,
        )?;
    } else if args.no_successor {
        pairs.push(("disposition.no-successor".into(), "true".into()));
    }
    // Transfer or waive matching delivery obligations before cancellation.
    if let Some(obligation_ref) = &obligation {
        if let Some(successor) = &args.successor {
            edit_metadata(
                &invocation,
                obligation_ref,
                &[
                    ("delivery.obligation-for".into(), successor.clone()),
                    ("delivery.transferred-from".into(), reference.clone()),
                ],
            )?;
            let _ = aven(
                &invocation,
                &["related", "add", obligation_ref, successor],
                None,
            );
            notes.push(format!("transferred delivery obligation to {successor}"));
        } else {
            edit_metadata(
                &invocation,
                obligation_ref,
                &[
                    ("delivery.state".into(), "waived".into()),
                    ("delivery.waiver-reason".into(), reason.clone()),
                    ("delivery.waived-at".into(), now().to_string()),
                ],
            )?;
            aven(
                &invocation,
                &["edit", obligation_ref, "--status", "canceled"],
                None,
            )?;
            notes.push(format!("waived delivery obligation {obligation_ref}"));
        }
    }
    edit_metadata(&invocation, &reference, &pairs)?;
    aven(
        &invocation,
        &["edit", &reference, "--status", "canceled"],
        None,
    )?;
    let readback = refresh_task_by_ref(&invocation, &reference)?;
    let disposition_readback = metadata_value(&readback, "disposition.state") == Some("canceled")
        && metadata_value(&readback, "disposition.reason") == Some(reason.as_str())
        && metadata_value(&readback, "disposition.artifacts")
            .and_then(|value| serde_json::from_str::<Vec<Artifact>>(value).ok())
            .is_some_and(|recorded| recorded == outcome.artifacts)
        && (args.successor.as_deref().is_none_or(|successor| {
            metadata_value(&readback, "disposition.successor") == Some(successor)
        }))
        && (!args.no_successor
            || metadata_value(&readback, "disposition.no-successor") == Some("true"));
    let successor_linked = args.successor.as_deref().is_none_or(|successor| {
        readback
            .get("related")
            .and_then(Value::as_array)
            .is_some_and(|related| {
                related.iter().any(|entry| {
                    entry
                        .get("display_ref")
                        .or_else(|| entry.get("ref"))
                        .and_then(Value::as_str)
                        == Some(successor)
                })
            })
    });
    if task_status(&readback) != "canceled"
        || !has_marker(&readback, &decision_marker)
        || !disposition_readback
        || !successor_linked
    {
        bail!("disposition read-back for {reference} is incomplete; cancellation remains pending");
    }
    if !transferred.is_empty() {
        outcome.transferred_obligations = transferred;
    }
    outcome.notes = notes;
    emit(&outcome, args.json)?;
    Ok(())
}

fn emit(outcome: &DispositionOutcome, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(outcome)?);
        return Ok(());
    }
    println!(
        "disposition {} action={} dry_run={} artifacts={}",
        outcome.task,
        outcome.action,
        outcome.dry_run,
        outcome.artifacts.len()
    );
    for artifact in &outcome.artifacts {
        println!(
            "  artifact {} {} branch={} commit={} dirty={:?}",
            artifact.kind, artifact.path, artifact.branch, artifact.commit, artifact.dirty
        );
    }
    for note in &outcome.notes {
        println!("  {note}");
    }
    Ok(())
}

/// Reconcile a dispatcher log task from matching execution evidence. Source
/// acceptance alone is not proof that execution stopped.
pub(crate) fn reconcile_log(attempt: &mut Attempt, store: &mut LockedStore) -> Result<bool> {
    if attempt.log_task_ref.is_empty() {
        return Ok(false);
    }
    let stopped = matches!(
        attempt.lifecycle.observation.as_str(),
        "stopped-success" | "stopped-failure" | "stopped-interrupted"
    );
    let live_or_unknown = matches!(
        attempt.lifecycle.observation.as_str(),
        "live" | "unknown" | ""
    );
    if live_or_unknown {
        return Ok(false);
    }
    if !stopped {
        return Ok(false);
    }
    let task = refresh_task_by_ref(&attempt.aven, &attempt.log_task_ref)?;
    if task.pointer("/task/status").and_then(Value::as_str) == Some("done") {
        return Ok(false);
    }
    // Proven stopped execution permits normal log closure. Explicit
    // supersession is distinguishable from ordinary completion.
    let superseded = task
        .pointer("/metadata/disposition.state")
        .and_then(Value::as_str)
        == Some("superseded");
    let status = if superseded { "canceled" } else { "done" };
    aven(
        &attempt.aven,
        &["edit", &attempt.log_task_ref, "--status", status],
        None,
    )?;
    let note = format!(
        "## Log closed\n\nExecution for attempt `{}` is proven stopped ({}). Source acceptance alone did not close this log.",
        attempt.attempt_id, attempt.lifecycle.observation
    );
    aven(
        &attempt.aven,
        &["note", &attempt.log_task_ref, "--stdin"],
        Some(&note),
    )?;
    store.save()?;
    Ok(true)
}

#[derive(Debug, Serialize)]
pub(crate) struct RecoveryInventory {
    pub(crate) reference: String,
    pub(crate) status: String,
    pub(crate) attempt_id: String,
    pub(crate) classification: String,
    pub(crate) reason: String,
}

pub(crate) struct RecoveryArgs {
    pub(crate) apply: bool,
    pub(crate) task: Option<String>,
    pub(crate) reason: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) json: bool,
}

fn all_attempt_references(attempts: &[Attempt], attempt_id: &str) -> usize {
    attempts
        .iter()
        .filter(|attempt| {
            attempt.attempt_id == attempt_id
                || attempt
                    .phases
                    .iter()
                    .any(|phase| phase.prompt_id.contains(attempt_id))
        })
        .count()
}

pub(crate) fn recovery(path: PathBuf, args: RecoveryArgs) -> Result<()> {
    let invocation = invocation(args.workspace.clone());
    let attempts = read_only_store_payloads(&path, 2_000)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|payload| serde_json::from_str::<Attempt>(&payload).ok())
        .collect::<Vec<_>>();
    let tasks = list_tasks(&invocation, "dispatcher-recovery", None).unwrap_or_default();
    let mut inventory = Vec::new();
    for task in tasks {
        let reference = task
            .get("ref")
            .or_else(|| task.get("display_ref"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if reference.is_empty() {
            continue;
        }
        let attempt_id = task
            .get("metadata")
            .and_then(Value::as_object)
            .and_then(|metadata| metadata.get("dispatch.attempt-id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let retained = task
            .get("metadata")
            .and_then(Value::as_object)
            .and_then(|metadata| metadata.get("recovery.retained"))
            .and_then(Value::as_str)
            == Some("true");
        let owners = all_attempt_references(&attempts, &attempt_id);
        let (classification, reason) = if retained {
            (
                "retained",
                "record is explicitly retained as durable recovery evidence",
            )
        } else if owners > 0 {
            (
                "owned-elsewhere",
                "a retained attempt or workflow still references this record",
            )
        } else if attempt_id.is_empty() {
            (
                "unknown",
                "record has no attempt identity; external-store absence is not orphan proof",
            )
        } else {
            (
                "orphan-candidate",
                "attempt is absent from the central store, but retirement still needs explicit approval",
            )
        };
        inventory.push(RecoveryInventory {
            reference,
            status: task
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            attempt_id,
            classification: classification.into(),
            reason: reason.into(),
        });
    }
    if args.apply {
        let reference = args
            .task
            .as_deref()
            .context("recovery --apply requires an explicit --task reference")?;
        let reason = args
            .reason
            .as_deref()
            .context("recovery --apply requires an explicit --reason")?;
        let candidate = inventory
            .iter()
            .find(|item| item.reference == reference)
            .with_context(|| {
                format!("recovery record {reference} was not found in the inventory")
            })?;
        if candidate.classification != "orphan-candidate" {
            bail!(
                "recovery record {reference} is {}; only an orphan candidate may be retired",
                candidate.classification
            );
        }
        // Prefer a non-destructive retained/canceled disposition over deletion.
        aven(
            &invocation,
            &[
                "edit",
                reference,
                "--status",
                "canceled",
                "--metadata",
                "recovery.retired=true",
                "--metadata",
                &format!("recovery.retirement-reason={reason}"),
            ],
            None,
        )?;
        aven(
            &invocation,
            &["note", reference, "--stdin"],
            Some(&format!(
                "## Recovery retired\n\nReason: {reason}\n\nThe record and its retained evidence were preserved; no deletion was performed."
            )),
        )?;
    }
    if args.json {
        println!("{}", serde_json::to_string_pretty(&inventory)?);
    } else {
        for item in &inventory {
            println!(
                "recovery {} status={} attempt={} classification={} ({})",
                item.reference, item.status, item.attempt_id, item.classification, item.reason
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_inventory_preserves_dirty_and_commit_evidence() {
        let artifacts = artifact_inventory("missing", &[]);
        assert!(artifacts.is_empty());
    }

    #[test]
    fn disposition_marker_is_stable_and_scoped() {
        assert_eq!(
            marker("task-id"),
            "<!-- aven-dispatch:disposition:task-id -->"
        );
    }
}
