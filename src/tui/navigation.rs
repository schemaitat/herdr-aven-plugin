//! Pure pane-candidate resolution and the only permitted navigation effect.
//!
//! A task, epic, attempt, session or pane resolves only through explicitly
//! persisted execution-role ownership. Paths, titles, agent profile names and
//! shared workspaces never create a candidate.

use std::collections::BTreeMap;

use anyhow::{Context, Result};

use crate::inspect::model::*;

use super::state::{Row, RowKind};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub(crate) pane_id: String,
    pub(crate) core_id: String,
    pub(crate) labels: Vec<(String, String)>,
    pub(crate) task_id: String,
    pub(crate) task_ref: String,
    pub(crate) workflow: String,
    pub(crate) attempt_id: String,
    pub(crate) roles: Vec<SessionRole>,
    pub(crate) session_ids: Vec<String>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) tab_id: Option<String>,
    pub(crate) evidence: String,
    pub(crate) topology_present: bool,
}

impl Candidate {
    pub(crate) fn label(&self) -> String {
        let roles = self
            .roles
            .iter()
            .map(|role| format!("{role:?}").to_lowercase())
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{}{} · {} · {} · {}/{} · {} · {}",
            if self.task_ref.is_empty() {
                "-"
            } else {
                &self.task_ref
            },
            if self.workflow.is_empty() {
                String::new()
            } else {
                format!(" [{}]", self.workflow)
            },
            if roles.is_empty() {
                "pane".to_owned()
            } else {
                roles
            },
            if self.attempt_id.is_empty() {
                "-"
            } else {
                &self.attempt_id
            },
            if self.session_ids.is_empty() {
                "-".to_owned()
            } else {
                self.session_ids.join(",")
            },
            self.pane_id,
            self.workspace_id.as_deref().unwrap_or("-"),
            if self.topology_present {
                "present"
            } else {
                "stale/unknown"
            }
        )
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Resolution {
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) reason: Option<String>,
}

impl Resolution {
    fn none(reason: impl Into<String>) -> Self {
        Self {
            candidates: Vec::new(),
            reason: Some(reason.into()),
        }
    }
    fn from_candidates(candidates: Vec<Candidate>) -> Self {
        if candidates.is_empty() {
            Self::none("No explicitly owned execution pane is recorded for this row.")
        } else {
            Self {
                candidates,
                reason: None,
            }
        }
    }
}

pub(crate) fn resolve(snapshot: &Snapshot, row: &Row) -> Resolution {
    match row.kind {
        RowKind::Task => resolve_task(snapshot, row),
        RowKind::Attempt => resolve_attempt(snapshot, row),
        RowKind::Session => resolve_session(snapshot, row),
        RowKind::Pane => resolve_pane(snapshot, row),
        RowKind::Workspace => Resolution::none("Workspace rows do not identify an execution pane."),
    }
}

fn resolve_task(snapshot: &Snapshot, row: &Row) -> Resolution {
    let Some(task_id) = row
        .task_id
        .clone()
        .or_else(|| row.key.strip_prefix("task:").map(str::to_owned))
    else {
        return Resolution::none("Task identity is unavailable.");
    };
    let task = snapshot.tasks.iter().find(|task| task.id == task_id);
    let mut owned = vec![task_id.clone()];
    if let Some(task) = task
        && task.is_epic
    {
        owned.extend(task.epic_children.iter().map(|child| child.id.clone()));
    }
    let mut candidates = BTreeMap::new();
    for candidate in &snapshot.candidates {
        let task_owned = owned.iter().any(|id| id == &candidate.task_id);
        let phase_owned = candidate
            .phase_task_id
            .as_ref()
            .is_some_and(|phase| owned.iter().any(|id| id == phase));
        if task_owned || phase_owned {
            add(&mut candidates, candidate);
        }
    }
    let result = Resolution::from_candidates(candidates.into_values().collect());
    if result.candidates.is_empty() {
        Resolution::none(format!(
            "{} has no recorded execution pane (planning or planned work may have no dispatcher attempt).",
            task.map(|task| task.reference.as_str()).unwrap_or(&task_id)
        ))
    } else {
        result
    }
}

fn resolve_attempt(snapshot: &Snapshot, row: &Row) -> Resolution {
    let Some((task_id, workflow, attempt_id)) = attempt_key(&row.key) else {
        return Resolution::none("Attempt identity is unavailable.");
    };
    let mut candidates = BTreeMap::new();
    for candidate in &snapshot.candidates {
        if candidate.task_id == task_id
            && candidate.workflow == workflow
            && candidate.attempt_id == attempt_id
        {
            add(&mut candidates, candidate);
        }
    }
    Resolution::from_candidates(candidates.into_values().collect())
}

fn resolve_session(snapshot: &Snapshot, row: &Row) -> Resolution {
    let Some(session_id) = row.key.strip_prefix("session:") else {
        return Resolution::none("Session identity is unavailable.");
    };
    let Some(session) = snapshot
        .sessions
        .iter()
        .find(|session| session.session_id == session_id)
    else {
        return Resolution::none("The selected session is no longer present.");
    };
    let mut candidates = BTreeMap::new();
    for candidate in &snapshot.candidates {
        if candidate.session_id.as_deref() == Some(session_id) {
            add(&mut candidates, candidate);
        }
    }
    if candidates.is_empty()
        && let Some(pane_id) = &session.pane
        && let Some(pane) = snapshot.panes.iter().find(|pane| &pane.pane_id == pane_id)
    {
        let candidate = Candidate {
            pane_id: pane_id.clone(),
            core_id: String::new(),
            labels: Vec::new(),
            task_id: session.task_ids.first().cloned().unwrap_or_default(),
            task_ref: session.task_refs.first().cloned().unwrap_or_default(),
            workflow: session.workflows.first().cloned().unwrap_or_default(),
            attempt_id: session.attempt_ids.first().cloned().unwrap_or_default(),
            roles: session.roles.clone(),
            session_ids: vec![session_id.to_owned()],
            workspace_id: Some(pane.workspace_id.clone()),
            tab_id: Some(pane.tab_id.clone()),
            evidence: "persisted session pane + inherited topology".into(),
            topology_present: true,
        };
        candidates.insert(candidate.pane_id.clone(), candidate);
    }
    if candidates.is_empty() {
        Resolution::none(format!(
            "Session {} is pane-less; no terminal target is inferred.",
            session.session_id
        ))
    } else {
        Resolution::from_candidates(candidates.into_values().collect())
    }
}

fn resolve_pane(snapshot: &Snapshot, row: &Row) -> Resolution {
    let Some(pane_id) = row.key.strip_prefix("pane:") else {
        return Resolution::none("Pane identity is unavailable.");
    };
    let Some(pane) = snapshot.panes.iter().find(|pane| pane.pane_id == pane_id) else {
        return Resolution::none("The selected pane is no longer in the inherited topology.");
    };
    let session = pane.agent_session_id.as_ref().and_then(|session_id| {
        snapshot
            .sessions
            .iter()
            .find(|session| &session.session_id == session_id)
    });
    let candidate = Candidate {
        pane_id: pane.pane_id.clone(),
        core_id: String::new(),
        labels: Vec::new(),
        task_id: session
            .and_then(|session| session.task_ids.first())
            .cloned()
            .unwrap_or_default(),
        task_ref: session
            .and_then(|session| session.task_refs.first())
            .cloned()
            .unwrap_or_default(),
        workflow: session
            .and_then(|session| session.workflows.first())
            .cloned()
            .unwrap_or_default(),
        attempt_id: session
            .and_then(|session| session.attempt_ids.first())
            .cloned()
            .unwrap_or_default(),
        roles: session
            .map(|session| session.roles.clone())
            .unwrap_or_default(),
        session_ids: session
            .map(|session| vec![session.session_id.clone()])
            .unwrap_or_default(),
        workspace_id: Some(pane.workspace_id.clone()),
        tab_id: Some(pane.tab_id.clone()),
        evidence: "explicit pane row".into(),
        topology_present: true,
    };
    Resolution {
        candidates: vec![candidate],
        reason: None,
    }
}

fn attempt_key(key: &str) -> Option<(String, String, String)> {
    let rest = key.strip_prefix("attempt:")?;
    let mut parts = rest.splitn(3, ':');
    Some((
        parts.next()?.to_owned(),
        parts.next()?.to_owned(),
        parts.next()?.to_owned(),
    ))
}

fn add(candidates: &mut BTreeMap<String, Candidate>, source: &PaneCandidate) {
    let entry = candidates
        .entry(source.pane_id.clone())
        .or_insert_with(|| Candidate {
            pane_id: source.pane_id.clone(),
            core_id: source.core_id.clone(),
            labels: source.labels.clone(),
            task_id: source.task_id.clone(),
            task_ref: source.task_ref.clone(),
            workflow: source.workflow.clone(),
            attempt_id: source.attempt_id.clone(),
            roles: Vec::new(),
            session_ids: Vec::new(),
            workspace_id: source.workspace_id.clone(),
            tab_id: source.tab_id.clone(),
            evidence: String::new(),
            topology_present: false,
        });
    if !entry.roles.contains(&source.role) {
        entry.roles.push(source.role);
    }
    if let Some(session) = &source.session_id
        && !entry.session_ids.contains(session)
    {
        entry.session_ids.push(session.clone());
    }
    if !source.evidence.is_empty() && !entry.evidence.contains(&source.evidence) {
        if !entry.evidence.is_empty() {
            entry.evidence.push_str("; ");
        }
        entry.evidence.push_str(&source.evidence);
    }
    entry.topology_present |= source.topology_present;
    if entry.workspace_id.is_none() {
        entry.workspace_id = source.workspace_id.clone();
    }
    if entry.tab_id.is_none() {
        entry.tab_id = source.tab_id.clone();
    }
}

/// Revalidate the exact candidate immediately before the single focus call.
/// There is no retry and no substitute target.
pub(crate) fn focus_candidate(candidate: &Candidate) -> Result<()> {
    let core = crate::core::identity().context("resolve herdr-core identity")?;
    if !candidate.core_id.is_empty() && candidate.core_id != core.id {
        anyhow::bail!(
            "terminal {} belongs to a different herdr-core; focus failed closed",
            candidate.pane_id
        );
    }
    let terminal = crate::core::get(&candidate.pane_id)
        .with_context(|| format!("revalidate terminal {}", candidate.pane_id))?;
    if !terminal.live() {
        anyhow::bail!(
            "terminal {} is no longer live (state {})",
            candidate.pane_id,
            terminal.state
        );
    }
    for (key, expected) in &candidate.labels {
        match terminal
            .labels
            .iter()
            .find(|(label, _)| label == key)
            .map(|(_, value)| value.as_str())
        {
            Some(actual) if actual == expected => {}
            Some(actual) => anyhow::bail!(
                "terminal {} now reports {key}={actual:?}, expected {expected:?}; focus failed closed",
                candidate.pane_id
            ),
            None if matches!(key.as_str(), "aven.task_id" | "aven.attempt_id") => {
                anyhow::bail!(
                    "terminal {} no longer reports ownership label {key}; focus failed closed",
                    candidate.pane_id
                );
            }
            None => {}
        }
    }
    if crate::app::focus(&candidate.pane_id) {
        return Ok(());
    }
    if crate::app::peek(&candidate.pane_id) {
        return Ok(());
    }
    anyhow::bail!(
        "herdr-app is unavailable, so terminal {} could not be revealed; no fallback was attempted",
        candidate.pane_id
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(pane_id: &str, session: Option<&str>) -> PaneRecord {
        PaneRecord {
            pane_id: pane_id.into(),
            workspace_id: "w1".into(),
            tab_id: "w1:t1".into(),
            cwd: "/repo/wt".into(),
            agent_profile: Some("opencode".into()),
            agent_status: "idle".into(),
            agent_session_id: session.map(str::to_owned),
            focused: false,
        }
    }

    fn candidate(
        pane_id: &str,
        task_id: &str,
        reference: &str,
        workflow: &str,
        attempt_id: &str,
        role: SessionRole,
        session: Option<&str>,
        phase: Option<&str>,
    ) -> PaneCandidate {
        PaneCandidate {
            task_id: task_id.into(),
            task_ref: reference.into(),
            workflow: workflow.into(),
            attempt_id: attempt_id.into(),
            phase_task_id: phase.map(str::to_owned),
            role,
            session_id: session.map(str::to_owned),
            pane_id: pane_id.into(),
            core_id: "core".into(),
            labels: vec![
                ("aven.task_id".into(), task_id.into()),
                ("aven.attempt_id".into(), attempt_id.into()),
            ],
            workspace_id: Some("w1".into()),
            tab_id: Some("w1:t1".into()),
            evidence: "persisted attempt pane".into(),
            topology_present: true,
        }
    }

    fn task(id: &str, reference: &str, epic: bool, children: Vec<EntityRef>) -> TaskRecord {
        TaskRecord {
            id: id.into(),
            reference: reference.into(),
            title: reference.into(),
            project: "app".into(),
            status: "active".into(),
            is_epic: epic,
            epic_parent: None,
            epic_children: children,
            dependencies: vec![],
            blocks: vec![],
            related: vec![],
            plan: PlanMetadata::default(),
            delivery: None,
            hydrated: true,
            context_observed_at_ms: Some(1),
        }
    }

    fn snapshot() -> Snapshot {
        Snapshot {
            schema: SCHEMA.into(),
            observed_at_ms: 1,
            scope: Scope {
                project: "app".into(),
                workspace: "default".into(),
                repository: "/repo".into(),
                cwd: "/repo".into(),
                project_source: "explicit".into(),
                workspace_source: "default".into(),
                core_session: "inherited".into(),
            },
            limits: Limits::default(),
            sources: vec![],
            tasks: vec![
                task(
                    "epic",
                    "APP-9",
                    true,
                    vec![EntityRef::task("phase-one", Some("APP-P1"), None)],
                ),
                task("task-one", "APP-1", false, vec![]),
                task("other", "APP-2", false, vec![]),
            ],
            attempts: vec![],
            sessions: vec![
                SessionRecord {
                    session_id: "ses_primary".into(),
                    roles: vec![SessionRole::Primary],
                    task_ids: vec!["task-one".into()],
                    task_refs: vec!["APP-1".into()],
                    workflows: vec!["implementation".into()],
                    attempt_ids: vec!["a1".into()],
                    pane: Some("w1:p1".into()),
                    api: ApiActivity::unknown(),
                },
                SessionRecord {
                    session_id: "ses_less".into(),
                    roles: vec![SessionRole::PhaseWorker],
                    task_ids: vec!["phase-one".into()],
                    task_refs: vec!["APP-P1".into()],
                    workflows: vec!["implementation".into()],
                    attempt_ids: vec!["a1".into()],
                    pane: None,
                    api: ApiActivity::unknown(),
                },
            ],
            panes: vec![pane("w1:p1", Some("ses_primary")), pane("w1:p2", None)],
            workspaces: vec![],
            worktrees: vec![],
            candidates: vec![
                candidate(
                    "w1:p1",
                    "task-one",
                    "APP-1",
                    "implementation",
                    "a1",
                    SessionRole::Primary,
                    Some("ses_primary"),
                    None,
                ),
                candidate(
                    "w1:p1",
                    "task-one",
                    "APP-1",
                    "planning",
                    "a2",
                    SessionRole::Coordinator,
                    Some("ses_primary"),
                    None,
                ),
                candidate(
                    "w1:p2",
                    "task-one",
                    "APP-1",
                    "implementation",
                    "a1",
                    SessionRole::Babysitter,
                    Some("ses_baby"),
                    None,
                ),
                candidate(
                    "w1:p3",
                    "phase-one",
                    "APP-P1",
                    "implementation",
                    "a1",
                    SessionRole::PhaseWorker,
                    Some("ses_phase"),
                    Some("phase-one"),
                ),
                candidate(
                    "w2:p9",
                    "other",
                    "APP-2",
                    "implementation",
                    "a3",
                    SessionRole::Primary,
                    Some("ses_other"),
                    None,
                ),
            ],
            relationships: vec![],
            conflicts: vec![],
            warnings: vec![],
        }
    }

    fn row(kind: RowKind, key: &str, task_id: Option<&str>) -> Row {
        Row {
            key: key.into(),
            task_id: task_id.map(str::to_owned),
            kind,
            cells: vec![],
            state: String::new(),
            is_epic: false,
            search: String::new(),
            detail: vec![],
        }
    }

    #[test]
    fn task_attempt_and_session_resolution_respects_explicit_ownership() {
        let snapshot = snapshot();
        let task = resolve(
            &snapshot,
            &row(RowKind::Task, "task:task-one", Some("task-one")),
        );
        assert_eq!(task.candidates.len(), 2);
        assert!(task.candidates.iter().any(|candidate| {
            candidate.pane_id == "w1:p1"
                && candidate.roles.contains(&SessionRole::Primary)
                && candidate.roles.contains(&SessionRole::Coordinator)
        }));
        assert!(
            task.candidates
                .iter()
                .all(|candidate| candidate.pane_id != "w2:p9"),
            "unrelated task candidate leaked"
        );
        let attempt = resolve(
            &snapshot,
            &row(
                RowKind::Attempt,
                "attempt:task-one:implementation:a1",
                Some("task-one"),
            ),
        );
        assert_eq!(attempt.candidates.len(), 2);
        let session = resolve(
            &snapshot,
            &row(RowKind::Session, "session:ses_primary", Some("task-one")),
        );
        assert_eq!(session.candidates.len(), 1);
        assert_eq!(session.candidates[0].pane_id, "w1:p1");
        let pane_row = resolve(&snapshot, &row(RowKind::Pane, "pane:w1:p2", None));
        assert_eq!(pane_row.candidates.len(), 1);
        assert_eq!(pane_row.candidates[0].pane_id, "w1:p2");
        assert!(pane_row.candidates[0].session_ids.is_empty());
    }

    #[test]
    fn epics_include_phase_ownership_and_pane_less_sessions_explain_absence() {
        let snapshot = snapshot();
        let epic = resolve(&snapshot, &row(RowKind::Task, "task:epic", Some("epic")));
        assert!(
            epic.candidates.iter().any(|candidate| {
                candidate.pane_id == "w1:p3" && candidate.roles.contains(&SessionRole::PhaseWorker)
            }),
            "phase child ownership must reach the epic"
        );
        let pane_less = resolve(
            &snapshot,
            &row(RowKind::Session, "session:ses_less", Some("phase-one")),
        );
        assert!(pane_less.candidates.is_empty());
        assert!(pane_less.reason.unwrap().contains("pane-less"));
    }

    #[test]
    fn stale_candidates_remain_visible_but_are_not_replaced() {
        let mut snapshot = snapshot();
        for candidate in &mut snapshot.candidates {
            if candidate.pane_id == "w1:p1" {
                candidate.topology_present = false;
            }
        }
        let resolution = resolve(
            &snapshot,
            &row(RowKind::Task, "task:task-one", Some("task-one")),
        );
        assert!(
            resolution
                .candidates
                .iter()
                .any(|candidate| candidate.pane_id == "w1:p1" && !candidate.topology_present)
        );
        assert!(
            !resolution
                .candidates
                .iter()
                .any(|candidate| candidate.pane_id == "w2:p9")
        );
    }

    #[test]
    fn workspace_rows_never_resolve_from_placement() {
        let snapshot = snapshot();
        let resolution = resolve(&snapshot, &row(RowKind::Workspace, "workspace:w1", None));
        assert!(resolution.candidates.is_empty());
        assert!(resolution.reason.unwrap().contains("Workspace rows"));
    }
}
