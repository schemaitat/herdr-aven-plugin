//! Command-facing dispatch types.

pub(crate) mod approval;
pub(crate) mod audit;
pub(crate) mod aven;
pub(crate) mod board;
pub(crate) mod closeout;
pub(crate) mod disposition;
pub(crate) mod integration;
pub(crate) mod lifecycle;
pub(crate) mod phases;
pub(crate) mod plan;
pub(crate) mod reset;
pub(crate) mod runtime;
pub(crate) mod summary;
pub(crate) mod supervision;

use self::runtime::{
    admit_babysitter, create_worktree, focus_terminal, launch_and_record,
    provision_phase_worktrees, remove_owned_worktree, start_babysitter, start_optional_babysitter,
    wait_for_global_agent,
};

use self::aven::{
    ensure_attempt_current, refresh_task_by_ref, repair_aven_links, reset_incomplete,
    task_generation,
};

use self::lifecycle::{ensure_pending_admission_open, validate_dispatch_target};
use self::plan::validate_epic_phases;

use crate::{
    agents::{
        ORCHESTRATOR_AGENT, ORCHESTRATOR_AGENT_ID, install_global_agent, resolve_orchestrator_model,
    },
    agents::{select_agent, select_model},
    app, core,
    model::{
        Attempt, CommandContext, ExecutionMode, Invocation, Selected, TerminalRef,
        attempt_is_legacy, attempt_key, normalize_attempt, workflow_for_skill,
    },
    process::{field, identifier, now, opencode, run},
    store::{LockedStore, store_attempt},
    worktrees,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    collections::BTreeSet,
    env, fs,
    io::{self, BufRead, Read, Write},
    path::{Path, PathBuf},
};

/// Inputs assembled once from unchanged CLI flags before dispatch admission.
#[derive(Clone)]
pub(crate) struct DispatchOptions {
    pub(crate) path: PathBuf,
    pub(crate) dry_run: bool,
    pub(crate) agent: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) preferred_agent: Option<String>,
    pub(crate) preferred_model: Option<String>,
    pub(crate) skill: Option<String>,
    pub(crate) skills_dir: Option<PathBuf>,
    pub(crate) babysitter: bool,
    pub(crate) babysitter_model: Option<String>,
    pub(crate) orchestrator_model: Option<String>,
    pub(crate) requested_mode: Option<ExecutionMode>,
    pub(crate) relaunch: bool,
}

/// Validate and optionally dry-run an existing attempt before its reopen effects.
pub(crate) fn reopen_preflight(
    task: &Value,
    existing: &Attempt,
    relaunch: bool,
    requested_mode: Option<ExecutionMode>,
    dry_run: bool,
) -> Result<bool> {
    // An existing attempt is not permission to re-admit a task that Aven has
    // since accepted or canceled. Terminal reopening is a separate reviewed
    // Aven status transition plus reset generation.
    validate_dispatch_target(task, &existing.task_id, &existing.aven)?;
    ensure_attempt_current(task, existing)?;
    ensure_pending_admission_open(task, existing)?;
    if crate::model::attempt_is_legacy(existing) && !relaunch {
        bail!(
            "attempt {} was created by the retired herdr runtime; run `aven-dispatch dispatch --relaunch` to move its durable OpenCode session to herdr-core, or reset and redispatch",
            existing.attempt_id
        );
    }
    if let Some(mode) = requested_mode
        && mode != existing.execution_mode
    {
        bail!(
            "attempt already uses {} mode; reopen preserves its saved topology",
            existing.execution_mode.as_str()
        );
    }
    if dry_run {
        println!(
            "would reopen {} in OpenCode session {} (attempt {})",
            existing.task_ref, existing.session_id, existing.attempt_id
        );
        return Ok(true);
    }
    Ok(false)
}

// Runtime terminal/worktree ownership primitives used by admission.
// Stable, human-filterable owner labels. They prove which attempt a terminal
// belongs to; they are never used as permission to advance Aven state.

/// Launch (or safely adopt) the OpenCode CLI for one role in a dedicated
/// herdr-core terminal, detached from this short-lived dispatcher process.
// Durable dispatcher diagnostic event formatting and best-effort persistence.
pub(crate) fn bundled_skill(
    skill: Option<String>,
    skills_dir: Option<PathBuf>,
) -> Result<Option<String>> {
    let Some(skill) = skill.or_else(|| env::var("AVEN_DISPATCH_SKILL").ok()) else {
        return Ok(None);
    };
    if skill.is_empty() {
        return Ok(None);
    }
    if skill.split('/').any(|segment| {
        segment.is_empty()
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }) {
        bail!("invalid AVEN_DISPATCH_SKILL: {skill}");
    }
    let skills_dir = skills_dir.unwrap_or_else(|| {
        let mut candidates = vec![
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
                .join("skills"),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("skills"),
        ];
        if let Some(executable) = env::current_exe().ok()
            && let Some(directory) = executable.parent()
        {
            candidates.push(directory.join("skills"));
            if let Some(parent) = directory.parent() {
                candidates.push(parent.join("skills"));
            }
        }
        candidates
            .into_iter()
            .find(|candidate| candidate.exists())
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("skills"))
    });
    let path = skills_dir.join(skill).with_extension("md");
    let text = fs::read_to_string(&path)
        .with_context(|| format!("read bundled dispatch skill {}", path.display()))?;
    Ok(Some(text))
}
pub(crate) fn workflow_prompt(
    task: &Value,
    reference: &str,
    skill: Option<String>,
    skills_dir: Option<PathBuf>,
) -> Result<String> {
    let opening =
        bundled_skill(skill, skills_dir)?.unwrap_or_else(|| format!("Implement {reference}."));
    Ok(format!(
        "{opening}\n\nAven is the source of truth: re-read `aven context {reference} --full`, record handoffs and verification in Aven notes, and do not mark the task done until verification/review succeeds.\n\nTask context:\n{}",
        serde_json::to_string_pretty(task).unwrap()
    ))
}
pub(crate) fn execution_guidance(mode: ExecutionMode) -> &'static str {
    match mode {
        ExecutionMode::SingleSession => {
            "Work every planned item in dependency order in this OpenCode session and its existing worktree. Do not coordinate or provision cumulative worktrees."
        }
        ExecutionMode::Subsessions => {
            "Use native subsessions for planned child work one at a time in this worktree. Verify each predecessor before beginning its successor; do not coordinate or provision cumulative worktrees."
        }
        ExecutionMode::Worktrees => {
            "You are the coordinator for cumulative worktrees. Do not implement a phase in this worktree; preserve the ordered worker and integration lifecycle below."
        }
    }
}
pub(crate) fn root_prompt(
    task: &Value,
    reference: &str,
    skill: Option<String>,
    skills_dir: Option<PathBuf>,
    mode: ExecutionMode,
    topology: Option<&str>,
) -> Result<String> {
    let topology = match mode {
        ExecutionMode::Worktrees => {
            topology.context("worktree mode requires coordinator topology")?
        }
        ExecutionMode::SingleSession | ExecutionMode::Subsessions => "",
    };
    Ok(format!(
        "{}\n\n## Execution mode\n\n{}{}",
        workflow_prompt(task, reference, skill, skills_dir)?,
        execution_guidance(mode),
        topology,
    ))
}

// Dispatch prompt and durable log ownership.
// The reopen flow threads the existing attempt plus CLI-provided overrides;
// a parameter struct would only mirror those fields.
#[allow(clippy::too_many_arguments)]
pub(crate) fn reopen_existing(
    existing: Attempt,
    task: &Value,
    origin_cwd: &str,
    task_title: &str,
    path: PathBuf,
    agent: Option<String>,
    model: Option<String>,
    skill: Option<String>,
    skills_dir: Option<PathBuf>,
) -> Result<()> {
    // Reopen confirmation uses interactive pickers; release the store
    // lock before starting them and reacquire only to checkpoint state.
    let resource = create_worktree(
        origin_cwd,
        &existing.branch,
        &format!("{} {}", existing.task_ref, task_title),
        None,
    )?;
    if agent.as_deref().is_none_or(|agent| agent == "select") {
        select_agent(&resource.path, &path, Some(&existing.agent), None)?;
    }
    if model.is_none() {
        select_model(
            &[(
                format!("Saved model ({})", existing.model),
                existing.model.clone(),
            )],
            &path,
        )?;
    }
    let mut reopened = existing;
    let prior_state = reopened.state.clone();
    let same_checkout = reopened.worktree == resource.path;
    reopened.worktree_created_by_attempt =
        (same_checkout && reopened.worktree_created_by_attempt) || resource.created_by_attempt;
    reopened.worktree = resource.path;
    let was_legacy = attempt_is_legacy(&reopened);
    reopened.backend = "hc".into();
    reopened.state = "terminal-pending".into();
    if was_legacy {
        // Identity cannot be mapped; the new terminal replaces the old
        // pane, and the durable OpenCode session/prompt ids are preserved.
        reopened.terminal = TerminalRef::default();
        reopened.coordinator_terminal = TerminalRef::default();
        reopened.babysitter_terminal = TerminalRef::default();
        reopened.terminals.clear();
        for phase in &mut reopened.phases {
            phase.terminal = TerminalRef::default();
        }
    }
    let mut store = LockedStore::open(path.clone())?;
    store_attempt(&mut store, reopened.clone());
    store.save()?;
    let role = if reopened.execution_mode == ExecutionMode::Worktrees {
        "coordinator"
    } else {
        "builder"
    };
    let session_id = reopened.session_id.clone();
    let worktree = reopened.worktree.clone();
    let terminal = launch_and_record(
        &mut reopened,
        role,
        &worktree,
        &session_id,
        &path,
        &mut store,
    )?;
    let _ = app::show_worktree(
        &terminal.address,
        &terminal.address,
        &worktree,
        &format!("{} {}", reopened.task_ref, task_title),
        &reopened.task_ref,
    );
    if reopened.babysitter {
        if reopened.babysitter_session_id.is_empty() {
            // A prior dispatch can fail during babysitter discovery after
            // the build session is durable. Retry the missing sidecar on
            // reopen rather than silently reopening without supervision.
            start_babysitter(&mut reopened, &path, &mut store)?;
        } else {
            let session = reopened.babysitter_session_id.clone();
            let worktree = reopened.worktree.clone();
            let babysitter = launch_and_record(
                &mut reopened,
                "babysitter",
                &worktree,
                &session,
                &path,
                &mut store,
            )?;
            let _ = app::show_worktree(
                &babysitter.address,
                &reopened.terminal.address,
                &worktree,
                &format!("Babysit {}", reopened.task_ref),
                &reopened.task_ref,
            );
            if matches!(
                prior_state.as_str(),
                "babysitter-session-pending" | "babysitter-prompt-pending"
            ) {
                admit_babysitter(&mut reopened, &mut store)?;
            }
        }
    }
    if matches!(prior_state.as_str(), "prompt-pending" | "terminal-pending") {
        if reopened.pending_prompt.is_empty() {
            if reopened.execution_mode == ExecutionMode::Worktrees {
                bail!(
                    "worktree attempt is awaiting prompt admission without a durable prompt body; its coordinator topology cannot be reconstructed safely, so reset and redispatch it"
                );
            }
            // Early dispatcher versions could persist a session as
            // prompt-pending before checkpointing its deterministic root
            // prompt. Rebuild that prompt for single-session/subsession
            // workflows rather than permanently stranding the attempt.
            reopened.prompt_id = identifier("msg");
            reopened.pending_prompt = root_prompt(
                task,
                &reopened.task_ref,
                skill,
                skills_dir,
                reopened.execution_mode,
                None,
            )?;
        }
        reopened.state = "prompt-pending".into();
        store_attempt(&mut store, reopened.clone());
        store.save()?;
        let admission = opencode(
            "POST",
            &format!("/api/session/{}/prompt", reopened.session_id),
            Some(
                json!({"id": reopened.prompt_id, "text": reopened.pending_prompt, "resume": true}),
            ),
        )?;
        if field(&admission, "/data/id")? != reopened.prompt_id {
            bail!("OpenCode admitted an unexpected recovered message id");
        }
    }
    reopened.state = if matches!(
        prior_state.as_str(),
        "prompt-pending"
            | "terminal-pending"
            | "babysitter-session-pending"
            | "babysitter-prompt-pending"
    ) {
        "running".into()
    } else {
        prior_state
    };
    store_attempt(&mut store, reopened.clone());
    store.save()?;
    let focused = if !reopened.terminal.is_empty() {
        reopened.terminal.address.clone()
    } else {
        reopened.coordinator_terminal.address.clone()
    };
    focus_terminal(&focused);
    println!(
        "reopened {} in OpenCode session {} (attempt {})",
        reopened.task_ref, reopened.session_id, reopened.attempt_id
    );
    Ok(())
}

/// Construct the durable attempt before any reservation or external effect.
/// The arguments mirror the attempt record and its invocation overrides; a
/// parameter struct would duplicate them without adding behavior.
#[allow(clippy::too_many_arguments)]
pub(crate) fn new_attempt(
    task_id: String,
    task_ref: String,
    workflow: &str,
    branch: String,
    agent: Option<String>,
    model: Option<String>,
    execution_mode: ExecutionMode,
    generation: u64,
    babysitter: bool,
    babysitter_model: Option<String>,
    invocation: Invocation,
) -> Attempt {
    Attempt {
        task_id,
        task_ref,
        workflow: workflow.into(),
        attempt_id: identifier("att"),
        branch,
        worktree: String::new(),
        worktree_created_by_attempt: false,
        backend: "hc".into(),
        core_id: String::new(),
        core_name: String::new(),
        terminal: TerminalRef::default(),
        pane: String::new(),
        agent: agent.unwrap_or_default(),
        model: model.unwrap_or_default(),
        execution_mode,
        coordinator_session_id: String::new(),
        coordinator_agent: String::new(),
        coordinator_model: String::new(),
        coordinator_terminal: TerminalRef::default(),
        auto_permissions: true,
        phases: Vec::new(),
        terminals: BTreeMap::new(),
        last_event_seq: 0,
        session_id: String::new(),
        prompt_id: identifier("msg"),
        pending_prompt: String::new(),
        state: "workspace-pending".into(),
        lifecycle: crate::model::LifecycleState::default(),
        aven_update_pending: false,
        log_cursor: String::new(),
        log_task_ref: String::new(),
        generation,
        babysitter,
        babysitter_model: crate::agents::resolve_babysitter_model(babysitter, babysitter_model),
        babysitter_terminal: TerminalRef::default(),
        babysitter_pane: String::new(),
        babysitter_session_id: String::new(),
        babysitter_prompt_id: String::new(),
        aven: invocation,
        created_at: now(),
    }
}

/// Atomically reserve a newly provisioned attempt before picker or session effects.
pub(crate) fn reserve_attempt(attempt: &Attempt, path: PathBuf) -> Result<LockedStore> {
    let mut store = LockedStore::open(path)?;
    if let Some(existing) = store.reserve(attempt.clone())? {
        drop(store);
        remove_owned_worktree(&attempt.worktree, attempt.worktree_created_by_attempt);
        bail!(
            "another dispatcher already started {} (attempt {}); run aven-dispatch status {}",
            existing.task_ref,
            existing.attempt_id,
            existing.task_ref
        );
    }
    store.save()?;
    Ok(store)
}

/// Undo only a failed new-attempt reservation and its owned worktree.
pub(crate) fn fail_provisioning(
    attempt: &Attempt,
    error: anyhow::Error,
    path: &Path,
) -> anyhow::Error {
    if let Ok(mut store) = LockedStore::open(path.to_path_buf())
        && let Err(cleanup) = store.remove_attempt(&attempt.task_id, &attempt.workflow)
    {
        eprintln!("could not remove failed provisioning reservation: {cleanup:#}");
    }
    remove_owned_worktree(&attempt.worktree, attempt.worktree_created_by_attempt);
    error
}

/// Select the primary agent after reservation, cleaning up only on picker failure.
pub(crate) fn select_primary_agent(
    attempt: &mut Attempt,
    path: &Path,
    preferred_agent: Option<&str>,
) -> Result<()> {
    if attempt.agent.is_empty() || attempt.agent == "select" {
        attempt.agent = select_agent(&attempt.worktree, path, None, preferred_agent)
            .map_err(|error| fail_provisioning(attempt, error, path))?;
    }
    Ok(())
}

/// Select a worker model after reservation, retaining configured-model fallback behavior.
pub(crate) fn select_attempt_model(
    attempt: &mut Attempt,
    path: &Path,
    preferred_model: Option<&str>,
) -> Result<()> {
    if attempt.model.is_empty() {
        let configured = crate::agents::configured_agent_model(&attempt.worktree, &attempt.agent)
            .map_err(|error| fail_provisioning(attempt, error, path))?;
        let available = match crate::agents::available_models(&attempt.worktree) {
            Ok(models) => models,
            Err(error) => {
                eprintln!(
                    "warning: could not list configured OpenCode models; using built-in choices: {error:#}"
                );
                Vec::new()
            }
        };
        attempt.model = select_model(
            &crate::agents::model_choices(configured.as_deref(), preferred_model, &available),
            path,
        )
        .map_err(|error| fail_provisioning(attempt, error, path))?;
    }
    Ok(())
}

/// Reopen the store and persist the pre-session recovery checkpoint.
pub(crate) fn checkpoint_session_pending(
    attempt: &mut Attempt,
    path: PathBuf,
) -> Result<LockedStore> {
    let mut store = LockedStore::open(path)?;
    attempt.state = "session-pending".into();
    store_attempt(&mut store, attempt.clone());
    store.save()?;
    Ok(store)
}

/// Build the unchanged OpenCode session request body for a prepared attempt.
pub(crate) fn session_payload(
    attempt: &Attempt,
    task_title: &str,
    session_agent: &str,
    session_model: &str,
) -> Result<Value> {
    Ok(json!({
        "title": format!("{} {}", attempt.task_ref, task_title),
        "location": {"directory": attempt.worktree},
        "agent": if session_agent.is_empty() { Value::Null } else { Value::String(session_agent.into()) },
        "model": crate::agents::model_ref(Some(session_model))?,
        "permissions": [{"action": "*", "resource": "*", "effect": "allow"}],
    }))
}

/// Create the OpenCode session and persist its durable identity on the attempt.
pub(crate) fn create_session(
    attempt: &mut Attempt,
    task_title: &str,
    session_agent: String,
    session_model: String,
) -> Result<()> {
    let payload = session_payload(attempt, task_title, &session_agent, &session_model)?;
    let session = if attempt.execution_mode == ExecutionMode::Worktrees {
        opencode("POST", "/api/session", Some(payload))?
    } else {
        crate::process::opencode_in(
            "POST",
            "/api/session",
            Some(payload),
            Path::new(&attempt.worktree),
        )?
    };
    attempt.session_id = field(&session, "/data/id")?.to_owned();
    attempt.coordinator_session_id = attempt.session_id.clone();
    attempt.coordinator_agent = session_agent;
    attempt.coordinator_model = session_model;
    Ok(())
}

/// Checkpoint and launch the primary OpenCode terminal before prompt admission.
pub(crate) fn launch_primary_terminal(
    attempt: &mut Attempt,
    path: &Path,
    store: &mut LockedStore,
    task_title: &str,
) -> Result<core::Terminal> {
    attempt.state = "terminal-pending".into();
    store_attempt(store, attempt.clone());
    store.save()?;
    let role = if attempt.execution_mode == ExecutionMode::Worktrees {
        "coordinator"
    } else {
        "builder"
    };
    let session_id = attempt.session_id.clone();
    let worktree = attempt.worktree.clone();
    let terminal = launch_and_record(attempt, role, &worktree, &session_id, path, store)?;
    let _ = app::show_worktree(
        &terminal.address,
        &terminal.address,
        &worktree,
        &format!("{} {}", attempt.task_ref, task_title),
        &attempt.task_ref,
    );
    Ok(terminal)
}

/// Persist and admit the root prompt before optional supervision is started.
pub(crate) fn admit_root_prompt(
    attempt: &mut Attempt,
    task: &Value,
    skill: Option<String>,
    skills_dir: Option<PathBuf>,
    store: &mut LockedStore,
) -> Result<()> {
    attempt.state = "prompt-pending".into();
    let topology =
        (attempt.execution_mode == ExecutionMode::Worktrees).then(|| coordinator_topology(attempt));
    attempt.pending_prompt = root_prompt(
        task,
        &attempt.task_ref,
        skill,
        skills_dir,
        attempt.execution_mode,
        topology.as_deref(),
    )?;
    store_attempt(store, attempt.clone());
    store.save()?;
    let admission = opencode(
        "POST",
        &format!("/api/session/{}/prompt", attempt.session_id),
        Some(json!({"id": attempt.prompt_id, "text": attempt.pending_prompt, "resume": true})),
    )?;
    if field(&admission, "/data/id")? != attempt.prompt_id {
        bail!("OpenCode admitted an unexpected message id");
    }
    attempt.state = "running".into();
    store_attempt(store, attempt.clone());
    store.save()?;
    Ok(())
}

/// Start optional supervision only after the root prompt is durable and admitted.
/// Best-effort Aven repair; only a successful write clears the pending marker.
pub(crate) fn coordinator_topology(attempt: &Attempt) -> String {
    let phases = attempt
        .phases
        .iter()
        .map(|phase| {
            format!(
                "- `{}` — branch `{}`; worktree `{}`; worker session `{}`; state `{}`",
                phase.task_ref, phase.branch, phase.worktree, phase.session_id, phase.state
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "\n\n## Pre-provisioned cumulative worktrees\n\nYou are the coordinator only: do not implement a phase in this worktree. The dispatcher has provisioned one worker worktree per ordered phase. The first ready phase is already admitted; later phase sessions remain unprompted until their predecessor is committed, tested, reviewed, and cleanly fast-forwarded into `{}`. Preserve all state and record a blocker rather than bypassing this order.\n\n{}",
        attempt.branch, phases
    )
}

// Durable task metadata and handoff note writer.
pub(crate) fn finish_admission(attempt: &Attempt, terminal: &core::Terminal, path: &Path) {
    focus_terminal(&terminal.address);
    if let Ok(core) = core::identity()
        && let Ok(terminals) = core::snapshot(&[("aven.dispatch".into(), "1".into())])
    {
        let _ = crate::watch::write_inventory(path, &core, &terminals);
    }
    println!(
        "admitted {} to OpenCode session {} (attempt {})",
        attempt.task_ref, attempt.session_id, attempt.attempt_id
    );
    if attempt.aven_update_pending {
        println!("Aven update pending; run reconcile before retrying dispatch");
    }
}

// Command-context parsing and authoritative target selection.
pub(crate) fn parse_context(text: &str) -> Result<CommandContext> {
    let context: CommandContext =
        serde_json::from_str(text).context("invalid Aven command context JSON")?;
    if context.version != 1 {
        bail!(
            "unsupported Aven command context version {}; expected 1",
            context.version
        );
    }
    if context.targeting.targets.is_empty() {
        bail!("dispatch requires at least one targeting.targets entry");
    }
    let mut target_ids = BTreeSet::new();
    for target in &context.targeting.targets {
        if target.id.is_empty() || target.reference().is_empty() {
            bail!("Aven target is missing immutable id or ref");
        }
        if !target_ids.insert(&target.id) {
            bail!(
                "Aven command context contains duplicate target id {}",
                target.id
            );
        }
    }
    // Aven resolves `marked-or-focused` to the marked tasks in `targeting`
    // while `selection.primary` still points at the focused row, which may be a
    // different task. Batch dispatch therefore cares only about the targets and
    // never singles out the focused selection.
    Ok(context)
}
pub(crate) fn selected_for(context: &CommandContext) -> Result<&Selected> {
    let selected = context
        .selection
        .primary
        .as_ref()
        .context("command context lacks selection.primary task details")?;
    if !context
        .targeting
        .targets
        .iter()
        .any(|target| target.id == selected.task.id)
    {
        bail!(
            "selection.primary does not belong to targeting.targets; refusing focused-selection operation"
        );
    }
    Ok(selected)
}
/// Re-read one batch target from Aven and build its authoritative selection.
pub(crate) fn selected_target(
    context: &CommandContext,
    target: &crate::model::Target,
) -> Result<(Selected, Value)> {
    let task = refresh_task_by_ref(&context.invocation, target.reference())?;
    if task.pointer("/task/id").and_then(Value::as_str) != Some(target.id.as_str()) {
        bail!("Aven re-read returned a different task; refusing dispatch");
    }
    let title = task
        .pointer("/task/title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let project = task
        .pointer("/project/key")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    Ok((
        Selected {
            reference: target.reference().to_owned(),
            short_ref: String::new(),
            task: crate::model::SelectedTask {
                id: target.id.clone(),
                title,
            },
            project: crate::model::Project { key: project },
        },
        task,
    ))
}

// Execution topology selection policy.
pub(crate) fn choose_mode(
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> Result<ExecutionMode> {
    writeln!(
        output,
        "Select implementation mode:\n\n  1. Single session (default)\n  2. Native subsessions\n  3. Cumulative worktrees"
    )?;
    loop {
        write!(
            output,
            "\nChoice [1-3], Enter for single session, or q to cancel: "
        )?;
        output.flush()?;
        let mut value = String::new();
        if input.read_line(&mut value)? == 0 || matches!(value.trim(), "q" | "Q") {
            bail!("implementation mode selection was canceled");
        }
        match value.trim() {
            "" | "1" => return Ok(ExecutionMode::SingleSession),
            "2" => return Ok(ExecutionMode::Subsessions),
            "3" => return Ok(ExecutionMode::Worktrees),
            _ => writeln!(output, "Enter 1, 2, 3, or q.")?,
        }
    }
}
pub(crate) fn select_mode(
    requested: Option<ExecutionMode>,
    workflow: &str,
) -> Result<ExecutionMode> {
    if workflow != "implementation" {
        if requested.is_some() {
            bail!("--mode applies only to implementation workflows");
        }
        return Ok(ExecutionMode::SingleSession);
    }
    if let Some(mode) = requested {
        return Ok(mode);
    }
    if env::var_os("AVEN_COMMAND_CONTEXT").is_some() {
        return choose_mode(&mut io::stdin().lock(), &mut io::stdout().lock());
    }
    Ok(ExecutionMode::SingleSession)
}

// Worktree phase provisioning and first-phase admission.
pub(crate) fn branch(project: &str, task_id: &str) -> String {
    format!(
        "{}/dispatch-{}",
        if project.is_empty() { "task" } else { project },
        task_id.to_ascii_lowercase()
    )
}

// Admission command orchestration.
pub(crate) fn dispatch(options: DispatchOptions) -> Result<()> {
    let input = if let Some(context) = env::var_os("AVEN_COMMAND_CONTEXT") {
        fs::read_to_string(context).context("read Aven terminal command context")?
    } else {
        let mut input = String::new();
        io::stdin().read_to_string(&mut input)?;
        input
    };
    let context = parse_context(&input)?;
    // Validate every target against Aven before the first admission side effect
    // so stale or inconsistent batch identities cannot partially dispatch.
    let targets = context
        .targeting
        .targets
        .iter()
        .map(|target| {
            let (selected, task) = selected_target(&context, target)?;
            // A mixed batch is rejected as a whole: one terminal/invalid
            // target must never create a partially dispatched batch.
            validate_dispatch_target(&task, &target.id, &context.invocation)?;
            Ok((selected, task))
        })
        .collect::<Result<Vec<_>>>()?;
    for (selected, task) in targets {
        dispatch_one(options.clone(), &context, &selected, task)?;
    }
    Ok(())
}

fn dispatch_one(
    options: DispatchOptions,
    context: &CommandContext,
    selected: &Selected,
    _initial_task: Value,
) -> Result<()> {
    let DispatchOptions {
        path,
        dry_run,
        agent,
        model,
        preferred_agent,
        preferred_model,
        skill,
        skills_dir,
        babysitter,
        babysitter_model,
        orchestrator_model,
        requested_mode,
        relaunch,
    } = options;
    // Re-read immediately before this target's effects. Concurrent external
    // Aven writers can stop this and remaining targets, but cannot roll back
    // work already admitted for earlier targets (Aven and the dispatcher are
    // not one transaction).
    let task = refresh_task_by_ref(&context.invocation, selected.reference())?;
    validate_dispatch_target(&task, &selected.task.id, &context.invocation)?;
    if reset_incomplete(&task) {
        bail!("task reset is incomplete; rerun aven-dispatch reset instead of admitting work");
    }
    let generation = task_generation(&task)?;
    let mut store = LockedStore::open(path.clone())?;
    let workflow = workflow_for_skill(skill.as_deref());
    let key = attempt_key(&selected.task.id, workflow);
    if !store.store.attempts.contains_key(&key)
        && let Some(snapshot) =
            task.get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| {
                    metadata
                        .get(&format!("dispatch.attempt.{workflow}"))
                        .and_then(Value::as_str)
                        .or_else(|| {
                            (workflow == "default")
                                .then(|| metadata.get("dispatch.attempt"))
                                .flatten()
                                .and_then(Value::as_str)
                        })
                })
    {
        // An attempt absent from the central store may still be recoverable
        // from the task-scoped Aven snapshot (including after the JSON cut).
        let recovered: Attempt = normalize_attempt(
            serde_json::from_str(snapshot).context("read Aven dispatcher attempt snapshot")?,
        );
        if recovered.task_id != selected.task.id {
            bail!("Aven dispatcher snapshot belongs to a different task");
        }
        if recovered.workflow != workflow {
            bail!("Aven dispatcher snapshot belongs to a different workflow role");
        }
        ensure_attempt_current(&task, &recovered)?;
        store_attempt(&mut store, recovered);
        if !dry_run {
            store.save()?;
        }
    }
    // A reservation without a durable OpenCode session crashed between
    // workspace provisioning and session creation. No agent ran, so discard it
    // only when the checkout is provably owned and clean, then dispatch fresh.
    if let Some(incomplete) = store.store.attempts.get(&key).cloned()
        && incomplete.session_id.is_empty()
        && !dry_run
    {
        if !incomplete.worktree.is_empty() {
            if !incomplete.worktree_created_by_attempt {
                bail!(
                    "incomplete attempt {} reuses worktree {}; inspect it before redispatch",
                    incomplete.attempt_id,
                    incomplete.worktree
                );
            }
            if !worktrees::clean(Path::new(&incomplete.worktree)).unwrap_or(false) {
                bail!(
                    "incomplete attempt {} left changes in {}; inspect them before redispatch",
                    incomplete.attempt_id,
                    incomplete.worktree
                );
            }
        }
        drop(store);
        if !incomplete.worktree.is_empty() {
            worktrees::remove_owned(&incomplete.worktree, true);
        }
        let mut reopened_store = LockedStore::open(path.clone())?;
        reopened_store.remove_attempt(&incomplete.task_id, &incomplete.workflow)?;
        reopened_store.save()?;
        drop(reopened_store);
        store = LockedStore::open(path.clone())?;
    }
    if let Some(existing) = store.store.attempts.get(&key).cloned() {
        if reopen_preflight(&task, &existing, relaunch, requested_mode, dry_run)? {
            return Ok(());
        }
        drop(store);
        return reopen_existing(
            existing,
            &task,
            &context.invocation.origin_cwd,
            &selected.task.title,
            path,
            agent,
            model,
            skill,
            skills_dir,
        );
    }
    // Mode and agent/model pickers can wait for user input indefinitely. Do
    // not retain the process-wide store lock while they are visible.
    drop(store);
    let execution_mode = select_mode(requested_mode, workflow)?;
    let orchestrator_model = resolve_orchestrator_model(execution_mode, orchestrator_model);
    let mut attempt = new_attempt(
        selected.task.id.clone(),
        selected.reference().to_owned(),
        workflow,
        branch(&selected.project.key, &selected.task.id),
        agent,
        model,
        execution_mode,
        generation,
        babysitter,
        babysitter_model,
        context.invocation.clone(),
    );
    if dry_run {
        println!(
            "would dispatch {} as {} on {}{}",
            attempt.task_ref,
            attempt.attempt_id,
            attempt.branch,
            if attempt.agent.is_empty() {
                String::new()
            } else {
                format!(" with agent {}", attempt.agent)
            }
        );
        return Ok(());
    }
    if attempt.execution_mode == ExecutionMode::Worktrees {
        validate_epic_phases(&context.invocation, &task, &attempt.task_ref)?;
    }
    let resource = create_worktree(
        &context.invocation.origin_cwd,
        &attempt.branch,
        &format!("{} {}", attempt.task_ref, selected.task.title),
        None,
    )?;
    attempt.worktree = resource.path;
    attempt.worktree_created_by_attempt = resource.created_by_attempt;
    // Persist ownership intent before pickers or a session can have side
    // effects. A later failure removes exactly this reservation and safely
    // cleans only the checkout this attempt created.
    let store = reserve_attempt(&attempt, path.clone())?;
    drop(store);
    select_primary_agent(&mut attempt, &path, preferred_agent.as_deref())?;
    select_attempt_model(&mut attempt, &path, preferred_model.as_deref())?;
    let mut store = checkpoint_session_pending(&mut attempt, path.clone())?;
    if attempt.execution_mode == ExecutionMode::Worktrees {
        install_global_agent(ORCHESTRATOR_AGENT_ID, ORCHESTRATOR_AGENT)?;
        wait_for_global_agent(ORCHESTRATOR_AGENT_ID)?;
        provision_phase_worktrees(&mut attempt, &task, &path, &mut store, skills_dir.clone())?;
        store_attempt(&mut store, attempt.clone());
        store.save()?;
    }
    let (session_agent, session_model) = if attempt.execution_mode == ExecutionMode::Worktrees {
        (ORCHESTRATOR_AGENT_ID.to_owned(), orchestrator_model)
    } else {
        (attempt.agent.clone(), attempt.model.clone())
    };
    create_session(
        &mut attempt,
        &selected.task.title,
        session_agent,
        session_model,
    )?;
    let terminal = launch_primary_terminal(&mut attempt, &path, &mut store, &selected.task.title)?;
    admit_root_prompt(&mut attempt, &task, skill, skills_dir, &mut store)?;
    start_optional_babysitter(&mut attempt, &path, &mut store)?;
    repair_aven_links(&mut attempt, &mut store)?;
    finish_admission(&attempt, &terminal, &path);
    Ok(())
}

/// Validate required Aven, herdr-core, and OpenCode capabilities.
pub(crate) fn doctor(path: &Path) -> Result<()> {
    println!("store: {}", path.display());
    let aven_version = run("aven", &["--version".into()], None)?;
    let core = core::identity().context("herdr-core is required for dispatch")?;
    let schema = core::run_text(&["schema".into()])?;
    if !schema.contains("events.subscribe") || !schema.contains("terminal.send") {
        bail!(
            "herdr-core does not expose the events.subscribe and terminal.send capabilities this dispatcher requires"
        );
    }
    // `opencode api` intentionally truncates very large bodies, so probe a
    // small V2 endpoint rather than trying to parse its complete OpenAPI body.
    let sessions = opencode("GET", "/api/session?limit=1", None)?;
    if sessions.get("data").is_none() {
        bail!("OpenCode V2 session endpoint returned an unsupported response");
    }
    let app = match app::status() {
        app::Availability::Available => "herdr-app: available (optional navigation only)",
        app::Availability::Unavailable(_) => {
            "herdr-app: unavailable (headless dispatch remains supported)"
        }
    };
    println!(
        "ready: {aven_version}; herdr-core {} core {}/{} with events.subscribe and terminal.send; OpenCode V2 session API detected; {app}",
        core.version, core.name, core.id
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ExecutionMode;
    use crate::{Cli, Commands};
    use clap::Parser;
    use serde_json::json;

    #[test]
    fn lifecycle_commands_accept_an_explicit_workflow_selector() {
        let cli = Cli::try_parse_from([
            "aven-dispatch",
            "status",
            "APP-1",
            "--workflow",
            "implementation",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Commands::Status { workflow: Some(ref workflow), .. } if workflow == "implementation"
        ));
    }
    #[test]
    fn marked_batch_is_accepted_when_focus_is_outside_the_targets() {
        let context = parse_context(r#"{"version":1,"invocation":{},"targeting":{"targets":[{"id":"one","ref":"APP-1"},{"id":"two","ref":"APP-2"}]},"selection":{"primary":{"ref":"APP-9","task":{"id":"focused"}}}}"#).unwrap();
        assert_eq!(
            context
                .targeting
                .targets
                .iter()
                .map(|target| target.id.as_str())
                .collect::<Vec<_>>(),
            ["one", "two"]
        );
        // Focused-only operations such as reset still require the focused
        // selection to be one of the targets.
        assert!(selected_for(&context).is_err());
    }
    #[test]
    fn multiple_targets_are_validated_in_supplied_order() {
        let context = parse_context(r#"{"version":1,"invocation":{},"targeting":{"targets":[{"id":"one","ref":"APP-1"},{"id":"two","ref":"APP-2"}]},"selection":{"primary":{"ref":"APP-2","task":{"id":"two"}}}}"#).unwrap();
        assert_eq!(context.targeting.targets.len(), 2);
        assert_eq!(context.targeting.targets[0].reference(), "APP-1");
        assert_eq!(context.targeting.targets[1].reference(), "APP-2");
        assert_eq!(selected_for(&context).unwrap().task.id, "two");
        assert!(parse_context(r#"{"version":1,"invocation":{},"targeting":{"targets":[{"id":"one","ref":"APP-1"},{"id":"one","ref":"APP-2"}]}}"#).is_err());
    }
    #[test]
    fn root_prompts_include_only_the_selected_execution_mode() {
        let task = json!({"task": {"id": "task-1", "title": "prompt scope"}});
        let topology = "\n\n## Pre-provisioned cumulative worktrees\n\n- `APP-P1` — worker";
        let single = root_prompt(
            &task,
            "APP-1",
            None,
            None,
            ExecutionMode::SingleSession,
            None,
        )
        .unwrap();
        assert!(single.contains("Work every planned item"));
        assert!(!single.contains("Pre-provisioned cumulative worktrees"));
        assert!(!single.contains("native subsessions"));
        let bundled = bundled_skill(
            Some("aven/sdd-implement".into()),
            Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("skills")),
        )
        .unwrap()
        .unwrap();
        assert!(!bundled.contains("cumulative worktrees"));
        assert!(!bundled.contains("native subsessions"));

        let subsessions =
            root_prompt(&task, "APP-1", None, None, ExecutionMode::Subsessions, None).unwrap();
        assert!(subsessions.contains("Use native subsessions"));
        assert!(!subsessions.contains("Pre-provisioned cumulative worktrees"));
        assert!(!subsessions.contains("Work every planned item"));

        let worktrees = root_prompt(
            &task,
            "APP-1",
            None,
            None,
            ExecutionMode::Worktrees,
            Some(topology),
        )
        .unwrap();
        assert!(worktrees.contains("You are the coordinator"));
        assert_eq!(
            worktrees
                .matches("Pre-provisioned cumulative worktrees")
                .count(),
            1
        );
        assert!(worktrees.contains("`APP-P1` — worker"));
    }
}

#[cfg(test)]
mod moved_owner_tests {
    use crate::dispatch::{branch, bundled_skill};
    use std::fs;

    #[test]
    fn namespaced_skill_is_loaded_below_the_skills_root() {
        let root = tempfile::tempdir().unwrap();
        let skill = root.path().join("aven/sdd-plan.md");
        fs::create_dir_all(skill.parent().unwrap()).unwrap();
        fs::write(&skill, "workflow").unwrap();
        assert_eq!(
            bundled_skill(Some("aven/sdd-plan".into()), Some(root.path().into())).unwrap(),
            Some("workflow".into())
        );
    }
    #[test]
    fn unsafe_skill_path_is_rejected() {
        assert!(bundled_skill(Some("aven/../sdd".into()), None).is_err());
    }
    #[test]
    fn branch_uses_immutable_id() {
        assert_eq!(branch("APP", "ABC123"), "APP/dispatch-abc123");
    }
}
