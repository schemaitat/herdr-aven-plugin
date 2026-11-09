//! Read-only work-queue projection over the scoped Aven and dispatcher evidence.
//!
//! `inspect --json` is the full structural snapshot and the Kanban board owns
//! live presentation. `work` is the automation-facing lifecycle projection: it
//! answers "what can be dispatched, planned, approved, or landed next?" without
//! mutating Aven, dispatcher state, sessions or Git.
//!
//! The classifier is deliberately pure and small. It reuses the inspector's
//! bounded scoped read (including Aven-recovery attempts and the read-only store)
//! and Aven's authoritative `--ready` list. Live `needs_you` presence is a
//! Kanban-only fact because this command never reads herdr-core terminals.

use crate::inspect::{
    model::{
        ApprovalRecord, AttemptRecord, DeliveryRecord, Limits, PlanMetadata, SourceHealth,
        TaskRecord,
    },
    sources::{self, BaseRead, Options},
};
use crate::process::now;
use anyhow::{Context, Result, bail};
use clap::ValueEnum;
use serde::Serialize;
use std::{collections::BTreeMap, collections::BTreeSet, path::PathBuf};

pub(crate) const SCHEMA: &str = "aven-dispatch-work/v1";
pub(crate) const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 500;
/// One-shot work reads hydrate the whole scoped list, still bounded by the
/// shared Aven list cap and source timeout. The inspector keeps its smaller
/// incremental budget because it runs per refresh cycle.
const WORK_CONTEXT_ADMISSION: usize = 500;

const WORKING_STATES: [&str; 10] = [
    "running",
    "waiting",
    "starting",
    "queued",
    "workspace-pending",
    "session-pending",
    "terminal-pending",
    "prompt-pending",
    "babysitter-session-pending",
    "babysitter-prompt-pending",
];
const REVIEW_STATES: [&str; 2] = ["needs-review", "completed"];
const STOPPED_FAILURE_STATES: [&str; 3] = ["failed", "interrupted", "reconciled"];
const TERMINAL_STATUSES: [&str; 2] = ["done", "canceled"];
const SETTLED_DELIVERY_STATES: [&str; 4] = ["merged", "not-applicable", "superseded", "waived"];

/// Lifecycle stage. The order is the order a person or automation should read:
/// ship first, then review, then startable work, then in-flight and waiting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, ValueEnum, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkStage {
    Land,
    Review,
    Dispatch,
    Plan,
    Working,
    Waiting,
    Blocked,
    Unknown,
    Done,
}

impl WorkStage {
    pub(crate) const ALL: [Self; 9] = [
        Self::Land,
        Self::Review,
        Self::Dispatch,
        Self::Plan,
        Self::Working,
        Self::Waiting,
        Self::Blocked,
        Self::Unknown,
        Self::Done,
    ];
    fn id(self) -> &'static str {
        match self {
            Self::Land => "land",
            Self::Review => "review",
            Self::Dispatch => "dispatch",
            Self::Plan => "plan",
            Self::Working => "working",
            Self::Waiting => "waiting",
            Self::Blocked => "blocked",
            Self::Unknown => "unknown",
            Self::Done => "done",
        }
    }
    fn title(self) -> &'static str {
        match self {
            Self::Land => "READY TO LAND",
            Self::Review => "REVIEW",
            Self::Dispatch => "READY TO DISPATCH",
            Self::Plan => "NEEDS A PLAN",
            Self::Working => "WORKING",
            Self::Waiting => "WAITING",
            Self::Blocked => "BLOCKED",
            Self::Unknown => "UNKNOWN",
            Self::Done => "DONE",
        }
    }
    /// The same column names the interactive Kanban read model uses.
    fn column(self) -> &'static str {
        match self {
            Self::Land | Self::Review => "ready",
            Self::Working => "working",
            Self::Done => "done",
            Self::Dispatch | Self::Plan | Self::Waiting | Self::Blocked | Self::Unknown => {
                "backlog"
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkAction {
    Merge,
    Approve,
    Dispatch,
    Plan,
    Watch,
    Resume,
    None,
}

impl WorkAction {
    fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Approve => "approve",
            Self::Dispatch => "dispatch",
            Self::Plan => "plan",
            Self::Watch => "watch",
            Self::Resume => "resume",
            Self::None => "none",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Classification {
    pub(crate) stage: WorkStage,
    pub(crate) action: WorkAction,
    pub(crate) reason: &'static str,
    pub(crate) detail: String,
}

impl Classification {
    fn new(
        stage: WorkStage,
        action: WorkAction,
        reason: &'static str,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            stage,
            action,
            reason,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkAttempt {
    pub(crate) workflow: String,
    pub(crate) attempt_id: String,
    pub(crate) state: String,
    pub(crate) observation: String,
    pub(crate) contradiction: String,
    pub(crate) execution_mode: String,
    pub(crate) branch: String,
    pub(crate) worktree: String,
    pub(crate) session_id: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkCard {
    #[serde(rename = "ref")]
    pub(crate) reference: String,
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) is_epic: bool,
    pub(crate) stage: WorkStage,
    pub(crate) column: String,
    pub(crate) action: WorkAction,
    pub(crate) reason: String,
    pub(crate) detail: String,
    pub(crate) priority: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) blocked_by: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) parent: Option<String>,
    pub(crate) children: Vec<String>,
    pub(crate) plan: PlanMetadata,
    pub(crate) approval: ApprovalRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) delivery: Option<DeliveryRecord>,
    pub(crate) attempts: Vec<WorkAttempt>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkGroup {
    pub(crate) id: &'static str,
    pub(crate) title: &'static str,
    pub(crate) column: &'static str,
    pub(crate) total: usize,
    pub(crate) cards: Vec<WorkCard>,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkScope {
    pub(crate) project: String,
    pub(crate) workspace: String,
    pub(crate) repository: String,
    pub(crate) cwd: String,
    pub(crate) project_source: String,
    pub(crate) workspace_source: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct WorkReport {
    pub(crate) schema: &'static str,
    pub(crate) observed_at_ms: u64,
    pub(crate) scope: WorkScope,
    pub(crate) limits: Limits,
    pub(crate) card_limit: usize,
    pub(crate) counts: BTreeMap<&'static str, usize>,
    pub(crate) truncated: bool,
    pub(crate) stages: Vec<WorkGroup>,
    pub(crate) sources: Vec<SourceHealth>,
    pub(crate) warnings: Vec<String>,
}

pub(crate) struct WorkArgs {
    pub(crate) store: PathBuf,
    pub(crate) project: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) stages: Vec<WorkStage>,
    pub(crate) limit: usize,
    pub(crate) json: bool,
}

fn is_open(status: &str) -> bool {
    matches!(status, "inbox" | "backlog" | "todo" | "active")
}

fn is_terminal(status: &str) -> bool {
    TERMINAL_STATUSES.contains(&status)
}

/// A stored terminal observation is a checkpoint, not a live fact. All
/// recorded role terminals in a finished/removed state are durable evidence
/// that the attempt is no longer working.
fn attempt_stopped(attempt: &AttemptRecord) -> bool {
    let observed = attempt
        .terminals
        .values()
        .filter(|terminal| !terminal.state.is_empty())
        .collect::<Vec<_>>();
    !observed.is_empty()
        && observed
            .iter()
            .all(|terminal| matches!(terminal.state.as_str(), "finished" | "removed"))
}

fn attempt_working(attempt: &AttemptRecord) -> bool {
    WORKING_STATES.contains(&attempt.state.as_str()) && !attempt_stopped(attempt)
}

fn attempt_review(attempt: &AttemptRecord) -> bool {
    REVIEW_STATES.contains(&attempt.state.as_str())
}

fn attempt_stopped_failure(attempt: &AttemptRecord) -> bool {
    STOPPED_FAILURE_STATES.contains(&attempt.state.as_str())
}

/// Durable lifecycle contradiction published by the dispatcher. A stored
/// `running` state without this marker is a checkpoint, not live evidence; this
/// command never reads herdr-core presence.
fn attempt_contradiction(attempt: &AttemptRecord) -> bool {
    !attempt.contradiction.is_empty()
}

fn delivery_settled(task: &TaskRecord) -> bool {
    task.delivery
        .as_ref()
        .and_then(|delivery| delivery.state.as_deref())
        .is_some_and(|state| SETTLED_DELIVERY_STATES.contains(&state))
}

fn delivery_state(task: &TaskRecord) -> &str {
    task.delivery
        .as_ref()
        .and_then(|delivery| delivery.state.as_deref())
        .unwrap_or("")
}

fn attempt_detail(attempt: &AttemptRecord) -> String {
    if attempt.workflow.is_empty() {
        format!("attempt {} is {}", attempt.attempt_id, attempt.state)
    } else {
        format!(
            "attempt {} ({}) is {}",
            attempt.attempt_id, attempt.workflow, attempt.state
        )
    }
}

/// Classify one scoped task. `ready` comes from Aven's authoritative ready
/// list; `parent` and `children` come from the same bounded task snapshot.
pub(crate) fn classify(
    task: &TaskRecord,
    attempts: &[&AttemptRecord],
    parent: Option<&TaskRecord>,
    children: &[&TaskRecord],
    ready: bool,
) -> Classification {
    let working = attempts
        .iter()
        .copied()
        .find(|attempt| attempt_working(attempt));
    let review = attempts
        .iter()
        .copied()
        .find(|attempt| attempt_review(attempt));
    let stopped = attempts
        .iter()
        .copied()
        .find(|attempt| attempt_stopped_failure(attempt));

    if is_terminal(&task.status) {
        // Only a durable contradiction, not a stale state checkpoint, can
        // challenge terminal Aven acceptance. Live presence is intentionally
        // out of scope for this command.
        if let Some(attempt) = attempts
            .iter()
            .copied()
            .find(|attempt| attempt_contradiction(attempt))
        {
            return Classification::new(
                WorkStage::Blocked,
                WorkAction::None,
                "terminal_execution_contradiction",
                format!(
                    "terminal Aven status conflicts with {}; reconcile or interrupt before closing",
                    attempt_detail(attempt)
                ),
            );
        }
        if task.status == "canceled" {
            return Classification::new(
                WorkStage::Done,
                WorkAction::None,
                "canceled",
                "task is canceled",
            );
        }
        if delivery_settled(task) {
            return Classification::new(
                WorkStage::Done,
                WorkAction::None,
                "delivery_settled",
                format!("delivery is {}", delivery_state(task)),
            );
        }
        if task.approval.is_complete() {
            return Classification::new(
                WorkStage::Land,
                WorkAction::Merge,
                "approved_not_delivered",
                match task.approval.commit.as_deref() {
                    Some(commit) if !commit.is_empty() => {
                        format!("accepted and approved at {commit} but delivery is not settled")
                    }
                    _ => "accepted and approved but delivery is not settled".into(),
                },
            );
        }
        if task.approval.is_approved() {
            return Classification::new(
                WorkStage::Review,
                WorkAction::Approve,
                "approval_incomplete",
                "approval.state is approved but the commit-bound marker is incomplete",
            );
        }
        if let Some(attempt) = review {
            return Classification::new(
                WorkStage::Review,
                WorkAction::Approve,
                "approval_missing",
                format!(
                    "{} finished but no commit-bound approval is recorded",
                    attempt_detail(attempt)
                ),
            );
        }
        return Classification::new(
            WorkStage::Done,
            WorkAction::None,
            "accepted_without_dispatcher_evidence",
            "Aven accepted the task without dispatcher approval evidence",
        );
    }

    if !is_open(&task.status) {
        return Classification::new(
            WorkStage::Unknown,
            WorkAction::None,
            "unknown_status",
            format!("unrecognized Aven status {:?}", task.status),
        );
    }

    if let Some(attempt) = working {
        return Classification::new(
            WorkStage::Working,
            WorkAction::Watch,
            "attempt_running",
            attempt_detail(attempt),
        );
    }
    if let Some(attempt) = review {
        return Classification::new(
            WorkStage::Review,
            WorkAction::Approve,
            "review_execution",
            attempt_detail(attempt),
        );
    }
    if let Some(attempt) = stopped {
        return Classification::new(
            WorkStage::Blocked,
            WorkAction::Resume,
            "attempt_stopped",
            format!(
                "{}; resume or reset before redispatching",
                attempt_detail(attempt)
            ),
        );
    }

    if task.is_epic {
        if !task.hydrated {
            return Classification::new(
                WorkStage::Unknown,
                WorkAction::None,
                "context_not_hydrated",
                "epic plan metadata was not hydrated within the bounded admission window",
            );
        }
        if !task.plan.plan_worked_out {
            if task.blocked_by > 0 {
                return Classification::new(
                    WorkStage::Blocked,
                    WorkAction::None,
                    "dependency_open",
                    format!(
                        "{} open {} still block{} planning",
                        task.blocked_by,
                        if task.blocked_by == 1 {
                            "dependency"
                        } else {
                            "dependencies"
                        },
                        if task.blocked_by == 1 { "s" } else { "" }
                    ),
                );
            }
            return Classification::new(
                WorkStage::Plan,
                WorkAction::Plan,
                "plan_not_worked_out",
                "open epic has no published worked-out plan",
            );
        }
        if children.is_empty() {
            return Classification::new(
                WorkStage::Blocked,
                WorkAction::None,
                "plan_has_no_children",
                "worked-out epic has no phase children; run board hygiene before implementation",
            );
        }
        let open = children
            .iter()
            .filter(|child| is_open(&child.status))
            .count();
        if open == 0 {
            return Classification::new(
                WorkStage::Review,
                WorkAction::Approve,
                "phases_complete",
                "every phase child is done or canceled; accept the root or close out delivery",
            );
        }
        return Classification::new(
            WorkStage::Waiting,
            WorkAction::None,
            "awaiting_phases",
            format!(
                "{open} phase {} still open",
                if open == 1 {
                    "child is"
                } else {
                    "children are"
                }
            ),
        );
    }

    if let Some(parent) = parent {
        if parent.is_epic && !parent.hydrated {
            return Classification::new(
                WorkStage::Unknown,
                WorkAction::None,
                "parent_not_hydrated",
                "the parent epic's plan metadata was not hydrated",
            );
        }
        if parent.is_epic && !parent.plan.plan_worked_out {
            return Classification::new(
                WorkStage::Blocked,
                WorkAction::None,
                "plan_not_worked_out",
                "the parent epic has no published worked-out plan",
            );
        }
    }

    if task.blocked_by > 0 {
        return Classification::new(
            WorkStage::Blocked,
            WorkAction::None,
            "dependency_open",
            format!(
                "{} open {} must finish first",
                task.blocked_by,
                if task.blocked_by == 1 {
                    "dependency"
                } else {
                    "dependencies"
                }
            ),
        );
    }
    if task.status == "active" {
        return Classification::new(
            WorkStage::Working,
            WorkAction::None,
            "aven_active",
            "Aven status is active but no dispatcher attempt was found",
        );
    }
    if !ready {
        return Classification::new(
            WorkStage::Blocked,
            WorkAction::None,
            "not_aven_ready",
            "Aven does not report the task ready (availability, claim or dependency state)",
        );
    }
    Classification::new(
        WorkStage::Dispatch,
        WorkAction::Dispatch,
        "aven_ready",
        "open and Aven-ready with no in-flight attempt",
    )
}

fn work_card(
    task: &TaskRecord,
    classification: Classification,
    attempts: &[&AttemptRecord],
    children: &[&TaskRecord],
) -> WorkCard {
    let mut attempt_summaries = attempts
        .iter()
        .map(|attempt| WorkAttempt {
            workflow: attempt.workflow.clone(),
            attempt_id: attempt.attempt_id.clone(),
            state: attempt.state.clone(),
            observation: attempt.observation.clone(),
            contradiction: attempt.contradiction.clone(),
            execution_mode: attempt.execution_mode.clone(),
            branch: attempt.branch.clone(),
            worktree: attempt.worktree.clone(),
            session_id: attempt.session_id.clone(),
        })
        .collect::<Vec<_>>();
    attempt_summaries.sort_by(|left, right| {
        left.workflow
            .cmp(&right.workflow)
            .then_with(|| left.attempt_id.cmp(&right.attempt_id))
    });
    let mut child_refs = children
        .iter()
        .map(|child| child.reference.clone())
        .collect::<Vec<_>>();
    child_refs.sort();
    WorkCard {
        reference: task.reference.clone(),
        id: task.id.clone(),
        title: task.title.clone(),
        status: task.status.clone(),
        is_epic: task.is_epic,
        stage: classification.stage,
        column: classification.stage.column().into(),
        action: classification.action,
        reason: classification.reason.into(),
        detail: classification.detail,
        priority: task.priority.clone(),
        created_at: task.created_at.clone(),
        updated_at: task.updated_at.clone(),
        blocked_by: task.blocked_by,
        parent: task
            .epic_parent
            .as_ref()
            .and_then(|parent| parent.reference.clone())
            .filter(|reference| !reference.is_empty()),
        children: child_refs,
        plan: task.plan.clone(),
        approval: task.approval.clone(),
        delivery: task.delivery.clone(),
        attempts: attempt_summaries,
    }
}

pub(crate) fn build_report(
    base: &BaseRead,
    ready_ids: &BTreeSet<String>,
    stages: &[WorkStage],
    limit: usize,
) -> WorkReport {
    let selected = if stages.is_empty() {
        WorkStage::ALL.to_vec()
    } else {
        let mut seen = BTreeSet::new();
        stages
            .iter()
            .copied()
            .filter(|stage| seen.insert(*stage))
            .collect()
    };
    let tasks_by_id = base
        .tasks
        .iter()
        .map(|task| (task.id.as_str(), task))
        .collect::<BTreeMap<_, _>>();
    let mut attempts_by_task: BTreeMap<&str, Vec<&AttemptRecord>> = BTreeMap::new();
    for attempt in &base.attempts {
        attempts_by_task
            .entry(attempt.task_id.as_str())
            .or_default()
            .push(attempt);
    }
    let mut children_by_parent: BTreeMap<&str, Vec<&TaskRecord>> = BTreeMap::new();
    for task in &base.tasks {
        if let Some(parent) = task.epic_parent.as_ref() {
            children_by_parent
                .entry(parent.id.as_str())
                .or_default()
                .push(task);
        }
    }

    let mut grouped: BTreeMap<WorkStage, Vec<WorkCard>> = BTreeMap::new();
    for task in &base.tasks {
        if task.deleted {
            continue;
        }
        let attempts = attempts_by_task
            .get(task.id.as_str())
            .cloned()
            .unwrap_or_default();
        let parent = task
            .epic_parent
            .as_ref()
            .and_then(|parent| tasks_by_id.get(parent.id.as_str()).copied());
        let children = children_by_parent
            .get(task.id.as_str())
            .cloned()
            .unwrap_or_default();
        let classification = classify(
            task,
            &attempts,
            parent,
            &children,
            ready_ids.contains(&task.id),
        );
        grouped
            .entry(classification.stage)
            .or_default()
            .push(work_card(task, classification, &attempts, &children));
    }

    let mut counts = BTreeMap::new();
    let mut truncated = false;
    let mut warnings = base.warnings.clone();
    let mut groups = Vec::new();
    for stage in &selected {
        let mut cards = grouped.remove(stage).unwrap_or_default();
        cards.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.reference.cmp(&right.reference))
        });
        let total = cards.len();
        counts.insert(stage.id(), total);
        if total > limit {
            truncated = true;
            cards.truncate(limit);
            warnings.push(format!(
                "{total} {} {} matched the {limit}-card cap; raise --limit to see all",
                stage.id(),
                if total == 1 { "card" } else { "cards" }
            ));
        }
        groups.push(WorkGroup {
            id: stage.id(),
            title: stage.title(),
            column: stage.column(),
            total,
            cards,
        });
    }

    WorkReport {
        schema: SCHEMA,
        observed_at_ms: now(),
        scope: WorkScope {
            project: base.scope.project.clone(),
            workspace: base.scope.workspace.clone(),
            repository: base.scope.repository.clone(),
            cwd: base.scope.cwd.clone(),
            project_source: base.scope.project_source.clone(),
            workspace_source: base.scope.workspace_source.clone(),
        },
        limits: Limits {
            context_admissions: WORK_CONTEXT_ADMISSION,
            ..Limits::default()
        },
        card_limit: limit,
        counts,
        truncated,
        stages: groups,
        sources: base.sources.clone(),
        warnings,
    }
}

pub(crate) fn run(args: WorkArgs) -> Result<()> {
    if args.limit == 0 || args.limit > MAX_LIMIT {
        bail!("work --limit must be between 1 and {MAX_LIMIT}");
    }
    let mut options = Options {
        project: args.project,
        workspace: args.workspace,
        cwd: args.cwd,
        store: args.store,
        context_admission: Some(WORK_CONTEXT_ADMISSION),
        ..Default::default()
    };
    let mut base = sources::read_base(&options)
        .context("read the scoped Aven/dispatcher work evidence; nothing was changed")?;
    let approved_done = sources::read_approved_done_ids(&base.scope)
        .context("read Aven's approved done tasks; nothing was changed")?
        .into_iter()
        .collect::<BTreeSet<_>>();
    // A large project can exceed the one-shot hydration budget. The ship queue
    // and plan stages are the only consumers that need metadata for tasks whose
    // incremental admission may not have reached them yet; pin those exact ids
    // and make one bounded second pass against the warm context cache.
    let priority = base
        .tasks
        .iter()
        .filter(|task| {
            !task.hydrated
                && (task.is_epic || (task.status == "done" && approved_done.contains(&task.id)))
        })
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    if !priority.is_empty() {
        options.priority_tasks = priority;
        base = sources::read_base(&options)
            .context("hydrate prioritized work evidence; nothing was changed")?;
    }
    let ready = sources::read_ready_ids(&base.scope)
        .context("read Aven's authoritative ready-task list; nothing was changed")?;
    let ready = ready.into_iter().collect::<BTreeSet<_>>();
    let report = build_report(&base, &ready, &args.stages, args.limit);
    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print_human(&report);
    }
    Ok(())
}

fn print_human(report: &WorkReport) {
    println!(
        "scope: project={} workspace={} repository={}",
        report.scope.project, report.scope.workspace, report.scope.repository
    );
    let mut printed = 0;
    for group in &report.stages {
        println!("{} ({}) {}", group.id, group.column, group.total);
        for card in &group.cards {
            printed += 1;
            println!(
                "  {} [{}] {} {} — {}",
                card.reference,
                card.action.as_str(),
                card.reason,
                card.detail,
                card.title
            );
        }
    }
    if printed == 0 {
        println!("work clean: no tasks in the selected stages");
    }
    if report.truncated {
        println!(
            "truncated: output is capped at {} cards per stage",
            report.card_limit
        );
    }
    for warning in &report.warnings {
        println!("warning: {warning}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inspect::model::{
        ApprovalRecord, AttemptRecord, DeliveryRecord, Origin, PlanMetadata, SourceHealth,
        TaskRecord, TerminalObservationRecord,
    };

    fn task(id: &str, reference: &str, status: &str) -> TaskRecord {
        TaskRecord {
            id: id.into(),
            reference: reference.into(),
            title: reference.into(),
            project: "app".into(),
            status: status.into(),
            is_epic: false,
            deleted: false,
            priority: "none".into(),
            available_at: String::new(),
            due_on: String::new(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            epic_parent: None,
            epic_children: Vec::new(),
            dependencies: Vec::new(),
            blocks: Vec::new(),
            related: Vec::new(),
            blocked_by: 0,
            plan: PlanMetadata::default(),
            delivery: None,
            approval: ApprovalRecord::default(),
            hydrated: true,
            context_observed_at_ms: Some(1),
        }
    }

    fn attempt(state: &str) -> AttemptRecord {
        AttemptRecord {
            task_id: "task".into(),
            task_ref: "APP-1".into(),
            workflow: "implementation".into(),
            attempt_id: "att-1".into(),
            generation: 0,
            origin: Origin::CentralStore,
            observed_at_ms: 1,
            created_at_ms: 1,
            state: state.into(),
            execution_mode: "single-session".into(),
            observation: String::new(),
            contradiction: String::new(),
            backend: "hc".into(),
            core_id: String::new(),
            terminal: Default::default(),
            coordinator_terminal: Default::default(),
            babysitter_terminal: Default::default(),
            branch: "b".into(),
            worktree: "/tmp/w".into(),
            worktree_created_by_attempt: true,
            agent: String::new(),
            model: String::new(),
            coordinator_agent: String::new(),
            coordinator_model: String::new(),
            coordinator_session_id: String::new(),
            babysitter: false,
            babysitter_session_id: String::new(),
            babysitter_pane: String::new(),
            session_id: "ses_1".into(),
            pane: String::new(),
            log_task_ref: String::new(),
            terminals: BTreeMap::new(),
            phases: Vec::new(),
        }
    }

    fn approved(commit: &str) -> ApprovalRecord {
        ApprovalRecord {
            state: Some("approved".into()),
            id: Some("approval-1".into()),
            commit: Some(commit.into()),
            workflow: Some("implementation".into()),
        }
    }

    fn classification(task: &TaskRecord, attempts: &[&AttemptRecord]) -> Classification {
        classify(task, attempts, None, &[], false)
    }

    #[test]
    fn approved_done_work_is_ready_to_land() {
        let mut task = task("task", "APP-1", "done");
        task.approval = approved("deadbeef");
        let result = classification(&task, &[]);
        assert_eq!(result.stage, WorkStage::Land);
        assert_eq!(result.action, WorkAction::Merge);
        assert_eq!(result.reason, "approved_not_delivered");
    }

    #[test]
    fn settled_delivery_and_cancellation_are_done() {
        let mut merged = task("task", "APP-1", "done");
        merged.approval = approved("deadbeef");
        merged.delivery = Some(DeliveryRecord {
            state: Some("merged".into()),
            ..DeliveryRecord::default()
        });
        let result = classification(&merged, &[]);
        assert_eq!(result.stage, WorkStage::Done);
        assert_eq!(result.reason, "delivery_settled");

        let canceled = task("task", "APP-2", "canceled");
        assert_eq!(classification(&canceled, &[]).stage, WorkStage::Done);
        assert_eq!(classification(&canceled, &[]).reason, "canceled");
    }

    #[test]
    fn incomplete_approval_and_review_execution_need_approval() {
        let mut incomplete = task("task", "APP-1", "done");
        incomplete.approval = ApprovalRecord {
            state: Some("approved".into()),
            ..ApprovalRecord::default()
        };
        let result = classification(&incomplete, &[]);
        assert_eq!(result.stage, WorkStage::Review);
        assert_eq!(result.action, WorkAction::Approve);
        assert_eq!(result.reason, "approval_incomplete");

        let attempt = attempt("needs-review");
        let result = classification(&task("task", "APP-2", "done"), &[&attempt]);
        assert_eq!(result.stage, WorkStage::Review);
        assert_eq!(result.reason, "approval_missing");
    }

    #[test]
    fn terminal_execution_contradiction_is_blocked_not_done() {
        let mut attempt = attempt("running");
        attempt.contradiction = "terminal_live_execution".into();
        let result = classification(&task("task", "APP-1", "done"), &[&attempt]);
        assert_eq!(result.stage, WorkStage::Blocked);
        assert_eq!(result.reason, "terminal_execution_contradiction");
    }

    #[test]
    fn ready_open_task_is_dispatchable_and_unready_is_blocked() {
        let task = task("task", "APP-1", "todo");
        let result = classify(&task, &[], None, &[], true);
        assert_eq!(result.stage, WorkStage::Dispatch);
        assert_eq!(result.action, WorkAction::Dispatch);
        assert_eq!(result.reason, "aven_ready");

        let result = classify(&task, &[], None, &[], false);
        assert_eq!(result.stage, WorkStage::Blocked);
        assert_eq!(result.reason, "not_aven_ready");

        let mut blocked = task.clone();
        blocked.blocked_by = 2;
        let result = classify(&blocked, &[], None, &[], false);
        assert_eq!(result.reason, "dependency_open");
    }

    #[test]
    fn working_and_stopped_attempts_are_distinguished() {
        let task = task("task", "APP-1", "active");
        let live = attempt("running");
        assert_eq!(classification(&task, &[&live]).stage, WorkStage::Working);

        let mut stopped = attempt("running");
        stopped.terminals.insert(
            "builder".into(),
            TerminalObservationRecord {
                state: "finished".into(),
                ..TerminalObservationRecord::default()
            },
        );
        let result = classification(&task, &[&stopped]);
        // A running state with all role terminals stopped falls through to the
        // Aven active rule instead of claiming live work.
        assert_eq!(result.stage, WorkStage::Working);
        assert_eq!(result.reason, "aven_active");

        let failed = attempt("failed");
        let result = classification(&task, &[&failed]);
        assert_eq!(result.stage, WorkStage::Blocked);
        assert_eq!(result.action, WorkAction::Resume);
        assert_eq!(result.reason, "attempt_stopped");
    }

    #[test]
    fn active_task_without_attempt_is_working_but_not_dispatchable() {
        let mut task = task("task", "APP-1", "active");
        task.blocked_by = 0;
        let result = classify(&task, &[], None, &[], true);
        assert_eq!(result.stage, WorkStage::Working);
        assert_eq!(result.action, WorkAction::None);
        assert_eq!(result.reason, "aven_active");
    }

    #[test]
    fn epics_plan_then_wait_or_review_their_phases() {
        let mut epic = task("epic", "APP-EPIC", "todo");
        epic.is_epic = true;
        let result = classify(&epic, &[], None, &[], false);
        assert_eq!(result.stage, WorkStage::Plan);
        assert_eq!(result.action, WorkAction::Plan);
        assert_eq!(result.reason, "plan_not_worked_out");

        epic.plan.plan_worked_out = true;
        let result = classify(&epic, &[], None, &[], false);
        assert_eq!(result.stage, WorkStage::Blocked);
        assert_eq!(result.reason, "plan_has_no_children");

        let open_child = task("child", "APP-1", "todo");
        let result = classify(&epic, &[], None, &[&open_child], false);
        assert_eq!(result.stage, WorkStage::Waiting);
        assert_eq!(result.reason, "awaiting_phases");

        let done_child = task("child", "APP-1", "done");
        let result = classify(&epic, &[], None, &[&done_child], false);
        assert_eq!(result.stage, WorkStage::Review);
        assert_eq!(result.reason, "phases_complete");
    }

    #[test]
    fn child_of_an_unplanned_epic_is_blocked() {
        let mut epic = task("epic", "APP-EPIC", "todo");
        epic.is_epic = true;
        let child = task("child", "APP-1", "todo");
        let result = classify(&child, &[], Some(&epic), &[], true);
        assert_eq!(result.stage, WorkStage::Blocked);
        assert_eq!(result.reason, "plan_not_worked_out");
    }

    #[test]
    fn unhydrated_epic_and_parent_are_unknown() {
        let mut epic = task("epic", "APP-EPIC", "todo");
        epic.is_epic = true;
        epic.hydrated = false;
        assert_eq!(classification(&epic, &[]).reason, "context_not_hydrated");

        let mut parent = task("epic", "APP-EPIC", "todo");
        parent.is_epic = true;
        parent.hydrated = false;
        let child = task("child", "APP-1", "todo");
        assert_eq!(
            classify(&child, &[], Some(&parent), &[], true).reason,
            "parent_not_hydrated"
        );
    }

    #[test]
    fn report_filters_orders_and_truncates_without_mutating_counts() {
        let mut ready = task("b", "APP-B", "todo");
        ready.updated_at = "2026-01-01T00:00:00Z".into();
        let mut newer = task("a", "APP-A", "todo");
        newer.updated_at = "2026-01-02T00:00:00Z".into();
        let land = {
            let mut task = task("c", "APP-C", "done");
            task.approval = approved("deadbeef");
            task
        };
        let base = BaseRead {
            scope: crate::inspect::model::Scope {
                project: "app".into(),
                workspace: "default".into(),
                repository: "/repo".into(),
                cwd: "/repo".into(),
                project_source: "explicit".into(),
                workspace_source: "default".into(),
                core_session: "hc".into(),
            },
            tasks: vec![ready, newer, land],
            attempts: Vec::new(),
            sources: vec![SourceHealth::ok("aven", "test")],
            warnings: Vec::new(),
        };
        let ready_ids = ["a", "b"].into_iter().map(str::to_owned).collect();
        let report = build_report(&base, &ready_ids, &[WorkStage::Dispatch], 1);
        assert_eq!(report.schema, SCHEMA);
        assert!(report.truncated);
        assert_eq!(report.counts.get("dispatch"), Some(&2));
        assert_eq!(report.stages.len(), 1);
        assert_eq!(report.stages[0].cards[0].reference, "APP-A");
        assert!(
            report
                .warnings
                .iter()
                .any(|warning| warning.contains("2 dispatch cards"))
        );
    }

    #[test]
    fn report_keeps_selected_empty_groups() {
        let base = BaseRead {
            scope: crate::inspect::model::Scope {
                project: "app".into(),
                workspace: "default".into(),
                repository: "/repo".into(),
                cwd: "/repo".into(),
                project_source: "explicit".into(),
                workspace_source: "default".into(),
                core_session: "hc".into(),
            },
            tasks: Vec::new(),
            attempts: Vec::new(),
            sources: Vec::new(),
            warnings: Vec::new(),
        };
        let report = build_report(&base, &BTreeSet::new(), &[WorkStage::Land], 100);
        assert_eq!(report.stages.len(), 1);
        assert_eq!(report.stages[0].id, "land");
        assert!(report.stages[0].cards.is_empty());
        assert_eq!(report.counts.get("land"), Some(&0));
    }
}
