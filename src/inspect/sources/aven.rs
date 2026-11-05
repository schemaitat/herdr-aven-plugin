//! Bounded read-only Aven task and context source.

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use super::PROJECT_LIMIT;
use super::scope::source_error;
use crate::inspect::model::*;
use crate::process::{now, run_bounded};

#[derive(Debug, Deserialize)]
pub(super) struct AvenProject {
    pub(super) key: String,
    #[serde(default)]
    pub(super) name: String,
}

pub(super) fn project_list(
    workspace: &str,
    cwd: &Path,
    secrets: &[String],
) -> Result<Vec<AvenProject>> {
    let output = aven_read(
        &[
            "project".into(),
            "list".into(),
            "--workspace".into(),
            workspace.into(),
            "--limit".into(),
            PROJECT_LIMIT.to_string(),
            "--json".into(),
        ],
        cwd,
        secrets,
    )?;
    let projects: Vec<AvenProject> = serde_json::from_str(&output)
        .context("Aven project list returned an unsupported payload")?;
    if projects.len() > PROJECT_LIMIT {
        bail!("Aven project list exceeded the {PROJECT_LIMIT}-project limit");
    }
    Ok(projects)
}

// ---------------------------------------------------------------------------
// Aven scoped tasks and contexts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct AvenRef {
    #[serde(default)]
    id: String,
    #[serde(rename = "ref", default)]
    reference: String,
    #[serde(default)]
    pub(super) display_ref: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
}

impl AvenRef {
    fn reference(&self) -> &str {
        if !self.display_ref.is_empty() {
            &self.display_ref
        } else if !self.reference.is_empty() {
            &self.reference
        } else {
            &self.id
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct AvenTask {
    #[serde(default)]
    id: String,
    #[serde(rename = "ref", default)]
    reference: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    project: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    is_epic: bool,
    #[serde(default)]
    epic_parent: Option<AvenRef>,
    #[serde(default)]
    epic_children: Vec<AvenRef>,
    #[serde(default)]
    updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ContextTask {
    #[serde(default)]
    id: String,
    #[serde(default)]
    pub(super) display_ref: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    is_epic: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct Keyed {
    #[serde(default)]
    pub(super) key: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct Dependencies {
    #[serde(default)]
    depends_on: Vec<AvenRef>,
    #[serde(default)]
    blocks: Vec<AvenRef>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Related {
    #[serde(default)]
    task_id: String,
    #[serde(default)]
    display_ref: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct AvenContext {
    #[serde(default)]
    pub(super) task: Option<ContextTask>,
    #[serde(default)]
    project: Keyed,
    #[serde(default)]
    workspace: Keyed,
    #[serde(default)]
    pub(super) metadata: BTreeMap<String, Value>,
    #[serde(default)]
    dependencies: Dependencies,
    #[serde(default)]
    related: Vec<Related>,
    #[serde(default)]
    epic_parent: Option<AvenRef>,
    #[serde(default)]
    epic_children: Vec<AvenRef>,
}

impl AvenContext {
    fn task(&self) -> Result<&ContextTask> {
        self.task
            .as_ref()
            .context("Aven context is missing task details")
    }
    pub(super) fn metadata_strings(&self) -> BTreeMap<String, String> {
        self.metadata
            .iter()
            .filter_map(|(key, value)| {
                value
                    .as_str()
                    .map(|value| (key.clone(), value.to_owned()))
                    .or_else(|| {
                        (!value.is_null() && !value.is_object() && !value.is_array())
                            .then(|| (key.clone(), value.to_string()))
                    })
            })
            .collect()
    }
}

#[cfg(test)]
pub(super) fn test_context(metadata: BTreeMap<String, Value>) -> AvenContext {
    AvenContext {
        task: Some(ContextTask {
            id: "task-one".into(),
            display_ref: "APP-1".into(),
            title: "task one".into(),
            status: "active".into(),
            is_epic: false,
        }),
        project: Keyed { key: "app".into() },
        workspace: Keyed {
            key: "default".into(),
        },
        metadata,
        dependencies: Dependencies::default(),
        related: Vec::new(),
        epic_parent: None,
        epic_children: Vec::new(),
    }
}

struct AvenRead {
    tasks: Vec<TaskRecord>,
    contexts: BTreeMap<String, (AvenContext, u64)>,
    health: SourceHealth,
}

pub(super) fn read_aven(
    scope: &Scope,
    hydration_offset: usize,
    priority_task: Option<&str>,
    secrets: &[String],
) -> Result<(
    Vec<TaskRecord>,
    BTreeMap<String, (AvenContext, u64)>,
    SourceHealth,
)> {
    let (available, upcoming) = thread::scope(|threads| {
        let available = threads.spawn(|| read_list(scope, false, secrets));
        let upcoming = threads.spawn(|| read_list(scope, true, secrets));
        (
            available.join().expect("available list worker"),
            upcoming.join().expect("upcoming list worker"),
        )
    });
    let lists = match (available, upcoming) {
        (Ok(available), Ok(upcoming)) => vec![available, upcoming],
        (Err(error), _) | (_, Err(error)) => {
            return Ok((
                Vec::new(),
                BTreeMap::new(),
                SourceHealth::unavailable(
                    "aven",
                    format!(
                        "Aven list unavailable or unsupported; inspection did not widen scope: {}",
                        source_error(&error, secrets)
                    ),
                ),
            ));
        }
    };
    let mut list_tasks: BTreeMap<String, AvenTask> = BTreeMap::new();
    let mut capped = false;
    for list in &lists {
        if list.len() >= AVEN_LIST_LIMIT {
            capped = true;
        }
        for task in list {
            if task.project != scope.project {
                continue;
            }
            if !valid_identifier(&task.id) || !valid_reference(&task.reference) {
                continue;
            }
            list_tasks
                .entry(task.id.clone())
                .or_insert_with(|| task.clone());
        }
    }
    let tasks = list_tasks.into_values().collect::<Vec<_>>();
    let total = tasks.len();
    let (contexts, hydration_failed, hydration_capped) =
        hydrate_contexts(&tasks, scope, hydration_offset, priority_task, secrets);
    let aven_read = AvenRead {
        tasks: build_task_records(&tasks, &contexts, secrets),
        contexts,
        health: SourceHealth::ok("aven", "Scoped list/context reads are read-only."),
    };
    let health = if capped
        || hydration_failed
        || hydration_capped
        || aven_read.contexts.len() < total
    {
        SourceHealth::incomplete(
            "aven",
            format!(
                "Coverage incomplete: {}/{} task contexts hydrated; list cap {} per available/upcoming list{}.",
                aven_read.contexts.len(),
                total,
                AVEN_LIST_LIMIT,
                if capped { "; list cap reached" } else { "" }
            ),
        )
    } else {
        aven_read.health
    };
    Ok((aven_read.tasks, aven_read.contexts, health))
}

fn read_list(scope: &Scope, upcoming: bool, secrets: &[String]) -> Result<Vec<AvenTask>> {
    let mut args = vec![
        "list".into(),
        "--project".into(),
        scope.project.clone(),
        "--workspace".into(),
        scope.workspace.clone(),
        "--limit".into(),
        AVEN_LIST_LIMIT.to_string(),
        "--json".into(),
    ];
    if upcoming {
        args.push("--upcoming".into());
    }
    let output = aven_read(&args, Path::new(&scope.cwd), secrets)?;
    let tasks: Vec<AvenTask> =
        serde_json::from_str(&output).context("Aven list returned an unsupported payload")?;
    if tasks.len() > AVEN_LIST_LIMIT {
        bail!("Aven list exceeded the {AVEN_LIST_LIMIT}-task limit");
    }
    Ok(tasks)
}

fn hydrate_contexts(
    tasks: &[AvenTask],
    scope: &Scope,
    hydration_offset: usize,
    priority_task: Option<&str>,
    secrets: &[String],
) -> (BTreeMap<String, (AvenContext, u64)>, bool, bool) {
    let mut selected = tasks.to_vec();
    selected.sort_by(|left, right| left.updated_at.cmp(&right.updated_at));
    if let Some(priority) = priority_task
        && let Some(index) = selected
            .iter()
            .position(|task| task.id == priority || task.reference == priority)
    {
        let task = selected.remove(index);
        selected.insert(0, task);
    } else if !selected.is_empty() {
        let length = selected.len();
        selected.rotate_left(hydration_offset % length);
    }
    selected.truncate(CONTEXT_ADMISSION_LIMIT);
    let capped = selected.len() < tasks.len();
    let deadline = Instant::now() + Duration::from_millis(SOURCE_TIMEOUT_MS);
    let next = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    thread::scope(|scope_threads| {
        for _ in 0..SOURCE_WORKERS.min(selected.len().max(1)) {
            scope_threads.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(task) = selected.get(index) else {
                        break;
                    };
                    if Instant::now() >= deadline {
                        break;
                    }
                    let result = read_context(&task.reference, scope, secrets);
                    results
                        .lock()
                        .expect("context result lock")
                        .push((task.id.clone(), result));
                }
            });
        }
    });
    let mut contexts = BTreeMap::new();
    let mut failed = false;
    let mut observed = now();
    for (task_id, result) in results.into_inner().expect("context result lock") {
        match result {
            Ok((context, observed_at)) => {
                observed = observed.max(observed_at);
                contexts.insert(task_id, (context, observed_at));
            }
            Err(_) => failed = true,
        }
    }
    let timed_out = Instant::now() >= deadline;
    (contexts, failed || timed_out, capped)
}

fn read_context(reference: &str, scope: &Scope, secrets: &[String]) -> Result<(AvenContext, u64)> {
    if !valid_reference(reference) {
        bail!("invalid task reference");
    }
    let observed_at = now();
    let output = aven_read(
        &[
            "context".into(),
            reference.into(),
            "--workspace".into(),
            scope.workspace.clone(),
            "--json".into(),
        ],
        Path::new(&scope.cwd),
        secrets,
    )?;
    let context: AvenContext =
        serde_json::from_str(&output).context("Aven context returned an unsupported payload")?;
    let task = context.task()?;
    if !valid_identifier(&task.id) {
        bail!("Aven context returned an invalid immutable task id");
    }
    if !context.project.key.is_empty() && context.project.key != scope.project {
        bail!("Aven context project does not match the startup scope");
    }
    if !context.workspace.key.is_empty() && context.workspace.key != scope.workspace {
        bail!("Aven context workspace does not match the startup scope");
    }
    if !context.epic_children.is_empty()
        && context
            .epic_children
            .iter()
            .any(|child| !valid_identifier(&child.id))
    {
        bail!("Aven context contains an invalid epic child identity");
    }
    Ok((context, observed_at))
}

fn build_task_records(
    tasks: &[AvenTask],
    contexts: &BTreeMap<String, (AvenContext, u64)>,
    secrets: &[String],
) -> Vec<TaskRecord> {
    let hydrated_ids = contexts.keys().cloned().collect::<BTreeSet<_>>();
    tasks
        .iter()
        .filter_map(|task| {
            let context = contexts.get(&task.id).map(|(context, _)| context);
            let context_task = context.and_then(|context| context.task.as_ref());
            let reference = context_task
                .map(|task| task.display_ref.as_str())
                .filter(|value| !value.is_empty())
                .unwrap_or(&task.reference);
            if !valid_reference(reference) {
                return None;
            }
            let metadata = context
                .map(AvenContext::metadata_strings)
                .unwrap_or_default();
            let plan = PlanMetadata {
                plan_root: metadata.get("sdd.plan-root").cloned(),
                plan_phase: metadata.get("sdd.plan-phase").cloned(),
                plan_kind: metadata.get("sdd.plan-kind").cloned(),
                plan_worked_out: metadata.get("sdd.plan-worked-out").map(String::as_str)
                    == Some("true"),
                reset_generation: generation(&metadata).unwrap_or(0),
                reset_state: metadata.get("dispatch.reset-state").cloned(),
            };
            let children = context
                .map(|context| context.epic_children.as_slice())
                .filter(|children| !children.is_empty())
                .unwrap_or(&task.epic_children);
            let epic_parent = context
                .and_then(|context| context.epic_parent.as_ref())
                .or(task.epic_parent.as_ref());
            Some(TaskRecord {
                id: task.id.clone(),
                reference: sanitize(reference, 256, secrets),
                title: sanitize(
                    context_task
                        .map(|details| details.title.as_str())
                        .filter(|value| !value.is_empty())
                        .unwrap_or(&task.title),
                    512,
                    secrets,
                ),
                project: sanitize(&task.project, 128, secrets),
                status: sanitize(
                    context_task
                        .map(|details| details.status.as_str())
                        .filter(|value| !value.is_empty())
                        .unwrap_or(&task.status),
                    64,
                    secrets,
                ),
                is_epic: context_task
                    .map(|details| details.is_epic)
                    .unwrap_or(task.is_epic),
                epic_parent: epic_parent.map(|parent| {
                    EntityRef::task(
                        &parent.id,
                        Some(parent.reference()),
                        Some(&sanitize(&parent.title, 256, secrets)),
                    )
                }),
                epic_children: children
                    .iter()
                    .filter(|child| valid_identifier(&child.id))
                    .map(|child| {
                        EntityRef::task(
                            &child.id,
                            Some(child.reference()),
                            Some(&sanitize(&child.title, 256, secrets)),
                        )
                    })
                    .collect(),
                dependencies: context
                    .map(|context| {
                        boundary_refs(
                            &context.dependencies.depends_on,
                            "dependency",
                            &hydrated_ids,
                            secrets,
                        )
                    })
                    .unwrap_or_default(),
                blocks: context
                    .map(|context| {
                        boundary_refs(
                            &context.dependencies.blocks,
                            "blocker",
                            &hydrated_ids,
                            secrets,
                        )
                    })
                    .unwrap_or_default(),
                related: context
                    .map(|context| {
                        context
                            .related
                            .iter()
                            .filter(|related| valid_identifier(&related.task_id))
                            .map(|related| BoundaryRef {
                                kind: "related".into(),
                                id: related.task_id.clone(),
                                reference: (!related.display_ref.is_empty())
                                    .then(|| sanitize(&related.display_ref, 256, secrets)),
                                title: None,
                                status: None,
                                hydrated: hydrated_ids.contains(&related.task_id),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                plan,
                hydrated: context.is_some(),
                context_observed_at_ms: contexts.get(&task.id).map(|(_, observed)| *observed),
            })
        })
        .collect()
}

fn boundary_refs(
    values: &[AvenRef],
    kind: &str,
    hydrated: &BTreeSet<String>,
    secrets: &[String],
) -> Vec<BoundaryRef> {
    values
        .iter()
        .filter(|value| valid_identifier(&value.id))
        .map(|value| BoundaryRef {
            kind: kind.into(),
            id: value.id.clone(),
            reference: (!value.reference().is_empty())
                .then(|| sanitize(value.reference(), 256, secrets)),
            title: (!value.title.is_empty()).then(|| sanitize(&value.title, 256, secrets)),
            status: (!value.status.is_empty()).then(|| sanitize(&value.status, 64, secrets)),
            hydrated: hydrated.contains(&value.id),
        })
        .collect()
}

fn aven_read(args: &[String], cwd: &Path, secrets: &[String]) -> Result<String> {
    // Fixed read allowlist: inspector code never invokes mutating Aven
    // commands, custom commands, `opencode api`, or the writable store path.
    let allowed = matches!(
        args.first().map(String::as_str),
        Some("list" | "context" | "project")
    );
    if !allowed {
        bail!("unsupported Aven read command");
    }
    run_bounded(
        "aven",
        args,
        Some(cwd),
        Duration::from_millis(SOURCE_TIMEOUT_MS),
        SOURCE_OUTPUT_LIMIT,
    )
    .map_err(|error| anyhow!(sanitize(&format!("{error:#}"), 240, secrets)))
}
