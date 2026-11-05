//! Scoped, read-only lifecycle audit.
//!
//! Audit never opens a migrating dispatcher store, never changes Aven, and
//! never substitutes a missing source for a clean result. Exit contract:
//! 0 = complete and clean, 1 = violations, 2 = incomplete/unknown required
//! source (findings are still reported).

use super::{closeout::invocation, lifecycle::status_is_terminal};
use crate::{
    model::Attempt,
    process::{aven, run_bounded},
    store::read_only::{read_only_effects, read_only_store_payloads},
};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Duration,
};

const AUDIT_TASK_LIMIT: usize = 2_000;
const AUDIT_CONTEXT_LIMIT: usize = 800;
const AUDIT_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const AUDIT_TIMEOUT_MS: u64 = 8_000;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Severity {
    Violation,
    Advisory,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Finding {
    pub(crate) code: String,
    pub(crate) severity: Severity,
    pub(crate) task: String,
    pub(crate) task_id: String,
    pub(crate) message: String,
    pub(crate) action: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Coverage {
    pub(crate) source: String,
    pub(crate) status: String,
    pub(crate) message: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct AuditReport {
    pub(crate) schema: String,
    pub(crate) project: String,
    pub(crate) workspace: String,
    pub(crate) repository: String,
    pub(crate) observed_at_ms: u64,
    pub(crate) complete: bool,
    pub(crate) findings: Vec<Finding>,
    pub(crate) coverage: Vec<Coverage>,
}

pub(crate) struct AuditArgs {
    pub(crate) project: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) store: PathBuf,
    pub(crate) repository: Option<String>,
    pub(crate) json: bool,
}

#[derive(Debug, Clone)]
struct TaskInfo {
    id: String,
    reference: String,
    status: String,
    is_epic: bool,
    deleted: bool,
    metadata: BTreeMap<String, String>,
    related: Vec<String>,
    epic_children: Vec<String>,
}

impl TaskInfo {
    fn from_context(context: &Value) -> Option<Self> {
        let id = context.pointer("/task/id")?.as_str()?.to_owned();
        let reference = context
            .pointer("/task/display_ref")
            .or_else(|| context.pointer("/task/ref"))
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_owned();
        let metadata = context
            .get("metadata")
            .and_then(Value::as_object)
            .map(|metadata| {
                metadata
                    .iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|value| (key.clone(), value.to_owned()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let related = context
            .get("related")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|related| {
                related
                    .get("display_ref")
                    .or_else(|| related.get("ref"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();
        let epic_children = context
            .get("epic_children")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|child| child.get("ref").and_then(Value::as_str).map(str::to_owned))
            .collect();
        Some(Self {
            id,
            reference,
            status: context
                .pointer("/task/status")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            is_epic: context
                .pointer("/task/is_epic")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            deleted: context
                .pointer("/task/deleted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            metadata,
            related,
            epic_children,
        })
    }
    fn metadata(&self, key: &str) -> Option<&str> {
        self.metadata.get(key).map(String::as_str)
    }
}

fn list_scoped(
    invocation: &crate::model::Invocation,
    project: &str,
    all: bool,
) -> Result<Vec<Value>> {
    let mut args = vec![
        "list".to_owned(),
        "--project".into(),
        project.into(),
        "--json".into(),
        "--limit".into(),
        AUDIT_TASK_LIMIT.to_string(),
    ];
    if all {
        args.push("--all".into());
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = aven(invocation, &refs, None)?;
    serde_json::from_str(&output).context("Aven list --json output")
}

fn task_ref_from_list(task: &Value) -> Option<String> {
    task.get("ref")
        .or_else(|| task.get("display_ref"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn read_git(repository: &str, args: &[&str]) -> Result<String> {
    let mut full = vec!["-C".to_owned(), repository.to_owned()];
    full.extend(args.iter().map(|value| (*value).to_owned()));
    run_bounded(
        "git",
        &full,
        None,
        Duration::from_millis(AUDIT_TIMEOUT_MS),
        AUDIT_OUTPUT_LIMIT,
    )
}

fn add(
    findings: &mut Vec<Finding>,
    code: &str,
    severity: Severity,
    task: &TaskInfo,
    message: String,
    action: &str,
) {
    findings.push(Finding {
        code: code.into(),
        severity,
        task: task.reference.clone(),
        task_id: task.id.clone(),
        message,
        action: action.into(),
    });
}

pub(crate) fn run(args: AuditArgs) -> Result<()> {
    let invocation = invocation(args.workspace.clone());
    let workspace = args
        .workspace
        .clone()
        .or_else(|| std::env::var("AVEN_WORKSPACE").ok())
        .unwrap_or_else(|| "default".into());
    let repository = args.repository.clone().unwrap_or_else(|| {
        args.cwd
            .canonicalize()
            .unwrap_or_else(|_| args.cwd.clone())
            .display()
            .to_string()
    });
    let project = args.project.clone().or_else(|| {
        Path::new(&repository)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    });
    let project =
        project.context("audit requires --project when the repository name is unusable")?;
    let mut coverage = Vec::new();
    let mut complete = true;
    let mut findings = Vec::new();

    let listed = match list_scoped(&invocation, &project, true) {
        Ok(tasks) => {
            coverage.push(Coverage {
                source: "aven".into(),
                status: "ok".into(),
                message: format!("{} task(s) listed in project {project}", tasks.len()),
            });
            tasks
        }
        Err(error) => {
            complete = false;
            coverage.push(Coverage {
                source: "aven".into(),
                status: "unavailable".into(),
                message: format!("{error:#}"),
            });
            Vec::new()
        }
    };
    let mut tasks: BTreeMap<String, TaskInfo> = BTreeMap::new();
    let mut context_failures = 0;
    for reference in listed.iter().filter_map(task_ref_from_list) {
        match super::aven::refresh_task_by_ref(&invocation, &reference) {
            Ok(context) => {
                if let Some(task) = TaskInfo::from_context(&context) {
                    tasks.insert(task.id.clone(), task);
                }
            }
            Err(_) => context_failures += 1,
        }
        if tasks.len() >= AUDIT_CONTEXT_LIMIT {
            break;
        }
    }
    if context_failures > 0 || tasks.len() < listed.len().min(AUDIT_CONTEXT_LIMIT) {
        complete = false;
        coverage.push(Coverage {
            source: "aven-context".into(),
            status: "incomplete".into(),
            message: format!(
                "{} of {} task contexts hydrated",
                tasks.len(),
                listed.len().min(AUDIT_CONTEXT_LIMIT)
            ),
        });
    } else {
        coverage.push(Coverage {
            source: "aven-context".into(),
            status: "ok".into(),
            message: format!("{} task context(s) hydrated", tasks.len()),
        });
    }

    // Operational records are included only when a verified store attempt or a
    // scoped task owns them. Other projects are never swept.
    let mut attempts = Vec::new();
    match read_only_store_payloads(&args.store, AUDIT_TASK_LIMIT) {
        Ok(payloads) => {
            for payload in payloads {
                if let Ok(attempt) = serde_json::from_str::<Attempt>(&payload) {
                    attempts.push(attempt);
                }
            }
            coverage.push(Coverage {
                source: "dispatcher-store".into(),
                status: "ok".into(),
                message: format!("{} attempt(s) read read-only", attempts.len()),
            });
        }
        Err(error) => {
            complete = false;
            coverage.push(Coverage {
                source: "dispatcher-store".into(),
                status: "unavailable".into(),
                message: format!("{error:#}"),
            });
        }
    }
    let effects = match read_only_effects(&args.store, AUDIT_TASK_LIMIT) {
        Ok(effects) => Some(effects),
        Err(_) => {
            if !args.store.exists() {
                complete = false;
            }
            None
        }
    };
    let attempt_ids = attempts
        .iter()
        .map(|attempt| attempt.attempt_id.clone())
        .collect::<BTreeSet<_>>();
    for project_name in ["dispatcher-logs", "dispatcher-recovery"] {
        let Ok(operational) = list_scoped(&invocation, project_name, false) else {
            continue;
        };
        for reference in operational.iter().filter_map(task_ref_from_list) {
            let Ok(context) = super::aven::refresh_task_by_ref(&invocation, &reference) else {
                continue;
            };
            let Some(task) = TaskInfo::from_context(&context) else {
                continue;
            };
            let owned = task
                .metadata("dispatch.attempt-id")
                .is_some_and(|attempt| attempt_ids.contains(attempt))
                || task
                    .related
                    .iter()
                    .any(|related| tasks.values().any(|source| source.reference == *related));
            if owned && !tasks.contains_key(&task.id) {
                tasks.insert(task.id.clone(), task);
            }
        }
    }

    let attempts_by_task = attempts.iter().fold(
        BTreeMap::<String, Vec<&Attempt>>::new(),
        |mut map, attempt| {
            map.entry(attempt.task_id.clone())
                .or_default()
                .push(attempt);
            map
        },
    );
    let obligations = tasks
        .values()
        .filter_map(|task| {
            task.metadata("delivery.obligation-for")
                .map(|source| (source.to_owned(), task))
        })
        .collect::<Vec<_>>();

    for task in tasks.values() {
        if task.deleted {
            continue;
        }
        let terminal = status_is_terminal(&task.status);
        let task_attempts = attempts_by_task.get(&task.id).cloned().unwrap_or_default();

        // F1 — accepted code without verified delivery or a mapped obligation.
        let aggregates_child_delivery = task.is_epic && !task.epic_children.is_empty();
        if task.status == "done" && !aggregates_child_delivery {
            let state = task.metadata("delivery.state");
            if !matches!(
                state,
                Some("merged" | "not-applicable" | "superseded" | "waived")
            ) {
                let open_obligation = obligations.iter().any(|(source, obligation)| {
                    *source == task.reference
                        && !matches!(obligation.status.as_str(), "done" | "canceled")
                });
                if !task_attempts.is_empty() || state.is_some() {
                    if open_obligation {
                        add(
                            &mut findings,
                            "delivery_pending",
                            Severity::Advisory,
                            task,
                            format!(
                                "accepted result has delivery state {:?} and a mapped open obligation",
                                state.unwrap_or("none")
                            ),
                            "complete closeout after the human-triggered merge",
                        );
                    } else {
                        add(
                            &mut findings,
                            "delivery_missing",
                            Severity::Violation,
                            task,
                            "accepted result has no verified delivery state and no mapped open obligation"
                                .into(),
                            "run aven-dispatch closeout, then integrate and re-run it with --apply",
                        );
                    }
                } else if state.is_none() {
                    add(
                        &mut findings,
                        "delivery_unknown",
                        Severity::Advisory,
                        task,
                        "accepted task has no dispatcher result or delivery disposition".into(),
                        "record an explicit no-code/planning disposition with closeout --not-applicable",
                    );
                }
            }
        }

        // F2/F3 — terminal execution contradictions and pending sync.
        if terminal {
            for attempt in &task_attempts {
                let running = matches!(
                    attempt.state.as_str(),
                    "running"
                        | "waiting"
                        | "workspace-pending"
                        | "session-pending"
                        | "terminal-pending"
                        | "prompt-pending"
                        | "babysitter-session-pending"
                        | "babysitter-prompt-pending"
                        | "needs-review"
                        | "failed"
                );
                if running || !attempt.lifecycle.contradiction.is_empty() {
                    add(
                        &mut findings,
                        "terminal_execution_contradiction",
                        Severity::Violation,
                        task,
                        format!(
                            "terminal task retains attempt {} state={} contradiction={}",
                            attempt.attempt_id,
                            attempt.state,
                            if attempt.lifecycle.contradiction.is_empty() {
                                "none"
                            } else {
                                &attempt.lifecycle.contradiction
                            }
                        ),
                        "reconcile with live evidence; resolve or interrupt under explicit approval",
                    );
                }
                if attempt.aven_update_pending {
                    add(
                        &mut findings,
                        "pending_synchronization",
                        Severity::Violation,
                        task,
                        format!(
                            "attempt {} still has a pending Aven publication",
                            attempt.attempt_id
                        ),
                        "reconcile and verify read-back before closeout",
                    );
                }
            }
        }
        if let Some(effects) = &effects {
            for effect in effects.iter().filter(|effect| {
                effect.task_id == task.id && matches!(effect.state.as_str(), "pending" | "unknown")
            }) {
                add(
                    &mut findings,
                    "pending_effect",
                    Severity::Violation,
                    task,
                    format!(
                        "effect {} ({}) is {}; inspect before retrying",
                        effect.operation_id, effect.kind, effect.state
                    ),
                    "inspect the scoped external evidence and reconcile; do not blindly retry",
                );
            }
        }

        // F4 — board shape / plan persistence.
        if status_is_open_status(&task.status) {
            if task.is_epic && task.epic_children.is_empty() {
                add(
                    &mut findings,
                    "childless_epic",
                    Severity::Violation,
                    task,
                    "open epic has no phase children and hides actionable work from --ready".into(),
                    "run aven-dispatch board; return it to a non-epic idea until a worked-out plan exists",
                );
            } else if task.is_epic && task.metadata("sdd.plan-worked-out") != Some("true") {
                add(
                    &mut findings,
                    "incomplete_plan",
                    Severity::Violation,
                    task,
                    "epic has children but sdd.plan-worked-out=true was never published".into(),
                    "resume planning and publish worked-out last",
                );
            }
        }

        // F5 — cancellation decisions.
        if task.status == "canceled" {
            let reason = task.metadata("disposition.reason");
            let successor = task.metadata("disposition.successor");
            let no_successor = task.metadata("disposition.no-successor") == Some("true");
            if reason.is_none() || (!no_successor && successor.is_none()) {
                add(
                    &mut findings,
                    "cancellation_incomplete",
                    Severity::Violation,
                    task,
                    "canceled task lacks a durable reason and successor/no-successor decision"
                        .into(),
                    "use aven-dispatch disposition --apply with --reason and --successor/--no-successor",
                );
            }
        }

        // F6 — root closed with unresolved obligations.
        if task.is_epic && task.status == "done" {
            for child_ref in &task.epic_children {
                let Some(child) = tasks
                    .values()
                    .find(|candidate| candidate.reference == *child_ref)
                else {
                    add(
                        &mut findings,
                        "root_closed_with_obligations",
                        Severity::Violation,
                        task,
                        format!("closed root child {child_ref} is not in the scoped evidence"),
                        "re-hydrate the child and verify its disposition",
                    );
                    continue;
                };
                if !matches!(child.status.as_str(), "done" | "canceled") {
                    add(
                        &mut findings,
                        "root_closed_with_obligations",
                        Severity::Violation,
                        task,
                        format!("closed root child {child_ref} is {}", child.status),
                        "leave the root open until every child is accepted or canceled",
                    );
                } else if child.status == "done"
                    && !matches!(
                        child.metadata("delivery.state"),
                        Some("merged" | "not-applicable" | "superseded" | "waived")
                    )
                {
                    add(
                        &mut findings,
                        "root_closed_with_obligations",
                        Severity::Violation,
                        task,
                        format!(
                            "closed root child {child_ref} has delivery state {:?}",
                            child.metadata("delivery.state")
                        ),
                        "resolve the child delivery obligation before closing the root",
                    );
                }
                if child.status == "done"
                    && let Some((_, obligation)) =
                        obligations.iter().find(|(source, obligation)| {
                            source == &child.reference
                                && !matches!(obligation.status.as_str(), "done" | "canceled")
                        })
                {
                    add(
                        &mut findings,
                        "root_closed_with_obligations",
                        Severity::Violation,
                        task,
                        format!(
                            "closed root child {child_ref} retains open delivery obligation {} ({})",
                            obligation.reference, obligation.status
                        ),
                        "resolve the matching delivery obligation before closing the root",
                    );
                }
            }
        }

        // F7 — active log for proven stopped execution.
        if task.metadata("dispatch.attempt-id").is_some()
            && task.status == "active"
            && task.reference.starts_with("DL-")
        {
            let attempt_id = task.metadata("dispatch.attempt-id").unwrap_or_default();
            if let Some(attempt) = attempts
                .iter()
                .find(|attempt| attempt.attempt_id == attempt_id)
                && matches!(
                    attempt.lifecycle.observation.as_str(),
                    "stopped-success" | "stopped-failure" | "stopped-interrupted"
                )
            {
                add(
                    &mut findings,
                    "log_active_stopped",
                    Severity::Violation,
                    task,
                    format!("active log belongs to stopped attempt {attempt_id}"),
                    "reconcile the log from proven stopped execution",
                );
            }
        }

        // F8 — recovery evidence. Absence from the local store is a candidate,
        // never proof of orphanhood.
        if task.reference.starts_with("DR-")
            && !matches!(task.status.as_str(), "canceled")
            && task.metadata("recovery.retained") != Some("true")
        {
            let attempt_id = task.metadata("dispatch.attempt-id").unwrap_or_default();
            if attempt_id.is_empty() {
                add(
                    &mut findings,
                    "recovery_unknown",
                    Severity::Advisory,
                    task,
                    "recovery record has no attempt identity; external absence is not orphan proof"
                        .into(),
                    "retain or retire only with explicit ownership evidence and approval",
                );
            } else if !attempt_ids.contains(attempt_id) {
                add(
                    &mut findings,
                    "recovery_orphan_candidate",
                    Severity::Advisory,
                    task,
                    format!("attempt {attempt_id} is absent from the central store"),
                    "run aven-dispatch recovery to inventory; retire only under explicit approval",
                );
            }
        }
    }

    // F9 — stale/protected worktrees, read with a bounded local Git command.
    match read_git(&repository, &["worktree", "list", "--porcelain"]) {
        Ok(listing) => {
            let owned = attempts
                .iter()
                .flat_map(|attempt| {
                    attempt
                        .phases
                        .iter()
                        .map(|phase| phase.worktree.clone())
                        .chain(std::iter::once(attempt.worktree.clone()))
                })
                .filter(|path| !path.is_empty())
                .collect::<BTreeSet<_>>();
            for entry in listing
                .split("\n\n")
                .filter(|entry| !entry.trim().is_empty())
            {
                let path = entry
                    .lines()
                    .find_map(|line| line.strip_prefix("worktree "))
                    .unwrap_or_default();
                if path.is_empty() || owned.contains(path) {
                    continue;
                }
                let dirty = read_git(path, &["status", "--porcelain"])
                    .map(|status| !status.trim().is_empty())
                    .unwrap_or(true);
                let task = TaskInfo {
                    id: path.to_owned(),
                    reference: path.to_owned(),
                    status: "active".into(),
                    is_epic: false,
                    deleted: false,
                    metadata: BTreeMap::new(),
                    related: Vec::new(),
                    epic_children: Vec::new(),
                };
                if dirty {
                    add(
                        &mut findings,
                        "protected_worktree",
                        Severity::Advisory,
                        &task,
                        "unowned worktree has changes and is preserved".into(),
                        "inspect ownership; never delete dirty/ignored/untracked work automatically",
                    );
                } else {
                    add(
                        &mut findings,
                        "stale_worktree",
                        Severity::Advisory,
                        &task,
                        "clean worktree is not owned by any durable attempt".into(),
                        "optional dry-run cleanup only after explicit human approval",
                    );
                }
            }
            coverage.push(Coverage {
                source: "git-worktrees".into(),
                status: "ok".into(),
                message: "worktree inventory read read-only".into(),
            });
        }
        Err(error) => {
            complete = false;
            coverage.push(Coverage {
                source: "git-worktrees".into(),
                status: "unavailable".into(),
                message: format!("{error:#}"),
            });
        }
    }

    for source in &coverage {
        if source.status != "ok" {
            findings.push(Finding {
                code: "source_unknown".into(),
                severity: Severity::Unknown,
                task: String::new(),
                task_id: String::new(),
                message: format!("{} is {}: {}", source.source, source.status, source.message),
                action:
                    "restore the required source and re-run the audit; findings remain incomplete"
                        .into(),
            });
        }
    }
    let findings = {
        let mut findings = findings;
        findings.sort_by(|left, right| {
            severity_rank(left.severity)
                .cmp(&severity_rank(right.severity))
                .then_with(|| left.task.cmp(&right.task))
                .then_with(|| left.code.cmp(&right.code))
        });
        findings
    };
    let report = AuditReport {
        schema: "aven-dispatch-audit/v1".into(),
        project,
        workspace,
        repository,
        observed_at_ms: crate::process::now(),
        complete,
        findings,
        coverage,
    };
    if args.json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        for finding in &report.findings {
            println!(
                "{:?} {} {}: {} ({})",
                finding.severity, finding.code, finding.task, finding.message, finding.action
            );
        }
        for source in &report.coverage {
            println!(
                "coverage {} {}: {}",
                source.source, source.status, source.message
            );
        }
        println!(
            "audit {}: {} finding(s)",
            if report.complete {
                "complete"
            } else {
                "incomplete"
            },
            report.findings.len()
        );
    }
    let violations = report
        .findings
        .iter()
        .any(|finding| finding.severity == Severity::Violation);
    if !report.complete {
        std::process::exit(2);
    }
    if violations {
        std::process::exit(1);
    }
    Ok(())
}

fn status_is_open_status(status: &str) -> bool {
    super::lifecycle::status_is_open(status)
}

fn severity_rank(severity: Severity) -> u8 {
    match severity {
        Severity::Violation => 0,
        Severity::Advisory => 1,
        Severity::Unknown => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_info_extracts_delivery_and_cancellation_metadata() {
        let task = TaskInfo::from_context(&serde_json::json!({
            "task":{"id":"one","display_ref":"APP-1","title":"one","status":"done","is_epic":false,"deleted":false},
            "metadata":{"delivery.state":"merged","disposition.reason":"superseded"},
            "related":[{"display_ref":"APP-2"}],
            "epic_children":[]
        }))
        .unwrap();
        assert_eq!(task.reference, "APP-1");
        assert_eq!(task.metadata("delivery.state"), Some("merged"));
        assert_eq!(task.related, vec!["APP-2"]);
    }

    #[test]
    fn terminal_statuses_are_never_open() {
        assert!(!status_is_open_status("done"));
        assert!(!status_is_open_status("canceled"));
        assert!(status_is_open_status("todo"));
    }
}
