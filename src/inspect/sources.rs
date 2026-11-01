//! Bounded, read-only source collection for the inspector snapshot.
//!
//! Every transport here is deliberately narrower than a lifecycle command:
//! Aven reads are allowlisted `list`/`context`/`project list` calls, the
//! dispatcher store is opened read-only and never migrated, herdr-core is read
//! through its snapshot/worktree read API, and OpenCode is queried through
//! authenticated GET-only V2 endpoints of an already running service.

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use url::Url;

use super::model::*;
use crate::process::{now, read_only_store_payloads, run_bounded};

const PROJECT_LIMIT: usize = 100;
const API_REQUEST_TIMEOUT_MS: u64 = 1_800;
const API_RESPONSE_LIMIT: usize = 512 * 1024;
const SERVICE_FILE_LIMIT: u64 = 64 * 1024;
const ACTIVITY_TTL_MS: u64 = 4_500;

#[derive(Clone)]
pub(crate) struct Options {
    pub(crate) project: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) store: PathBuf,
    /// Rotating context-hydration offset; the long-lived collector advances it
    /// per cycle so projects above the admission cap eventually gain coverage.
    pub(crate) hydration_offset: usize,
    /// Selected immutable task id to hydrate first in the next bounded cycle.
    pub(crate) priority_task: Option<String>,
}

#[derive(Clone)]
pub(crate) struct BaseRead {
    pub(crate) scope: Scope,
    pub(crate) tasks: Vec<TaskRecord>,
    pub(crate) attempts: Vec<AttemptRecord>,
    pub(crate) sources: Vec<SourceHealth>,
    pub(crate) warnings: Vec<String>,
}

#[derive(Clone, Default)]
pub(crate) struct LiveRead {
    pub(crate) panes: Vec<PaneRecord>,
    pub(crate) workspaces: Vec<WorkspaceRecord>,
    pub(crate) worktrees: Vec<WorktreeRecord>,
    pub(crate) sessions: Vec<SessionRecord>,
    pub(crate) sources: Vec<SourceHealth>,
    pub(crate) warnings: Vec<String>,
}

/// Aven/task/store lane. The long-lived collector calls this on its slower
/// cadence; the one-shot `inspect` command calls it once.
pub(crate) fn read_base(options: &Options) -> Result<BaseRead> {
    let started = Instant::now();
    let secrets = configured_secrets();
    let scope = resolve_scope(options, &secrets)?;
    let (tasks, contexts, aven_health) = read_aven(
        &scope,
        options.hydration_offset,
        options.priority_task.as_deref(),
        &secrets,
    )?;
    let (attempts, store_health) = read_attempts(&options.store, &contexts, &secrets);
    let mut warnings = Vec::new();
    if started.elapsed() > Duration::from_millis(SOURCE_TIMEOUT_MS) {
        warnings.push(format!(
            "Aven/store lane exceeded the {} ms read budget; coverage is incomplete.",
            SOURCE_TIMEOUT_MS
        ));
    }
    Ok(BaseRead {
        scope,
        tasks,
        attempts,
        sources: vec![aven_health, store_health],
        warnings,
    })
}

/// herdr-core/API lane. It consumes only the last-good scoped attempts from the
/// Aven lane and never writes back to it.
pub(crate) fn read_live(scope: &Scope, attempts: &[AttemptRecord]) -> LiveRead {
    let secrets = configured_secrets();
    let (panes, workspaces, worktrees, core_health) = read_core(scope, attempts, &secrets);
    let (mut sessions, mut warnings) = link_sessions(attempts, &panes);
    let api_health = read_api_activity(&mut sessions, &secrets);
    warnings.truncate(64);
    LiveRead {
        panes,
        workspaces,
        worktrees,
        sessions,
        sources: vec![core_health, api_health],
        warnings,
    }
}

pub(crate) fn assemble(base: &BaseRead, live: &LiveRead) -> Snapshot {
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
        observed_at_ms: now(),
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

pub(crate) fn collect(options: &Options) -> Result<Snapshot> {
    let base = read_base(options)?;
    let live = read_live(&base.scope, &base.attempts);
    Ok(assemble(&base, &live))
}

fn configured_secrets() -> Vec<String> {
    [
        "AVEN_DISPATCH_OPENCODE_AUTHORIZATION",
        "AVEN_DISPATCH_OPENCODE_TOKEN",
        "AVEN_DISPATCH_OPENCODE_PASSWORD",
    ]
    .into_iter()
    .filter_map(|name| env::var(name).ok())
    .filter(|value| !value.is_empty())
    .collect()
}

fn source_error(error: &anyhow::Error, secrets: &[String]) -> String {
    sanitize(&format!("{error:#}"), 240, secrets)
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

fn resolve_scope(options: &Options, secrets: &[String]) -> Result<Scope> {
    let workspace = options
        .workspace
        .clone()
        .or_else(|| env::var("AVEN_WORKSPACE").ok())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".into());
    if !valid_identifier(&workspace) {
        bail!("invalid workspace key {workspace:?}");
    }
    let cwd = fs::canonicalize(&options.cwd)
        .unwrap_or_else(|_| options.cwd.clone())
        .display()
        .to_string();
    let repository = repository_root(&options.cwd, secrets).unwrap_or_else(|| cwd.clone());
    let (project, project_source) = match options.project.as_deref() {
        Some(project) => {
            if !valid_identifier(project) {
                bail!("invalid project key {project:?}");
            }
            (project.to_owned(), "explicit".into())
        }
        None => (
            infer_project(&repository, &workspace, &options.cwd, secrets)?,
            "inferred".into(),
        ),
    };
    let project = validate_project(&project, &workspace, &options.cwd, secrets)?;
    let core_session = env::var("HC_SESSION")
        .or_else(|_| env::var("HC_BIN"))
        .unwrap_or_else(|_| "hc".into());
    Ok(Scope {
        project,
        workspace,
        repository,
        cwd,
        project_source,
        workspace_source: if options.workspace.is_some() {
            "explicit".into()
        } else if env::var("AVEN_WORKSPACE").is_ok_and(|value| !value.is_empty()) {
            "environment".into()
        } else {
            "default".into()
        },
        core_session,
    })
}

fn repository_root(cwd: &Path, secrets: &[String]) -> Option<String> {
    let output = run_bounded(
        "git",
        &[
            "-C".into(),
            cwd.display().to_string(),
            "rev-parse".into(),
            "--show-toplevel".into(),
        ],
        Some(cwd),
        Duration::from_millis(SOURCE_TIMEOUT_MS),
        SOURCE_OUTPUT_LIMIT,
    )
    .ok()?;
    if output.is_empty() {
        None
    } else {
        Some(sanitize(&output, 4096, secrets))
    }
}

fn infer_project(
    repository: &str,
    workspace: &str,
    cwd: &Path,
    secrets: &[String],
) -> Result<String> {
    let basename = Path::new(repository)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if !valid_identifier(basename) {
        bail!(
            "cannot infer an Aven project from {}; pass --project",
            Path::new(repository).display()
        );
    }
    let projects = project_list(workspace, cwd, secrets)?;
    if let Some(project) = projects.iter().find(|project| project.key == basename) {
        return Ok(project.key.clone());
    }
    let matches = projects
        .iter()
        .filter(|project| project.name == basename)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [project] => Ok(project.key.clone()),
        [] => bail!(
            "cannot infer an Aven project for {basename:?}; pass --project (scope was not widened)"
        ),
        _ => bail!("project name {basename:?} is ambiguous; pass --project"),
    }
}

fn validate_project(
    requested: &str,
    workspace: &str,
    cwd: &Path,
    secrets: &[String],
) -> Result<String> {
    let projects = project_list(workspace, cwd, secrets)?;
    projects
        .iter()
        .find(|project| project.key == requested || project.name == requested)
        .map(|project| project.key.clone())
        .with_context(|| {
            format!("Aven project {requested:?} was not found in workspace {workspace:?}")
        })
}

#[derive(Debug, Deserialize)]
struct AvenProject {
    key: String,
    #[serde(default)]
    name: String,
}

fn project_list(workspace: &str, cwd: &Path, secrets: &[String]) -> Result<Vec<AvenProject>> {
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
    display_ref: String,
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
struct ContextTask {
    #[serde(default)]
    id: String,
    #[serde(default)]
    display_ref: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    is_epic: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Keyed {
    #[serde(default)]
    key: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct Dependencies {
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
struct AvenContext {
    #[serde(default)]
    task: Option<ContextTask>,
    #[serde(default)]
    project: Keyed,
    #[serde(default)]
    workspace: Keyed,
    #[serde(default)]
    metadata: BTreeMap<String, Value>,
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
    fn metadata_strings(&self) -> BTreeMap<String, String> {
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

struct AvenRead {
    tasks: Vec<TaskRecord>,
    contexts: BTreeMap<String, (AvenContext, u64)>,
    health: SourceHealth,
}

fn read_aven(
    scope: &Scope,
    hydration_offset: usize,
    priority_task: Option<&str>,
    secrets: &[String],
) -> Result<(
    Vec<TaskRecord>,
    BTreeMap<String, (AvenContext, u64)>,
    SourceHealth,
)> {
    let mut observations = Vec::new();
    for upcoming in [false, true] {
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
        match aven_read(&args, Path::new(&scope.cwd), secrets).and_then(|output| {
            let tasks: Vec<AvenTask> = serde_json::from_str(&output)
                .context("Aven list returned an unsupported payload")?;
            if tasks.len() > AVEN_LIST_LIMIT {
                bail!("Aven list exceeded the {AVEN_LIST_LIMIT}-task limit");
            }
            Ok((tasks, upcoming))
        }) {
            Ok((tasks, _)) => observations.push(tasks),
            Err(error) => {
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
        }
    }
    let lists = observations;
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

// ---------------------------------------------------------------------------
// Dispatcher store merge
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct RawTerminal {
    #[serde(default)]
    core_id: String,
    #[serde(default)]
    address: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    created_by_attempt: bool,
}

impl RawTerminal {
    fn is_empty(&self) -> bool {
        self.address.is_empty()
    }
    fn link(&self, secrets: &[String]) -> TerminalLink {
        TerminalLink {
            core_id: sanitize(&self.core_id, 128, secrets),
            address: sanitize(&self.address, 128, secrets),
            name: sanitize(&self.name, 256, secrets),
            role: sanitize(&self.role, 128, secrets),
            created_by_attempt: self.created_by_attempt,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct RawAttempt {
    #[serde(default)]
    task_id: String,
    #[serde(rename = "ref", default)]
    task_ref: String,
    #[serde(default)]
    workflow: String,
    #[serde(default)]
    attempt_id: String,
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    execution_mode: String,
    #[serde(default)]
    backend: String,
    #[serde(default)]
    core_id: String,
    #[serde(default)]
    terminal: RawTerminal,
    #[serde(default)]
    coordinator_terminal: RawTerminal,
    #[serde(default)]
    babysitter_terminal: RawTerminal,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    worktree: String,
    #[serde(default)]
    worktree_created_by_attempt: bool,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    coordinator_session_id: String,
    #[serde(default)]
    coordinator_agent: String,
    #[serde(default)]
    coordinator_model: String,
    #[serde(default)]
    babysitter: bool,
    #[serde(default)]
    babysitter_session_id: String,
    #[serde(default)]
    babysitter_pane: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    pane: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    created_at: u64,
    #[serde(default)]
    phases: Vec<RawPhase>,
}

#[derive(Debug, Default, Deserialize)]
struct RawPhase {
    #[serde(default)]
    task_id: String,
    #[serde(rename = "ref", default)]
    task_ref: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    branch: String,
    #[serde(default)]
    worktree: String,
    #[serde(default)]
    terminal: RawTerminal,
    #[serde(default)]
    pane: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    commit: String,
    #[serde(default)]
    integrated_commit: String,
}

fn read_attempts(
    store: &Path,
    contexts: &BTreeMap<String, (AvenContext, u64)>,
    secrets: &[String],
) -> (Vec<AttemptRecord>, SourceHealth) {
    let mut accepted: BTreeMap<(String, String, u64), AttemptRecord> = BTreeMap::new();
    let mut rejected = 0_usize;
    // Aven recovery snapshots are imported first so the central store wins
    // equal-generation/created_at ties, matching the dashboard contract.
    for (task_id, (context, observed_at)) in contexts {
        for (key, value) in &context.metadata {
            if key != "dispatch.attempt" && !key.starts_with("dispatch.attempt.") {
                continue;
            }
            let Some(snapshot) = value.as_str() else {
                rejected += 1;
                continue;
            };
            let workflow =
                (key != "dispatch.attempt").then(|| key.trim_start_matches("dispatch.attempt."));
            accept_attempt(
                snapshot,
                Origin::AvenRecovery,
                *observed_at,
                contexts,
                Some(task_id),
                workflow,
                &mut accepted,
                &mut rejected,
                secrets,
            );
        }
    }
    let (health, central_count, store_available) = match read_only_store_payloads(
        store,
        ATTEMPT_LIMIT,
    ) {
        Ok(payloads) => {
            for payload in &payloads {
                accept_attempt(
                    payload,
                    Origin::CentralStore,
                    now(),
                    contexts,
                    None,
                    None,
                    &mut accepted,
                    &mut rejected,
                    secrets,
                );
            }
            (
                SourceHealth::ok(
                    "dispatcher",
                    format!(
                        "Read-only central SQLite store ({} rows); scoped Aven recovery merged; no lock or reconciliation.",
                        payloads.len()
                    ),
                ),
                payloads.len(),
                true,
            )
        }
        Err(error) => (
            SourceHealth::unavailable(
                "dispatcher",
                format!(
                    "Central dispatcher store absent, unsupported or unreadable; scoped Aven recovery snapshots only: {}",
                    source_error(&error, secrets)
                ),
            ),
            0,
            false,
        ),
    };
    let mut attempts = accepted.into_values().collect::<Vec<_>>();
    attempts.sort_by(|left, right| {
        left.task_ref
            .cmp(&right.task_ref)
            .then_with(|| left.workflow.cmp(&right.workflow))
    });
    let mut message = health.message;
    if rejected > 0 {
        message.push_str(&format!(
            "; {rejected} malformed, mismatched, reset-in-progress or obsolete snapshot(s) rejected"
        ));
    }
    let status = if !store_available {
        HealthStatus::Unavailable
    } else if rejected > 0 || (central_count == 0 && !attempts.is_empty()) {
        HealthStatus::Incomplete
    } else {
        health.status
    };
    let health = SourceHealth {
        source: "dispatcher".into(),
        status,
        observed_at_ms: health.observed_at_ms,
        message,
    };
    (attempts, health)
}

#[allow(clippy::too_many_arguments)]
fn accept_attempt(
    payload: &str,
    origin: Origin,
    observed_at: u64,
    contexts: &BTreeMap<String, (AvenContext, u64)>,
    owner: Option<&str>,
    workflow: Option<&str>,
    accepted: &mut BTreeMap<(String, String, u64), AttemptRecord>,
    rejected: &mut usize,
    secrets: &[String],
) {
    let raw: RawAttempt = match serde_json::from_str(payload) {
        Ok(raw) => raw,
        Err(_) => {
            *rejected += 1;
            return;
        }
    };
    if !valid_identifier(&raw.task_id) || raw.attempt_id.is_empty() {
        *rejected += 1;
        return;
    }
    if owner.is_some_and(|owner| owner != raw.task_id) {
        *rejected += 1;
        return;
    }
    if workflow.is_some_and(|workflow| workflow != raw.workflow) {
        *rejected += 1;
        return;
    }
    // Unscoped tasks are never imported, but they are not malformed evidence.
    let Some((context, _)) = contexts.get(&raw.task_id) else {
        return;
    };
    let metadata = context.metadata_strings();
    let Ok(current_generation) = generation(&metadata) else {
        *rejected += 1;
        return;
    };
    if current_generation != raw.generation {
        *rejected += 1;
        return;
    }
    if metadata
        .get("dispatch.reset-state")
        .is_some_and(|state| state != "completed")
    {
        *rejected += 1;
        return;
    }
    let context_reference = context
        .task
        .as_ref()
        .map(|task| task.display_ref.as_str())
        .unwrap_or_default();
    let task_ref = if raw.task_ref.is_empty() {
        context_reference
    } else {
        &raw.task_ref
    };
    if !valid_reference(task_ref)
        || (!context_reference.is_empty() && task_ref != context_reference)
    {
        *rejected += 1;
        return;
    }
    let workflow = if raw.workflow.is_empty() {
        "default".to_owned()
    } else {
        sanitize(&raw.workflow, 128, secrets)
    };
    let attempt = AttemptRecord {
        task_id: raw.task_id.clone(),
        task_ref: sanitize(task_ref, 256, secrets),
        workflow: workflow.clone(),
        attempt_id: sanitize(&raw.attempt_id, 128, secrets),
        generation: raw.generation,
        origin,
        observed_at_ms: observed_at,
        created_at_ms: raw.created_at,
        state: sanitize(&raw.state, 128, secrets),
        execution_mode: sanitize(
            if raw.execution_mode.is_empty() {
                "single-session"
            } else {
                &raw.execution_mode
            },
            64,
            secrets,
        ),
        backend: sanitize(
            if raw.backend.is_empty() {
                if raw.terminal.is_empty() && raw.pane.is_empty() {
                    "hc"
                } else if raw.terminal.is_empty() {
                    "herdr"
                } else {
                    "hc"
                }
            } else {
                &raw.backend
            },
            32,
            secrets,
        ),
        core_id: sanitize(
            if raw.core_id.is_empty() {
                &raw.terminal.core_id
            } else {
                &raw.core_id
            },
            128,
            secrets,
        ),
        terminal: raw.terminal.link(secrets),
        coordinator_terminal: raw.coordinator_terminal.link(secrets),
        babysitter_terminal: raw.babysitter_terminal.link(secrets),
        branch: sanitize(&raw.branch, 512, secrets),
        worktree: sanitize(&raw.worktree, 4096, secrets),
        worktree_created_by_attempt: raw.worktree_created_by_attempt,
        agent: sanitize(&raw.agent, 128, secrets),
        model: sanitize(&raw.model, 256, secrets),
        coordinator_agent: sanitize(&raw.coordinator_agent, 128, secrets),
        coordinator_model: sanitize(&raw.coordinator_model, 256, secrets),
        coordinator_session_id: sanitize(&raw.coordinator_session_id, 132, secrets),
        babysitter: raw.babysitter,
        babysitter_session_id: sanitize(&raw.babysitter_session_id, 132, secrets),
        babysitter_pane: sanitize(&raw.babysitter_pane, 128, secrets),
        session_id: sanitize(&raw.session_id, 132, secrets),
        pane: sanitize(&raw.pane, 128, secrets),
        phases: raw
            .phases
            .iter()
            .map(|phase| PhaseRecord {
                task_id: sanitize(&phase.task_id, 128, secrets),
                reference: sanitize(&phase.task_ref, 256, secrets),
                title: sanitize(&phase.title, 512, secrets),
                branch: sanitize(&phase.branch, 512, secrets),
                worktree: sanitize(&phase.worktree, 4096, secrets),
                terminal: phase.terminal.link(secrets),
                pane: sanitize(&phase.pane, 128, secrets),
                session_id: sanitize(&phase.session_id, 132, secrets),
                state: sanitize(&phase.state, 128, secrets),
                commit: sanitize(&phase.commit, 128, secrets),
                integrated_commit: sanitize(&phase.integrated_commit, 128, secrets),
            })
            .collect(),
    };
    let key = (attempt.task_id.clone(), workflow, attempt.generation);
    match accepted.get(&key) {
        Some(existing) if existing.created_at_ms > attempt.created_at_ms => {}
        Some(existing)
            if existing.created_at_ms == attempt.created_at_ms
                && existing.origin == Origin::CentralStore => {}
        _ => {
            accepted.insert(key, attempt);
        }
    }
}

fn attempt_worktrees(attempts: &[AttemptRecord]) -> Vec<WorktreeRecord> {
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

#[derive(Debug, Default, Deserialize)]
struct HcTerminal {
    #[serde(default)]
    address: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    r#where: String,
    #[serde(default)]
    turn: u64,
}

fn read_core(
    scope: &Scope,
    attempts: &[AttemptRecord],
    secrets: &[String],
) -> (
    Vec<PaneRecord>,
    Vec<WorkspaceRecord>,
    Vec<WorktreeRecord>,
    SourceHealth,
) {
    let binary = env::var("HC_BIN").unwrap_or_else(|_| "hc".into());
    let output = run_bounded(
        &binary,
        &["ls".into(), "--json".into()],
        Some(Path::new(&scope.cwd)),
        Duration::from_millis(SOURCE_TIMEOUT_MS),
        SOURCE_OUTPUT_LIMIT,
    );
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            return (
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SourceHealth::unavailable(
                    "core",
                    format!(
                        "herdr-core is unavailable; terminal observations are unknown: {}",
                        source_error(&error, secrets)
                    ),
                ),
            );
        }
    };
    let value: Value = match serde_json::from_str(&output) {
        Ok(value) => value,
        Err(_) => {
            return (
                Vec::new(),
                Vec::new(),
                Vec::new(),
                SourceHealth::unavailable(
                    "core",
                    "herdr-core returned an unsupported terminal list; terminal observations are unknown.",
                ),
            );
        }
    };
    let mut values = value
        .get("terminals")
        .and_then(Value::as_array)
        .map(|values| values.clone())
        .unwrap_or_default();
    let capped = values.len() > PANE_LIMIT;
    values.truncate(PANE_LIMIT);
    let referenced = attempts
        .iter()
        .flat_map(|attempt| {
            [
                attempt.terminal.address.as_str(),
                attempt.coordinator_terminal.address.as_str(),
                attempt.babysitter_terminal.address.as_str(),
            ]
            .into_iter()
            .chain(
                attempt
                    .phases
                    .iter()
                    .map(|phase| phase.terminal.address.as_str()),
            )
        })
        .filter(|address| !address.is_empty())
        .collect::<BTreeSet<_>>();
    let mut paths = BTreeSet::from([scope.repository.clone()]);
    paths.extend(
        attempts
            .iter()
            .filter(|attempt| !attempt.worktree.is_empty())
            .map(|attempt| attempt.worktree.clone()),
    );
    let mut panes = Vec::new();
    for value in values {
        let Ok(terminal) = serde_json::from_value::<HcTerminal>(value) else {
            continue;
        };
        if terminal.address.is_empty() {
            continue;
        }
        let in_scope = referenced.contains(terminal.address.as_str())
            || paths.iter().any(|path| {
                terminal.cwd == *path
                    || (!path.is_empty()
                        && terminal
                            .cwd
                            .starts_with(&format!("{}/", path.trim_end_matches('/'))))
            });
        if !in_scope {
            continue;
        }
        panes.push(PaneRecord {
            pane_id: sanitize(&terminal.address, 128, secrets),
            workspace_id: sanitize(
                if terminal.r#where.is_empty() {
                    "core"
                } else {
                    &terminal.r#where
                },
                256,
                secrets,
            ),
            tab_id: String::new(),
            cwd: sanitize(&terminal.cwd, 4096, secrets),
            agent_profile: (!terminal.agent.is_empty())
                .then(|| sanitize(&terminal.agent, 128, secrets)),
            agent_status: sanitize(
                if !terminal.status.is_empty() {
                    &terminal.status
                } else if !terminal.state.is_empty() {
                    &terminal.state
                } else {
                    "unknown"
                },
                64,
                secrets,
            ),
            agent_session_id: None,
            focused: false,
        });
        let _ = (&terminal.name, terminal.turn);
    }
    panes.sort_by(|left, right| left.pane_id.cmp(&right.pane_id));
    let mut workspaces = BTreeMap::<String, WorkspaceRecord>::new();
    for pane in &panes {
        workspaces
            .entry(pane.workspace_id.clone())
            .or_insert_with(|| WorkspaceRecord {
                workspace_id: pane.workspace_id.clone(),
                label: pane.workspace_id.clone(),
                repo_root: None,
                checkout_path: None,
                active_tab_id: String::new(),
                focused: false,
            });
    }
    let health = if capped {
        SourceHealth::incomplete(
            "core",
            format!("herdr-core terminal topology capped at {PANE_LIMIT} terminals."),
        )
    } else {
        SourceHealth::ok(
            "core",
            "herdr-core terminal state is separate from OpenCode API activity and Aven acceptance.",
        )
    };
    (
        panes,
        workspaces.into_values().collect(),
        attempt_worktrees(attempts),
        health,
    )
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

fn link_sessions(
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

struct ApiEndpoint {
    base: String,
    headers: Vec<(String, String)>,
    secrets: Vec<String>,
}

fn discover_api(secrets: &mut Vec<String>) -> Result<ApiEndpoint> {
    if let Ok(explicit) = env::var("AVEN_DISPATCH_OPENCODE_URL") {
        if explicit.is_empty() {
            bail!("explicit OpenCode service URL is empty");
        }
        let url = validate_origin(&explicit, false)?;
        let headers = explicit_auth(secrets)?;
        return Ok(ApiEndpoint {
            base: url,
            headers,
            secrets: secrets.clone(),
        });
    }
    let file = env::var_os("AVEN_DISPATCH_OPENCODE_SERVICE_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(default_service_file);
    let metadata = fs::metadata(&file).with_context(|| {
        format!(
            "no existing OpenCode service registration at {}",
            file.display()
        )
    })?;
    if !metadata.is_file() || metadata.len() > SERVICE_FILE_LIMIT {
        bail!("OpenCode service registration is not a bounded file");
    }
    let raw = fs::read_to_string(&file).context("read OpenCode service registration")?;
    let registration: Value =
        serde_json::from_str(&raw).context("OpenCode service registration is not JSON")?;
    let url = registration
        .get("url")
        .and_then(Value::as_str)
        .context("OpenCode service registration is missing url")?;
    let base = validate_origin(url, true)?;
    let password = registration
        .get("password")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut headers = Vec::new();
    if !password.is_empty() {
        if password.len() > 4096 {
            bail!("OpenCode service password is not bounded");
        }
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!("opencode:{password}").as_bytes());
        headers.push(("authorization".into(), format!("Basic {encoded}")));
        if !secrets.iter().any(|secret| secret == password) {
            secrets.push(password.to_owned());
        }
    }
    Ok(ApiEndpoint {
        base,
        headers,
        secrets: secrets.clone(),
    })
}

fn explicit_auth(secrets: &mut Vec<String>) -> Result<Vec<(String, String)>> {
    if let Ok(authorization) = env::var("AVEN_DISPATCH_OPENCODE_AUTHORIZATION") {
        if authorization.is_empty() || authorization.len() > 8192 {
            bail!("explicit OpenCode authorization header is not bounded");
        }
        return Ok(vec![("authorization".into(), authorization)]);
    }
    if let Ok(token) = env::var("AVEN_DISPATCH_OPENCODE_TOKEN") {
        if token.is_empty() || token.len() > 8192 {
            bail!("explicit OpenCode token is not bounded");
        }
        return Ok(vec![("authorization".into(), format!("Bearer {token}"))]);
    }
    if let Ok(password) = env::var("AVEN_DISPATCH_OPENCODE_PASSWORD") {
        if password.is_empty() || password.len() > 4096 {
            bail!("explicit OpenCode password is not bounded");
        }
        if !secrets.iter().any(|secret| secret == &password) {
            secrets.push(password.clone());
        }
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!("opencode:{password}").as_bytes());
        return Ok(vec![("authorization".into(), format!("Basic {encoded}"))]);
    }
    Ok(Vec::new())
}

fn default_service_file() -> PathBuf {
    let base = env::var_os("XDG_STATE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".local/state"))
        })
        .unwrap_or_else(|| PathBuf::from(".local/state"));
    base.join("opencode/service.json")
}

fn validate_origin(value: &str, require_loopback: bool) -> Result<String> {
    if value.len() > 2048 {
        bail!("OpenCode service origin is not bounded");
    }
    let url = Url::parse(value).context("OpenCode service origin is not a URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("OpenCode service origin must use http or https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("OpenCode service origin must not embed credentials");
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        bail!("OpenCode service origin must not carry a path, query or fragment");
    }
    if require_loopback
        && !matches!(
            url.host_str(),
            Some("127.0.0.1" | "localhost" | "::1" | "[::1]")
        )
    {
        bail!("discovered OpenCode service is not a loopback endpoint");
    }
    Ok(url.origin().ascii_serialization())
}

fn allowed_api_read(path: &str) -> bool {
    if path == "/openapi.json" || path == "/api/session/active" {
        return true;
    }
    let Some(rest) = path.strip_prefix("/api/session/") else {
        return false;
    };
    let mut parts = rest.split('/');
    let Some(session_id) = parts.next() else {
        return false;
    };
    if !valid_session_id(session_id) {
        return false;
    }
    match parts.next() {
        None => parts.next().is_none(),
        Some("permission" | "form") => parts.next().is_none(),
        Some(_) => false,
    }
}

struct ApiClient {
    agent: ureq::Agent,
    base: String,
    headers: Vec<(String, String)>,
    capabilities: BTreeSet<String>,
    secrets: Vec<String>,
}

enum ApiError {
    NotFound,
    Other(String),
}

impl ApiClient {
    fn connect(mut endpoint: ApiEndpoint) -> Result<Self> {
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_millis(API_REQUEST_TIMEOUT_MS))
            .redirects(0)
            .build();
        let mut client = Self {
            agent,
            base: endpoint.base,
            headers: endpoint.headers,
            capabilities: BTreeSet::new(),
            secrets: std::mem::take(&mut endpoint.secrets),
        };
        let schema = client.get("/openapi.json").map_err(|error| {
            anyhow!(
                "OpenCode capability discovery unavailable: {}",
                describe_api_error(error, &client.secrets)
            )
        })?;
        let paths = schema
            .get("paths")
            .and_then(Value::as_object)
            .context("OpenCode OpenAPI payload has no paths")?;
        for (path, value) in paths {
            if value.get("get").is_some() {
                client.capabilities.insert(path.clone());
            }
        }
        Ok(client)
    }

    fn supports(&self, path: &str) -> bool {
        self.capabilities.contains(path)
    }

    fn get(&self, path: &str) -> Result<Value, ApiError> {
        if !allowed_api_read(path) {
            return Err(ApiError::Other("non-allowlisted API read".into()));
        }
        let mut request = self.agent.get(&format!("{}{path}", self.base));
        for (name, value) in &self.headers {
            request = request.set(name, value);
        }
        let response = request.call().map_err(|error| match error {
            ureq::Error::Status(404, _) => ApiError::NotFound,
            other => ApiError::Other(api_error(other, &self.secrets)),
        })?;
        let status = response.status();
        if !(200..300).contains(&status) {
            return Err(ApiError::Other(format!(
                "API returned unsupported status {status}"
            )));
        }
        let mut body = Vec::new();
        response
            .into_reader()
            .take((API_RESPONSE_LIMIT + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|error| {
                ApiError::Other(sanitize(
                    &format!("read API response: {error}"),
                    200,
                    &self.secrets,
                ))
            })?;
        if body.len() > API_RESPONSE_LIMIT {
            return Err(ApiError::Other("API response exceeded the bound".into()));
        }
        serde_json::from_slice(&body)
            .map_err(|_| ApiError::Other("API returned malformed JSON".into()))
    }

    fn get_until(&self, path: &str, deadline: Instant) -> Result<Value, ApiError> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(ApiError::Other("API read budget exhausted".into()));
        }
        if !allowed_api_read(path) {
            return Err(ApiError::Other("non-allowlisted API read".into()));
        }
        let mut request = self
            .agent
            .get(&format!("{}{path}", self.base))
            .timeout(remaining.min(Duration::from_millis(API_REQUEST_TIMEOUT_MS)));
        for (name, value) in &self.headers {
            request = request.set(name, value);
        }
        let response = request.call().map_err(|error| match error {
            ureq::Error::Status(404, _) => ApiError::NotFound,
            other => ApiError::Other(api_error(other, &self.secrets)),
        })?;
        let status = response.status();
        if !(200..300).contains(&status) {
            return Err(ApiError::Other(format!(
                "API returned unsupported status {status}"
            )));
        }
        let mut body = Vec::new();
        response
            .into_reader()
            .take((API_RESPONSE_LIMIT + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|error| {
                ApiError::Other(sanitize(
                    &format!("read API response: {error}"),
                    200,
                    &self.secrets,
                ))
            })?;
        if body.len() > API_RESPONSE_LIMIT {
            return Err(ApiError::Other("API response exceeded the bound".into()));
        }
        serde_json::from_slice(&body)
            .map_err(|_| ApiError::Other("API returned malformed JSON".into()))
    }
}

fn api_error(error: ureq::Error, secrets: &[String]) -> String {
    match error {
        ureq::Error::Status(status, _) => format!("API returned status {status}"),
        ureq::Error::Transport(error) => {
            sanitize(&format!("API transport unavailable: {error}"), 200, secrets)
        }
    }
}

fn describe_api_error(error: ApiError, secrets: &[String]) -> String {
    match error {
        ApiError::NotFound => "API returned status 404".into(),
        ApiError::Other(message) => sanitize(&message, 200, secrets),
    }
}

fn read_api_activity(sessions: &mut [SessionRecord], secrets: &[String]) -> SourceHealth {
    if sessions.is_empty() {
        return SourceHealth::ok(
            "opencode",
            "No linked execution sessions; the API was not queried.",
        );
    }
    let mut known = secrets.to_vec();
    let deadline = Instant::now() + Duration::from_millis(SOURCE_TIMEOUT_MS);
    let endpoint = match discover_api(&mut known) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            return SourceHealth::unavailable(
                "opencode",
                format!(
                    "OpenCode is optional and unavailable; API activity stays unknown and no service was started: {}",
                    source_error(&error, secrets)
                ),
            );
        }
    };
    let client = match ApiClient::connect(endpoint) {
        Ok(client) => client,
        Err(error) => {
            return SourceHealth::unavailable(
                "opencode",
                format!(
                    "OpenCode is optional and unavailable; API activity stays unknown and no service was started: {}",
                    source_error(&error, secrets)
                ),
            );
        }
    };
    if !client.supports("/api/session/active") || !client.supports("/api/session/{sessionID}") {
        return SourceHealth::unavailable(
            "opencode",
            "Installed OpenCode service lacks the required activity/session GET endpoints; API activity unknown.",
        );
    }
    let active = match client.get_until("/api/session/active", deadline) {
        Ok(value) => value
            .get("data")
            .cloned()
            .unwrap_or(value)
            .as_object()
            .map(|values| {
                values
                    .iter()
                    .filter(|(_, value)| {
                        value.get("type").and_then(Value::as_str) == Some("running")
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default(),
        Err(error) => {
            return SourceHealth::unavailable(
                "opencode",
                format!(
                    "OpenCode activity endpoint unavailable; API activity stays unknown: {}",
                    describe_api_error(error, &client.secrets)
                ),
            );
        }
    };
    let observed_at = now();
    let expires_at = observed_at.saturating_add(ACTIVITY_TTL_MS);
    let next = AtomicUsize::new(0);
    let failures = AtomicUsize::new(0);
    let results = Mutex::new(Vec::new());
    thread::scope(|thread_scope| {
        for _ in 0..SOURCE_WORKERS.min(sessions.len().max(1)) {
            thread_scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(session) = sessions.get(index) else {
                        break;
                    };
                    if Instant::now() >= deadline {
                        break;
                    }
                    let result = read_one_activity(&client, &session.session_id, &active, deadline);
                    if result.is_err() {
                        failures.fetch_add(1, Ordering::SeqCst);
                    }
                    results
                        .lock()
                        .expect("API result lock")
                        .push((index, result));
                }
            });
        }
    });
    for (index, result) in results.into_inner().expect("API result lock") {
        match result {
            Ok(mut activity) => {
                activity.observed_at_ms = observed_at;
                activity.expires_at_ms = expires_at;
                sessions[index].api = activity;
            }
            Err(_) => {
                sessions[index].api = ApiActivity {
                    freshness: Freshness::Unknown,
                    ..ApiActivity::unknown()
                };
            }
        }
    }
    let failures = failures.load(Ordering::SeqCst);
    let remaining = sessions
        .iter()
        .filter(|session| session.api.observed_at_ms == 0)
        .count();
    if failures > 0 || remaining > 0 {
        SourceHealth::incomplete(
            "opencode",
            format!(
                "Linked API activity partially unavailable ({} failed, {} not observed); unknown is never reported as idle.",
                failures, remaining
            ),
        )
    } else {
        SourceHealth::ok(
            "opencode",
            format!(
                "Authenticated GET-only V2 activity for {} linked session(s); live activity expires after {} ms.",
                sessions.len(),
                ACTIVITY_TTL_MS
            ),
        )
    }
}

fn read_one_activity(
    client: &ApiClient,
    session_id: &str,
    active: &BTreeSet<String>,
    deadline: Instant,
) -> Result<ApiActivity, ApiError> {
    let info = match client.get_until(&format!("/api/session/{session_id}"), deadline) {
        Ok(info) => info,
        Err(ApiError::NotFound) => {
            return Ok(ApiActivity {
                state: ApiState::Missing,
                freshness: Freshness::Current,
                observed_at_ms: now(),
                expires_at_ms: now().saturating_add(ACTIVITY_TTL_MS),
                approval_waiting: Tri::Unknown,
                input_waiting: Tri::Unknown,
                parent_id: None,
            });
        }
        Err(error) => return Err(error),
    };
    let data = info.get("data").unwrap_or(&info);
    let returned_id = data.get("id").and_then(Value::as_str).unwrap_or_default();
    if returned_id != session_id {
        return Err(ApiError::Other(
            "API returned a mismatched session identity".into(),
        ));
    }
    let parent_id = data
        .get("parentID")
        .and_then(Value::as_str)
        .filter(|value| valid_session_id(value))
        .map(str::to_owned);
    let mut activity = ApiActivity {
        state: if active.contains(session_id) {
            ApiState::Working
        } else {
            ApiState::Idle
        },
        freshness: Freshness::Current,
        observed_at_ms: now(),
        expires_at_ms: now().saturating_add(ACTIVITY_TTL_MS),
        approval_waiting: Tri::Unknown,
        input_waiting: Tri::Unknown,
        parent_id,
    };
    if Instant::now() < deadline && client.supports("/api/session/{sessionID}/permission") {
        activity.approval_waiting = waiting_facet(
            client,
            &format!("/api/session/{session_id}/permission"),
            deadline,
        );
    }
    if Instant::now() < deadline && client.supports("/api/session/{sessionID}/form") {
        activity.input_waiting =
            waiting_facet(client, &format!("/api/session/{session_id}/form"), deadline);
    }
    Ok(activity)
}

fn waiting_facet(client: &ApiClient, path: &str, deadline: Instant) -> Tri {
    match client.get_until(path, deadline) {
        Ok(value) => {
            let data = value.get("data").unwrap_or(&value);
            match data.as_array() {
                Some(values) => {
                    if values.is_empty() {
                        Tri::No
                    } else {
                        Tri::Yes
                    }
                }
                None => Tri::Unknown,
            }
        }
        Err(_) => Tri::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn context(metadata: &[(&str, &str)]) -> AvenContext {
        let metadata = metadata
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Value::String((*value).to_owned())))
            .collect();
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

    fn payload(attempt_id: &str, generation: u64, created_at: u64, state: &str) -> String {
        serde_json::json!({
            "task_id": "task-one",
            "task_ref": "APP-1",
            "workflow": "implementation",
            "attempt_id": attempt_id,
            "generation": generation,
            "session_id": "ses_one",
            "pane": "w1:p1",
            "state": state,
            "created_at": created_at,
            "prompt_id": "msg_secret",
            "pending_prompt": "do not leak this prompt"
        })
        .to_string()
    }

    fn contexts(metadata: &[(&str, &str)]) -> BTreeMap<String, (AvenContext, u64)> {
        BTreeMap::from([("task-one".to_owned(), (context(metadata), 10))])
    }

    #[test]
    fn recovery_only_attempts_are_accepted_with_generation_zero() {
        let contexts = contexts(&[(
            "dispatch.attempt.implementation",
            &payload("a1", 0, 5, "running"),
        )]);
        let store = tempfile::tempdir().unwrap().path().join("missing.sqlite");
        let (attempts, health) = read_attempts(&store, &contexts, &[]);
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].origin, Origin::AvenRecovery);
        assert_eq!(attempts[0].generation, 0);
        assert_eq!(health.status, HealthStatus::Unavailable);
        assert!(
            !store.exists(),
            "inspection must not create a missing store"
        );
    }

    #[test]
    fn newer_central_record_wins_and_equal_ties_favor_central_store() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("dispatch.sqlite");
        let connection = rusqlite::Connection::open(&store).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE attempts (task_id TEXT, workflow TEXT, attempt_id TEXT, task_ref TEXT,
                 state TEXT, generation INTEGER, session_id TEXT, created_at INTEGER,
                 updated_at INTEGER, payload TEXT, PRIMARY KEY (task_id, workflow));
                 PRAGMA user_version = 1;",
            )
            .unwrap();
        for (workflow, attempt_id, created, state) in [
            ("implementation", "central", 20, "needs-review"),
            ("planning", "tie", 10, "running"),
        ] {
            connection
                .execute(
                    "INSERT INTO attempts (task_id, workflow, attempt_id, task_ref, state, generation, session_id, created_at, updated_at, payload)
                     VALUES (?1, ?2, ?3, ?4, ?5, 1, 'ses_central', ?6, ?6, ?7)",
                    rusqlite::params![
                        "task-one",
                        workflow,
                        attempt_id,
                        "APP-1",
                        state,
                        created as i64,
                        payload(attempt_id, 1, created, state)
                            .replace("\"workflow\":\"implementation\"", &format!("\"workflow\":\"{workflow}\""))
                    ],
                )
                .unwrap();
        }
        drop(connection);
        let contexts = contexts(&[
            ("dispatch.reset-generation", "1"),
            (
                "dispatch.attempt.implementation",
                &payload("recovery-newer", 1, 30, "running"),
            ),
            (
                "dispatch.attempt.planning",
                &payload("tie", 1, 10, "running"),
            ),
        ]);
        let (attempts, _) = read_attempts(&store, &contexts, &[]);
        let implementation = attempts
            .iter()
            .find(|attempt| attempt.workflow == "implementation")
            .unwrap();
        assert_eq!(implementation.attempt_id, "recovery-newer");
        let planning = attempts
            .iter()
            .find(|attempt| attempt.workflow == "planning")
            .unwrap();
        assert_eq!(planning.origin, Origin::CentralStore);
    }

    #[test]
    fn reset_in_progress_and_obsolete_generations_are_rejected() {
        let contexts = contexts(&[
            ("dispatch.reset-generation", "2"),
            ("dispatch.reset-state", "in_progress"),
            (
                "dispatch.attempt.implementation",
                &payload("stale", 1, 5, "running"),
            ),
        ]);
        let store = tempfile::tempdir().unwrap().path().join("missing.sqlite");
        let (attempts, health) = read_attempts(&store, &contexts, &[]);
        assert!(attempts.is_empty());
        assert_eq!(health.status, HealthStatus::Unavailable);
        assert!(health.message.contains("rejected"));
    }

    #[test]
    fn schema_is_serialized_without_prompts_or_invocation_details() {
        let attempts = vec![AttemptRecord {
            task_id: "task-one".into(),
            task_ref: "APP-1".into(),
            workflow: "implementation".into(),
            attempt_id: "a1".into(),
            generation: 0,
            origin: Origin::CentralStore,
            observed_at_ms: 1,
            created_at_ms: 1,
            state: "running".into(),
            execution_mode: "single-session".into(),
            backend: "hc".into(),
            core_id: "core".into(),
            terminal: TerminalLink::default(),
            coordinator_terminal: TerminalLink::default(),
            babysitter_terminal: TerminalLink::default(),
            branch: String::new(),
            worktree: String::new(),
            worktree_created_by_attempt: false,
            agent: String::new(),
            model: String::new(),
            coordinator_agent: String::new(),
            coordinator_model: String::new(),
            coordinator_session_id: String::new(),
            babysitter: false,
            babysitter_session_id: String::new(),
            babysitter_pane: String::new(),
            session_id: "ses_one".into(),
            pane: "w1:p1".into(),
            phases: Vec::new(),
        }];
        let serialized = serde_json::to_string(&attempts).unwrap();
        assert!(!serialized.contains("prompt"));
        assert!(!serialized.contains("aven"));
    }

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
    fn api_allowlist_is_exact() {
        assert!(allowed_api_read("/openapi.json"));
        assert!(allowed_api_read("/api/session/active"));
        assert!(allowed_api_read("/api/session/ses_one"));
        assert!(allowed_api_read("/api/session/ses_one/permission"));
        assert!(allowed_api_read("/api/session/ses_one/form"));
        assert!(!allowed_api_read("/api/session"));
        assert!(!allowed_api_read("/api/session?limit=1"));
        assert!(!allowed_api_read("/api/session/ses_one/message"));
        assert!(!allowed_api_read("/api/session/ses_one/permission/x"));
        assert!(!allowed_api_read("/api/session/ses_bad/../x"));
    }

    #[test]
    fn malformed_and_newer_stores_do_not_panic_or_create_files() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing.sqlite");
        assert!(read_only_store_payloads(&missing, 10).is_err());
        assert!(!missing.exists());
        let newer = directory.path().join("newer.sqlite");
        let connection = rusqlite::Connection::open(&newer).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);
        assert!(read_only_store_payloads(&newer, 10).is_err());
        let malformed = directory.path().join("malformed.sqlite");
        fs::write(&malformed, b"not sqlite").unwrap();
        assert!(read_only_store_payloads(&malformed, 10).is_err());
    }
}
