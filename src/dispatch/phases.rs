//! Pure worktree phase reconciliation predicates.

use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::path::Path;

use crate::{
    dispatch::{
        aven::{ensure_attempt_current, refresh_task_by_ref, write_aven_links},
        plan::{phase_is_done_for, phase_is_eligible, phase_prompt, phase_task},
    },
    model::{Attempt, EpicPhase, PhaseAttempt},
    process::{field, identifier, opencode},
    store::{LockedStore, store_attempt},
    worktrees,
};

pub(crate) fn integrated_phase_needs_reconciliation(
    phase_state: &str,
    integrated_commit: &str,
    phase_commit: &str,
    coordinator_commit: &str,
) -> Result<bool> {
    if phase_state != "integrated" || phase_commit == integrated_commit {
        return Ok(false);
    }
    if coordinator_commit != integrated_commit {
        bail!(
            "integrated phase advanced from {integrated_commit} to {phase_commit}, but coordinator is at {coordinator_commit}; refusing to reconcile a non-fast-forward state"
        );
    }
    Ok(true)
}
pub(crate) fn completed_successor_needs_resume(
    phase_state: &str,
    task_done: bool,
    session_succeeded: bool,
) -> bool {
    phase_state == "running" && !task_done && session_succeeded
}
pub(crate) fn integrated_root_state(accepted: bool) -> &'static str {
    if accepted {
        "completed"
    } else {
        "needs-review"
    }
}

// Worktree phase reconciliation and advancement.
pub(crate) fn git_head(directory: &Path) -> Result<String> {
    worktrees::head(directory)
}
pub(crate) fn worktree_is_integration_clean(directory: &Path) -> Result<bool> {
    worktrees::clean(directory)
}
pub(crate) fn phase_is_done(attempt: &Attempt, phase: &PhaseAttempt) -> Result<bool> {
    phase_is_done_for(&attempt.aven, phase)
}
pub(crate) fn phase_session_succeeded(phase: &PhaseAttempt) -> Result<bool> {
    Ok(
        opencode("GET", &format!("/api/session/{}", phase.session_id), None)?
            .pointer("/data/outcome")
            .and_then(Value::as_str)
            == Some("succeeded"),
    )
}
pub(crate) fn advance_worktree_phases(
    attempt: &mut Attempt,
    store: &mut LockedStore,
) -> Result<bool> {
    ensure_attempt_current(
        &refresh_task_by_ref(&attempt.aven, &attempt.task_ref)?,
        attempt,
    )?;
    let mut changed = false;
    for index in 0..attempt.phases.len() {
        let mut phase = attempt.phases[index].clone();
        if phase.state == "prompt-pending" {
            // The predecessor integration is already durable and the prompt ID
            // was checkpointed before admission. Re-admit the exact same ID;
            // OpenCode treats it as the same durable message.
            if phase.prompt_id.is_empty() {
                phase.prompt_id = identifier("msg");
            }
            if phase.pending_prompt.is_empty() {
                let task = phase_task(
                    &attempt.aven,
                    &EpicPhase {
                        task_id: phase.task_id.clone(),
                        task_ref: phase.task_ref.clone(),
                        title: phase.title.clone(),
                    },
                )?;
                phase.pending_prompt = phase_prompt(&task, &phase, &attempt.task_ref, None)?;
            }
            attempt.phases[index] = phase.clone();
            store_attempt(store, attempt.clone());
            store.save()?;
            let admission = opencode(
                "POST",
                &format!("/api/session/{}/prompt", phase.session_id),
                Some(json!({
                    "id": phase.prompt_id,
                    "text": phase.pending_prompt,
                    "resume": true,
                })),
            )?;
            if field(&admission, "/data/id")? != phase.prompt_id {
                bail!("OpenCode admitted an unexpected recovered phase message id");
            }
            phase.state = "running".into();
            phase.pending_prompt.clear();
            attempt.phases[index] = phase;
            changed = true;
            store_attempt(store, attempt.clone());
            store.save()?;
            break;
        }
        if phase.state == "integrated" {
            let phase_commit = git_head(Path::new(&phase.worktree))?;
            let coordinator_commit = git_head(Path::new(&attempt.worktree))?;
            if !integrated_phase_needs_reconciliation(
                &phase.state,
                &phase.integrated_commit,
                &phase_commit,
                &coordinator_commit,
            )? {
                continue;
            }
            // A prior reconciliation may have recorded an unchanged baseline
            // before the worker's verified commit existed. Re-enter the same
            // guarded integration path only when the coordinator is still at
            // that recorded checkpoint; its fast-forward and cleanliness
            // checks remain authoritative.
            phase.state = "running".into();
            attempt.phases[index].state = "running".into();
        }
        if phase.state != "running" || !phase_is_done(attempt, &phase)? {
            break;
        }
        if !phase_session_succeeded(&phase)? {
            bail!(
                "phase {} is marked done but its OpenCode session did not succeed",
                phase.task_ref
            );
        }
        let root = Path::new(&attempt.worktree);
        if !worktree_is_integration_clean(root)? {
            bail!(
                "coordinator worktree has user changes or unowned output; refusing to integrate {}",
                phase.task_ref
            );
        }
        let commit = git_head(Path::new(&phase.worktree))?;
        if git_head(root)? != commit {
            worktrees::merge_ff(root, &phase.branch)?;
        }
        attempt.phases[index].commit = commit;
        attempt.phases[index].integrated_commit = git_head(root)?;
        attempt.phases[index].state = "integrated".into();
        changed = true;
        // Integration is a durable boundary. A crash while admitting the next
        // phase must resume from this completed integration, never repeat it.
        store_attempt(store, attempt.clone());
        store.save()?;

        let Some(next) = attempt.phases.get(index + 1).cloned() else {
            continue;
        };
        let resume_stopped_successor = completed_successor_needs_resume(
            &next.state,
            phase_is_done(attempt, &next)?,
            phase_session_succeeded(&next)?,
        );
        if next.state != "provisioned" && !resume_stopped_successor {
            continue;
        }
        let next_directory = Path::new(&next.worktree);
        if !worktree_is_integration_clean(next_directory)? {
            bail!(
                "next phase worktree {} has user changes or unowned output; refusing to advance it",
                next.task_ref
            );
        }
        worktrees::merge_ff(next_directory, &attempt.branch)?;
        // Re-read immediately before admission: a dependency may have been
        // added while the prior worker was integrating.
        let task = phase_is_eligible(&attempt.aven, &next, Some(&attempt.phases[index]))?;
        let mut admitted = next;
        admitted.prompt_id = identifier("msg");
        admitted.pending_prompt = phase_prompt(&task, &admitted, &attempt.task_ref, None)?;
        admitted.state = "prompt-pending".into();
        attempt.phases[index + 1] = admitted.clone();
        store_attempt(store, attempt.clone());
        store.save()?;
        let response = opencode(
            "POST",
            &format!("/api/session/{}/prompt", admitted.session_id),
            Some(json!({
                "id": admitted.prompt_id,
                "text": admitted.pending_prompt,
                "resume": true,
            })),
        )?;
        if field(&response, "/data/id")? != admitted.prompt_id {
            bail!("OpenCode admitted an unexpected successor phase message id");
        }
        admitted.state = "running".into();
        admitted.pending_prompt.clear();
        attempt.phases[index + 1] = admitted;
        changed = true;
        break;
    }
    let all_integrated = !attempt.phases.is_empty()
        && attempt
            .phases
            .iter()
            .all(|phase| phase.state == "integrated");
    if all_integrated {
        // Integration alone is not acceptance: only the authoritative Aven
        // root status can graduate the attempt from needs-review.
        let root = refresh_task_by_ref(&attempt.aven, &attempt.task_ref)?;
        let accepted = root.pointer("/task/status").and_then(Value::as_str) == Some("done");
        let next = integrated_root_state(accepted);
        if attempt.state != next {
            attempt.state = next.into();
            changed = true;
        }
    }
    if changed {
        let _ = write_aven_links(&attempt.aven, attempt);
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integrated_phase_reconciles_a_later_worker_commit_at_its_checkpoint() {
        assert!(
            integrated_phase_needs_reconciliation("integrated", "base", "phase", "base").unwrap()
        );
        assert!(
            !integrated_phase_needs_reconciliation("integrated", "base", "base", "base").unwrap()
        );
        assert!(
            !integrated_phase_needs_reconciliation("running", "base", "phase", "base").unwrap()
        );
    }
    #[test]
    fn integrated_phase_refuses_reconciliation_after_coordinator_moved() {
        let error =
            integrated_phase_needs_reconciliation("integrated", "base", "phase", "unrelated")
                .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("refusing to reconcile a non-fast-forward state")
        );
    }
    #[test]
    fn completed_incomplete_successor_is_resumed_only_after_it_has_stopped() {
        assert!(completed_successor_needs_resume("running", false, true));
        assert!(!completed_successor_needs_resume("running", true, true));
        assert!(!completed_successor_needs_resume("running", false, false));
        assert!(!completed_successor_needs_resume(
            "provisioned",
            false,
            true
        ));
    }
    #[test]
    fn integrated_root_requires_aven_acceptance_before_completion() {
        assert_eq!(integrated_root_state(false), "needs-review");
        assert_eq!(integrated_root_state(true), "completed");
    }
}
