//! Pure Aven phase metadata parsing.

use super::workflow_prompt;
use crate::{
    model::{EpicPhase, Invocation, PhaseAttempt},
    process::{aven, field},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::path::PathBuf;

pub(crate) fn phase_branch(root_branch: &str, position: usize) -> String {
    format!("{root_branch}-phase-{position:02}")
}
pub(crate) fn epic_phases(task: &Value) -> Result<Vec<EpicPhase>> {
    let children = task
        .pointer("/epic_children")
        .and_then(Value::as_array)
        .context("worktree mode requires a root epic with phase children")?;
    if children.is_empty() {
        bail!("worktree mode requires at least one ordered epic phase");
    }
    children
        .iter()
        .map(|child| {
            Ok(EpicPhase {
                task_id: child
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .context("epic phase is missing immutable id")?
                    .to_owned(),
                task_ref: child
                    .get("ref")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .context("epic phase is missing reference")?
                    .to_owned(),
                title: child
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            })
        })
        .collect()
}
pub(crate) fn phase_number(task: &Value, reference: &str) -> Result<usize> {
    let metadata = task
        .get("metadata")
        .and_then(Value::as_object)
        .context(format!("phase {reference} has no metadata"))?;
    let value = metadata
        .get("sdd.plan-phase")
        .or_else(|| metadata.get("sdd.phase"))
        .and_then(Value::as_str)
        .context(format!("phase {reference} is missing sdd.plan-phase"))?;
    value
        .parse::<usize>()
        .ok()
        .filter(|number| *number > 0)
        .context(format!(
            "phase {reference} has invalid phase number {value:?}"
        ))
}
pub(crate) fn phase_dependencies(task: &Value) -> Vec<String> {
    task.pointer("/dependencies/depends_on")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|dependency| {
            dependency
                .get("task_id")
                .or_else(|| dependency.get("id"))
                .and_then(Value::as_str)
                .or_else(|| dependency.get("ref").and_then(Value::as_str))
        })
        .map(str::to_owned)
        .collect()
}
pub(crate) fn unresolved_phase_blockers(task: &Value, phase_ref: &str) -> Result<Vec<String>> {
    let unresolved_count = task
        .pointer("/dependencies/depends_on_open")
        .and_then(Value::as_u64)
        .context(format!(
            "phase {phase_ref} is missing its unresolved dependency count"
        ))?;
    if unresolved_count == 0 {
        return Ok(Vec::new());
    }
    let blockers = task
        .pointer("/dependencies/depends_on")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|dependency| dependency.get("unresolved").and_then(Value::as_bool) == Some(true))
        .map(|dependency| {
            dependency
                .get("display_ref")
                .or_else(|| dependency.get("task_id"))
                .or_else(|| dependency.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("unknown dependency")
                .to_owned()
        })
        .collect::<Vec<_>>();
    if blockers.is_empty() {
        Ok(vec![format!(
            "{unresolved_count} unresolved dependency(ies)"
        )])
    } else {
        Ok(blockers)
    }
}

pub(crate) fn has_worked_out_multi_phase_plan(task: &Value) -> bool {
    task.pointer("/metadata/sdd.plan-worked-out")
        .and_then(Value::as_str)
        == Some("true")
        && task
            .pointer("/metadata/sdd.plan-kind")
            .and_then(Value::as_str)
            == Some("multi-phase")
}
pub(crate) fn autonomous_permissions() -> Value {
    json!([{"action":"*", "resource":"*", "effect":"allow"}])
}

pub(crate) fn phase_task(invocation: &Invocation, phase: &EpicPhase) -> Result<Value> {
    let output = aven(invocation, &["context", &phase.task_ref, "--json"], None)?;
    let task: Value = serde_json::from_str(&output).context("Aven phase context --json output")?;
    if task.pointer("/task/id").and_then(Value::as_str) != Some(phase.task_id.as_str()) {
        bail!("Aven re-read returned a different phase task");
    }
    Ok(task)
}

pub(crate) fn phase_prompt(
    task: &Value,
    phase: &PhaseAttempt,
    root_ref: &str,
    skills_dir: Option<PathBuf>,
) -> Result<String> {
    Ok(format!(
        "You are phase `{}` of the approved root epic `{}`. The root has `sdd.plan-worked-out=true` and `sdd.plan-kind=multi-phase`; its plan is the authoritative plan gate for this phase. Work only in your phase worktree and never modify the coordinator worktree. Your predecessor must be verified and integrated before you begin.\n\n{}",
        phase.task_ref,
        root_ref,
        workflow_prompt(
            task,
            &phase.task_ref,
            Some("aven/sdd-implement".into()),
            skills_dir
        )?
    ))
}

pub(crate) fn phase_is_done_for(invocation: &Invocation, phase: &PhaseAttempt) -> Result<bool> {
    Ok(phase_task(
        invocation,
        &EpicPhase {
            task_id: phase.task_id.clone(),
            task_ref: phase.task_ref.clone(),
            title: phase.title.clone(),
        },
    )?
    .pointer("/task/status")
    .and_then(Value::as_str)
        == Some("done"))
}

pub(crate) fn phase_is_eligible(
    invocation: &Invocation,
    phase: &PhaseAttempt,
    predecessor: Option<&PhaseAttempt>,
) -> Result<Value> {
    let task = phase_task(
        invocation,
        &EpicPhase {
            task_id: phase.task_id.clone(),
            task_ref: phase.task_ref.clone(),
            title: phase.title.clone(),
        },
    )?;
    if task.pointer("/task/status").and_then(Value::as_str) != Some("todo") {
        bail!("phase {} is not ready (status is not todo)", phase.task_ref);
    }
    if task
        .pointer("/dependencies/depends_on_open")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        != 0
    {
        bail!("phase {} has unresolved dependencies", phase.task_ref);
    }
    if let Some(predecessor) = predecessor
        && (predecessor.state != "integrated" || !phase_is_done_for(invocation, predecessor)?)
    {
        bail!(
            "phase {} cannot be admitted before predecessor {} is verified and integrated",
            phase.task_ref,
            predecessor.task_ref
        );
    }
    Ok(task)
}

pub(crate) fn validate_epic_phases(
    invocation: &Invocation,
    root: &Value,
    root_ref: &str,
) -> Result<Vec<EpicPhase>> {
    let root_id = field(root, "/task/id")?;
    let mut phases = epic_phases(root)?
        .into_iter()
        .map(|phase| {
            let task = phase_task(invocation, &phase)?;
            let owner = task
                .pointer("/metadata/sdd.plan-root")
                .and_then(Value::as_str);
            if !matches!(owner, Some(value) if value == root_id || value == root_ref) {
                bail!("phase {} is not owned by root {}", phase.task_ref, root_ref);
            }
            Ok((phase_number(&task, &phase.task_ref)?, phase, task))
        })
        .collect::<Result<Vec<_>>>()?;
    phases.sort_by_key(|(number, _, _)| *number);
    for (expected, (number, phase, task)) in phases.iter().enumerate() {
        if *number != expected + 1 {
            bail!(
                "phase {} has number {}; expected consecutive phase {:02}",
                phase.task_ref,
                number,
                expected + 1
            );
        }
        let dependencies = phase_dependencies(task);
        if expected == 0 {
            let blockers = unresolved_phase_blockers(task, &phase.task_ref)?;
            if !blockers.is_empty() {
                bail!(
                    "first phase {} has unresolved blocker(s): {}",
                    phase.task_ref,
                    blockers.join(", ")
                );
            }
        } else {
            let predecessor = &phases[expected - 1].1;
            if dependencies.len() != 1
                || !dependencies.iter().any(|dependency| {
                    dependency == &predecessor.task_id || dependency == &predecessor.task_ref
                })
            {
                bail!(
                    "phase {} must depend only on predecessor {}",
                    phase.task_ref,
                    predecessor.task_ref
                );
            }
        }
    }
    Ok(phases.into_iter().map(|(_, phase, _)| phase).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{PhaseAttempt, TerminalRef};
    use serde_json::json;

    #[test]
    fn phase_branch_appends_the_phase_to_a_feat_branch() {
        assert_eq!(
            phase_branch("feat/hap-fpjs-branch-naming-dispatch-fpjsfbf2vh24vnm6", 1),
            "feat/hap-fpjs-branch-naming-dispatch-fpjsfbf2vh24vnm6-phase-01"
        );
        assert_eq!(
            phase_branch("feat/app-cumulative-epic-dispatch-epic-task", 12),
            "feat/app-cumulative-epic-dispatch-epic-task-phase-12"
        );
    }
    #[test]
    fn phase_branch_keeps_a_legacy_root_usable() {
        assert_eq!(
            phase_branch("app/quoted-task-dispatch-abc123", 1),
            "app/quoted-task-dispatch-abc123-phase-01"
        );
        assert_eq!(
            phase_branch("app/legacy-branch", 3),
            "app/legacy-branch-phase-03"
        );
    }

    #[test]
    fn phase_prompt_is_scoped_to_its_worker_worktree() {
        let phase = PhaseAttempt {
            task_id: "phase-1".into(),
            task_ref: "APP-P1".into(),
            title: "first phase".into(),
            branch: "app/phase-1".into(),
            worktree: "/phase-1".into(),
            worktree_created_by_attempt: true,
            terminal: TerminalRef::default(),
            pane: "w1:p1".into(),
            session_id: "ses_1".into(),
            prompt_id: "msg_1".into(),
            pending_prompt: String::new(),
            commit: String::new(),
            integrated_commit: String::new(),
            state: "running".into(),
        };
        let prompt = phase_prompt(
            &json!({"task": {"id": "phase-1"}}),
            &phase,
            "APP-ROOT",
            None,
        )
        .unwrap();
        assert!(prompt.contains("Work only in your phase worktree"));
        assert!(prompt.contains("approved root epic `APP-ROOT`"));
        assert!(!prompt.contains("Pre-provisioned cumulative worktrees"));
        assert!(!prompt.contains("You are the coordinator"));
    }
    #[test]
    fn phase_metadata_accepts_planner_schema_and_legacy_alias() {
        assert_eq!(
            phase_number(&json!({"metadata":{"sdd.plan-phase":"2"}}), "APP-2").unwrap(),
            2
        );
        assert_eq!(
            phase_number(&json!({"metadata":{"sdd.phase":"1"}}), "APP-1").unwrap(),
            1
        );
        assert!(phase_number(&json!({"metadata":{"sdd.plan-phase":"zero"}}), "APP-X").is_err());
    }
    #[test]
    fn phase_dependency_ids_are_read_without_response_order() {
        assert_eq!(
            phase_dependencies(
                &json!({"dependencies":{"depends_on":[{"task_id":"immutable-predecessor"}]}})
            ),
            vec!["immutable-predecessor"]
        );
    }
    #[test]
    fn first_phase_allows_completed_dependencies_but_rejects_open_blockers() {
        let completed = json!({
            "dependencies": {
                "depends_on_open": 0,
                "depends_on": [{"id": "completed-id", "display_ref": "APP-1", "unresolved": false}]
            }
        });
        assert!(
            unresolved_phase_blockers(&completed, "APP-P1")
                .unwrap()
                .is_empty()
        );

        let blocked = json!({
            "dependencies": {
                "depends_on_open": 1,
                "depends_on": [{"id": "open-id", "display_ref": "APP-2", "unresolved": true}]
            }
        });
        assert_eq!(
            unresolved_phase_blockers(&blocked, "APP-P1").unwrap(),
            vec!["APP-2"]
        );
    }
    #[test]
    fn first_phase_requires_authoritative_unresolved_dependency_count() {
        let task = json!({"dependencies": {"depends_on": []}});
        assert!(
            unresolved_phase_blockers(&task, "APP-P1")
                .unwrap_err()
                .to_string()
                .contains("missing its unresolved dependency count")
        );
    }
    #[test]
    fn phase_prompt_bodies_are_durable_for_recovery() {
        let phase = PhaseAttempt {
            task_id: "phase-one".into(),
            task_ref: "APP-P1".into(),
            title: "first phase".into(),
            branch: "app/phase-1".into(),
            worktree: "/phase-1".into(),
            worktree_created_by_attempt: true,
            terminal: TerminalRef::default(),
            pane: String::new(),
            session_id: "ses_1".into(),
            prompt_id: "msg_1".into(),
            pending_prompt: "durable prompt".into(),
            commit: String::new(),
            integrated_commit: String::new(),
            state: "prompt-pending".into(),
        };
        let encoded = serde_json::to_string(&phase).unwrap();
        let decoded: PhaseAttempt = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.pending_prompt, "durable prompt");
        assert_eq!(decoded.prompt_id, "msg_1");
    }
}
