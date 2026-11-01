use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute, queue,
    terminal::{self, ClearType},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{self, BufRead, IsTerminal, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

mod app;
mod core;
mod inspect;
mod model;
mod process;
mod tui;
mod watch;
mod worktrees;

use model::{
    Attempt, CommandContext, EpicPhase, ExecutionMode, Invocation, PhaseAttempt, Selected,
    TerminalRef, attempt_is_legacy, attempt_key, normalize_attempt, workflow_for_skill,
};
#[cfg(test)]
use process::header_value;
use process::{
    LockedStore, absolute_path, aven, aven_args, field, identifier, now, opencode, opencode_in,
    opencode_text, opencode_text_in, run, store_attempt, store_path,
};
use worktrees::WorktreeResource;

#[derive(Parser)]
#[command(about = "Durable one-task Aven to OpenCode V2 dispatcher")]
struct Cli {
    #[arg(long, env = "AVEN_DISPATCH_STORE")]
    store: Option<PathBuf>,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Read an Aven custom-command context from stdin and admit one prompt.
    Dispatch {
        #[arg(long)]
        dry_run: bool,
        /// Primary OpenCode agent for the created session (or AVEN_DISPATCH_AGENT).
        #[arg(long, env = "AVEN_DISPATCH_AGENT")]
        agent: Option<String>,
        /// OpenCode model in provider/model form.
        #[arg(long, env = "AVEN_DISPATCH_MODEL")]
        model: Option<String>,
        /// Agent ID to show first when --agent select opens the picker.
        #[arg(long)]
        preferred_agent: Option<String>,
        /// Model to show first when the model picker opens.
        #[arg(long)]
        preferred_model: Option<String>,
        /// Namespaced bundled workflow under the skills directory (for example, aven/sdd-plan).
        #[arg(long, env = "AVEN_DISPATCH_SKILL")]
        skill: Option<String>,
        /// Directory containing bundled workflow files.
        #[arg(long, env = "AVEN_DISPATCH_SKILLS_DIR")]
        skills_dir: Option<PathBuf>,
        /// Create an adjacent API-owned babysitter session for this build agent.
        #[arg(long)]
        babysitter: bool,
        /// Babysitter OpenCode model in provider/model form (or AVEN_DISPATCH_BABYSITTER_MODEL).
        #[arg(long, env = "AVEN_DISPATCH_BABYSITTER_MODEL")]
        babysitter_model: Option<String>,
        /// Worktree coordinator model in provider/model form (or AVEN_DISPATCH_ORCHESTRATOR_MODEL).
        #[arg(long, env = "AVEN_DISPATCH_ORCHESTRATOR_MODEL")]
        orchestrator_model: Option<String>,
        /// Implementation topology; legacy dispatches default to single-session.
        #[arg(long, value_enum)]
        mode: Option<ExecutionMode>,
        /// Explicitly relaunch a legacy Herdr attempt on herdr-core. Never
        /// re-admits an already admitted prompt.
        #[arg(long)]
        relaunch: bool,
    },
    /// Resume an existing attempt without creating a second session.
    Resume {
        task: String,
        /// Explicit workflow selector when a task has more than one attempt.
        #[arg(long)]
        workflow: Option<String>,
    },
    /// Inspect persisted state and the authoritative OpenCode snapshot.
    Status {
        task: String,
        #[arg(long)]
        workflow: Option<String>,
    },
    /// List persisted dispatch attempts; --running limits results to active execution.
    List {
        #[arg(long)]
        running: bool,
    },
    /// Repair pending Aven updates and refresh session state.
    Reconcile {
        task: String,
        #[arg(long)]
        workflow: Option<String>,
    },
    /// Append a diagnostic event to this attempt's linked Dispatcher Logs task.
    Log {
        task: String,
        #[arg(long)]
        workflow: Option<String>,
        #[arg(long)]
        event: String,
        #[arg(long)]
        detail: String,
    },
    /// Interrupt OpenCode execution; this never changes the Aven task to done/canceled.
    Interrupt {
        task: String,
        #[arg(long)]
        workflow: Option<String>,
    },
    /// Render an agent/model picker in a dedicated herdr-core terminal.
    Pick {
        /// agent or model
        #[arg(long)]
        kind: String,
    },
    /// Send text to an idle attempt terminal. Refuses blocked programs.
    Message {
        task: String,
        #[arg(long)]
        text: String,
        #[arg(long, default_value = "builder")]
        role: String,
        #[arg(long)]
        workflow: Option<String>,
        #[arg(long)]
        wait: bool,
    },
    /// Supervise dispatcher terminals through herdr-core events.
    Watch {
        /// Reconcile once and exit; useful for tests and external schedulers.
        #[arg(long)]
        once: bool,
        /// Stop the owning watcher and report its pid.
        #[arg(long)]
        stop: bool,
        /// Print watcher ownership and durable supervision state.
        #[arg(long)]
        status: bool,
        /// Bounded periodic reconciliation interval in seconds.
        #[arg(long, default_value_t = 60)]
        interval: u64,
        /// Reconcile all attempts once, then exit.
        #[arg(long)]
        reconcile_all: bool,
    },
    /// Invalidate dispatch execution state while preserving the durable Aven plan.
    Reset {
        /// Task ref, or omit when invoked by an Aven focused-task command.
        task: Option<String>,
        /// Perform the reset without the interactive default-No confirmation.
        #[arg(long)]
        yes: bool,
        /// Print the reset inventory without changing Aven, the store, or sessions.
        #[arg(long)]
        dry_run: bool,
    },
    /// Open the keyboard-driven read-only dispatcher inspector.
    Tui {
        /// Aven project key; inferred from the repository when omitted.
        #[arg(long)]
        project: Option<String>,
        /// Aven workspace key; defaults to the Aven default workspace.
        #[arg(long)]
        workspace: Option<String>,
        /// Directory used to infer the project and repository.
        #[arg(long, default_value = ".")]
        cwd: PathBuf,
    },
    /// Read a scoped, sanitized correlation snapshot without mutating state.
    Inspect {
        /// Aven project key; inferred from the repository when omitted.
        #[arg(long)]
        project: Option<String>,
        /// Aven workspace key; defaults to the Aven default workspace.
        #[arg(long)]
        workspace: Option<String>,
        /// Directory used to infer the project and repository.
        #[arg(long, default_value = ".")]
        cwd: PathBuf,
        /// Print the immutable snapshot as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Validate local Aven and OpenCode V2 capabilities without mutation.
    Doctor,
}

fn parse_context(text: &str) -> Result<CommandContext> {
    let context: CommandContext =
        serde_json::from_str(text).context("invalid Aven command context JSON")?;
    if context.version != 1 {
        bail!(
            "unsupported Aven command context version {}; expected 1",
            context.version
        );
    }
    if context.targeting.targets.len() != 1 {
        bail!(
            "one-task dispatch requires exactly one targeting.targets entry (got {})",
            context.targeting.targets.len()
        );
    }
    if context.targeting.targets[0].id.is_empty()
        || context.targeting.targets[0].reference().is_empty()
    {
        bail!("Aven target is missing immutable id or ref");
    }
    Ok(context)
}
fn selected_for(context: &CommandContext) -> Result<&Selected> {
    let selected = context
        .selection
        .primary
        .as_ref()
        .context("command context lacks selection.primary task details")?;
    if selected.task.id != context.targeting.targets[0].id {
        bail!(
            "selection.primary does not match targeting.targets; refusing focused-selection dispatch"
        );
    }
    Ok(selected)
}
fn branch(project: &str, task_id: &str) -> String {
    format!(
        "{}/dispatch-{}",
        if project.is_empty() { "task" } else { project },
        task_id.to_ascii_lowercase()
    )
}
fn phase_branch(root_branch: &str, position: usize) -> String {
    format!("{root_branch}-phase-{position:02}")
}
fn epic_phases(task: &Value) -> Result<Vec<EpicPhase>> {
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
fn phase_number(task: &Value, reference: &str) -> Result<usize> {
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
fn phase_dependencies(task: &Value) -> Vec<String> {
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
fn unresolved_phase_blockers(task: &Value, phase_ref: &str) -> Result<Vec<String>> {
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
fn validate_epic_phases(
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
fn phase_is_eligible(
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
fn has_worked_out_multi_phase_plan(task: &Value) -> bool {
    task.pointer("/metadata/sdd.plan-worked-out")
        .and_then(Value::as_str)
        == Some("true")
        && task
            .pointer("/metadata/sdd.plan-kind")
            .and_then(Value::as_str)
            == Some("multi-phase")
}
/// Effective babysitter model. An override is only meaningful when the
/// optional babysitter session will be created; attempts without one keep no
/// babysitter model at all.
fn resolve_babysitter_model(babysitter: bool, configured: Option<String>) -> String {
    if !babysitter {
        return String::new();
    }
    configured
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| BABYSITTER_MODEL.to_owned())
}
/// Effective worktree coordinator model. Only worktree-mode dispatches create
/// an orchestrator; every other topology keeps the worker as its root session.
fn resolve_orchestrator_model(mode: ExecutionMode, configured: Option<String>) -> String {
    if mode != ExecutionMode::Worktrees {
        return String::new();
    }
    configured
        .filter(|model| !model.is_empty())
        .unwrap_or_else(|| ORCHESTRATOR_MODEL.to_owned())
}
fn model_ref(model: Option<&str>) -> Result<Value> {
    let Some(model) = model.filter(|model| !model.is_empty()) else {
        return Ok(Value::Null);
    };
    let (provider_id, model) = model
        .split_once('/')
        .context("--model must use provider/model form")?;
    if provider_id.is_empty() || model.is_empty() || model.contains('/') {
        bail!("--model must use provider/model form");
    }
    let (id, variant) = match model.split_once('#') {
        Some((id, variant)) if !id.is_empty() && !variant.is_empty() => (id, Some(variant)),
        Some(_) => bail!("--model variant must follow model as provider/model#variant"),
        None => (model, None),
    };
    let mut value = json!({"providerID": provider_id, "id": id});
    if let Some(variant) = variant {
        value["variant"] = Value::String(variant.to_owned());
    }
    Ok(value)
}
fn autonomous_permissions() -> Value {
    json!([{"action":"*", "resource":"*", "effect":"allow"}])
}
fn choose_mode(input: &mut impl BufRead, output: &mut impl Write) -> Result<ExecutionMode> {
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
fn select_mode(requested: Option<ExecutionMode>, workflow: &str) -> Result<ExecutionMode> {
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
const BABYSITTER_AGENT: &str = include_str!("../agents/babysitter.md");
const ORCHESTRATOR_AGENT: &str = include_str!("../agents/orchestrator.md");
const BABYSITTER_AGENT_ID: &str = "aven-babysitter";
const ORCHESTRATOR_AGENT_ID: &str = "aven-orchestrator";
const BABYSITTER_MODEL: &str = "github-copilot/gpt-6-luna";
const ORCHESTRATOR_MODEL: &str = "github-copilot/gpt-6-luna";
const MODEL_CHOICES: &[(&str, &str)] = &[
    ("Latest Sol", "github-copilot/gpt-6.1-sol"),
    ("Latest Terra", "github-copilot/gpt-5.6-terra"),
    ("Latest GPT", "github-copilot/gpt-5.5"),
    ("GPT Astra", "github-copilot/gpt-6-astra"),
    ("GPT Luna", "github-copilot/gpt-6-luna"),
    ("Claude Opus", "github-copilot/claude-opus-5.5"),
    ("Claude Sonnet", "github-copilot/claude-sonnet-5.5"),
    ("Claude Haiku", "github-copilot/claude-haiku-5.5"),
];

#[derive(Debug, Clone)]
struct PrimaryAgent {
    id: String,
    name: String,
    model: Option<String>,
}
fn is_legacy_dispatcher_agent(agent_id: &str) -> bool {
    // The `aven-*` profiles are installed globally and must stay visible so an
    // attached OpenCode TUI adopts the session agent instead of falling back to
    // `build`, which would switch the session on the next prompt. They remain
    // dispatcher-owned, so they are still excluded from the agent picker.
    matches!(
        agent_id,
        "babysitter" | "orchestrator" | BABYSITTER_AGENT_ID | ORCHESTRATOR_AGENT_ID
    )
}

fn global_opencode_agents_dir() -> Result<PathBuf> {
    let config_dir = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
        .context("cannot resolve XDG_CONFIG_HOME or HOME for global OpenCode agents")?;
    Ok(config_dir.join("opencode/agents"))
}
/// Older bundled profiles marked the dispatcher agents `hidden: true`. OpenCode's
/// TUI cannot adopt a hidden session agent, so an attached terminal falls back
/// to `build` and switches the session on the next prompt. Recognize that exact
/// prior bundled form so upgrades replace it; any genuine edit still blocks.
fn is_previous_bundled_agent(existing: &str, bundled: &str) -> bool {
    existing.replace("hidden: true\n", "") == bundled
}
fn install_agent_definition(directory: &Path, agent_id: &str, contents: &str) -> Result<PathBuf> {
    let destination = directory.join(format!("{agent_id}.md"));
    if destination.exists() {
        let existing = fs::read_to_string(&destination)?;
        if existing != contents {
            if !is_previous_bundled_agent(&existing, contents) {
                bail!(
                    "global OpenCode agent {} already exists with different contents; refusing to overwrite user configuration",
                    destination.display()
                );
            }
            fs::write(&destination, contents).with_context(|| {
                format!("upgrade bundled OpenCode agent {}", destination.display())
            })?;
        }
        return Ok(destination);
    }
    fs::create_dir_all(directory).with_context(|| {
        format!(
            "create global OpenCode agent directory {}",
            directory.display()
        )
    })?;
    fs::write(&destination, contents)
        .with_context(|| format!("write bundled OpenCode agent {}", destination.display()))?;
    Ok(destination)
}
/// Install plugin-owned agents once in OpenCode's global agent directory. The
/// stable `aven-*` IDs work from every temporary dispatch worktree, avoiding
/// per-worktree configuration caches and preserving project configuration.
fn install_global_agent(agent_id: &str, contents: &str) -> Result<PathBuf> {
    install_agent_definition(&global_opencode_agents_dir()?, agent_id, contents)
}

fn available_primary_agents(worktree: &str) -> Result<Vec<PrimaryAgent>> {
    let output = opencode_text_in("GET", "/api/agent", None, Some(Path::new(worktree)))?;
    let response: Value = serde_json::from_str(&output).context("OpenCode agent list response")?;
    let agents = response
        .pointer("/data")
        .and_then(Value::as_array)
        .context("/data")?;
    Ok(agents
        .iter()
        .filter(|agent| agent.pointer("/mode").and_then(Value::as_str) == Some("primary"))
        .filter(|agent| agent.pointer("/hidden").and_then(Value::as_bool) != Some(true))
        .filter(|agent| {
            agent
                .pointer("/id")
                .and_then(Value::as_str)
                .is_none_or(|id| !is_legacy_dispatcher_agent(id))
        })
        .filter_map(|agent| {
            let id = agent.pointer("/id").and_then(Value::as_str)?;
            let name = agent.pointer("/name").and_then(Value::as_str).unwrap_or(id);
            let provider = agent.pointer("/model/providerID").and_then(Value::as_str);
            let model = agent.pointer("/model/id").and_then(Value::as_str);
            Some(PrimaryAgent {
                id: id.to_owned(),
                name: name.to_owned(),
                model: provider
                    .zip(model)
                    .map(|(provider, model)| format!("{provider}/{model}")),
            })
        })
        .collect())
}

/// Every chat model from every currently configured provider. The API is
/// scoped to the worktree so provider configuration merged for that location
/// is included, exactly as session creation will resolve it.
fn available_models(worktree: &str) -> Result<Vec<(String, String)>> {
    let output = opencode_text_in("GET", "/api/model", None, Some(Path::new(worktree)))?;
    let response: Value = serde_json::from_str(&output).context("OpenCode model list response")?;
    let models = response
        .pointer("/data")
        .and_then(Value::as_array)
        .context("/data")?;
    let mut choices = Vec::new();
    for model in models {
        // The endpoint defaults to chat models; an explicit decision or image
        // model can never serve a session.
        if model
            .pointer("/type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "chat")
        {
            continue;
        }
        if model.pointer("/enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let Some(provider) = model.pointer("/providerID").and_then(Value::as_str) else {
            continue;
        };
        let Some(id) = model
            .pointer("/id")
            .and_then(Value::as_str)
            .or_else(|| model.pointer("/modelID").and_then(Value::as_str))
        else {
            continue;
        };
        let name = model.pointer("/name").and_then(Value::as_str).unwrap_or(id);
        let reference = format!("{provider}/{id}");
        if choices.iter().any(|(_, candidate)| candidate == &reference) {
            continue;
        }
        choices.push((name.to_owned(), reference));
    }
    Ok(choices)
}

/// Subsequence fuzzy match. Higher scores mean denser and earlier matches;
/// `None` means the query is not a subsequence of the candidate.
fn fuzzy_score(query: &str, candidate: &str) -> Option<usize> {
    let mut score = 0;
    let mut previous = None;
    let mut candidate = candidate.chars().flat_map(char::to_lowercase).enumerate();
    for query_character in query.chars().flat_map(char::to_lowercase) {
        if query_character.is_whitespace() {
            continue;
        }
        let (index, _) = candidate
            .by_ref()
            .find(|(_, candidate)| *candidate == query_character)?;
        score += match previous {
            Some(previous) if index == previous + 1 => 3,
            Some(_) => 1,
            None => 2,
        };
        previous = Some(index);
    }
    Some(score)
}

fn fuzzy_matches<'a>(choices: &'a [(String, String)], query: &str) -> Vec<&'a (String, String)> {
    let mut matches = choices
        .iter()
        .filter_map(|choice| {
            fuzzy_score(query, &format!("{} {}", choice.0, choice.1)).map(|score| (score, choice))
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|left| std::cmp::Reverse(left.0));
    matches.into_iter().map(|(_, choice)| choice).collect()
}

/// Shared terminal chooser. On a TTY the list filters live as characters are
/// typed after `/`, with arrow-key navigation; piped input keeps the numbered
/// line protocol used by tests and scripts.
fn choose_from(
    heading: &str,
    choices: &[(String, String)],
    input: &mut impl BufRead,
    output: &mut impl Write,
    interactive: bool,
) -> Result<Option<String>> {
    if choices.is_empty() {
        bail!("no choices are available");
    }
    if interactive {
        choose_from_interactive(heading, choices, output)
    } else {
        choose_from_lines(heading, choices, input, output)
    }
}

fn choose_from_lines(
    heading: &str,
    choices: &[(String, String)],
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> Result<Option<String>> {
    writeln!(output, "{heading}\n")?;
    let mut query: Option<String> = None;
    loop {
        let visible = match query.as_deref() {
            Some(query) => fuzzy_matches(choices, query),
            None => choices.iter().collect(),
        };
        for (index, (name, id)) in visible.iter().enumerate() {
            writeln!(output, "  {}. {name} ({id})", index + 1)?;
        }
        if let Some(query) = query.as_deref() {
            writeln!(
                output,
                "\n  {} of {} choices match \"{query}\".",
                visible.len(),
                choices.len()
            )?;
        }
        if visible.is_empty() {
            write!(output, "\nType / and a new query, or q to cancel: ")?;
        } else if query.is_some() {
            write!(
                output,
                "\nChoice [1-{}] of {} matching, / to search again, or q to cancel: ",
                visible.len(),
                choices.len()
            )?;
        } else {
            write!(
                output,
                "\nChoice [1-{}], / to fuzzy search, or q to cancel: ",
                visible.len()
            )?;
        }
        output.flush()?;
        let mut choice = String::new();
        if input.read_line(&mut choice)? == 0 {
            return Ok(None);
        }
        let choice = choice.trim();
        if matches!(choice, "" | "q" | "Q") {
            return Ok(None);
        }
        if let Some(search) = choice.strip_prefix('/') {
            let search = search.trim();
            query = if search.is_empty() {
                None
            } else {
                Some(search.to_lowercase())
            };
            continue;
        }
        if let Ok(index) = choice.parse::<usize>()
            && let Some(id) = index
                .checked_sub(1)
                .and_then(|index| visible.get(index))
                .map(|choice| choice.1.clone())
        {
            return Ok(Some(id));
        }
        if visible.is_empty() {
            writeln!(
                output,
                "No matches; refine the search with / or q to cancel."
            )?;
        } else {
            writeln!(output, "Enter a number from 1 to {}, or q.", visible.len())?;
        }
    }
}

/// Live-filter state. Kept separate from I/O so filtering and navigation can
/// be tested without a terminal.
#[derive(Default)]
struct PickerState {
    query: String,
    searching: bool,
    selected: usize,
}

impl PickerState {
    fn visible<'a>(&self, choices: &'a [(String, String)]) -> Vec<&'a (String, String)> {
        if self.query.is_empty() {
            choices.iter().collect()
        } else {
            fuzzy_matches(choices, &self.query)
        }
    }

    fn clamp(&mut self, count: usize) {
        self.selected = self.selected.min(count.saturating_sub(1));
    }

    fn down(&mut self, count: usize) {
        if count == 0 {
            self.selected = 0;
        } else {
            self.selected = (self.selected + 1) % count;
        }
    }

    fn up(&mut self, count: usize) {
        if count == 0 {
            self.selected = 0;
        } else if self.selected == 0 {
            self.selected = count - 1;
        } else {
            self.selected -= 1;
        }
    }

    fn type_character(&mut self, character: char) {
        self.query.push(character);
        self.selected = 0;
    }

    fn backspace(&mut self) {
        self.query.pop();
        self.selected = 0;
    }
}

/// Restores canonical input and echoing even when the picker exits early.
struct RawMode;
impl RawMode {
    fn enter() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        Ok(Self)
    }
}
impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
    }
}

fn choose_from_interactive(
    heading: &str,
    choices: &[(String, String)],
    output: &mut impl Write,
) -> Result<Option<String>> {
    let raw = RawMode::enter().context("enable interactive picker input")?;
    execute!(output, terminal::EnterAlternateScreen, cursor::Hide)
        .context("enter picker screen")?;
    let result = interactive_pick_loop(heading, choices, output);
    let restored = execute!(output, cursor::Show, terminal::LeaveAlternateScreen)
        .context("leave picker screen");
    drop(raw);
    match result {
        Ok(selection) => {
            restored?;
            Ok(selection)
        }
        Err(error) => {
            let _ = restored;
            Err(error)
        }
    }
}

fn interactive_pick_loop(
    heading: &str,
    choices: &[(String, String)],
    output: &mut impl Write,
) -> Result<Option<String>> {
    let mut state = PickerState::default();
    loop {
        let visible = state.visible(choices);
        state.clamp(visible.len());
        render_picker(output, heading, choices.len(), &visible, &state)?;
        let Event::Key(key) = event::read().context("read picker input")? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(None),
            KeyCode::Esc => {
                if state.query.is_empty() {
                    return Ok(None);
                }
                state.query.clear();
                state.searching = false;
                state.selected = 0;
            }
            KeyCode::Enter => {
                if let Some(choice) = visible.get(state.selected) {
                    return Ok(Some(choice.1.clone()));
                }
            }
            KeyCode::Up => state.up(visible.len()),
            KeyCode::Down => state.down(visible.len()),
            KeyCode::PageUp => state.selected = state.selected.saturating_sub(10),
            KeyCode::PageDown => {
                state.selected = (state.selected + 10).min(visible.len().saturating_sub(1));
            }
            KeyCode::Home => state.selected = 0,
            KeyCode::End => state.selected = visible.len().saturating_sub(1),
            KeyCode::Backspace if state.searching => state.backspace(),
            KeyCode::Char('/') if !state.searching => {
                state.searching = true;
                state.query.clear();
                state.selected = 0;
            }
            KeyCode::Char(character)
                if state.searching
                    && !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                state.type_character(character);
            }
            KeyCode::Char('q') if !state.searching => return Ok(None),
            _ => {}
        }
    }
}

fn truncate_chars(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.to_owned();
    }
    value
        .chars()
        .take(width.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn render_picker(
    output: &mut impl Write,
    heading: &str,
    total: usize,
    visible: &[&(String, String)],
    state: &PickerState,
) -> Result<()> {
    let (columns, rows) = match terminal::size() {
        Ok((columns, rows)) if columns > 0 && rows > 0 => (columns, rows),
        _ => (80, 24),
    };
    let width = usize::from(columns.max(20));
    let capacity = usize::from(rows).saturating_sub(6).max(1);
    let start = if visible.len() <= capacity {
        0
    } else {
        state
            .selected
            .saturating_sub(capacity / 2)
            .min(visible.len() - capacity)
    };
    let end = (start + capacity).min(visible.len());
    queue!(
        output,
        terminal::Clear(ClearType::All),
        cursor::MoveTo(0, 0)
    )?;
    writeln!(output, "{heading}\r")?;
    if state.searching {
        writeln!(output, "  fuzzy: /{}\r", state.query)?;
    } else {
        writeln!(output, "  press / to fuzzy search\r")?;
    }
    writeln!(output, "  {} of {} choices\r", visible.len(), total)?;
    if visible.is_empty() {
        writeln!(output, "  no matches\r")?;
    }
    for (offset, (name, id)) in visible[start..end].iter().enumerate() {
        let index = start + offset;
        let line = truncate_chars(
            &format!("{:>3}. {name} ({id})", index + 1),
            width.saturating_sub(4),
        );
        if index == state.selected {
            writeln!(output, "  \x1b[7m{line}\x1b[0m\r")?;
        } else {
            writeln!(output, "  {line}\r")?;
        }
    }
    writeln!(
        output,
        "\r  Up/Down move · Enter select · / search · Esc clear/cancel\r"
    )?;
    output.flush()?;
    Ok(())
}

fn choose_agent(
    agents: &[PrimaryAgent],
    input: &mut impl BufRead,
    output: &mut impl Write,
    interactive: bool,
) -> Result<String> {
    let choices = agents
        .iter()
        .map(|agent| (agent.name.clone(), agent.id.clone()))
        .collect::<Vec<_>>();
    choose_from(
        "Select an OpenCode agent:",
        &choices,
        input,
        output,
        interactive,
    )?
    .context("OpenCode agent selection was canceled")
}

fn model_name<'a>(model: &str, available: &'a [(String, String)]) -> Option<&'a str> {
    available
        .iter()
        .find(|(_, candidate)| candidate == model)
        .map(|(name, _)| name.as_str())
        .or_else(|| {
            MODEL_CHOICES
                .iter()
                .find(|(_, candidate)| *candidate == model)
                .map(|(name, _)| *name)
        })
}

fn model_choices(
    configured: Option<&str>,
    preferred: Option<&str>,
    available: &[(String, String)],
) -> Vec<(String, String)> {
    let mut choices = Vec::new();
    if let Some(model) = preferred.filter(|model| !model.is_empty()) {
        let name = model_name(model, available).unwrap_or(model);
        choices.push((format!("Preferred ({name})"), model.to_owned()));
    }
    if let Some(model) = configured.filter(|model| !model.is_empty())
        && !choices.iter().any(|(_, choice)| choice == model)
    {
        choices.push((format!("Agent default ({model})"), model.to_owned()));
    }
    // All configured providers come from the API. The curated list is only a
    // fallback for an older server or a transient listing failure.
    let source = if available.is_empty() {
        MODEL_CHOICES
            .iter()
            .map(|(name, model)| ((*name).to_owned(), (*model).to_owned()))
            .collect::<Vec<_>>()
    } else {
        available.to_vec()
    };
    for (name, model) in source {
        if !choices.iter().any(|(_, choice)| *choice == model) {
            choices.push((name, model));
        }
    }
    choices
}

fn choose_model(
    choices: &[(String, String)],
    input: &mut impl BufRead,
    output: &mut impl Write,
    interactive: bool,
) -> Result<String> {
    choose_from(
        "Select an OpenCode model:",
        choices,
        input,
        output,
        interactive,
    )?
    .context("OpenCode model selection was canceled")
}

fn picker(kind: &str, choices: &[(String, String)], store_path: &Path) -> Result<String> {
    if choices.is_empty() {
        bail!("no {kind} choices are available");
    }
    let ids = choices
        .iter()
        .map(|(_, id)| id.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let names = choices
        .iter()
        .map(|(name, _)| name.replace(['\n', '\r'], " "))
        .collect::<Vec<_>>()
        .join("\n");
    let id = identifier("pick");
    let response = store_path.with_file_name(format!(".picker-{kind}-{id}.response"));
    let _ = fs::remove_file(&response);
    let response_text = response
        .to_str()
        .context("picker response path is not valid UTF-8")?
        .to_owned();
    let suffix = id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .rev()
        .take(6)
        .collect::<String>();
    let name = format!("aven-pick-{}-{suffix}", sanitize_name(kind));
    let executable = env::current_exe().context("resolve aven-dispatch executable")?;
    let terminal = core::launch(&core::LaunchSpec {
        name,
        cwd: env::current_dir()?.to_string_lossy().to_string(),
        labels: vec![
            ("aven.dispatch".into(), "1".into()),
            ("aven.role".into(), "picker".into()),
            ("aven.picker".into(), kind.into()),
        ],
        env: vec![
            (
                "AVEN_DISPATCH_PICKER_RESPONSE".into(),
                response_text.clone(),
            ),
            ("AVEN_DISPATCH_PICKER_NAMES".into(), names),
            ("AVEN_DISPATCH_PICKER_IDS".into(), ids),
        ],
        argv: vec![
            executable.to_string_lossy().to_string(),
            "pick".into(),
            "--kind".into(),
            kind.into(),
        ],
    })?;
    // Revealing the picker is optional; submission waits for its response file.
    let _ = app::peek(&terminal.address);
    // Interactive search can legitimately take a while; liveness is still
    // checked below, so this is only a backstop against a wedged terminal.
    for tick in 0..18000u32 {
        if response.exists() {
            let selected = fs::read_to_string(&response)?.trim().to_owned();
            let _ = fs::remove_file(&response);
            if choices.iter().any(|(_, id)| id == &selected) {
                let _ = core::remove(&terminal.address);
                return Ok(selected);
            }
            bail!("OpenCode {kind} selection was canceled");
        }
        if tick % 10 == 9
            && let Ok(current) = core::get(&terminal.address)
            && !current.live()
        {
            bail!("OpenCode {kind} picker exited without a selection");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = core::kill(&terminal.address);
    let _ = core::remove(&terminal.address);
    bail!("timed out waiting for the herdr-core OpenCode {kind} picker")
}

fn select_model(choices: &[(String, String)], store_path: &Path) -> Result<String> {
    if env::var_os("AVEN_COMMAND_CONTEXT").is_some() {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            bail!("Aven terminal dispatch requires an interactive terminal");
        }
        return choose_model(
            choices,
            &mut io::stdin().lock(),
            &mut io::stdout().lock(),
            true,
        );
    }
    let choices = choices
        .iter()
        .map(|(name, model)| (name.clone(), model.clone()))
        .collect::<Vec<_>>();
    picker("model", &choices, store_path)
}

fn select_agent(
    worktree: &str,
    store_path: &Path,
    existing: Option<&str>,
    preferred: Option<&str>,
) -> Result<String> {
    let mut agents = available_primary_agents(worktree)?;
    if let Some(existing) = existing {
        // Re-dispatch confirms the existing session, never silently swaps its
        // agent or admits another prompt. It must still display the picker.
        let name = agents
            .iter()
            .find(|agent| agent.id == existing)
            .map(|agent| agent.name.as_str())
            .unwrap_or(existing);
        agents = vec![PrimaryAgent {
            id: existing.to_owned(),
            name: format!("{name} — reopen existing session"),
            model: None,
        }];
    } else if let Some(preferred) = preferred.filter(|agent| !agent.is_empty())
        && let Some(index) = agents.iter().position(|agent| agent.id == preferred)
    {
        let preferred = agents.remove(index);
        agents.insert(0, preferred);
    }
    if agents.is_empty() {
        bail!(
            "OpenCode has no visible primary agents in {}; configure one and retry",
            worktree
        );
    }

    // Aven's terminal execution mode lends us the existing terminal and
    // supplies JSON via AVEN_COMMAND_CONTEXT. Open the picker inline there;
    // elsewhere it gets its own dedicated herdr-core terminal.
    if env::var_os("AVEN_COMMAND_CONTEXT").is_some() {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            bail!("Aven terminal dispatch requires an interactive terminal");
        }
        return choose_agent(
            &agents,
            &mut io::stdin().lock(),
            &mut io::stdout().lock(),
            true,
        );
    }
    let choices = agents
        .iter()
        .map(|agent| (agent.name.clone(), agent.id.clone()))
        .collect::<Vec<_>>();
    picker("agent", &choices, store_path)
}

fn configured_agent_model(worktree: &str, agent_id: &str) -> Result<Option<String>> {
    Ok(available_primary_agents(worktree)?
        .into_iter()
        .find(|agent| agent.id == agent_id)
        .and_then(|agent| agent.model))
}

fn refresh_task(context: &CommandContext, selected: &Selected) -> Result<Value> {
    let output = aven(
        &context.invocation,
        &["context", selected.reference(), "--json"],
        None,
    )?;
    let task: Value = serde_json::from_str(&output).context("Aven context --json output")?;
    if task.pointer("/task/id").and_then(Value::as_str) != Some(selected.task.id.as_str()) {
        bail!("Aven re-read returned a different task; refusing dispatch");
    }
    Ok(task)
}
fn refresh_task_by_ref(invocation: &Invocation, reference: &str) -> Result<Value> {
    let output = aven(invocation, &["context", reference, "--json"], None)?;
    serde_json::from_str(&output).context("Aven context --json output")
}
fn task_generation(task: &Value) -> Result<u64> {
    match task
        .pointer("/metadata/dispatch.reset-generation")
        .and_then(Value::as_str)
    {
        Some(value) => value.parse().context("invalid dispatch.reset-generation"),
        None => Ok(0),
    }
}
fn reset_incomplete(task: &Value) -> bool {
    task.pointer("/metadata/dispatch.reset-state")
        .and_then(Value::as_str)
        == Some("incomplete")
}
fn ensure_attempt_current(task: &Value, attempt: &Attempt) -> Result<()> {
    if reset_incomplete(task) {
        bail!(
            "task reset is incomplete; rerun aven-dispatch reset after resolving its preflight error"
        );
    }
    let generation = task_generation(task)?;
    if attempt.generation != generation {
        bail!(
            "attempt {} belongs to reset generation {}, but task is generation {}; dispatch a fresh session",
            attempt.attempt_id,
            attempt.generation,
            generation
        );
    }
    Ok(())
}
fn create_worktree(
    origin: &str,
    branch: &str,
    _label: &str,
    base: Option<&str>,
) -> Result<WorktreeResource> {
    worktrees::create(origin, branch, base)
}
fn remove_owned_worktree(worktree: &str, created_by_attempt: bool) {
    worktrees::remove_owned(worktree, created_by_attempt);
}
fn focus_terminal(address: &str) {
    // A dispatcher terminal is a hidden core terminal until it gets a pane.
    // Focus alone fails then; peek is the supported way to reveal it in the
    // current app tab. Both are best-effort and never affect dispatch.
    if !app::focus(address) {
        let _ = app::peek(address);
    }
}

/// Stable, human-filterable owner labels. They prove which attempt a terminal
/// belongs to; they are never used as permission to advance Aven state.
struct TerminalOwner<'a> {
    task_id: &'a str,
    task_ref: &'a str,
    workflow: &'a str,
    attempt_id: &'a str,
    generation: u64,
}
fn terminal_labels(
    owner: &TerminalOwner<'_>,
    role: &str,
    phase: Option<&str>,
) -> Vec<(String, String)> {
    let mut labels = vec![
        ("aven.dispatch".into(), "1".into()),
        ("aven.task".into(), owner.task_ref.into()),
        ("aven.task_id".into(), owner.task_id.into()),
        ("aven.workflow".into(), owner.workflow.into()),
        ("aven.attempt".into(), owner.attempt_id.into()),
        ("aven.generation".into(), owner.generation.to_string()),
        ("aven.role".into(), role.into()),
    ];
    if let Some(phase) = phase {
        labels.push(("aven.phase".into(), phase.into()));
    }
    labels
}
fn sanitize_name(value: &str) -> String {
    let mut out = String::new();
    for character in value.chars() {
        let character = character.to_ascii_lowercase();
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '-' | '_' | '.')
        {
            out.push(character);
        } else {
            out.push('-');
        }
    }
    out
}
fn terminal_name(owner: &TerminalOwner<'_>, role: &str) -> String {
    let suffix = owner
        .attempt_id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .rev()
        .take(6)
        .collect::<String>();
    let mut stem = format!(
        "aven-{}-{}",
        sanitize_name(owner.task_ref),
        sanitize_name(role)
    );
    // Keep the attempt suffix: it distinguishes two attempts for the same
    // task/role while the name stays within hc's 32-character limit.
    stem.truncate(25);
    let stem = stem.trim_end_matches('-');
    format!("{stem}-{suffix}")
}

/// Launch (or safely adopt) the OpenCode CLI for one role in a dedicated
/// herdr-core terminal, detached from this short-lived dispatcher process.
fn launch_opencode_terminal(
    owner: &TerminalOwner<'_>,
    role: &str,
    phase: Option<&str>,
    cwd: &str,
    session_id: &str,
    store_path: &Path,
) -> Result<(core::CoreIdentity, core::Terminal, bool)> {
    if session_id.is_empty() {
        bail!("refusing to launch a terminal without a durable OpenCode session id");
    }
    let core = core::identity()?;
    let labels = terminal_labels(owner, role, phase);
    let name = terminal_name(owner, phase.unwrap_or(role));
    if let Some(existing) = core::find_owned(&labels, &name)? {
        if existing.recovered_shell() {
            // A kept terminal recovered with a shell is not a resumed OpenCode
            // process, even at the same address. Close only the terminal this
            // exact attempt owns, then launch a fresh one.
            let _ = core::kill(&existing.address);
            let _ = core::remove(&existing.address);
        } else {
            return Ok((core, existing, false));
        }
    }
    let terminal = core::launch(&core::LaunchSpec {
        name,
        cwd: cwd.into(),
        labels,
        env: vec![(
            "AVEN_DISPATCH_STORE".into(),
            store_path.to_string_lossy().to_string(),
        )],
        argv: vec![
            process::opencode_binary()?,
            "--session".into(),
            session_id.into(),
        ],
    })?;
    Ok((core, terminal, true))
}
fn terminal_ref_for(
    core: &core::CoreIdentity,
    terminal: &core::Terminal,
    role: &str,
    created: bool,
) -> TerminalRef {
    core::terminal_ref(core, terminal, role, created)
}
fn record_terminal(
    attempt: &mut Attempt,
    role: &str,
    terminal: &core::Terminal,
    core: &core::CoreIdentity,
) {
    let reference = terminal_ref_for(core, terminal, role, true);
    match role {
        "builder" => attempt.terminal = reference,
        "coordinator" => attempt.coordinator_terminal = reference,
        "babysitter" => attempt.babysitter_terminal = reference,
        _ => {}
    }
    attempt.terminals.insert(
        role.into(),
        terminal.observe(
            core,
            0,
            if terminal.recovered_shell() {
                "recovered-shell"
            } else {
                ""
            },
        ),
    );
}
fn launch_and_record(
    attempt: &mut Attempt,
    role: &str,
    cwd: &str,
    session_id: &str,
    store_path: &Path,
    store: &mut LockedStore,
) -> Result<core::Terminal> {
    let owner = TerminalOwner {
        task_id: &attempt.task_id,
        task_ref: &attempt.task_ref,
        workflow: &attempt.workflow,
        attempt_id: &attempt.attempt_id,
        generation: attempt.generation,
    };
    let (core, terminal, _) =
        launch_opencode_terminal(&owner, role, None, cwd, session_id, store_path)?;
    attempt.core_id = core.id.clone();
    attempt.core_name = core.name.clone();
    record_terminal(attempt, role, &terminal, &core);
    store_attempt(store, attempt.clone());
    store.save()?;
    Ok(terminal)
}
fn wait_for_global_agent(agent_id: &str) -> Result<()> {
    // Global Markdown profiles are discovered from the server's global
    // context. A location-scoped request intentionally returns only profiles
    // merged for that worktree, so it cannot prove a global agent exists.
    for attempt in 0..50 {
        let agents = opencode_text("GET", "/api/agent", None)?;
        let agents: Value =
            serde_json::from_str(&agents).context("OpenCode agent list response")?;
        if agents
            .pointer("/data")
            .and_then(Value::as_array)
            .is_some_and(|agents| {
                agents
                    .iter()
                    .any(|agent| agent.pointer("/id").and_then(Value::as_str) == Some(agent_id))
            })
        {
            return Ok(());
        }
        if attempt < 49 {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    bail!("global bundled {agent_id} agent is not discoverable")
}
fn babysitter_message(attempt: &Attempt) -> String {
    // The babysitter must watch the builder terminal, never its own pane. The
    // builder address is the one recorded for the build session above.
    let builder_terminal = if attempt.terminal.address.is_empty() {
        "its builder terminal"
    } else {
        attempt.terminal.address.as_str()
    };
    format!(
        "Supervise build OpenCode session {} in herdr-core terminal {} for task {}. Begin the 60-second monitoring protocol now and stay with it until the task is verified resolved.",
        attempt.session_id, builder_terminal, attempt.task_ref
    )
}
fn admit_babysitter(attempt: &mut Attempt, store: &mut LockedStore) -> Result<()> {
    if attempt.babysitter_prompt_id.is_empty() {
        attempt.babysitter_prompt_id = identifier("msg");
    }
    let text = babysitter_message(attempt);
    attempt.state = "babysitter-prompt-pending".into();
    store_attempt(store, attempt.clone());
    store.save()?;
    let admission = opencode(
        "POST",
        &format!("/api/session/{}/prompt", attempt.babysitter_session_id),
        Some(json!({
            "id": attempt.babysitter_prompt_id,
            "text": text,
            "resume": true,
        })),
    )?;
    if field(&admission, "/data/id")? != attempt.babysitter_prompt_id {
        bail!("OpenCode admitted an unexpected babysitter message id");
    }
    Ok(())
}
fn start_babysitter(
    attempt: &mut Attempt,
    store_path: &Path,
    store: &mut LockedStore,
) -> Result<()> {
    install_global_agent(BABYSITTER_AGENT_ID, BABYSITTER_AGENT)?;
    wait_for_global_agent(BABYSITTER_AGENT_ID)?;
    // Resolve the global `aven-babysitter` profile in the server's global
    // context. Its explicit session location still selects the build worktree.
    let session = opencode(
        "POST",
        "/api/session",
        Some(json!({
            "title": format!("Babysit {}", attempt.task_ref),
            "location": {"directory": attempt.worktree},
            "agent": BABYSITTER_AGENT_ID,
            // Empty means a record created before the field existed: keep the
            // historical Luna default rather than borrowing the worker model.
            "model": model_ref(Some(if attempt.babysitter_model.is_empty() {
                BABYSITTER_MODEL
            } else {
                attempt.babysitter_model.as_str()
            }))?,
            "permissions": [{"action": "*", "resource": "*", "effect": "allow"}],
        })),
    )?;
    attempt.babysitter_session_id = field(&session, "/data/id")?.to_owned();
    attempt.state = "babysitter-session-pending".into();
    store_attempt(store, attempt.clone());
    store.save()?;
    let worktree = attempt.worktree.clone();
    let session_id = attempt.babysitter_session_id.clone();
    let terminal = launch_and_record(
        attempt,
        "babysitter",
        &worktree,
        &session_id,
        store_path,
        store,
    )?;
    let _ = app::show_worktree(
        &terminal.address,
        &worktree,
        &format!("Babysit {}", attempt.task_ref),
        &attempt.task_ref,
        &mut attempt.aven_panel,
    );
    admit_babysitter(attempt, store)
}
fn bundled_skill(skill: Option<String>, skills_dir: Option<PathBuf>) -> Result<Option<String>> {
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
fn workflow_prompt(
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
fn execution_guidance(mode: ExecutionMode) -> &'static str {
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
fn root_prompt(
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
fn phase_prompt(
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
fn coordinator_topology(attempt: &Attempt) -> String {
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
fn phase_task(invocation: &Invocation, phase: &EpicPhase) -> Result<Value> {
    let output = aven(invocation, &["context", &phase.task_ref, "--json"], None)?;
    let task: Value = serde_json::from_str(&output).context("Aven phase context --json output")?;
    if task.pointer("/task/id").and_then(Value::as_str) != Some(phase.task_id.as_str()) {
        bail!("Aven re-read returned a different phase task");
    }
    Ok(task)
}
fn provision_phase_worktrees(
    attempt: &mut Attempt,
    root_task: &Value,
    store_path: &Path,
    store: &mut LockedStore,
    skills_dir: Option<PathBuf>,
) -> Result<()> {
    if !has_worked_out_multi_phase_plan(root_task) {
        bail!(
            "worktree mode requires sdd.plan-worked-out=true and sdd.plan-kind=multi-phase on the root epic"
        );
    }
    let phases = validate_epic_phases(&attempt.aven, root_task, &attempt.task_ref)?;
    for (index, task) in phases.iter().enumerate() {
        let branch = phase_branch(&attempt.branch, index + 1);
        let resource = create_worktree(
            &attempt.worktree,
            &branch,
            &format!("{} {}", task.task_ref, task.title),
            Some(&attempt.branch),
        )?;
        let session = opencode_in(
            "POST",
            "/api/session",
            Some(json!({
                "title": format!("{} {}", task.task_ref, task.title),
                "location": {"directory": resource.path},
                "agent": attempt.agent,
                "model": model_ref(Some(&attempt.model))?,
                "permissions": autonomous_permissions(),
            })),
            Path::new(&resource.path),
        )?;
        let session_id = field(&session, "/data/id")?.to_owned();
        attempt.phases.push(PhaseAttempt {
            task_id: task.task_id.clone(),
            task_ref: task.task_ref.clone(),
            title: task.title.clone(),
            branch,
            worktree: resource.path.clone(),
            worktree_created_by_attempt: resource.created_by_attempt,
            terminal: TerminalRef::default(),
            pane: String::new(),
            aven_panel: false,
            session_id: session_id.clone(),
            prompt_id: String::new(),
            pending_prompt: String::new(),
            commit: String::new(),
            integrated_commit: String::new(),
            state: "provisioned".into(),
        });
        let index = attempt.phases.len() - 1;
        let owner = TerminalOwner {
            task_id: &attempt.task_id,
            task_ref: &attempt.task_ref,
            workflow: &attempt.workflow,
            attempt_id: &attempt.attempt_id,
            generation: attempt.generation,
        };
        let (core, terminal, _) = launch_opencode_terminal(
            &owner,
            "phase",
            Some(&task.task_id),
            &resource.path,
            &session_id,
            store_path,
        )?;
        attempt.core_id = core.id.clone();
        attempt.core_name = core.name.clone();
        attempt.phases[index].terminal = terminal_ref_for(&core, &terminal, "phase", true);
        let _ = app::show_worktree(
            &terminal.address,
            &resource.path,
            &format!("{} {}", task.task_ref, task.title),
            &task.task_ref,
            &mut attempt.phases[index].aven_panel,
        );
        attempt.terminals.insert(
            format!("phase:{}", task.task_id),
            terminal.observe(
                &core,
                0,
                if terminal.recovered_shell() {
                    "recovered-shell"
                } else {
                    ""
                },
            ),
        );
        store_attempt(store, attempt.clone());
        store.save()?;
    }
    let ready = attempt
        .phases
        .first()
        .context("worktree mode requires a first phase")?;
    let task = phase_is_eligible(&attempt.aven, ready, None)?;
    let mut ready = ready.clone();
    ready.prompt_id = identifier("msg");
    ready.pending_prompt = phase_prompt(&task, &ready, &attempt.task_ref, skills_dir)?;
    ready.state = "prompt-pending".into();
    attempt.phases[0] = ready.clone();
    store_attempt(store, attempt.clone());
    store.save()?;
    let admission = opencode(
        "POST",
        &format!("/api/session/{}/prompt", ready.session_id),
        Some(json!({
            "id": ready.prompt_id,
            "text": ready.pending_prompt,
            "resume": true,
        })),
    )?;
    if field(&admission, "/data/id")? != ready.prompt_id {
        bail!("OpenCode admitted an unexpected phase message id");
    }
    ready.state = "running".into();
    ready.pending_prompt.clear();
    attempt.phases[0] = ready;
    Ok(())
}
fn write_aven_links(invocation: &Invocation, attempt: &Attempt) -> Result<()> {
    // Aven owns the task-scoped durable snapshot. The individual metadata
    // fields stay queryable, while one workflow-scoped dispatch.attempt snapshot
    // per role permits recovery from any checkout without consulting the
    // central store's row. Planning and implementation therefore retain
    // separate sessions while sharing the selected task's worktree branch.
    let current = refresh_task_by_ref(invocation, &attempt.task_ref)?;
    ensure_attempt_current(&current, attempt)?;
    let metadata = vec![
        "dispatch.backend=hc".to_owned(),
        format!("dispatch.session-id={}", attempt.session_id),
        format!("dispatch.core-id={}", attempt.core_id),
        format!(
            "dispatch.terminal={}",
            if attempt.terminal.is_empty() {
                &attempt.coordinator_terminal.address
            } else {
                &attempt.terminal.address
            }
        ),
        format!("dispatch.attempt-id={}", attempt.attempt_id),
        format!("dispatch.state={}", attempt.state),
        format!("dispatch.workflow={}", attempt.workflow),
        format!("dispatch.branch={}", attempt.branch),
        format!(
            "dispatch.attempt.{}={}",
            attempt.workflow,
            serde_json::to_string(&aven_attempt_snapshot(attempt))?
        ),
    ];
    let current_status = current
        .pointer("/task/status")
        .and_then(Value::as_str)
        .unwrap_or("todo");
    // A stale local snapshot must never reactivate work accepted or canceled by
    // Aven. Session completion is execution evidence, not task acceptance.
    let next_status = if matches!(current_status, "done" | "canceled") {
        current_status
    } else {
        "active"
    };
    let mut args = vec![
        "edit".to_owned(),
        attempt.task_ref.clone(),
        "--status".into(),
        next_status.into(),
    ];
    for item in metadata {
        args.extend(["--metadata".into(), item]);
    }
    let executable = if invocation.aven_exe.is_empty() {
        "aven"
    } else {
        &invocation.aven_exe
    };
    run(
        executable,
        &{
            let mut global = aven_args(invocation, &[]);
            global.extend(args);
            global
        },
        None,
    )?;
    let note = format!(
        "## Dispatcher handoff\n\nOpenCode prompt admitted for attempt `{}` (session `{}`). Worktree branch: `{}`. Execution state: `{}`. Use `aven-dispatch status {}` to inspect permissions, forms, and recovery state.",
        attempt.attempt_id, attempt.session_id, attempt.branch, attempt.state, attempt.task_ref
    );
    aven(
        invocation,
        &["note", &attempt.task_ref, "--stdin"],
        Some(&note),
    )?;
    Ok(())
}
fn aven_attempt_snapshot(attempt: &Attempt) -> Attempt {
    let mut snapshot = attempt.clone();
    // The full prompt is retained in the dispatcher store for recovery, but
    // after admission it is not needed in Aven's size-limited metadata.
    if matches!(snapshot.state.as_str(), "needs-review" | "completed") {
        snapshot.pending_prompt.clear();
    }
    snapshot
}
fn ensure_log_task(attempt: &mut Attempt) -> Result<()> {
    if !attempt.log_task_ref.is_empty() {
        return Ok(());
    }
    // Creating an existing project is harmlessly rejected by Aven; the add
    // operation below remains the authority for whether logging is available.
    let _ = aven(
        &attempt.aven,
        &["project", "create", "Dispatcher Logs"],
        None,
    );
    let title = format!(
        "Dispatch log: {} ({})",
        attempt.task_ref, attempt.attempt_id
    );
    let source = format!(
        "Source task: `{}`\n\nAttempt: `{}`",
        attempt.task_ref, attempt.attempt_id
    );
    let output = aven(
        &attempt.aven,
        &[
            "add",
            &title,
            "--project",
            "dispatcher-logs",
            "--status",
            "active",
            "--description",
            &source,
            "--metadata",
            &format!("dispatch.attempt-id={}", attempt.attempt_id),
        ],
        None,
    )?;
    let log_task_ref = output
        .split_whitespace()
        .nth(1)
        .filter(|reference| !reference.is_empty())
        .context("Aven did not return a log task reference")?
        .to_owned();
    let _ = aven(
        &attempt.aven,
        &["related", "add", &log_task_ref, &attempt.task_ref],
        None,
    );
    attempt.log_task_ref = log_task_ref;
    Ok(())
}
fn dispatcher_event(attempt: &Attempt, event: &str, detail: &str) -> Value {
    json!({
        "schema": "aven-dispatch-event/v1",
        "time_ms": now(),
        "source_task": attempt.task_ref,
        "attempt_id": attempt.attempt_id,
        "event": event,
        "state": attempt.state,
        "worktree": attempt.worktree,
        "terminal": if attempt.terminal.is_empty() { &attempt.coordinator_terminal.address } else { &attempt.terminal.address },
        "core_id": attempt.core_id,
        "backend": attempt.backend,
        "legacy_pane": attempt.pane,
        "opencode_session_id": attempt.session_id,
        "detail": detail,
    })
}
fn write_debug_event(attempt: &Attempt, event: &str, detail: &str) -> Option<Value> {
    if attempt.log_task_ref.is_empty() {
        return None;
    }
    let record = dispatcher_event(attempt, event, detail);
    // Debug evidence must never hide the operation's original outcome.
    let _ = aven(
        &attempt.aven,
        &["note", &attempt.log_task_ref, "--stdin"],
        Some(&record.to_string()),
    );
    Some(record)
}

#[allow(clippy::too_many_arguments)]
fn dispatch(
    path: PathBuf,
    dry_run: bool,
    agent: Option<String>,
    model: Option<String>,
    preferred_agent: Option<String>,
    preferred_model: Option<String>,
    skill: Option<String>,
    skills_dir: Option<PathBuf>,
    babysitter: bool,
    babysitter_model: Option<String>,
    orchestrator_model: Option<String>,
    requested_mode: Option<ExecutionMode>,
    relaunch: bool,
) -> Result<()> {
    let input = if let Some(context) = env::var_os("AVEN_COMMAND_CONTEXT") {
        fs::read_to_string(context).context("read Aven terminal command context")?
    } else {
        let mut input = String::new();
        io::stdin().read_to_string(&mut input)?;
        input
    };
    let context = parse_context(&input)?;
    let selected = selected_for(&context)?;
    let task = refresh_task(&context, selected)?;
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
        ensure_attempt_current(&task, &existing)?;
        if attempt_is_legacy(&existing) && !relaunch {
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
            return Ok(());
        }
        // Reopen confirmation uses interactive pickers; release the store
        // lock before starting them and reacquire only to checkpoint state.
        drop(store);
        let resource = create_worktree(
            &context.invocation.origin_cwd,
            &existing.branch,
            &format!("{} {}", existing.task_ref, selected.task.title),
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
            &worktree,
            &format!("{} {}", reopened.task_ref, selected.task.title),
            &reopened.task_ref,
            &mut reopened.aven_panel,
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
                launch_and_record(
                    &mut reopened,
                    "babysitter",
                    &worktree,
                    &session,
                    &path,
                    &mut store,
                )?;
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
                    &task,
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
        return Ok(());
    }
    // Mode and agent/model pickers can wait for user input indefinitely. Do
    // not retain the process-wide store lock while they are visible.
    drop(store);
    let execution_mode = select_mode(requested_mode, workflow)?;
    let orchestrator_model = resolve_orchestrator_model(execution_mode, orchestrator_model);
    let mut attempt = Attempt {
        task_id: selected.task.id.clone(),
        task_ref: selected.reference().to_owned(),
        workflow: workflow.into(),
        attempt_id: identifier("att"),
        branch: branch(&selected.project.key, &selected.task.id),
        worktree: String::new(),
        worktree_created_by_attempt: false,
        backend: "hc".into(),
        core_id: String::new(),
        core_name: String::new(),
        terminal: TerminalRef::default(),
        pane: String::new(),
        aven_panel: false,
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
        aven_update_pending: false,
        log_cursor: String::new(),
        log_task_ref: String::new(),
        generation,
        babysitter,
        babysitter_model: resolve_babysitter_model(babysitter, babysitter_model),
        babysitter_terminal: TerminalRef::default(),
        babysitter_pane: String::new(),
        babysitter_session_id: String::new(),
        babysitter_prompt_id: String::new(),
        aven: context.invocation.clone(),
        created_at: now(),
    };
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
    let mut store = LockedStore::open(path.clone())?;
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
    drop(store);
    let fail_provisioning =
        |attempt: &Attempt, error: anyhow::Error, path: &Path| -> anyhow::Error {
            if let Ok(mut store) = LockedStore::open(path.to_path_buf())
                && let Err(cleanup) = store.remove_attempt(&attempt.task_id, &attempt.workflow)
            {
                eprintln!("could not remove failed provisioning reservation: {cleanup:#}");
            }
            remove_owned_worktree(&attempt.worktree, attempt.worktree_created_by_attempt);
            error
        };
    if attempt.agent.is_empty() || attempt.agent == "select" {
        attempt.agent =
            match select_agent(&attempt.worktree, &path, None, preferred_agent.as_deref()) {
                Ok(agent) => agent,
                Err(error) => return Err(fail_provisioning(&attempt, error, &path)),
            };
    }
    if attempt.model.is_empty() {
        let configured = match configured_agent_model(&attempt.worktree, &attempt.agent) {
            Ok(configured) => configured,
            Err(error) => return Err(fail_provisioning(&attempt, error, &path)),
        };
        let available = match available_models(&attempt.worktree) {
            Ok(models) => models,
            Err(error) => {
                eprintln!(
                    "warning: could not list configured OpenCode models; using built-in choices: {error:#}"
                );
                Vec::new()
            }
        };
        attempt.model = match select_model(
            &model_choices(
                configured.as_deref(),
                preferred_model.as_deref(),
                &available,
            ),
            &path,
        ) {
            Ok(model) => model,
            Err(error) => return Err(fail_provisioning(&attempt, error, &path)),
        };
    }
    let mut store = LockedStore::open(path.clone())?;
    attempt.state = "session-pending".into();
    store_attempt(&mut store, attempt.clone());
    store.save()?;
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
    let session_payload = json!({
        "title": format!("{} {}", attempt.task_ref, selected.task.title),
        "location": {"directory": attempt.worktree},
        "agent": if session_agent.is_empty() { Value::Null } else { Value::String(session_agent.clone()) },
        "model": model_ref(Some(&session_model))?,
        "permissions": autonomous_permissions(),
    });
    let session = if attempt.execution_mode == ExecutionMode::Worktrees {
        opencode("POST", "/api/session", Some(session_payload))?
    } else {
        opencode_in(
            "POST",
            "/api/session",
            Some(session_payload),
            Path::new(&attempt.worktree),
        )?
    };
    attempt.session_id = field(&session, "/data/id")?.to_owned();
    attempt.coordinator_session_id = attempt.session_id.clone();
    attempt.coordinator_agent = session_agent;
    attempt.coordinator_model = session_model;
    // Launch the OpenCode CLI in its dedicated herdr-core terminal before
    // scheduling the prompt. The CLI attaches to the API-created session by
    // its durable ID, and the terminal survives this short-lived dispatcher.
    attempt.state = "terminal-pending".into();
    store_attempt(&mut store, attempt.clone());
    store.save()?;
    let role = if attempt.execution_mode == ExecutionMode::Worktrees {
        "coordinator"
    } else {
        "builder"
    };
    let session_id = attempt.session_id.clone();
    let worktree = attempt.worktree.clone();
    let terminal = launch_and_record(
        &mut attempt,
        role,
        &worktree,
        &session_id,
        &path,
        &mut store,
    )?;
    let _ = app::show_worktree(
        &terminal.address,
        &worktree,
        &format!("{} {}", attempt.task_ref, selected.task.title),
        &attempt.task_ref,
        &mut attempt.aven_panel,
    );
    attempt.state = "prompt-pending".into();
    let topology = (attempt.execution_mode == ExecutionMode::Worktrees)
        .then(|| coordinator_topology(&attempt));
    attempt.pending_prompt = root_prompt(
        &task,
        &attempt.task_ref,
        skill,
        skills_dir,
        attempt.execution_mode,
        topology.as_deref(),
    )?;
    store_attempt(&mut store, attempt.clone());
    store.save()?;
    let admission = opencode(
        "POST",
        &format!("/api/session/{}/prompt", attempt.session_id),
        Some(json!({
            "id": attempt.prompt_id,
            "text": attempt.pending_prompt,
            "resume": true
        })),
    )?;
    let admitted = field(&admission, "/data/id")?;
    if admitted != attempt.prompt_id {
        bail!("OpenCode admitted an unexpected message id");
    }
    // The build prompt is already durable and admitted. Checkpoint this before
    // optional supervision so a babysitter setup failure cannot make a later
    // reopen submit the build prompt a second time.
    attempt.state = "running".into();
    store_attempt(&mut store, attempt.clone());
    store.save()?;
    if attempt.babysitter {
        start_babysitter(&mut attempt, &path, &mut store)?;
    }
    attempt.state = "running".into();
    attempt.aven_update_pending = true;
    store_attempt(&mut store, attempt.clone());
    store.save()?;
    if write_aven_links(&context.invocation, &attempt).is_ok() {
        attempt.aven_update_pending = false;
        store_attempt(&mut store, attempt.clone());
        store.save()?;
    }
    focus_terminal(&terminal.address);
    if let Ok(core) = core::identity()
        && let Ok(terminals) = core::snapshot(&[("aven.dispatch".into(), "1".into())])
    {
        let _ = watch::write_inventory(&path, &core, &terminals);
    }
    println!(
        "admitted {} to OpenCode session {} (attempt {})",
        attempt.task_ref, attempt.session_id, attempt.attempt_id
    );
    if attempt.aven_update_pending {
        println!("Aven update pending; run reconcile before retrying dispatch");
    }
    Ok(())
}

fn find_attempt<'a>(
    store: &'a LockedStore,
    task: &str,
    workflow: Option<&str>,
) -> Result<&'a Attempt> {
    let matches = store
        .store
        .attempts
        .values()
        .filter(|a| {
            (a.task_id == task || a.task_ref == task)
                && workflow.is_none_or(|workflow| a.workflow == workflow)
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [] => bail!("no dispatcher attempt for task"),
        [attempt] => Ok(*attempt),
        _ => bail!("multiple dispatcher workflows exist for {task}; retry with --workflow <name>"),
    }
}
fn reset_context(task: Option<String>) -> Result<(Invocation, String)> {
    let input = env::var_os("AVEN_COMMAND_CONTEXT")
        .map(fs::read_to_string)
        .transpose()
        .context("read Aven terminal command context")?;
    let context = input.as_deref().map(parse_context).transpose()?;
    match (task, context.as_ref()) {
        (Some(task), Some(context)) => {
            let selected = selected_for(context)?;
            if task != selected.reference() && task != selected.task.id {
                bail!("explicit reset task does not match the focused Aven task");
            }
            Ok((context.invocation.clone(), selected.reference().to_owned()))
        }
        (Some(task), None) => Ok((
            Invocation {
                aven_exe: String::new(),
                db_path: None,
                workspace: None,
                origin_cwd: env::current_dir()?.display().to_string(),
            },
            task,
        )),
        (None, Some(context)) => {
            let selected = selected_for(context)?;
            Ok((context.invocation.clone(), selected.reference().to_owned()))
        }
        (None, None) => bail!("reset requires a task ref outside an Aven focused-task command"),
    }
}
fn metadata_attempts(task: &Value, task_id: &str) -> Result<Vec<Attempt>> {
    let empty = serde_json::Map::new();
    let metadata = task
        .get("metadata")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let mut attempts = Vec::new();
    for (key, value) in metadata {
        if key == "dispatch.attempt" || key.starts_with("dispatch.attempt.") {
            let snapshot = value
                .as_str()
                .with_context(|| format!("{key} must be a JSON string"))?;
            let attempt: Attempt = serde_json::from_str(snapshot)
                .with_context(|| format!("invalid {key} snapshot"))?;
            if attempt.task_id != task_id {
                bail!("{key} snapshot belongs to a different immutable task");
            }
            attempts.push(attempt);
        }
    }
    Ok(attempts)
}
fn attempt_session_ids(attempt: &Attempt) -> Vec<&str> {
    let mut ids = vec![
        attempt.session_id.as_str(),
        attempt.coordinator_session_id.as_str(),
        attempt.babysitter_session_id.as_str(),
    ];
    ids.extend(attempt.phases.iter().map(|phase| phase.session_id.as_str()));
    ids.into_iter().filter(|id| !id.is_empty()).collect()
}
fn json_contains_string(value: &Value, expected: &str) -> bool {
    match value {
        Value::String(value) => value == expected,
        Value::Array(values) => values
            .iter()
            .any(|value| json_contains_string(value, expected)),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key == expected || json_contains_string(value, expected)),
        _ => false,
    }
}
fn active_sessions(sessions: &[String], active: &Value) -> Vec<String> {
    sessions
        .iter()
        .filter(|id| json_contains_string(active, id))
        .cloned()
        .collect()
}
fn authoritative_execution_state(current: &str, snapshot: &Value) -> String {
    // A local admission checkpoint is not superseded by an API snapshot that
    // has not observed the prompt yet. Downgrading it would strand a durable
    // pending prompt and could make recovery submit it twice.
    if matches!(
        current,
        "workspace-pending"
            | "session-pending"
            | "terminal-pending"
            | "prompt-pending"
            | "babysitter-session-pending"
            | "babysitter-prompt-pending"
    ) {
        return current.into();
    }
    match snapshot.pointer("/data/outcome").and_then(Value::as_str) {
        Some("succeeded") => "needs-review".into(),
        Some("failed") => "failed".into(),
        Some("interrupted") | Some("canceled") => "interrupted".into(),
        // An explicit local interrupt remains terminal even if an older
        // snapshot has not yet exposed its outcome.
        None if current == "interrupted" => "interrupted".into(),
        None => "running".into(),
        Some(_) => "waiting".into(),
    }
}
fn refresh_attempt_execution_state(attempt: &mut Attempt) -> Result<()> {
    if attempt.session_id.is_empty() {
        return Ok(());
    }
    let snapshot = opencode("GET", &format!("/api/session/{}", attempt.session_id), None)?;
    attempt.state = authoritative_execution_state(&attempt.state, &snapshot);
    Ok(())
}
fn interrupt_and_drain_sessions(sessions: &[String]) -> Result<()> {
    let unique: BTreeSet<_> = sessions.iter().collect();
    for session in unique {
        opencode("POST", &format!("/api/session/{session}/interrupt"), None)
            .with_context(|| format!("interrupt associated OpenCode session {session}"))?;
    }
    for _ in 0..60 {
        let active = opencode("GET", "/api/session/active", None)
            .context("cannot confirm OpenCode sessions stopped after reset interrupt")?;
        let running = active_sessions(sessions, &active);
        if running.is_empty() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    bail!(
        "associated OpenCode session(s) remained active after interrupt: {}",
        active_sessions(sessions, &opencode("GET", "/api/session/active", None)?).join(", ")
    );
}
fn reset_phase_children(root: &Value) -> Result<Vec<String>> {
    let empty = Vec::new();
    root.pointer("/epic_children")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .map(|child| {
            child
                .get("ref")
                .and_then(Value::as_str)
                .filter(|reference| !reference.is_empty())
                .map(str::to_owned)
                .context("epic child is missing ref")
        })
        .collect()
}

fn reset_operation_strings(operation: &Value, key: &str) -> Result<Vec<String>> {
    operation
        .get(key)
        .map(|value| {
            value
                .as_array()
                .with_context(|| format!("reset operation {key} must be an array"))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .with_context(|| format!("reset operation {key} contains an invalid value"))
                })
                .collect()
        })
        .unwrap_or_else(|| Ok(Vec::new()))
}
fn merged_reset_inventory(mut current: Vec<String>, recovered: Vec<String>) -> Vec<String> {
    current.extend(recovered);
    current.sort();
    current.dedup();
    current
}
fn confirm_reset(reference: &str, attempts: usize) -> Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        bail!("reset mutates state only with --yes when no interactive terminal is available");
    }
    print!(
        "Reset {reference}, invalidating {attempts} dispatch attempt(s) while preserving its Aven plan? [y/N] "
    );
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    if !matches!(answer.trim(), "y" | "Y" | "yes" | "YES") {
        bail!("reset canceled; no state was changed");
    }
    Ok(())
}
fn reset(path: PathBuf, requested_task: Option<String>, yes: bool, dry_run: bool) -> Result<()> {
    let (invocation, reference) = reset_context(requested_task)?;
    let root = refresh_task_by_ref(&invocation, &reference)?;
    let task_id = field(&root, "/task/id")?.to_owned();
    let existing_generation = task_generation(&root)?;
    let recovering = reset_incomplete(&root);
    let generation = if recovering {
        existing_generation
    } else {
        existing_generation + 1
    };
    let mut store = LockedStore::open(path)?;
    let mut attempts: BTreeMap<String, Attempt> = store
        .store
        .attempts
        .values()
        .filter(|attempt| attempt.task_id == task_id)
        .map(|attempt| (attempt.attempt_id.clone(), attempt.clone()))
        .collect();
    for attempt in metadata_attempts(&root, &task_id)? {
        attempts.insert(attempt.attempt_id.clone(), attempt);
    }
    // This inventory is for audit only. It is deliberately derived from the
    // current Aven graph and is never used to alter epic membership.
    let children = reset_phase_children(&root)?;
    let mut recovered_sessions = Vec::new();
    let mut recovered_attempt_ids = Vec::new();
    if recovering {
        let operation = root
            .pointer("/metadata/dispatch.reset-operation")
            .and_then(Value::as_str)
            .context("incomplete reset is missing its operation record")?;
        let operation: Value =
            serde_json::from_str(operation).context("invalid incomplete reset operation record")?;
        if operation.get("generation").and_then(Value::as_u64) != Some(generation) {
            bail!("incomplete reset operation generation does not match task generation");
        }
        recovered_sessions = reset_operation_strings(&operation, "sessions")?;
        recovered_attempt_ids = reset_operation_strings(&operation, "attempt_ids")?;
        // Legacy operation records may contain `detached_children` from the
        // former destructive reset implementation. Ignore that stale inventory:
        // it must never attach, detach, or otherwise override the membership
        // currently recorded by Aven.
    }
    let active = opencode("GET", "/api/session/active", None)
        .context("cannot establish OpenCode session activity; reset refuses to guess")?;
    let sessions = merged_reset_inventory(
        attempts
            .values()
            .flat_map(attempt_session_ids)
            .map(str::to_owned)
            .collect(),
        recovered_sessions,
    );
    let operation_attempt_ids =
        merged_reset_inventory(attempts.keys().cloned().collect(), recovered_attempt_ids);
    let running = active_sessions(&sessions, &active);
    println!(
        "reset target={reference} generation={} attempts={} sessions={} phase_children={}",
        generation,
        operation_attempt_ids.len(),
        sessions.len(),
        children.len()
    );
    if !running.is_empty() {
        println!(
            "hard reset will interrupt associated active session(s): {}",
            running.join(", ")
        );
    }
    if dry_run {
        println!(
            "dry run: no Aven metadata, state store, sessions, worktrees, branches, or files were changed"
        );
        return Ok(());
    }
    if !yes {
        confirm_reset(&reference, attempts.len())?;
    }
    if !running.is_empty() {
        interrupt_and_drain_sessions(&running)?;
    }
    if !recovering {
        let operation = json!({"schema":"aven-dispatch-reset/v1", "generation": generation, "state":"incomplete", "attempt_ids": operation_attempt_ids, "sessions": sessions, "phase_children": children});
        let begin = vec![
            "edit".to_owned(),
            reference.clone(),
            "--metadata".into(),
            format!("dispatch.reset-generation={generation}"),
            "--metadata".into(),
            "dispatch.reset-state=incomplete".into(),
            "--metadata".into(),
            format!("dispatch.reset-operation={operation}"),
        ];
        run(
            if invocation.aven_exe.is_empty() {
                "aven"
            } else {
                &invocation.aven_exe
            },
            &{
                let mut args = aven_args(&invocation, &[]);
                args.extend(begin);
                args
            },
            None,
        )?;
    }
    store.remove_attempts_for_task(&task_id)?;
    let mut cleanup = vec!["edit".to_owned(), reference.clone()];
    let existing_metadata = root.get("metadata").and_then(Value::as_object);
    for key in [
        "dispatch.backend",
        "dispatch.core-id",
        "dispatch.terminal",
        "dispatch.session-id",
        "dispatch.attempt-id",
        "dispatch.state",
        "dispatch.workflow",
        "dispatch.branch",
        "dispatch.attempt",
        "dispatch.attempt.default",
        "dispatch.attempt.planning",
        "dispatch.attempt.implementation",
    ] {
        // Aven treats removal of an absent custom field as an error. A reset
        // commonly follows an aborted dispatch, so optional legacy/workflow
        // fields must be removed only when this task actually has them.
        if existing_metadata.is_some_and(|metadata| metadata.contains_key(key)) {
            cleanup.extend(["--remove-metadata".into(), key.into()]);
        }
    }
    // Workflow names are extensible, so fixed known names are not enough to
    // invalidate every task-scoped snapshot during a hard reset.
    if let Some(metadata) = existing_metadata {
        for key in metadata.keys().filter(|key| {
            key.starts_with("dispatch.attempt.")
                && !matches!(
                    key.as_str(),
                    "dispatch.attempt.default"
                        | "dispatch.attempt.planning"
                        | "dispatch.attempt.implementation"
                )
        }) {
            cleanup.extend(["--remove-metadata".into(), key.clone()]);
        }
    }
    cleanup.extend(["--metadata".into(), "dispatch.reset-state=incomplete".into(), "--metadata".into(), format!("dispatch.reset-operation={}", json!({"schema":"aven-dispatch-reset/v1", "generation":generation, "state":"auditing", "attempt_ids":operation_attempt_ids, "sessions":sessions, "phase_children":children}))]);
    run(
        if invocation.aven_exe.is_empty() {
            "aven"
        } else {
            &invocation.aven_exe
        },
        &{
            let mut args = aven_args(&invocation, &[]);
            args.extend(cleanup);
            args
        },
        None,
    )?;
    let note = format!(
        "## Dispatcher reset\n\nReset generation {} supersedes prior dispatch execution only. Removed {} attempt record(s) from the shared store and Aven snapshots. Preserved the approved Aven plan, including task status, metadata, epic membership, phase dependencies, specification, notes, history, sessions, branches, worktrees, and source files. Current phase inventory: {}. A new dispatch may use the retained approved plan.",
        generation,
        attempts.len(),
        if children.is_empty() {
            "none".into()
        } else {
            children.join(", ")
        }
    );
    aven(&invocation, &["note", &reference, "--stdin"], Some(&note))?;
    // The reset remains admission-fenced until the audit note is durable.
    aven(
        &invocation,
        &[
            "edit",
            &reference,
            "--metadata",
            "dispatch.reset-state=completed",
            "--metadata",
            &format!(
                "dispatch.reset-operation={}",
                json!({"schema":"aven-dispatch-reset/v1", "generation":generation, "state":"completed", "attempt_ids":operation_attempt_ids, "sessions":sessions, "phase_children":children})
            ),
        ],
        None,
    )?;
    println!(
        "reset complete for {reference}; dispatch attempts were invalidated while the Aven plan was preserved"
    );
    Ok(())
}
fn status(path: PathBuf, task: &str, workflow: Option<&str>) -> Result<()> {
    let store = LockedStore::open(path)?;
    let attempt = find_attempt(&store, task, workflow)?;
    let snapshot = opencode("GET", &format!("/api/session/{}", attempt.session_id), None)?;
    let permissions = opencode(
        "GET",
        &format!("/api/session/{}/permission", attempt.session_id),
        None,
    )?;
    let forms = opencode(
        "GET",
        &format!("/api/session/{}/form", attempt.session_id),
        None,
    )?;
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"attempt": attempt, "session": snapshot, "pending_permissions": permissions, "pending_forms": forms})
        )?
    );
    Ok(())
}
fn list(path: PathBuf, running: bool) -> Result<()> {
    let mut store = LockedStore::open(path)?;
    let mut attempts = store.store.attempts.values().cloned().collect::<Vec<_>>();
    if running {
        for attempt in &mut attempts {
            refresh_attempt_execution_state(attempt)?;
            store_attempt(&mut store, attempt.clone());
        }
        store.save()?;
        attempts.retain(|attempt| {
            matches!(
                attempt.state.as_str(),
                "running"
                    | "waiting"
                    | "workspace-pending"
                    | "session-pending"
                    | "terminal-pending"
                    | "prompt-pending"
                    | "babysitter-session-pending"
                    | "babysitter-prompt-pending"
            )
        });
    }
    println!("{}", serde_json::to_string_pretty(&attempts)?);
    Ok(())
}
fn interrupt(path: PathBuf, task: &str, workflow: Option<&str>) -> Result<()> {
    let mut store = LockedStore::open(path.clone())?;
    let attempt = find_attempt(&store, task, workflow)?.clone();
    let sessions = attempt_session_ids(&attempt)
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    interrupt_and_drain_sessions(&sessions)?;
    let mut changed = attempt;
    changed.state = "interrupted".into();
    store_attempt(&mut store, changed);
    store.save()?;
    println!("interrupted owned OpenCode execution sessions; Aven task status was not changed");
    Ok(())
}
fn reconcile_attempt(store: &mut LockedStore, mut attempt: Attempt) -> Result<Attempt> {
    ensure_attempt_current(
        &refresh_task_by_ref(&attempt.aven, &attempt.task_ref)?,
        &attempt,
    )?;
    refresh_attempt_execution_state(&mut attempt)?;
    // Persist authoritative execution state even when no Aven repair is due;
    // task acceptance remains exclusively under the task workflow.
    store_attempt(store, attempt.clone());
    store.save()?;
    if attempt.execution_mode == ExecutionMode::Worktrees
        && advance_worktree_phases(&mut attempt, store)?
    {
        store_attempt(store, attempt.clone());
        store.save()?;
        println!("advanced cumulative worktree phases");
    }
    if attempt.aven_update_pending {
        match write_aven_links(&attempt.aven, &attempt) {
            Ok(()) => {
                attempt.aven_update_pending = false;
                store_attempt(store, attempt.clone());
                store.save()?;
                println!("repaired pending Aven status, metadata, and handoff update");
            }
            Err(error) => eprintln!("pending Aven update could not be repaired: {error:#}"),
        }
    }
    let log = opencode_text(
        "GET",
        &format!(
            "/api/experimental/session/{}/log?after={}&follow=false",
            attempt.session_id, attempt.log_cursor
        ),
        None,
    );
    if let Ok(events) = log
        && let Some(cursor) = events
            .lines()
            .filter_map(|line| line.strip_prefix("id: "))
            .next_back()
    {
        attempt.log_cursor = cursor.to_owned();
        store_attempt(store, attempt.clone());
        store.save()?;
        println!("replayed durable session log through cursor {cursor}");
    }
    Ok(attempt)
}

fn reconcile(path: PathBuf, task: &str, workflow: Option<&str>) -> Result<()> {
    let mut store = LockedStore::open(path)?;
    let attempt = find_attempt(&store, task, workflow)?.clone();
    let attempt = reconcile_attempt(&mut store, attempt)?;
    println!(
        "attempt {} state={} aven_update_pending={}",
        attempt.attempt_id, attempt.state, attempt.aven_update_pending
    );
    Ok(())
}

/// Bounded periodic reconciliation for changes Aven/OpenCode make without a
/// core event. Stops at the first Aven/API outage instead of guessing.
fn reconcile_all(path: &Path) -> Result<usize> {
    let mut store = LockedStore::open(path.to_path_buf())?;
    let attempts = store.store.attempts.values().cloned().collect::<Vec<_>>();
    let mut reconciled = 0;
    for attempt in attempts {
        if attempt_is_legacy(&attempt) {
            continue;
        }
        match reconcile_attempt(&mut store, attempt.clone()) {
            Ok(_) => reconciled += 1,
            Err(error) => eprintln!(
                "supervision left {} ({}) unchanged: {error:#}",
                attempt.task_ref, attempt.attempt_id
            ),
        }
    }
    if let Err(error) = watch::refresh_inventory(path) {
        eprintln!("core inventory unavailable: {error:#}");
    }
    Ok(reconciled)
}
fn log_event(
    path: PathBuf,
    task: &str,
    workflow: Option<&str>,
    event: &str,
    detail: &str,
) -> Result<()> {
    let mut store = LockedStore::open(path)?;
    let mut attempt = find_attempt(&store, task, workflow)?.clone();
    ensure_log_task(&mut attempt)?;
    let record = write_debug_event(&attempt, event, detail);
    store_attempt(&mut store, attempt.clone());
    store.save()?;
    println!(
        "logged {event} for {} in {}",
        attempt.task_ref, attempt.log_task_ref
    );
    if let Some(record) = record {
        println!("{}", serde_json::to_string(&record)?);
    }
    Ok(())
}
fn git_head(directory: &Path) -> Result<String> {
    worktrees::head(directory)
}
fn worktree_is_integration_clean(directory: &Path) -> Result<bool> {
    worktrees::clean(directory)
}
fn phase_is_done_for(invocation: &Invocation, phase: &PhaseAttempt) -> Result<bool> {
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
fn phase_is_done(attempt: &Attempt, phase: &PhaseAttempt) -> Result<bool> {
    phase_is_done_for(&attempt.aven, phase)
}
fn phase_session_succeeded(phase: &PhaseAttempt) -> Result<bool> {
    Ok(
        opencode("GET", &format!("/api/session/{}", phase.session_id), None)?
            .pointer("/data/outcome")
            .and_then(Value::as_str)
            == Some("succeeded"),
    )
}
fn integrated_phase_needs_reconciliation(
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
fn completed_successor_needs_resume(
    phase_state: &str,
    task_done: bool,
    session_succeeded: bool,
) -> bool {
    phase_state == "running" && !task_done && session_succeeded
}
fn integrated_root_state(accepted: bool) -> &'static str {
    if accepted {
        "completed"
    } else {
        "needs-review"
    }
}
fn advance_worktree_phases(attempt: &mut Attempt, store: &mut LockedStore) -> Result<bool> {
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
fn doctor(path: &Path) -> Result<()> {
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
fn message(
    path: PathBuf,
    task: &str,
    workflow: Option<&str>,
    role: &str,
    text: &str,
    wait: bool,
) -> Result<()> {
    let store = LockedStore::open(path)?;
    let attempt = find_attempt(&store, task, workflow)?;
    let terminal = match role {
        "builder" => &attempt.terminal,
        "coordinator" => &attempt.coordinator_terminal,
        "babysitter" => &attempt.babysitter_terminal,
        phase => {
            let phase = phase.strip_prefix("phase:").unwrap_or(phase);
            attempt
                .phases
                .iter()
                .find(|candidate| {
                    candidate.task_id == phase
                        || candidate.task_ref == phase
                        || candidate.task_id == format!("phase:{phase}")
                })
                .map(|candidate| &candidate.terminal)
                .context("no phase terminal for that role")?
        }
    };
    if terminal.is_empty() {
        bail!(
            "attempt {} has no herdr-core terminal for role {role}",
            attempt.attempt_id
        );
    }
    let core = core::identity()?;
    if !terminal.matches_core(&core.id) {
        bail!(
            "terminal {} belongs to a different herdr-core identity; inspect before messaging",
            terminal.address
        );
    }
    let result = core::send_if_idle(&terminal.address, text, wait)?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn pick(kind: &str) -> Result<()> {
    let response = env::var("AVEN_DISPATCH_PICKER_RESPONSE")
        .context("AVEN_DISPATCH_PICKER_RESPONSE is not set")?;
    let names =
        env::var("AVEN_DISPATCH_PICKER_NAMES").context("AVEN_DISPATCH_PICKER_NAMES is not set")?;
    let ids =
        env::var("AVEN_DISPATCH_PICKER_IDS").context("AVEN_DISPATCH_PICKER_IDS is not set")?;
    let heading = match kind {
        "agent" => "Select an OpenCode agent:",
        "model" => "Select an OpenCode model:",
        other => bail!("unknown picker kind: {other}"),
    };
    let choices = names
        .lines()
        .zip(ids.lines())
        .map(|(name, id)| (name.to_owned(), id.to_owned()))
        .collect::<Vec<_>>();
    let selected = if choices.is_empty() {
        "cancelled".to_owned()
    } else {
        choose_from(
            heading,
            &choices,
            &mut io::stdin().lock(),
            &mut io::stdout().lock(),
            io::stdin().is_terminal() && io::stdout().is_terminal(),
        )?
        .unwrap_or_else(|| "cancelled".into())
    };
    let temporary = format!("{response}.new");
    fs::write(&temporary, format!("{selected}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&temporary, &response)?;
    Ok(())
}

fn apply_terminal_fact(
    store: &mut LockedStore,
    core: &core::CoreIdentity,
    terminal: &core::Terminal,
    kind: &str,
    seq: u64,
) -> Result<Vec<String>> {
    let matches = watch::find_attempt_for_terminal(&store.store, &core.id, &terminal.address)
        .into_iter()
        .map(|(attempt, roles)| (attempt_key(&attempt.task_id, &attempt.workflow), roles))
        .collect::<Vec<_>>();
    let mut keys = Vec::new();
    for (key, roles) in matches {
        let Some(mut attempt) = store.store.attempts.get(&key).cloned() else {
            continue;
        };
        let recovery = match kind {
            "finished" => "finished",
            "lost" => "lost",
            "removed" => "removed",
            "restarted" if terminal.recovered_shell() => "recovered-shell",
            _ if terminal.recovered_shell() => "recovered-shell",
            "snapshot" if terminal.state == "finished" && terminal.reason == "holder_lost" => {
                "lost"
            }
            "snapshot" if terminal.state == "finished" => "finished",
            _ => "",
        };
        for role in roles {
            attempt
                .terminals
                .insert(role, terminal.observe(core, seq, recovery));
        }
        attempt.core_id = core.id.clone();
        attempt.core_name = core.name.clone();
        attempt.last_event_seq = attempt.last_event_seq.max(seq);
        store_attempt(store, attempt);
        keys.push(key);
    }
    if !keys.is_empty() {
        store.save()?;
    }
    Ok(keys)
}

fn reconcile_key(store: &mut LockedStore, key: &str) {
    let Some(attempt) = store.store.attempts.get(key).cloned() else {
        return;
    };
    if attempt_is_legacy(&attempt) {
        return;
    }
    if let Err(error) = reconcile_attempt(store, attempt.clone()) {
        eprintln!(
            "supervision left {} ({}) unchanged: {error:#}",
            attempt.task_ref, attempt.attempt_id
        );
    }
}

fn reconcile_keys(path: &Path, keys: &[String]) -> Result<()> {
    let mut store = LockedStore::open(path.to_path_buf())?;
    for key in keys {
        reconcile_key(&mut store, key);
    }
    Ok(())
}

fn watch_command(
    path: PathBuf,
    once: bool,
    stop: bool,
    status: bool,
    interval: u64,
    reconcile_all_flag: bool,
) -> Result<()> {
    if status {
        println!("{}", serde_json::to_string_pretty(&watch::status(&path))?);
        return Ok(());
    }
    if stop {
        println!("{}", watch::stop(&path)?);
        return Ok(());
    }
    if once || reconcile_all_flag {
        let reconciled = reconcile_all(&path)?;
        println!("reconciled {reconciled} dispatch attempt(s)");
        return Ok(());
    }
    let mut guard = watch::WatcherGuard::acquire(&path)?;
    let core = core::identity()?;
    guard.state.core_id = core.id.clone();
    guard.state.core_name = core.name.clone();
    watch::write_state(&path, &guard.state)?;
    let labels = vec![("aven.dispatch".to_string(), "1".to_string())];
    let mut stream: Option<core::EventStream> = None;
    let mut last_periodic = std::time::Instant::now();
    let interval = interval.max(15);
    loop {
        if stream.is_none() {
            match core::EventStream::subscribe(&labels) {
                Ok(next) => stream = Some(next),
                Err(error) => {
                    guard.error(&path, &format!("subscribe failed: {error:#}"))?;
                    eprintln!("watcher could not subscribe to herdr-core events: {error:#}");
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
            }
        }
        let event = match stream.as_mut() {
            Some(stream) => stream.next(),
            None => Ok(None),
        };
        match event {
            Ok(Some(core::EventLine::Snapshot { seq, terminals })) => {
                let mut store = LockedStore::open(path.clone())?;
                let mut keys = Vec::new();
                for value in terminals {
                    if let Ok(terminal) = core::get(
                        value
                            .get("address")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    ) {
                        keys.extend(apply_terminal_fact(
                            &mut store, &core, &terminal, "snapshot", seq,
                        )?);
                    }
                }
                drop(store);
                for key in keys {
                    reconcile_keys(&path, &[key])?;
                }
                // Reconcile every durable attempt from the initial snapshot so
                // a terminated phase or lost terminal surfaces even when it is
                // no longer part of the live subscription.
                let _ = reconcile_all(&path);
                guard.state.last_seq = seq;
                guard.record(&path, "snapshot")?;
            }
            Ok(Some(core::EventLine::Notification {
                seq,
                terminal,
                kind,
                data,
            })) => {
                let observed = core::get(&terminal).unwrap_or_else(|_| core::Terminal {
                    address: terminal.clone(),
                    name: String::new(),
                    state: if kind == "removed" {
                        "removed".into()
                    } else {
                        "unknown".into()
                    },
                    status: data
                        .pointer("/status/state")
                        .or_else(|| data.pointer("/state"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    status_kind: data
                        .pointer("/status/kind")
                        .or_else(|| data.pointer("/kind"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    program: data
                        .pointer("/foreground/name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    reason: data
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    turn: data.get("turn").and_then(Value::as_u64).unwrap_or_default(),
                    labels: Vec::new(),
                    reported: false,
                });
                let mut store = LockedStore::open(path.clone())?;
                let keys = apply_terminal_fact(&mut store, &core, &observed, &kind, seq)?;
                drop(store);
                if !matches!(kind.as_str(), "foreground" | "size" | "doc" | "title") {
                    for key in keys {
                        reconcile_keys(&path, &[key])?;
                    }
                }
                guard.state.last_seq = seq;
                if matches!(
                    kind.as_str(),
                    "created" | "finished" | "lost" | "restarted" | "removed"
                ) {
                    guard.record(&path, &kind)?;
                }
            }
            Ok(Some(core::EventLine::Missed { seq, terminals })) => {
                // Never trust a partial stream: drop it, record the gap, and
                // start again from a fresh snapshot.
                guard.state.gaps = guard.state.gaps.saturating_add(1);
                guard.state.last_seq = seq;
                guard.error(
                    &path,
                    &format!("missed events through seq {seq}; resubscribing"),
                )?;
                let _ = terminals;
                stream = None;
                let _ = reconcile_all(&path);
            }
            Ok(Some(core::EventLine::Heartbeat)) => {}
            Ok(None) => {
                stream = None;
                guard.error(&path, "herdr-core event stream ended; reconnecting")?;
                let _ = reconcile_all(&path);
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(error) => {
                stream = None;
                guard.error(&path, &format!("event stream error: {error:#}"))?;
                eprintln!("watcher event stream error: {error:#}");
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        if last_periodic.elapsed() >= Duration::from_secs(interval) {
            let _ = reconcile_all(&path);
            guard.record(&path, "periodic")?;
            last_periodic = std::time::Instant::now();
        }
    }
}

fn is_interactive_cancellation(error: &anyhow::Error) -> bool {
    matches!(
        error.to_string().as_str(),
        "implementation mode selection was canceled"
            | "OpenCode agent selection was canceled"
            | "OpenCode model selection was canceled"
    )
}

fn show_terminal_error(error: &anyhow::Error) {
    // Aven lends this command its terminal, so a nested error screen would
    // compete for the same surface. Keep the borrowed terminal visible
    // instead, including the complete anyhow chain.
    if env::var_os("AVEN_COMMAND_CONTEXT").is_none()
        || !io::stdin().is_terminal()
        || !io::stderr().is_terminal()
        || is_interactive_cancellation(error)
    {
        return;
    }
    eprintln!("\nAven dispatch failed:\n\n{error:#}\n\nPress Enter to return to Aven.");
    let _ = io::stderr().flush();
    let mut acknowledgement = String::new();
    let _ = io::stdin().read_line(&mut acknowledgement);
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let path = absolute_path(store_path(cli.store))?;
    let result = match cli.command {
        Commands::Dispatch {
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
            mode,
            relaunch,
        } => dispatch(
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
            mode,
            relaunch,
        ),
        Commands::Resume { task, workflow } => reconcile(path, &task, workflow.as_deref()),
        Commands::Status { task, workflow } => status(path, &task, workflow.as_deref()),
        Commands::List { running } => list(path, running),
        Commands::Reconcile { task, workflow } => reconcile(path, &task, workflow.as_deref()),
        Commands::Log {
            task,
            workflow,
            event,
            detail,
        } => log_event(path, &task, workflow.as_deref(), &event, &detail),
        Commands::Interrupt { task, workflow } => interrupt(path, &task, workflow.as_deref()),
        Commands::Pick { kind } => pick(&kind),
        Commands::Message {
            task,
            text,
            role,
            workflow,
            wait,
        } => message(path, &task, workflow.as_deref(), &role, &text, wait),
        Commands::Watch {
            once,
            stop,
            status,
            interval,
            reconcile_all,
        } => watch_command(path, once, stop, status, interval, reconcile_all),
        Commands::Reset { task, yes, dry_run } => reset(path, task, yes, dry_run),
        Commands::Inspect {
            project,
            workspace,
            cwd,
            json,
        } => inspect::run(inspect::Args {
            project,
            workspace,
            cwd,
            store: path,
            json,
        }),
        Commands::Tui {
            project,
            workspace,
            cwd,
        } => tui::run(tui::Args {
            project,
            workspace,
            cwd,
            store: path,
        }),
        Commands::Doctor => doctor(&path),
    };
    if let Err(error) = &result {
        show_terminal_error(error);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_agent_still_requires_a_choice() {
        let agents = vec![PrimaryAgent {
            id: "build".into(),
            name: "Build".into(),
            model: Some("github-copilot/gpt-5.6-terra".into()),
        }];
        let mut output = Vec::new();
        assert!(choose_agent(&agents, &mut io::Cursor::new(""), &mut output, false).is_err());
        assert!(
            String::from_utf8(output)
                .unwrap()
                .contains("1. Build (build)")
        );
        assert_eq!(
            choose_agent(
                &agents,
                &mut io::Cursor::new("0\n2\n1\n"),
                &mut Vec::new(),
                false
            )
            .unwrap(),
            "build"
        );
        assert!(
            choose_agent(&agents, &mut io::Cursor::new("q\n"), &mut Vec::new(), false).is_err()
        );
    }
    #[test]
    fn configured_model_is_first_and_model_choice_requires_input() {
        let choices = model_choices(Some("github-copilot/gpt-5.6-terra"), None, &[]);
        assert_eq!(
            choices.first(),
            Some(&(
                "Agent default (github-copilot/gpt-5.6-terra)".into(),
                "github-copilot/gpt-5.6-terra".into()
            ))
        );
        assert_eq!(
            choose_model(
                &choices,
                &mut io::Cursor::new("0\n2\n"),
                &mut Vec::new(),
                false
            )
            .unwrap(),
            "github-copilot/gpt-6.1-sol"
        );
        assert!(
            choose_model(
                &choices,
                &mut io::Cursor::new("q\n"),
                &mut Vec::new(),
                false
            )
            .is_err()
        );
    }
    #[test]
    fn preferred_model_precedes_the_agent_default() {
        let choices = model_choices(
            Some("github-copilot/gpt-5.6-terra"),
            Some("github-copilot/gpt-6.1-sol"),
            &[],
        );
        assert_eq!(choices[0].1, "github-copilot/gpt-6.1-sol");
        assert_eq!(choices[1].1, "github-copilot/gpt-5.6-terra");
    }
    #[test]
    fn configured_provider_models_are_all_available() {
        let available = vec![
            (
                "GPT-6.1 Terra".into(),
                "github-copilot/gpt-6.1-terra".into(),
            ),
            (
                "DeepSeek V4.1 Flash".into(),
                "opencode-go/deepseek-v4.1-flash".into(),
            ),
        ];
        let choices = model_choices(Some("github-copilot/gpt-6.1-terra"), None, &available);
        assert_eq!(choices[0].1, "github-copilot/gpt-6.1-terra");
        assert!(
            choices
                .iter()
                .any(|(_, model)| model == "opencode-go/deepseek-v4.1-flash")
        );
        assert_eq!(
            choose_model(
                &choices,
                &mut io::Cursor::new("/flash\n1\n"),
                &mut Vec::new(),
                false
            )
            .unwrap(),
            "opencode-go/deepseek-v4.1-flash"
        );
    }
    #[test]
    fn fuzzy_search_filters_and_ranks_choices() {
        let choices = vec![
            (
                "GPT-6.1 Sol".to_owned(),
                "github-copilot/gpt-6.1-sol".to_owned(),
            ),
            (
                "Claude Sonnet".to_owned(),
                "github-copilot/claude-sonnet-5.5".to_owned(),
            ),
            (
                "DeepSeek V4.1 Flash".to_owned(),
                "opencode-go/deepseek-v4.1-flash".to_owned(),
            ),
        ];
        let matches = fuzzy_matches(&choices, "dsf");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].1, "opencode-go/deepseek-v4.1-flash");
        assert_eq!(fuzzy_matches(&choices, "clsn")[0].0, "Claude Sonnet");
        assert!(fuzzy_matches(&choices, "zzz").is_empty());
        assert_eq!(
            choose_model(
                &choices,
                &mut io::Cursor::new("/sol\n1\n"),
                &mut Vec::new(),
                false
            )
            .unwrap(),
            "github-copilot/gpt-6.1-sol"
        );
    }
    #[test]
    fn picker_state_filters_live_and_navigates() {
        let choices = vec![
            (
                "GPT-6.1 Sol".to_owned(),
                "github-copilot/gpt-6.1-sol".to_owned(),
            ),
            (
                "Claude Sonnet".to_owned(),
                "github-copilot/claude-sonnet-5.5".to_owned(),
            ),
            (
                "DeepSeek V4.1 Flash".to_owned(),
                "opencode-go/deepseek-v4.1-flash".to_owned(),
            ),
        ];
        let mut state = PickerState {
            searching: true,
            ..PickerState::default()
        };
        for character in "flash".chars() {
            state.type_character(character);
        }
        let visible = state.visible(&choices);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].1, "opencode-go/deepseek-v4.1-flash");
        for _ in 0.."flash".len() {
            state.backspace();
        }
        assert_eq!(state.visible(&choices).len(), choices.len());
        state.down(3);
        assert_eq!(state.selected, 1);
        state.up(3);
        assert_eq!(state.selected, 0);
        state.up(3);
        assert_eq!(state.selected, 2);
    }
    #[test]
    fn planning_and_implementation_have_separate_attempt_keys() {
        assert_eq!(workflow_for_skill(Some("aven/sdd-plan")), "planning");
        assert_eq!(
            workflow_for_skill(Some("aven/sdd-implement")),
            "implementation"
        );
        assert_ne!(
            attempt_key("task-id", "planning"),
            attempt_key("task-id", "implementation")
        );
    }
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
    fn targets_not_focused_selection_drive_validation() {
        let context = parse_context(r#"{"version":1,"invocation":{},"targeting":{"targets":[{"id":"one","ref":"APP-1"}]},"selection":{"primary":{"ref":"APP-1","task":{"id":"two"}}}}"#).unwrap();
        assert!(selected_for(&context).is_err());
    }
    #[test]
    fn model_option_becomes_an_opencode_model_ref() {
        assert_eq!(
            model_ref(Some("provider/model#fast")).unwrap(),
            json!({"providerID": "provider", "id": "model", "variant": "fast"})
        );
        assert!(model_ref(Some("missing-provider")).is_err());
        assert!(model_ref(Some("provider/")).is_err());
        assert!(model_ref(Some("provider/model#")).is_err());
    }
    #[test]
    fn babysitter_model_option_is_independent_from_the_worker_model() {
        let cli = Cli::try_parse_from([
            "aven-dispatch",
            "dispatch",
            "--agent",
            "build",
            "--model",
            "provider/worker",
            "--babysitter",
            "--babysitter-model",
            "provider/supervisor#fast",
        ])
        .unwrap();
        let Commands::Dispatch {
            model,
            babysitter,
            babysitter_model,
            ..
        } = cli.command
        else {
            panic!("expected dispatch command");
        };
        assert_eq!(model.as_deref(), Some("provider/worker"));
        assert!(babysitter);
        assert_eq!(
            babysitter_model.as_deref(),
            Some("provider/supervisor#fast")
        );
    }
    #[test]
    fn babysitter_model_resolves_luna_only_for_enabled_attempts() {
        assert_eq!(
            resolve_babysitter_model(true, None),
            "github-copilot/gpt-6-luna"
        );
        assert_eq!(
            resolve_babysitter_model(true, Some("provider/supervisor".into())),
            "provider/supervisor"
        );
        assert_eq!(resolve_babysitter_model(false, None), "");
        assert_eq!(
            resolve_babysitter_model(false, Some("provider/supervisor".into())),
            ""
        );
    }
    #[test]
    fn orchestrator_model_option_is_independent_from_the_worker_model() {
        let cli = Cli::try_parse_from([
            "aven-dispatch",
            "dispatch",
            "--agent",
            "build",
            "--model",
            "provider/worker",
            "--mode",
            "worktrees",
            "--orchestrator-model",
            "provider/coordinator#fast",
        ])
        .unwrap();
        let Commands::Dispatch {
            model,
            orchestrator_model,
            ..
        } = cli.command
        else {
            panic!("expected dispatch command");
        };
        assert_eq!(model.as_deref(), Some("provider/worker"));
        assert_eq!(
            orchestrator_model.as_deref(),
            Some("provider/coordinator#fast")
        );
    }
    #[test]
    fn orchestrator_model_resolves_luna_only_for_worktree_mode() {
        assert_eq!(
            resolve_orchestrator_model(ExecutionMode::Worktrees, None),
            "github-copilot/gpt-6-luna"
        );
        assert_eq!(
            resolve_orchestrator_model(
                ExecutionMode::Worktrees,
                Some("provider/coordinator".into())
            ),
            "provider/coordinator"
        );
        assert_eq!(
            resolve_orchestrator_model(ExecutionMode::SingleSession, None),
            ""
        );
        assert_eq!(
            resolve_orchestrator_model(
                ExecutionMode::Subsessions,
                Some("provider/coordinator".into())
            ),
            ""
        );
    }
    #[test]
    fn attempts_without_a_babysitter_model_keep_the_legacy_fallback() {
        let attempt = stored_attempt("task", "implementation", "running");
        let mut value = serde_json::to_value(&attempt).unwrap();
        value.as_object_mut().unwrap().remove("babysitter_model");
        let decoded: Attempt = serde_json::from_value(value).unwrap();
        assert!(decoded.babysitter_model.is_empty());
        assert_eq!(
            resolve_babysitter_model(true, Some(decoded.babysitter_model)),
            "github-copilot/gpt-6-luna"
        );
    }
    #[test]
    fn worktree_location_header_value_is_url_encoded() {
        assert_eq!(
            header_value("/tmp/task worktree/agent.md"),
            "%2Ftmp%2Ftask%20worktree%2Fagent.md"
        );
    }
    #[test]
    fn a_recovered_shell_is_not_resumed_agent_execution() {
        let terminal = |program: &str| core::Terminal {
            address: "t1".into(),
            name: "aven-test".into(),
            state: "live".into(),
            status: String::new(),
            status_kind: String::new(),
            program: program.into(),
            reason: String::new(),
            turn: 0,
            labels: Vec::new(),
            reported: false,
        };
        assert!(terminal("zsh").recovered_shell());
        assert!(!terminal("opencode").recovered_shell());
    }
    #[test]
    fn bundled_agent_definition_is_written_to_a_named_global_agent_path() {
        let root = tempfile::tempdir().unwrap();
        let agents = root.path().join("opencode/agents");
        let destination =
            install_agent_definition(&agents, BABYSITTER_AGENT_ID, BABYSITTER_AGENT).unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), BABYSITTER_AGENT);
        assert_eq!(destination, agents.join("aven-babysitter.md"));
    }
    #[test]
    fn previous_bundled_agent_is_upgraded_in_place() {
        let root = tempfile::tempdir().unwrap();
        let agents = root.path().join("opencode/agents");
        fs::create_dir_all(&agents).unwrap();
        let destination = agents.join("aven-babysitter.md");
        let previous = BABYSITTER_AGENT.replace("mode: primary\n", "mode: primary\nhidden: true\n");
        fs::write(&destination, &previous).unwrap();
        install_agent_definition(&agents, BABYSITTER_AGENT_ID, BABYSITTER_AGENT).unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), BABYSITTER_AGENT);
    }
    #[test]
    fn differing_user_agent_is_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let agents = root.path().join("opencode/agents");
        fs::create_dir_all(&agents).unwrap();
        let destination = agents.join("aven-babysitter.md");
        fs::write(&destination, "user edit").unwrap();
        let error = install_agent_definition(&agents, BABYSITTER_AGENT_ID, BABYSITTER_AGENT)
            .unwrap_err()
            .to_string();
        assert!(error.contains("refusing to overwrite user configuration"));
        assert_eq!(fs::read_to_string(&destination).unwrap(), "user edit");
    }
    #[test]
    fn orchestrator_definition_monitors_every_phase_and_defers_final_integration() {
        assert!(ORCHESTRATOR_AGENT.starts_with(
            "---\ndescription: Autonomously coordinate an approved Aven epic through cumulative worktrees\nmode: primary\nmodel: github-copilot/gpt-6-luna\nsteps: 1000\n---"
        ));
        assert!(!ORCHESTRATOR_AGENT.contains("fixed Luna"));
        assert!(ORCHESTRATOR_AGENT.contains(
            "your own coordinator\nagent and model come from the dispatch configuration"
        ));
        assert!(ORCHESTRATOR_AGENT.contains("do not stop after the first worker"));
        assert!(ORCHESTRATOR_AGENT.contains("Prefer event- and wait-driven supervision"));
        assert!(ORCHESTRATOR_AGENT.contains("hc wait <address> --timeout 180"));
        assert!(ORCHESTRATOR_AGENT.contains("aven-dispatch reconcile\n<root-ref>"));
        assert!(
            ORCHESTRATOR_AGENT.contains("every phase is\nintegrated and the root epic is `done`")
        );
        assert!(ORCHESTRATOR_AGENT.contains("creating a pull\nrequest as the preferred option"));
        assert!(ORCHESTRATOR_AGENT.contains("Wait for explicit approval"));
        assert!(ORCHESTRATOR_AGENT.contains("Never create a pull request, push, merge"));
    }
    #[test]
    fn agent_list_keeps_visible_primary_agents_only() {
        let response = json!({"data": [
            {"id": "build", "name": "Build", "mode": "primary", "hidden": false},
            {"id": "hidden", "mode": "primary", "hidden": true},
            {"id": "subagent", "mode": "subagent", "hidden": false}
        ]});
        let agents = response["data"].as_array().unwrap();
        let selected: Vec<_> = agents
            .iter()
            .filter(|agent| agent.pointer("/mode").and_then(Value::as_str) == Some("primary"))
            .filter(|agent| agent.pointer("/hidden").and_then(Value::as_bool) != Some(true))
            .filter_map(|agent| agent.pointer("/id").and_then(Value::as_str))
            .collect();
        assert_eq!(selected, vec!["build"]);
    }
    #[test]
    fn legacy_dispatcher_agent_ids_are_not_selectable() {
        assert!(is_legacy_dispatcher_agent("babysitter"));
        assert!(is_legacy_dispatcher_agent("orchestrator"));
        assert!(is_legacy_dispatcher_agent("aven-babysitter"));
        assert!(is_legacy_dispatcher_agent("aven-orchestrator"));
        assert!(!is_legacy_dispatcher_agent("build"));
    }
    #[test]
    fn babysitter_message_names_the_builder_terminal_only() {
        let attempt: Attempt = serde_json::from_value(json!({
            "task_id": "task",
            "task_ref": "APP-1",
            "workflow": "implementation",
            "attempt_id": "att",
            "branch": "branch",
            "worktree": "/tmp",
            "session_id": "ses_builder",
            "prompt_id": "msg",
            "state": "running",
            "terminal": {"address": "t1"},
            "babysitter_terminal": {"address": "t2"},
            "aven": {},
            "created_at": 0
        }))
        .unwrap();
        let message = babysitter_message(&attempt);
        assert!(message.contains("session ses_builder in herdr-core terminal t1"));
        assert!(!message.contains("terminal t2"));
    }
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
            aven_panel: false,
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
    fn branch_uses_immutable_id() {
        assert_eq!(branch("APP", "ABC123"), "APP/dispatch-abc123");
    }
    #[test]
    fn worktree_layout_matches_the_herdr_app_convention() {
        let path =
            worktrees::worktree_path("/repo/herdr-aven-plugin", "herdr-aven-plugin/dispatch-abc")
                .unwrap();
        assert_eq!(
            path,
            worktrees::root()
                .join("herdr-aven-plugin")
                .join("herdr-aven-plugin-dispatch-abc")
        );
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
    #[test]
    fn terminal_aven_snapshot_omits_large_admitted_prompt() {
        let mut attempt = stored_attempt("task", "implementation", "needs-review");
        attempt.pending_prompt = "large prompt".repeat(3000);
        assert!(aven_attempt_snapshot(&attempt).pending_prompt.is_empty());
        assert_eq!(attempt.pending_prompt.len(), 36000);
        attempt.state = "prompt-pending".into();
        assert_eq!(
            aven_attempt_snapshot(&attempt).pending_prompt,
            attempt.pending_prompt
        );
    }
    #[test]
    fn worktree_inventory_parses_porcelain_entries() {
        let trees = worktrees::parse_listing(
            "worktree /repo/main\nHEAD deadbeef\nbranch refs/heads/main\n\nworktree /tmp/dispatch\nHEAD feedface\nbranch refs/heads/app/dispatch-task\n",
        );
        assert_eq!(trees.len(), 2);
        assert_eq!(trees[0].path, "/repo/main");
        assert_eq!(trees[1].branch_name(), Some("app/dispatch-task"));
    }
    #[test]
    fn event_snapshot_and_notifications_are_parsed_without_guessing() {
        let snapshot =
            core::parse_event_line(r#"{"channel":null,"seq":4,"terminals":[]}"#).unwrap();
        assert!(matches!(
            snapshot,
            Some(core::EventLine::Snapshot { seq: 4, .. })
        ));
        let notification = core::parse_event_line(
            r#"{"jsonrpc":"2.0","method":"event","params":{"data":{"exit_code":0,"reason":"exited"},"seq":9,"terminal":"t2","type":"finished"}}"#,
        )
        .unwrap();
        match notification {
            Some(core::EventLine::Notification {
                seq,
                terminal,
                kind,
                ..
            }) => {
                assert_eq!(seq, 9);
                assert_eq!(terminal, "t2");
                assert_eq!(kind, "finished");
            }
            other => panic!("unexpected event parse: {other:?}"),
        }
        let missed = core::parse_event_line(
            r#"{"jsonrpc":"2.0","method":"event","params":{"data":{"terminals":[]},"seq":12,"terminal":"","type":"missed"}}"#,
        )
        .unwrap();
        assert!(matches!(
            missed,
            Some(core::EventLine::Missed { seq: 12, .. })
        ));
    }
    fn stored_attempt(task_id: &str, workflow: &str, state: &str) -> Attempt {
        Attempt {
            task_id: task_id.into(),
            task_ref: format!("APP-{}", task_id.to_uppercase()),
            workflow: workflow.into(),
            attempt_id: format!("att_{task_id}_{workflow}"),
            branch: format!("app/dispatch-{task_id}"),
            worktree: String::new(),
            worktree_created_by_attempt: false,
            backend: "hc".into(),
            core_id: String::new(),
            core_name: String::new(),
            terminal: TerminalRef::default(),
            pane: String::new(),
            aven_panel: false,
            agent: String::new(),
            model: String::new(),
            execution_mode: ExecutionMode::SingleSession,
            coordinator_session_id: String::new(),
            coordinator_agent: String::new(),
            coordinator_model: String::new(),
            coordinator_terminal: TerminalRef::default(),
            auto_permissions: false,
            phases: Vec::new(),
            terminals: BTreeMap::new(),
            last_event_seq: 0,
            session_id: format!("ses_{task_id}"),
            prompt_id: String::new(),
            pending_prompt: String::new(),
            state: state.into(),
            aven_update_pending: false,
            log_cursor: String::new(),
            log_task_ref: String::new(),
            generation: 0,
            babysitter: false,
            babysitter_model: String::new(),
            babysitter_terminal: TerminalRef::default(),
            babysitter_pane: String::new(),
            babysitter_session_id: String::new(),
            babysitter_prompt_id: String::new(),
            aven: Invocation {
                aven_exe: String::new(),
                db_path: None,
                workspace: None,
                origin_cwd: String::new(),
            },
            created_at: now(),
        }
    }
    #[test]
    fn sqlite_store_persists_and_removes_attempts() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("dispatch.sqlite");
        let mut store = LockedStore::open(state.clone()).unwrap();
        store_attempt(
            &mut store,
            stored_attempt("task-one", "planning", "running"),
        );
        store.save().unwrap();
        drop(store);

        let mut reopened = LockedStore::open(state.clone()).unwrap();
        assert_eq!(
            reopened
                .store
                .attempts
                .get(&attempt_key("task-one", "planning"))
                .unwrap()
                .state,
            "running"
        );
        assert_eq!(reopened.remove_attempts_for_task("task-one").unwrap(), 1);
        reopened.save().unwrap();
        drop(reopened);

        assert!(LockedStore::open(state).unwrap().store.attempts.is_empty());
    }
    #[test]
    fn sqlite_store_reserves_task_workflow_atomically() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("dispatch.sqlite");
        let mut first = LockedStore::open(state.clone()).unwrap();
        assert!(
            first
                .reserve(stored_attempt(
                    "task-one",
                    "implementation",
                    "session-pending"
                ))
                .unwrap()
                .is_none()
        );
        first.save().unwrap();

        let mut second = LockedStore::open(state).unwrap();
        let existing = second
            .reserve(stored_attempt(
                "task-one",
                "implementation",
                "session-pending",
            ))
            .unwrap()
            .expect("the second reservation must observe the first attempt");
        assert_eq!(existing.task_id, "task-one");
        assert_eq!(second.store.attempts.len(), 1);

        // A different workflow for the same task is a distinct execution.
        assert!(
            second
                .reserve(stored_attempt("task-one", "planning", "session-pending"))
                .unwrap()
                .is_none()
        );
        assert_eq!(second.store.attempts.len(), 2);
    }
    #[test]
    fn sqlite_store_allows_concurrent_different_task_dispatch() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("dispatch.sqlite");
        let mut first = LockedStore::open(state.clone()).unwrap();
        let mut second = LockedStore::open(state.clone()).unwrap();
        assert!(
            first
                .reserve(stored_attempt(
                    "task-one",
                    "implementation",
                    "session-pending"
                ))
                .unwrap()
                .is_none()
        );
        assert!(
            second
                .reserve(stored_attempt(
                    "task-two",
                    "implementation",
                    "session-pending"
                ))
                .unwrap()
                .is_none()
        );
        first.save().unwrap();
        second.save().unwrap();
        drop((first, second));

        let store = LockedStore::open(state).unwrap();
        assert_eq!(store.store.attempts.len(), 2);
        assert!(
            store
                .store
                .attempts
                .contains_key(&attempt_key("task-one", "implementation"))
        );
        assert!(
            store
                .store
                .attempts
                .contains_key(&attempt_key("task-two", "implementation"))
        );
    }
    #[test]
    fn sqlite_store_refuses_a_newer_schema_version() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("dispatch.sqlite");
        let connection = rusqlite::Connection::open(&state).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
        drop(connection);
        assert!(LockedStore::open(state).is_err());
    }
    #[test]
    fn central_store_path_is_xdg_compatible() {
        use std::ffi::OsStr;
        assert_eq!(
            process::default_store_path(Some(OsStr::new("/state")), Some(OsStr::new("/home/u"))),
            PathBuf::from("/state/aven/dispatch.sqlite")
        );
        assert_eq!(
            process::default_store_path(None, Some(OsStr::new("/home/u"))),
            PathBuf::from("/home/u/.local/state/aven/dispatch.sqlite")
        );
        assert_eq!(
            process::store_path(Some(PathBuf::from("/custom/dispatch.sqlite"))),
            PathBuf::from("/custom/dispatch.sqlite")
        );
    }
    #[test]
    fn interactive_cancellation_does_not_show_an_error_screen() {
        for cancellation in [
            "implementation mode selection was canceled",
            "OpenCode agent selection was canceled",
            "OpenCode model selection was canceled",
        ] {
            assert!(is_interactive_cancellation(&anyhow::anyhow!(cancellation)));
        }
        assert!(!is_interactive_cancellation(&anyhow::anyhow!(
            "store is locked"
        )));
    }
    #[test]
    fn running_list_excludes_non_running_attempts() {
        let attempts = ["running", "interrupted"];
        assert_eq!(
            attempts.iter().filter(|state| **state == "running").count(),
            1
        );
    }
    #[test]
    fn authoritative_session_outcome_controls_running_state() {
        assert_eq!(
            authoritative_execution_state("running", &json!({"data":{"outcome":"succeeded"}})),
            "needs-review"
        );
        assert_eq!(
            authoritative_execution_state("running", &json!({"data":{"outcome":"failed"}})),
            "failed"
        );
        assert_eq!(
            authoritative_execution_state("running", &json!({"data":{}})),
            "running"
        );
        assert_eq!(
            authoritative_execution_state("interrupted", &json!({"data":{}})),
            "interrupted"
        );
    }

    #[test]
    fn reset_phase_inventory_uses_current_membership_without_plan_ownership_checks() {
        let root = json!({
            "epic_children": [
                {"ref": "APP-MANUAL"},
                {"ref": "APP-PHASE"}
            ]
        });
        assert_eq!(
            reset_phase_children(&root).unwrap(),
            vec!["APP-MANUAL", "APP-PHASE"]
        );
    }
    #[test]
    fn reset_recovery_reads_saved_operation_sessions_and_attempts() {
        let operation = json!({
            "attempt_ids": ["att-root", "att-phase"],
            "sessions": ["ses-root", "ses-worker"],
            // This legacy field is parsed for a safe recovery audit but never
            // used to change current Aven membership.
            "detached_children": ["APP-P1"]
        });
        assert_eq!(
            reset_operation_strings(&operation, "attempt_ids").unwrap(),
            vec!["att-root", "att-phase"]
        );
        assert_eq!(
            reset_operation_strings(&operation, "sessions").unwrap(),
            vec!["ses-root", "ses-worker"]
        );
        assert!(reset_operation_strings(&json!({"sessions":"bad"}), "sessions").is_err());
    }
    #[test]
    fn reset_recovery_preserves_saved_attempt_ids_without_current_snapshots() {
        let operation = json!({
            "attempt_ids": ["att-root", "att-worker"],
            "sessions": ["ses-root", "ses-worker"]
        });
        // Model recovery after both the central store and task metadata
        // snapshots have already been removed: only the operation record is
        // available for the auditing/completed checkpoint.
        let attempts = merged_reset_inventory(
            Vec::new(),
            reset_operation_strings(&operation, "attempt_ids").unwrap(),
        );
        let sessions = merged_reset_inventory(
            Vec::new(),
            reset_operation_strings(&operation, "sessions").unwrap(),
        );
        assert_eq!(attempts, vec!["att-root", "att-worker"]);
        assert_eq!(sessions, vec!["ses-root", "ses-worker"]);
    }
    #[test]
    fn dispatcher_events_are_machine_readable_json() {
        let attempt = Attempt {
            task_id: "task-id".into(),
            task_ref: "APP-1".into(),
            workflow: "default".into(),
            attempt_id: "att_1".into(),
            branch: "app/dispatch-task-id".into(),
            worktree: "/worktree".into(),
            worktree_created_by_attempt: true,
            backend: "hc".into(),
            core_id: String::new(),
            core_name: String::new(),
            terminal: TerminalRef::default(),
            pane: "w1:p1".into(),
            aven_panel: false,
            agent: "build".into(),
            model: "provider/model".into(),
            execution_mode: ExecutionMode::SingleSession,
            coordinator_session_id: "ses_1".into(),
            coordinator_agent: "build".into(),
            coordinator_model: "provider/model".into(),
            coordinator_terminal: TerminalRef::default(),
            auto_permissions: true,
            phases: Vec::new(),
            terminals: BTreeMap::new(),
            last_event_seq: 0,
            session_id: "ses_1".into(),
            prompt_id: "msg_1".into(),
            pending_prompt: String::new(),
            state: "running".into(),
            aven_update_pending: false,
            log_cursor: String::new(),
            log_task_ref: "DL-1".into(),
            generation: 0,
            babysitter: false,
            babysitter_model: String::new(),
            babysitter_terminal: TerminalRef::default(),
            babysitter_pane: String::new(),
            babysitter_session_id: String::new(),
            babysitter_prompt_id: String::new(),
            aven: Invocation {
                aven_exe: String::new(),
                db_path: None,
                workspace: None,
                origin_cwd: String::new(),
            },
            created_at: 0,
        };
        let record = dispatcher_event(&attempt, "completed", "verified");
        assert_eq!(record["schema"], "aven-dispatch-event/v1");
        assert_eq!(record["source_task"], "APP-1");
        assert_eq!(record["event"], "completed");
        assert_eq!(record["detail"], "verified");
    }
    #[test]
    fn legacy_attempt_normalization_is_repeatable_and_read_only() {
        let mut attempt = stored_attempt("task", "implementation", "running");
        attempt.backend = String::new();
        attempt.pane = "w1:p1".into();
        attempt.terminal = TerminalRef::default();
        let first = normalize_attempt(attempt);
        assert_eq!(first.backend, "herdr");
        assert_eq!(first.pane, "w1:p1");
        assert!(first.terminal.is_empty());
        let second = normalize_attempt(first.clone());
        assert_eq!(second.backend, first.backend);
        assert_eq!(second.pane, first.pane);
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
            aven_panel: false,
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
    #[test]
    fn reset_generation_defaults_to_zero_and_fences_stale_attempts() {
        let mut attempt = Attempt {
            task_id: "task-id".into(),
            task_ref: "APP-1".into(),
            workflow: "default".into(),
            attempt_id: "att_1".into(),
            branch: String::new(),
            worktree: String::new(),
            worktree_created_by_attempt: false,
            backend: "hc".into(),
            core_id: String::new(),
            core_name: String::new(),
            terminal: TerminalRef::default(),
            pane: String::new(),
            aven_panel: false,
            agent: String::new(),
            model: String::new(),
            execution_mode: ExecutionMode::SingleSession,
            coordinator_session_id: String::new(),
            coordinator_agent: String::new(),
            coordinator_model: String::new(),
            coordinator_terminal: TerminalRef::default(),
            auto_permissions: false,
            phases: Vec::new(),
            terminals: BTreeMap::new(),
            last_event_seq: 0,
            session_id: String::new(),
            prompt_id: String::new(),
            pending_prompt: String::new(),
            state: "running".into(),
            aven_update_pending: false,
            log_cursor: String::new(),
            log_task_ref: String::new(),
            generation: 0,
            babysitter: false,
            babysitter_model: String::new(),
            babysitter_terminal: TerminalRef::default(),
            babysitter_pane: String::new(),
            babysitter_session_id: String::new(),
            babysitter_prompt_id: String::new(),
            aven: Invocation {
                aven_exe: String::new(),
                db_path: None,
                workspace: None,
                origin_cwd: String::new(),
            },
            created_at: 0,
        };
        assert_eq!(task_generation(&json!({"metadata": {}})).unwrap(), 0);
        assert!(
            ensure_attempt_current(
                &json!({"metadata": {"dispatch.reset-generation": "1"}}),
                &attempt
            )
            .is_err()
        );
        attempt.generation = 1;
        assert!(
            ensure_attempt_current(
                &json!({"metadata": {"dispatch.reset-generation": "1"}}),
                &attempt
            )
            .is_ok()
        );
        assert!(ensure_attempt_current(&json!({"metadata": {"dispatch.reset-state": "incomplete", "dispatch.reset-generation": "1"}}), &attempt).is_err());
    }
    #[test]
    fn reset_active_session_detection_matches_nested_active_payloads() {
        assert!(json_contains_string(
            &json!({"data": {"ses_1": {"status": "running"}}}),
            "ses_1"
        ));
        assert!(!json_contains_string(
            &json!({"data": {"ses_2": {}}}),
            "ses_1"
        ));
    }
}
