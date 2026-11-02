//! Pure deterministic inspector snapshot assembly.

use crate::inspect::model::*;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn assemble(
    base: &super::BaseRead,
    live: &super::LiveRead,
    observed_at_ms: u64,
) -> Snapshot {
    let mut tasks = base.tasks.clone();
    let attempts = base.attempts.clone();
    let panes = live.panes.clone();
    let worktrees = if live.worktrees.is_empty() {
        attempt_worktrees(&attempts)
    } else {
        live.worktrees.clone()
    };
    let candidates = build_candidates(&attempts, &panes);
    let relationships = build_relationships(&tasks, &attempts, &live.sessions, &panes, &worktrees);
    let conflicts = build_conflicts(&tasks, &attempts, &live.sessions, &candidates);
    let mut sources = base.sources.clone();
    sources.extend(live.sources.clone());
    let mut warnings = base.warnings.clone();
    warnings.extend(live.warnings.clone());
    tasks.sort_by(|left, right| left.reference.cmp(&right.reference));
    let mut panes = panes;
    panes.sort_by(|left, right| left.pane_id.cmp(&right.pane_id));
    let mut workspaces = live.workspaces.clone();
    workspaces.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    let mut worktrees = worktrees;
    worktrees.sort_by(|left, right| left.path.cmp(&right.path));
    Snapshot {
        schema: SCHEMA.into(),
        observed_at_ms,
        scope: base.scope.clone(),
        limits: Limits::default(),
        sources,
        tasks,
        attempts,
        sessions: live.sessions.clone(),
        panes,
        workspaces,
        worktrees,
        candidates,
        relationships,
        conflicts,
        warnings,
    }
}

pub(super) fn attempt_worktrees(attempts: &[AttemptRecord]) -> Vec<WorktreeRecord> {
    let mut seen = BTreeSet::new();
    attempts
        .iter()
        .filter(|attempt| !attempt.worktree.is_empty() && seen.insert(attempt.worktree.clone()))
        .map(|attempt| WorktreeRecord {
            path: attempt.worktree.clone(),
            branch: attempt.branch.clone(),
            open_workspace_id: None,
            origin: WorktreeOrigin::Attempt,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// herdr-core terminal topology
// ---------------------------------------------------------------------------

pub(super) fn link_sessions(
    attempts: &[AttemptRecord],
    panes: &[PaneRecord],
) -> (Vec<SessionRecord>, Vec<String>) {
    let mut sessions: BTreeMap<String, SessionRecord> = BTreeMap::new();
    let mut warnings = Vec::new();
    let pane_ids = panes
        .iter()
        .map(|pane| pane.pane_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut add = |session_id: &str, role: SessionRole, attempt: &AttemptRecord, pane: &str| {
        if session_id.is_empty() {
            return;
        }
        if !valid_session_id(session_id) {
            warnings.push(format!(
                "Ignored an invalid {} session identity on {}.",
                role_name(role),
                attempt.task_ref
            ));
            return;
        }
        let session = sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| SessionRecord {
                session_id: session_id.to_owned(),
                roles: Vec::new(),
                task_ids: Vec::new(),
                task_refs: Vec::new(),
                workflows: Vec::new(),
                attempt_ids: Vec::new(),
                pane: (!pane.is_empty() && pane_ids.contains(pane)).then(|| pane.to_owned()),
                api: ApiActivity::unknown(),
            });
        if !session.roles.contains(&role) {
            session.roles.push(role);
            session.roles.sort();
        }
        if !session.task_ids.contains(&attempt.task_id) {
            session.task_ids.push(attempt.task_id.clone());
        }
        if !session.task_refs.contains(&attempt.task_ref) {
            session.task_refs.push(attempt.task_ref.clone());
        }
        if !session.workflows.contains(&attempt.workflow) {
            session.workflows.push(attempt.workflow.clone());
        }
        if !session.attempt_ids.contains(&attempt.attempt_id) {
            session.attempt_ids.push(attempt.attempt_id.clone());
        }
        if session.pane.is_none() && !pane.is_empty() && pane_ids.contains(pane) {
            session.pane = Some(pane.to_owned());
        }
    };
    for attempt in attempts {
        add(
            &attempt.session_id,
            SessionRole::Primary,
            attempt,
            if attempt.terminal.is_empty() {
                &attempt.pane
            } else {
                &attempt.terminal.address
            },
        );
        add(
            &attempt.coordinator_session_id,
            SessionRole::Coordinator,
            attempt,
            if attempt.coordinator_terminal.is_empty() {
                &attempt.pane
            } else {
                &attempt.coordinator_terminal.address
            },
        );
        add(
            &attempt.babysitter_session_id,
            SessionRole::Babysitter,
            attempt,
            if attempt.babysitter_terminal.is_empty() {
                &attempt.babysitter_pane
            } else {
                &attempt.babysitter_terminal.address
            },
        );
        for phase in &attempt.phases {
            add(
                &phase.session_id,
                SessionRole::PhaseWorker,
                attempt,
                if phase.terminal.is_empty() {
                    &phase.pane
                } else {
                    &phase.terminal.address
                },
            );
        }
    }
    let mut sessions = sessions.into_values().collect::<Vec<_>>();
    if sessions.len() > LINKED_SESSION_LIMIT {
        sessions.truncate(LINKED_SESSION_LIMIT);
        warnings.push(format!(
            "Linked API session coverage capped at {LINKED_SESSION_LIMIT}; remaining sessions are unknown."
        ));
    }
    (sessions, warnings)
}

fn role_name(role: SessionRole) -> &'static str {
    match role {
        SessionRole::Primary => "primary",
        SessionRole::Coordinator => "coordinator",
        SessionRole::Babysitter => "babysitter",
        SessionRole::PhaseWorker => "phase-worker",
    }
}

fn build_candidates(attempts: &[AttemptRecord], panes: &[PaneRecord]) -> Vec<PaneCandidate> {
    let pane_ids = panes
        .iter()
        .map(|pane| pane.pane_id.as_str())
        .collect::<BTreeSet<_>>();
    let pane_index = panes
        .iter()
        .map(|pane| (pane.pane_id.as_str(), pane))
        .collect::<BTreeMap<_, _>>();
    let mut candidates = Vec::new();
    let mut push = |attempt: &AttemptRecord,
                    phase_task_id: Option<&str>,
                    role: SessionRole,
                    session_id: &str,
                    terminal: &TerminalLink,
                    legacy_pane: &str,
                    evidence: &str| {
        let address = if terminal.is_empty() {
            legacy_pane
        } else {
            &terminal.address
        };
        if address.is_empty() {
            return;
        }
        let topology = pane_index.get(address);
        let mut labels = vec![
            ("aven.task_id".to_owned(), attempt.task_id.clone()),
            ("aven.task".to_owned(), attempt.task_ref.clone()),
            ("aven.workflow".to_owned(), attempt.workflow.clone()),
            ("aven.attempt_id".to_owned(), attempt.attempt_id.clone()),
            ("aven.role".to_owned(), role_name(role).to_owned()),
        ];
        if let Some(phase) = phase_task_id {
            labels.push(("aven.phase".to_owned(), phase.to_owned()));
        }
        candidates.push(PaneCandidate {
            task_id: attempt.task_id.clone(),
            task_ref: attempt.task_ref.clone(),
            workflow: attempt.workflow.clone(),
            attempt_id: attempt.attempt_id.clone(),
            phase_task_id: phase_task_id.map(str::to_owned),
            role,
            session_id: (!session_id.is_empty()).then(|| session_id.to_owned()),
            pane_id: address.to_owned(),
            core_id: terminal.core_id.clone(),
            labels,
            workspace_id: topology.map(|pane| pane.workspace_id.clone()),
            tab_id: topology.map(|pane| pane.tab_id.clone()),
            evidence: evidence.into(),
            topology_present: pane_ids.contains(address),
        });
    };
    for attempt in attempts {
        push(
            attempt,
            None,
            SessionRole::Primary,
            &attempt.session_id,
            &attempt.terminal,
            &attempt.pane,
            "persisted builder terminal",
        );
        push(
            attempt,
            None,
            SessionRole::Coordinator,
            &attempt.coordinator_session_id,
            &attempt.coordinator_terminal,
            "",
            "persisted coordinator terminal",
        );
        push(
            attempt,
            None,
            SessionRole::Babysitter,
            &attempt.babysitter_session_id,
            &attempt.babysitter_terminal,
            &attempt.babysitter_pane,
            "persisted babysitter terminal",
        );
        for phase in &attempt.phases {
            push(
                attempt,
                (!phase.task_id.is_empty()).then_some(phase.task_id.as_str()),
                SessionRole::PhaseWorker,
                &phase.session_id,
                &phase.terminal,
                &phase.pane,
                "persisted phase terminal",
            );
        }
    }
    candidates.sort_by(|left, right| {
        left.task_ref
            .cmp(&right.task_ref)
            .then_with(|| left.workflow.cmp(&right.workflow))
            .then_with(|| left.role.cmp(&right.role))
            .then_with(|| left.pane_id.cmp(&right.pane_id))
    });
    candidates.dedup_by(|left, right| {
        left.task_id == right.task_id
            && left.workflow == right.workflow
            && left.attempt_id == right.attempt_id
            && left.role == right.role
            && left.pane_id == right.pane_id
    });
    candidates
}

fn build_conflicts(
    tasks: &[TaskRecord],
    attempts: &[AttemptRecord],
    sessions: &[SessionRecord],
    candidates: &[PaneCandidate],
) -> Vec<EvidenceConflict> {
    let mut conflicts = Vec::new();
    for attempt in attempts {
        let linked = sessions
            .iter()
            .filter(|session| session.attempt_ids.contains(&attempt.attempt_id))
            .collect::<Vec<_>>();
        let running = matches!(
            attempt.state.as_str(),
            "running" | "waiting" | "starting" | "queued"
        );
        if running
            && !linked.is_empty()
            && linked
                .iter()
                .all(|session| matches!(session.api.state, ApiState::Idle | ApiState::Missing))
        {
            conflicts.push(EvidenceConflict {
                kind: "execution_state".into(),
                task_id: attempt.task_id.clone(),
                task_ref: attempt.task_ref.clone(),
                message: format!(
                    "Persisted {} attempt state {:?} conflicts with idle/missing linked API sessions; both observations are retained.",
                    attempt.workflow, attempt.state
                ),
                sources: vec!["dispatcher".into(), "opencode".into()],
            });
        }
        if let Some(task) = tasks.iter().find(|task| task.id == attempt.task_id)
            && matches!(task.status.as_str(), "done" | "canceled")
            && running
        {
            conflicts.push(EvidenceConflict {
                kind: "task_acceptance".into(),
                task_id: attempt.task_id.clone(),
                task_ref: attempt.task_ref.clone(),
                message: format!(
                    "Aven task is {} while its {} attempt is still {}; acceptance and execution stay separate.",
                    task.status, attempt.workflow, attempt.state
                ),
                sources: vec!["aven".into(), "dispatcher".into()],
            });
        }
    }
    for candidate in candidates {
        if !candidate.topology_present {
            conflicts.push(EvidenceConflict {
                kind: "pane_topology".into(),
                task_id: candidate.task_id.clone(),
                task_ref: candidate.task_ref.clone(),
                message: format!(
                    "Persisted {} pane {} is absent from the inherited Herdr topology; no fallback target is inferred.",
                    role_name(candidate.role), candidate.pane_id
                ),
                sources: vec!["dispatcher".into(), "herdr".into()],
            });
        }
    }
    conflicts.sort_by(|left, right| {
        left.task_ref
            .cmp(&right.task_ref)
            .then_with(|| left.kind.cmp(&right.kind))
            .then_with(|| left.message.cmp(&right.message))
    });
    conflicts.dedup_by(|left, right| {
        left.task_id == right.task_id && left.kind == right.kind && left.message == right.message
    });
    conflicts
}

fn build_relationships(
    tasks: &[TaskRecord],
    attempts: &[AttemptRecord],
    sessions: &[SessionRecord],
    panes: &[PaneRecord],
    worktrees: &[WorktreeRecord],
) -> Vec<Relationship> {
    let mut relationships = Vec::new();
    for task in tasks {
        for attempt in attempts.iter().filter(|attempt| attempt.task_id == task.id) {
            relationships.push(Relationship {
                kind: "task_attempt".into(),
                from: EntityRef::task(&task.id, Some(&task.reference), Some(&task.title)),
                to: EntityRef {
                    kind: "attempt".into(),
                    id: attempt.attempt_id.clone(),
                    reference: Some(attempt.task_ref.clone()),
                    label: Some(format!("{} workflow", attempt.workflow)),
                },
                evidence: format!(
                    "{} generation {}",
                    match attempt.origin {
                        Origin::CentralStore => "central-store",
                        Origin::AvenRecovery => "aven-recovery",
                    },
                    attempt.generation
                ),
            });
        }
    }
    for session in sessions {
        for attempt_id in &session.attempt_ids {
            relationships.push(Relationship {
                kind: "attempt_session".into(),
                from: EntityRef {
                    kind: "attempt".into(),
                    id: attempt_id.clone(),
                    reference: None,
                    label: None,
                },
                to: EntityRef {
                    kind: "session".into(),
                    id: session.session_id.clone(),
                    reference: None,
                    label: Some(
                        session
                            .roles
                            .iter()
                            .map(|role| role_name(*role))
                            .collect::<Vec<_>>()
                            .join(","),
                    ),
                },
                evidence: "persisted role-scoped session identity".into(),
            });
        }
        if let Some(pane) = &session.pane {
            relationships.push(Relationship {
                kind: "session_pane".into(),
                from: EntityRef {
                    kind: "session".into(),
                    id: session.session_id.clone(),
                    reference: None,
                    label: None,
                },
                to: EntityRef {
                    kind: "pane".into(),
                    id: pane.clone(),
                    reference: None,
                    label: None,
                },
                evidence: "persisted session pane; topology revalidated separately".into(),
            });
        }
    }
    for pane in panes {
        relationships.push(Relationship {
            kind: "pane_workspace".into(),
            from: EntityRef {
                kind: "pane".into(),
                id: pane.pane_id.clone(),
                reference: None,
                label: Some(pane.tab_id.clone()),
            },
            to: EntityRef {
                kind: "workspace".into(),
                id: pane.workspace_id.clone(),
                reference: None,
                label: None,
            },
            evidence: "Herdr inherited-session snapshot".into(),
        });
    }
    for attempt in attempts {
        if attempt.worktree.is_empty() {
            continue;
        }
        if let Some(worktree) = worktrees.iter().find(|tree| tree.path == attempt.worktree) {
            relationships.push(Relationship {
                kind: "attempt_worktree".into(),
                from: EntityRef {
                    kind: "attempt".into(),
                    id: attempt.attempt_id.clone(),
                    reference: Some(attempt.task_ref.clone()),
                    label: None,
                },
                to: EntityRef {
                    kind: "worktree".into(),
                    id: worktree.path.clone(),
                    reference: Some(worktree.branch.clone()),
                    label: None,
                },
                evidence: "persisted attempt worktree + Herdr worktree inventory".into(),
            });
        }
    }
    relationships
}

// ---------------------------------------------------------------------------
// OpenCode V2 authenticated GET-only observations
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inspect::sources::{BaseRead, LiveRead};
    use std::collections::BTreeMap;
    fn link(address: &str) -> TerminalLink {
        TerminalLink {
            core_id: "core".into(),
            address: address.into(),
            name: format!("terminal-{address}"),
            role: "builder".into(),
            created_by_attempt: true,
        }
    }
    fn attempt_record() -> AttemptRecord {
        AttemptRecord {
            task_id: "task-one".into(),
            task_ref: "APP-1".into(),
            workflow: "implementation".into(),
            attempt_id: "a1".into(),
            generation: 0,
            origin: Origin::CentralStore,
            observed_at_ms: 1,
            created_at_ms: 1,
            state: "running".into(),
            execution_mode: "worktrees".into(),
            backend: "hc".into(),
            core_id: "core".into(),
            terminal: link("w1:p1"),
            coordinator_terminal: TerminalLink::default(),
            babysitter_terminal: link("w1:p2"),
            branch: "app/dispatch-task-one".into(),
            worktree: "/repo/wt".into(),
            worktree_created_by_attempt: true,
            agent: "build".into(),
            model: "provider/model".into(),
            coordinator_agent: "orchestrator".into(),
            coordinator_model: "provider/model".into(),
            coordinator_session_id: "ses_coord".into(),
            babysitter: true,
            babysitter_session_id: "ses_baby".into(),
            babysitter_pane: "w1:p2".into(),
            session_id: "ses_primary".into(),
            pane: "w1:p1".into(),
            phases: vec![PhaseRecord {
                task_id: "phase-one".into(),
                reference: "APP-P1".into(),
                title: "phase one".into(),
                branch: String::new(),
                worktree: String::new(),
                terminal: TerminalLink::default(),
                pane: String::new(),
                session_id: "ses_phase".into(),
                state: "running".into(),
                commit: String::new(),
                integrated_commit: String::new(),
            }],
        }
    }
    fn pane(pane_id: &str) -> PaneRecord {
        PaneRecord {
            pane_id: pane_id.into(),
            workspace_id: "w1".into(),
            tab_id: "w1:t1".into(),
            cwd: "/repo/wt".into(),
            agent_profile: Some("opencode".into()),
            agent_status: "idle".into(),
            agent_session_id: None,
            focused: false,
        }
    }
    #[test]
    fn one_to_many_roles_and_pane_less_sessions_are_preserved() {
        let attempt = attempt_record();
        let panes = vec![pane("w1:p1"), pane("w1:p2")];
        let (sessions, warnings) = link_sessions(&[attempt.clone()], &panes);
        assert!(warnings.is_empty());
        let roles = sessions
            .iter()
            .map(|session| (session.session_id.as_str(), session.roles[0]))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(roles.get("ses_primary"), Some(&SessionRole::Primary));
        assert_eq!(roles.get("ses_coord"), Some(&SessionRole::Coordinator));
        assert_eq!(roles.get("ses_baby"), Some(&SessionRole::Babysitter));
        assert_eq!(roles.get("ses_phase"), Some(&SessionRole::PhaseWorker));
        let phase = sessions
            .iter()
            .find(|session| session.session_id == "ses_phase")
            .unwrap();
        assert!(
            phase.pane.is_none(),
            "pane-less phase session keeps no pane"
        );
        let candidates = build_candidates(&[attempt], &panes);
        assert!(candidates.iter().any(|candidate| {
            candidate.pane_id == "w1:p1" && candidate.role == SessionRole::Primary
        }));
        assert!(candidates.iter().any(|candidate| {
            candidate.pane_id == "w1:p2" && candidate.role == SessionRole::Babysitter
        }));
        assert!(
            !candidates
                .iter()
                .any(|candidate| candidate.role == SessionRole::PhaseWorker),
            "an empty phase pane is not a navigation candidate"
        );
    }

    #[test]
    fn fallback_worktrees_deduplicate_nonempty_paths_using_first_owner_data() {
        let first = attempt_record();
        let mut duplicate = attempt_record();
        duplicate.branch = "later-branch".into();
        let mut empty = attempt_record();
        empty.worktree.clear();
        let worktrees = attempt_worktrees(&[first, duplicate, empty]);
        assert_eq!(worktrees.len(), 1);
        assert_eq!(worktrees[0].path, "/repo/wt");
        assert_eq!(worktrees[0].branch, "app/dispatch-task-one");
        assert_eq!(worktrees[0].origin, WorktreeOrigin::Attempt);
    }

    #[test]
    fn conflicts_retain_acceptance_and_topology_evidence_without_state_inference() {
        let mut attempt = attempt_record();
        attempt.state = "running".into();
        let tasks = vec![TaskRecord {
            id: attempt.task_id.clone(),
            reference: attempt.task_ref.clone(),
            title: "done task".into(),
            project: "app".into(),
            status: "done".into(),
            is_epic: false,
            epic_parent: None,
            epic_children: Vec::new(),
            dependencies: Vec::new(),
            blocks: Vec::new(),
            related: Vec::new(),
            plan: PlanMetadata::default(),
            hydrated: true,
            context_observed_at_ms: Some(1),
        }];
        let candidates = build_candidates(&[attempt.clone()], &[]);
        let sessions = vec![SessionRecord {
            session_id: attempt.session_id.clone(),
            roles: vec![SessionRole::Primary],
            task_ids: vec![attempt.task_id.clone()],
            task_refs: vec![attempt.task_ref.clone()],
            workflows: vec![attempt.workflow.clone()],
            attempt_ids: vec![attempt.attempt_id.clone()],
            pane: None,
            api: ApiActivity {
                state: ApiState::Idle,
                ..ApiActivity::unknown()
            },
        }];
        let conflicts = build_conflicts(&tasks, &[attempt], &sessions, &candidates);
        assert!(
            conflicts
                .iter()
                .any(|conflict| conflict.kind == "task_acceptance")
        );
        assert!(
            conflicts
                .iter()
                .any(|conflict| conflict.kind == "execution_state")
        );
        assert!(
            conflicts
                .iter()
                .any(|conflict| conflict.kind == "pane_topology")
        );
    }

    #[test]
    fn assemble_snapshot_is_stable_and_links_relations_in_contract_direction() {
        let attempt = attempt_record();
        let task = |id: &str, reference: &str| TaskRecord {
            id: id.into(),
            reference: reference.into(),
            title: reference.into(),
            project: "app".into(),
            status: "active".into(),
            is_epic: false,
            epic_parent: None,
            epic_children: Vec::new(),
            dependencies: Vec::new(),
            blocks: Vec::new(),
            related: Vec::new(),
            plan: PlanMetadata::default(),
            hydrated: true,
            context_observed_at_ms: Some(1),
        };
        let base = BaseRead {
            scope: Scope {
                project: "app".into(),
                workspace: "default".into(),
                repository: "/repo".into(),
                cwd: "/repo".into(),
                project_source: "test".into(),
                workspace_source: "test".into(),
                core_session: "hc".into(),
            },
            tasks: vec![task("task-two", "APP-2"), task("task-one", "APP-1")],
            attempts: vec![attempt.clone()],
            sources: Vec::new(),
            warnings: Vec::new(),
        };
        let mut second = pane("w2:p2");
        second.workspace_id = "w2".into();
        second.tab_id = "w2:t2".into();
        let live = LiveRead {
            panes: vec![second, pane("w1:p1")],
            workspaces: vec![
                WorkspaceRecord {
                    workspace_id: "w2".into(),
                    label: "two".into(),
                    repo_root: None,
                    checkout_path: None,
                    active_tab_id: String::new(),
                    focused: false,
                },
                WorkspaceRecord {
                    workspace_id: "w1".into(),
                    label: "one".into(),
                    repo_root: None,
                    checkout_path: None,
                    active_tab_id: String::new(),
                    focused: false,
                },
            ],
            worktrees: Vec::new(),
            sessions: link_sessions(&[attempt], &[pane("w1:p1")]).0,
            sources: Vec::new(),
            warnings: Vec::new(),
        };
        let snapshot = assemble(&base, &live, 4242);
        assert_eq!(snapshot.schema, "aven-dispatch-inspect/v1");
        assert_eq!(snapshot.observed_at_ms, 4242);
        assert_eq!(
            snapshot
                .tasks
                .iter()
                .map(|t| t.reference.as_str())
                .collect::<Vec<_>>(),
            vec!["APP-1", "APP-2"]
        );
        assert_eq!(
            snapshot
                .panes
                .iter()
                .map(|p| p.pane_id.as_str())
                .collect::<Vec<_>>(),
            vec!["w1:p1", "w2:p2"]
        );
        assert_eq!(
            snapshot
                .workspaces
                .iter()
                .map(|w| w.workspace_id.as_str())
                .collect::<Vec<_>>(),
            vec!["w1", "w2"]
        );
        assert_eq!(
            snapshot
                .worktrees
                .iter()
                .map(|w| w.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/repo/wt"]
        );
        for (kind, from, to) in [
            ("task_attempt", "task", "attempt"),
            ("attempt_session", "attempt", "session"),
            ("session_pane", "session", "pane"),
            ("pane_workspace", "pane", "workspace"),
            ("attempt_worktree", "attempt", "worktree"),
        ] {
            assert!(
                snapshot
                    .relationships
                    .iter()
                    .any(|r| r.kind == kind && r.from.kind == from && r.to.kind == to),
                "missing {kind}"
            );
        }
    }
}
