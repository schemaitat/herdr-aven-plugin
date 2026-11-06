//! Bounded read-only Aven task and context source.

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{
        Arc, Mutex,
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
    deleted: bool,
    #[serde(default)]
    priority: String,
    #[serde(default)]
    available_at: String,
    #[serde(default)]
    due_on: String,
    #[serde(default)]
    created_at: String,
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

/// How long a hydrated context stays usable before a background re-read.
///
/// Callers that poll the snapshot refresh about every 5 s, so a 5 s window
/// would expire every entry on every cycle and the cache would never hit.
/// `updated_at` changes still invalidate immediately; the window only bounds
/// how long an otherwise unchanged context is trusted without re-reading it.
const CONTEXT_CACHE_TTL_MS: u64 = 30_000;

#[derive(Debug, Clone)]
struct CachedContext {
    updated_at: String,
    context: AvenContext,
    observed_at: u64,
}

/// Hydrated contexts keyed by immutable task id, shared by long-lived base
/// lanes across cycles. The one-shot `inspect` path gets a fresh cache.
#[derive(Debug, Clone, Default)]
pub(crate) struct ContextCache {
    entries: Arc<Mutex<BTreeMap<String, CachedContext>>>,
}

impl ContextCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, CachedContext>> {
        self.entries.lock().expect("context cache lock")
    }
}

pub(super) fn read_aven(
    scope: &Scope,
    cache: &ContextCache,
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
    retain_live(cache, &tasks);
    let (contexts, hydration_failed, hydration_capped) =
        hydrate_contexts(&tasks, scope, cache, priority_task, secrets);
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

/// Drop cached contexts for tasks that left the scoped list so the map stays
/// bounded by live coverage.
fn retain_live(cache: &ContextCache, tasks: &[AvenTask]) {
    let live = tasks
        .iter()
        .map(|task| task.id.as_str())
        .collect::<BTreeSet<_>>();
    cache.lock().retain(|id, _| live.contains(id.as_str()));
}

/// Tasks that need a context read, in hydration order.
///
/// Uncovered and invalidated tasks come before merely stale ones, and within
/// each tier the oldest task goes first. Hydrated tasks leave the pending set,
/// so repeated bounded cycles converge even when the project exceeds the
/// admission window. The selected/priority task is pinned to the front.
fn pending_tasks<'a>(
    tasks: &'a [AvenTask],
    entries: &BTreeMap<String, CachedContext>,
    now_ms: u64,
    priority_task: Option<&str>,
) -> Vec<&'a AvenTask> {
    let mut uncovered = Vec::new();
    let mut stale = Vec::new();
    for task in tasks {
        match entries.get(&task.id) {
            None => uncovered.push(task),
            Some(entry) if entry.updated_at != task.updated_at => uncovered.push(task),
            Some(entry) if now_ms.saturating_sub(entry.observed_at) >= CONTEXT_CACHE_TTL_MS => {
                stale.push(task);
            }
            Some(_) => {}
        }
    }
    uncovered.sort_by(|left, right| {
        left.updated_at
            .cmp(&right.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    stale.sort_by(|left, right| {
        entries[&left.id]
            .observed_at
            .cmp(&entries[&right.id].observed_at)
            .then_with(|| left.updated_at.cmp(&right.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut ordered = uncovered;
    ordered.extend(stale);
    if let Some(priority) = priority_task
        && let Some(index) = ordered
            .iter()
            .position(|task| task.id == priority || task.reference == priority)
    {
        let task = ordered.remove(index);
        ordered.insert(0, task);
    }
    ordered
}

/// Contexts that still match the currently listed `updated_at`, so a failed or
/// skipped refresh is never served as fresh evidence.
fn cached_contexts(
    tasks: &[AvenTask],
    entries: &BTreeMap<String, CachedContext>,
) -> BTreeMap<String, (AvenContext, u64)> {
    tasks
        .iter()
        .filter_map(|task| {
            let entry = entries.get(&task.id)?;
            (entry.updated_at == task.updated_at)
                .then(|| (task.id.clone(), (entry.context.clone(), entry.observed_at)))
        })
        .collect()
}

fn hydrate_contexts(
    tasks: &[AvenTask],
    scope: &Scope,
    cache: &ContextCache,
    priority_task: Option<&str>,
    secrets: &[String],
) -> (BTreeMap<String, (AvenContext, u64)>, bool, bool) {
    let (selected, capped) = {
        let entries = cache.lock();
        let pending = pending_tasks(tasks, &entries, now(), priority_task);
        let capped = pending.len() > CONTEXT_ADMISSION_LIMIT;
        let selected = pending
            .into_iter()
            .take(CONTEXT_ADMISSION_LIMIT)
            .cloned()
            .collect::<Vec<_>>();
        (selected, capped)
    };
    if selected.is_empty() {
        let entries = cache.lock();
        return (cached_contexts(tasks, &entries), false, capped);
    }
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
                    results.lock().expect("context result lock").push((
                        task.id.clone(),
                        task.updated_at.clone(),
                        result,
                    ));
                }
            });
        }
    });
    let mut failed = false;
    let mut entries = cache.lock();
    for (task_id, updated_at, result) in results.into_inner().expect("context result lock") {
        match result {
            Ok((context, observed_at)) => {
                entries.insert(
                    task_id,
                    CachedContext {
                        updated_at,
                        context,
                        observed_at,
                    },
                );
            }
            Err(_) => {
                // Never keep a context the list no longer corroborates.
                entries.remove(&task_id);
                failed = true;
            }
        }
    }
    let timed_out = Instant::now() >= deadline;
    let contexts = cached_contexts(tasks, &entries);
    (contexts, failed || timed_out, capped)
}

fn read_context(reference: &str, scope: &Scope, secrets: &[String]) -> Result<(AvenContext, u64)> {
    if !valid_reference(reference) {
        bail!("invalid task reference");
    }
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
    // Stamp the cache when the read completes so the freshness window starts
    // from the observation, not from before the subprocess ran.
    Ok((context, now()))
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
            let delivery = DeliveryRecord {
                state: metadata.get("delivery.state").cloned(),
                commit: metadata.get("delivery.commit").cloned(),
                branch: metadata.get("delivery.branch").cloned(),
                repository: metadata.get("delivery.repository").cloned(),
                target: metadata.get("delivery.target").cloned(),
                merged: metadata.get("delivery.merged").cloned(),
                pr: metadata.get("delivery.pr").cloned(),
                obligation: metadata.get("delivery.obligation-for").cloned(),
                provenance: metadata.get("delivery.provenance").cloned(),
            };
            let delivery = (delivery.state.is_some()
                || delivery.commit.is_some()
                || delivery.obligation.is_some())
            .then(|| DeliveryRecord {
                state: delivery
                    .state
                    .as_deref()
                    .map(|value| sanitize(value, 64, secrets)),
                commit: delivery
                    .commit
                    .as_deref()
                    .map(|value| sanitize(value, 128, secrets)),
                branch: delivery
                    .branch
                    .as_deref()
                    .map(|value| sanitize(value, 256, secrets)),
                repository: delivery
                    .repository
                    .as_deref()
                    .map(|value| sanitize(value, 1024, secrets)),
                target: delivery
                    .target
                    .as_deref()
                    .map(|value| sanitize(value, 256, secrets)),
                merged: delivery
                    .merged
                    .as_deref()
                    .map(|value| sanitize(value, 128, secrets)),
                pr: delivery
                    .pr
                    .as_deref()
                    .map(|value| sanitize(value, 128, secrets)),
                obligation: delivery
                    .obligation
                    .as_deref()
                    .map(|value| sanitize(value, 64, secrets)),
                provenance: delivery
                    .provenance
                    .as_deref()
                    .map(|value| sanitize(value, 256, secrets)),
            });
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
                deleted: task.deleted,
                priority: sanitize(
                    if task.priority.is_empty() {
                        "none"
                    } else {
                        &task.priority
                    },
                    64,
                    secrets,
                ),
                available_at: sanitize(&task.available_at, 64, secrets),
                due_on: sanitize(&task.due_on, 64, secrets),
                created_at: sanitize(&task.created_at, 64, secrets),
                updated_at: sanitize(&task.updated_at, 64, secrets),
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
                delivery,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, reference: &str, updated_at: &str) -> AvenTask {
        AvenTask {
            id: id.into(),
            reference: reference.into(),
            title: String::new(),
            project: "app".into(),
            status: "todo".into(),
            is_epic: false,
            deleted: false,
            priority: String::new(),
            available_at: String::new(),
            due_on: String::new(),
            created_at: String::new(),
            epic_parent: None,
            epic_children: Vec::new(),
            updated_at: updated_at.into(),
        }
    }

    fn cached(updated_at: &str, observed_at: u64) -> CachedContext {
        CachedContext {
            updated_at: updated_at.into(),
            context: test_context(BTreeMap::new()),
            observed_at,
        }
    }

    fn ids(tasks: Vec<&AvenTask>) -> Vec<&str> {
        tasks.into_iter().map(|task| task.id.as_str()).collect()
    }

    #[test]
    fn warm_cache_needs_no_context_reads() {
        let tasks = vec![
            task("task-a", "APP-1", "2026-01-01T00:00:00Z"),
            task("task-b", "APP-2", "2026-01-02T00:00:00Z"),
        ];
        let entries = BTreeMap::from([
            ("task-a".to_owned(), cached("2026-01-01T00:00:00Z", 1_000)),
            ("task-b".to_owned(), cached("2026-01-02T00:00:00Z", 2_000)),
        ]);
        assert!(pending_tasks(&tasks, &entries, 1_000 + CONTEXT_CACHE_TTL_MS - 1, None).is_empty());
        assert_eq!(cached_contexts(&tasks, &entries).len(), 2);
    }

    #[test]
    fn updated_at_change_invalidates_only_that_context() {
        let tasks = vec![
            task("task-a", "APP-1", "2026-01-03T00:00:00Z"),
            task("task-b", "APP-2", "2026-01-02T00:00:00Z"),
        ];
        let entries = BTreeMap::from([
            ("task-a".to_owned(), cached("2026-01-01T00:00:00Z", 1_000)),
            ("task-b".to_owned(), cached("2026-01-02T00:00:00Z", 1_000)),
        ]);
        assert_eq!(
            ids(pending_tasks(&tasks, &entries, 1_500, None)),
            vec!["task-a"]
        );
        let contexts = cached_contexts(&tasks, &entries);
        assert_eq!(
            contexts.keys().cloned().collect::<Vec<_>>(),
            vec!["task-b"],
            "the invalidated context must not be served"
        );
    }

    #[test]
    fn aged_context_becomes_pending_again() {
        let tasks = vec![task("task-a", "APP-1", "2026-01-01T00:00:00Z")];
        let entries =
            BTreeMap::from([("task-a".to_owned(), cached("2026-01-01T00:00:00Z", 1_000))]);
        assert!(pending_tasks(&tasks, &entries, 1_000 + CONTEXT_CACHE_TTL_MS - 1, None).is_empty());
        assert_eq!(
            ids(pending_tasks(
                &tasks,
                &entries,
                1_000 + CONTEXT_CACHE_TTL_MS,
                None
            )),
            vec!["task-a"]
        );
    }

    #[test]
    fn pending_priority_task_is_pinned_first() {
        let tasks = vec![
            task("task-a", "APP-1", "2026-01-01T00:00:00Z"),
            task("task-b", "APP-2", "2026-01-02T00:00:00Z"),
        ];
        let entries = BTreeMap::new();
        assert_eq!(
            ids(pending_tasks(&tasks, &entries, 1_000, Some("APP-2"))),
            vec!["task-b", "task-a"]
        );
    }

    #[test]
    fn bounded_rotation_hydrates_every_task() {
        let tasks = (0..200)
            .map(|index| {
                task(
                    &format!("task-{index:03}"),
                    &format!("APP-{index}"),
                    "2026-01-01T00:00:00Z",
                )
            })
            .collect::<Vec<_>>();
        let mut entries = BTreeMap::new();
        let mut rounds = 0;
        while cached_contexts(&tasks, &entries).len() < tasks.len() {
            rounds += 1;
            let observed_at = rounds as u64 * 1_000;
            let selected = pending_tasks(&tasks, &entries, observed_at, None)
                .into_iter()
                .take(CONTEXT_ADMISSION_LIMIT)
                .cloned()
                .collect::<Vec<_>>();
            assert!(!selected.is_empty());
            for (index, task) in selected.iter().enumerate() {
                entries.insert(
                    task.id.clone(),
                    cached(&task.updated_at, observed_at + index as u64),
                );
            }
            assert!(
                rounds <= 3,
                "200 tasks at 80 per cycle must converge in 3 rounds"
            );
        }
        assert_eq!(rounds, 3);
        assert_eq!(cached_contexts(&tasks, &entries).len(), 200);
    }
}
