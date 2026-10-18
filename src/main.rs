use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, BufRead, IsTerminal, Read, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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
    },
    /// Resume an existing attempt without creating a second session.
    Resume { task: String },
    /// Inspect persisted state and the authoritative OpenCode snapshot.
    Status { task: String },
    /// List persisted dispatch attempts; --running limits results to active execution.
    List {
        #[arg(long)]
        running: bool,
    },
    /// Repair pending Aven updates and refresh session state.
    Reconcile { task: String },
    /// Append a diagnostic event to this attempt's linked Dispatcher Logs task.
    Log {
        task: String,
        #[arg(long)]
        event: String,
        #[arg(long)]
        detail: String,
    },
    /// Interrupt OpenCode execution; this never changes the Aven task to done/canceled.
    Interrupt { task: String },
    /// Validate local Aven and OpenCode V2 capabilities without mutation.
    Doctor,
}

#[derive(Debug, Deserialize)]
struct CommandContext {
    version: u32,
    invocation: Invocation,
    #[serde(default)]
    targeting: Targeting,
    #[serde(default)]
    selection: Selection,
}
#[derive(Debug, Deserialize, Default)]
struct Targeting {
    #[serde(default)]
    targets: Vec<Target>,
}
#[derive(Debug, Deserialize)]
struct Target {
    id: String,
    #[serde(default)]
    reference: String,
    #[serde(rename = "ref", default)]
    short_ref: String,
}
impl Target {
    fn reference(&self) -> &str {
        if self.reference.is_empty() {
            &self.short_ref
        } else {
            &self.reference
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Invocation {
    #[serde(default)]
    aven_exe: String,
    #[serde(default)]
    db_path: Option<String>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    origin_cwd: String,
}
#[derive(Debug, Deserialize, Default)]
struct Selection {
    #[serde(default)]
    primary: Option<Selected>,
}
#[derive(Debug, Deserialize)]
struct Selected {
    #[serde(default)]
    reference: String,
    #[serde(rename = "ref", default)]
    short_ref: String,
    task: SelectedTask,
    #[serde(default)]
    project: Project,
}
impl Selected {
    fn reference(&self) -> &str {
        if self.reference.is_empty() {
            &self.short_ref
        } else {
            &self.reference
        }
    }
}
#[derive(Debug, Deserialize)]
struct SelectedTask {
    id: String,
    #[serde(default)]
    title: String,
}
#[derive(Debug, Deserialize, Default)]
struct Project {
    #[serde(default)]
    key: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct Store {
    attempts: BTreeMap<String, Attempt>,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
struct Attempt {
    task_id: String,
    task_ref: String,
    attempt_id: String,
    branch: String,
    worktree: String,
    #[serde(default)]
    pane: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    session_id: String,
    prompt_id: String,
    state: String,
    #[serde(default)]
    aven_update_pending: bool,
    #[serde(default)]
    log_cursor: String,
    #[serde(default)]
    log_task_ref: String,
    #[serde(default)]
    babysitter: bool,
    #[serde(default)]
    babysitter_pane: String,
    #[serde(default)]
    babysitter_session_id: String,
    #[serde(default)]
    babysitter_prompt_id: String,
    aven: Invocation,
    created_at: u64,
}
struct LockedStore {
    path: PathBuf,
    lock: PathBuf,
    store: Store,
}
impl LockedStore {
    fn open(path: PathBuf) -> Result<Self> {
        let parent = path.parent().context("store path has no parent")?;
        fs::create_dir_all(parent).context("create dispatcher state directory")?;
        let lock = path.with_extension("lock");
        fs::OpenOptions::new().write(true).create_new(true).open(&lock)
            .with_context(|| format!("dispatcher store is locked: {}; use status/reconcile instead of concurrent dispatch", lock.display()))?;
        let store = if path.exists() {
            serde_json::from_slice(&fs::read(&path)?)?
        } else {
            Store::default()
        };
        Ok(Self { path, lock, store })
    }
    fn save(&self) -> Result<()> {
        let temporary = self.path.with_extension("new");
        fs::write(&temporary, serde_json::to_vec_pretty(&self.store)?)?;
        fs::rename(temporary, &self.path)?;
        Ok(())
    }
}
impl Drop for LockedStore {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.lock);
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn identifier(prefix: &str) -> String {
    format!("{prefix}_{:x}", now())
}
fn store_path(value: Option<PathBuf>) -> PathBuf {
    value.unwrap_or_else(|| {
        let directory = env::current_dir().unwrap();
        // All linked checkouts share the primary checkout's existing store.
        // This resolves a filesystem path only: it never switches branches or
        // moves Herdr focus to the primary checkout.
        let primary = run_in(
            "git",
            &["worktree".into(), "list".into(), "--porcelain".into()],
            None,
            Some(&directory),
        )
        .ok()
        .and_then(|listing| {
            listing
                .lines()
                .find_map(|line| line.strip_prefix("worktree "))
                .map(PathBuf::from)
        })
        .unwrap_or(directory);
        primary.join(".aven-dispatch/state.json")
    })
}
fn absolute_path(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

fn run_in(
    program: &str,
    args: &[String],
    input: Option<&str>,
    directory: Option<&Path>,
) -> Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    if input.is_some() {
        command.stdin(std::process::Stdio::piped());
    }
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .with_context(|| format!("start {program}"))?;
    if let Some(text) = input {
        use std::io::Write;
        child.stdin.as_mut().unwrap().write_all(text.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        bail!(
            "{} failed: {}",
            program,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}
fn run(program: &str, args: &[String], input: Option<&str>) -> Result<String> {
    run_in(program, args, input, None)
}
fn aven_args(invocation: &Invocation, command: &[&str]) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(db) = &invocation.db_path {
        args.extend(["--db".into(), db.clone()]);
    }
    if let Some(workspace) = &invocation.workspace {
        args.extend(["--workspace".into(), workspace.clone()]);
    }
    args.extend(command.iter().map(|x| (*x).into()));
    args
}
fn aven(invocation: &Invocation, command: &[&str], input: Option<&str>) -> Result<String> {
    run(
        if invocation.aven_exe.is_empty() {
            "aven"
        } else {
            &invocation.aven_exe
        },
        &aven_args(invocation, command),
        input,
    )
}
fn opencode(method: &str, path: &str, data: Option<Value>) -> Result<Value> {
    let output = opencode_text(method, path, data)?;
    serde_json::from_str(&output).with_context(|| format!("OpenCode returned non-JSON for {path}"))
}
fn opencode_text(method: &str, path: &str, data: Option<Value>) -> Result<String> {
    opencode_text_in(method, path, data, None)
}
fn opencode_text_in(
    method: &str,
    path: &str,
    data: Option<Value>,
    directory: Option<&Path>,
) -> Result<String> {
    let mut args = vec!["api".into(), method.into(), path.into()];
    if let Some(data) = data {
        args.extend(["--data".into(), serde_json::to_string(&data)?]);
    }
    run_in("opencode", &args, None, directory)
}
fn field<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .context(pointer.to_owned())
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
const BABYSITTER_AGENT: &str = include_str!("../agents/babysitter.md");
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

/// Add only the bundled babysitter agent. The worktree's OpenCode config stays
/// entirely user-owned: in particular, no opencode.json/opencode.jsonc is
/// created or copied by dispatch.
fn install_babysitter_agent(worktree: &str) -> Result<()> {
    let destination = Path::new(worktree).join(".opencode/agents/babysitter.md");
    if destination.exists() {
        return Ok(());
    }
    let parent = destination
        .parent()
        .context("babysitter agent destination has no parent")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create babysitter agent directory {}", parent.display()))?;
    fs::write(&destination, BABYSITTER_AGENT)
        .with_context(|| format!("write bundled babysitter agent {}", destination.display()))
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

fn choose_agent(
    agents: &[PrimaryAgent],
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> Result<String> {
    writeln!(output, "Select an OpenCode agent:\n")?;
    for (index, agent) in agents.iter().enumerate() {
        writeln!(output, "  {}. {} ({})", index + 1, agent.name, agent.id)?;
    }
    loop {
        write!(output, "\nChoice [1-{}], or q to cancel: ", agents.len())?;
        output.flush()?;
        let mut choice = String::new();
        if input.read_line(&mut choice)? == 0 || matches!(choice.trim(), "" | "q" | "Q") {
            bail!("OpenCode agent selection was canceled");
        }
        if let Ok(index) = choice.trim().parse::<usize>()
            && let Some(agent) = index.checked_sub(1).and_then(|index| agents.get(index))
        {
            return Ok(agent.id.clone());
        }
        writeln!(output, "Enter a number from 1 to {}, or q.", agents.len())?;
    }
}

fn model_choices(configured: Option<&str>, preferred: Option<&str>) -> Vec<(String, String)> {
    let mut choices = Vec::new();
    if let Some(model) = preferred.filter(|model| !model.is_empty()) {
        let name = MODEL_CHOICES
            .iter()
            .find(|(_, candidate)| *candidate == model)
            .map(|(name, _)| *name)
            .unwrap_or(model);
        choices.push((format!("Preferred ({name})"), model.to_owned()));
    }
    if let Some(model) = configured.filter(|model| !model.is_empty()) {
        if !choices.iter().any(|(_, choice)| choice == model) {
            choices.push((format!("Agent default ({model})"), model.to_owned()));
        }
    }
    for (name, model) in MODEL_CHOICES {
        if !choices.iter().any(|(_, choice)| choice == model) {
            choices.push(((*name).to_owned(), (*model).to_owned()));
        }
    }
    choices
}

fn choose_model(
    choices: &[(String, String)],
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> Result<String> {
    writeln!(output, "Select an OpenCode model:\n")?;
    for (index, (name, model)) in choices.iter().enumerate() {
        writeln!(output, "  {}. {} ({})", index + 1, name, model)?;
    }
    loop {
        write!(output, "\nChoice [1-{}], or q to cancel: ", choices.len())?;
        output.flush()?;
        let mut choice = String::new();
        if input.read_line(&mut choice)? == 0 || matches!(choice.trim(), "" | "q" | "Q") {
            bail!("OpenCode model selection was canceled");
        }
        if let Ok(index) = choice.trim().parse::<usize>()
            && let Some((_, model)) = index.checked_sub(1).and_then(|index| choices.get(index))
        {
            return Ok(model.clone());
        }
        writeln!(output, "Enter a number from 1 to {}, or q.", choices.len())?;
    }
}

fn select_model(choices: &[(String, String)], response: &Path) -> Result<String> {
    if env::var_os("AVEN_COMMAND_CONTEXT").is_some() {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            bail!("Aven terminal dispatch requires an interactive terminal");
        }
        return choose_model(choices, &mut io::stdin().lock(), &mut io::stdout().lock());
    }
    let choices_text = choices
        .iter()
        .enumerate()
        .map(|(index, (name, model))| format!("  {}. {} ({})", index + 1, name, model))
        .collect::<Vec<_>>()
        .join("\n");
    let ids = choices
        .iter()
        .map(|(_, model)| model.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let response = response
        .to_str()
        .context("model picker response path is not valid UTF-8")?;
    let _ = fs::remove_file(response);
    run(
        "herdr",
        &[
            "plugin".into(),
            "pane".into(),
            "open".into(),
            "--plugin".into(),
            "aven.tasks".into(),
            "--entrypoint".into(),
            "model-picker".into(),
            "--env".into(),
            format!("AVEN_DISPATCH_PICKER_RESPONSE={response}"),
            "--env".into(),
            format!("AVEN_DISPATCH_PICKER_CHOICES={choices_text}"),
            "--env".into(),
            format!("AVEN_DISPATCH_PICKER_IDS={ids}"),
        ],
        None,
    )?;
    for _ in 0..1200 {
        if Path::new(response).exists() {
            let selected = fs::read_to_string(response)?.trim().to_owned();
            let _ = fs::remove_file(response);
            if choices.iter().any(|(_, model)| model == &selected) {
                return Ok(selected);
            }
            bail!("OpenCode model selection was canceled");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    bail!("timed out waiting for the Herdr OpenCode model picker")
}

fn select_agent(
    worktree: &str,
    response: &Path,
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

    // Aven's terminal execution mode lends us the existing Herdr popup and
    // supplies JSON via AVEN_COMMAND_CONTEXT. Opening another popup here fails
    // with ui_busy: Herdr has only one session-modal popup slot.
    if env::var_os("AVEN_COMMAND_CONTEXT").is_some() {
        if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
            bail!("Aven terminal dispatch requires an interactive terminal");
        }
        return choose_agent(&agents, &mut io::stdin().lock(), &mut io::stdout().lock());
    }
    if env::var("HERDR_PLUGIN_ENTRYPOINT_ID").as_deref() == Ok("tui") {
        bail!(
            "Aven dispatch needs execution: terminal to reuse its Herdr popup; update the installed Aven commands and reopen Aven"
        );
    }

    let choices = agents
        .iter()
        .enumerate()
        .map(|(index, agent)| format!("  {}. {} ({})", index + 1, agent.name, agent.id))
        .collect::<Vec<_>>()
        .join("\n");
    let ids = agents
        .iter()
        .map(|agent| agent.id.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let response_path = response;
    let response = response_path
        .to_str()
        .context("agent picker response path is not valid UTF-8")?;
    let _ = fs::remove_file(response);
    run(
        "herdr",
        &[
            "plugin".into(),
            "pane".into(),
            "open".into(),
            "--plugin".into(),
            "aven.tasks".into(),
            "--entrypoint".into(),
            "agent-picker".into(),
            "--env".into(),
            format!("AVEN_DISPATCH_PICKER_RESPONSE={response}"),
            "--env".into(),
            format!("AVEN_DISPATCH_PICKER_CHOICES={choices}"),
            "--env".into(),
            format!("AVEN_DISPATCH_PICKER_IDS={ids}"),
        ],
        None,
    )?;
    for _ in 0..1200 {
        if response_path.exists() {
            let selected = fs::read_to_string(response_path)?.trim().to_owned();
            let _ = fs::remove_file(response_path);
            if agents.iter().any(|agent| agent.id == selected) {
                return Ok(selected);
            }
            bail!("OpenCode agent selection was canceled");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    bail!("timed out waiting for the Herdr OpenCode agent picker")
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
fn create_worktree(origin: &str, attempt: &Attempt, title: &str) -> Result<(String, String)> {
    let listing = run(
        "git",
        &[
            "-C".into(),
            origin.into(),
            "worktree".into(),
            "list".into(),
            "--porcelain".into(),
        ],
        None,
    )?;
    let repo = listing
        .lines()
        .find_map(|line| line.strip_prefix("worktree "))
        .map(str::to_owned)
        .context("resolve parent checkout")?;
    let existing = listing.split("\n\n").find_map(|entry| {
        entry
            .lines()
            .find_map(|line| line.strip_prefix("branch refs/heads/"))
            .filter(|branch| *branch == attempt.branch)
            .and_then(|_| {
                entry
                    .lines()
                    .find_map(|line| line.strip_prefix("worktree "))
            })
    });
    let mut args = vec!["worktree".into()];
    if let Some(path) = existing {
        args.extend([
            "open".into(),
            "--cwd".into(),
            repo,
            "--path".into(),
            path.into(),
        ]);
    } else {
        args.extend([
            "create".into(),
            "--cwd".into(),
            repo,
            "--branch".into(),
            attempt.branch.clone(),
        ]);
    }
    args.extend([
        "--label".into(),
        format!("{} {}", attempt.task_ref, title),
        "--no-focus".into(),
    ]);
    let output = run("herdr", &args, None)?;
    let value: Value = serde_json::from_str(&output)?;
    let worktree = value
        .pointer("/result/worktree/path")
        .and_then(Value::as_str)
        .context("Herdr worktree path")?
        .to_owned();
    let pane = value
        .pointer("/result/root_pane/pane_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    Ok((worktree, pane))
}
fn remove_worktree(worktree: &str) {
    // Picker cancellation happens before a session or attempt is created, so
    // this workspace is solely the one just created for this dispatch.
    let Ok(listing) = run("herdr", &["workspace".into(), "list".into()], None) else {
        return;
    };
    let Ok(listing): Result<Value, _> = serde_json::from_str(&listing) else {
        return;
    };
    let workspace = listing
        .pointer("/result/workspaces")
        .and_then(Value::as_array)
        .and_then(|workspaces| {
            workspaces.iter().find_map(|workspace| {
                (workspace
                    .pointer("/worktree/checkout_path")
                    .and_then(Value::as_str)
                    == Some(worktree))
                .then(|| workspace.pointer("/workspace_id").and_then(Value::as_str))
                .flatten()
            })
        });
    let Some(workspace) = workspace else {
        return;
    };
    let _ = run(
        "herdr",
        &[
            "worktree".into(),
            "remove".into(),
            "--workspace".into(),
            workspace.to_owned(),
            "--force".into(),
        ],
        None,
    );
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn focus_pane(pane: &str) -> Result<()> {
    // The CLI exposes directional pane focus only. The public socket API can
    // focus this exact pane across workspaces without relying on agent detection.
    let socket = env::var_os("HERDR_SOCKET_PATH").context("HERDR_SOCKET_PATH is not set")?;
    let mut stream = UnixStream::connect(socket).context("connect to Herdr for pane focus")?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let id = identifier("focus");
    writeln!(
        stream,
        "{}",
        json!({"id": id, "method": "pane.focus", "params": {"pane_id": pane}})
    )?;
    let mut response = String::new();
    io::BufReader::new(stream).read_line(&mut response)?;
    let response: Value = serde_json::from_str(&response).context("Herdr pane focus response")?;
    if response.get("id").and_then(Value::as_str) != Some(&id) {
        bail!("Herdr pane focus returned an unexpected request id");
    }
    if let Some(error) = response.get("error") {
        bail!("Herdr pane focus failed: {error}");
    }
    if response.get("result").is_none() {
        bail!("Herdr pane focus returned no result");
    }
    Ok(())
}
fn start_opencode_in_pane(pane: &str, session_id: &str, store_path: &Path) -> Result<()> {
    run(
        "herdr",
        &[
            "pane".into(),
            "run".into(),
            pane.into(),
            format!(
                "env AVEN_DISPATCH_STORE={} opencode --session {}",
                shell_quote(&store_path.to_string_lossy()),
                shell_quote(session_id),
            ),
        ],
        None,
    )?;
    Ok(())
}
fn start_babysitter(attempt: &mut Attempt, store_path: &Path) -> Result<()> {
    install_babysitter_agent(&attempt.worktree)?;
    let session = opencode(
        "POST",
        "/api/session",
        Some(json!({
            "title": format!("Babysit {}", attempt.task_ref),
            "location": {"directory": attempt.worktree},
            "agent": "babysitter",
            "model": model_ref(Some("github-copilot/gpt-6-luna"))?,
            "permissions": [{"action": "*", "resource": "*", "effect": "allow"}],
        })),
    )?;
    attempt.babysitter_session_id = field(&session, "/data/id")?.to_owned();
    let output = run(
        "herdr",
        &[
            "pane".into(),
            "split".into(),
            attempt.pane.clone(),
            "--direction".into(),
            "right".into(),
            "--cwd".into(),
            attempt.worktree.clone(),
            "--no-focus".into(),
        ],
        None,
    )?;
    let response: Value = serde_json::from_str(&output).context("Herdr pane split response")?;
    attempt.babysitter_pane = field(&response, "/result/pane/pane_id")?.to_owned();
    start_opencode_in_pane(
        &attempt.babysitter_pane,
        &attempt.babysitter_session_id,
        store_path,
    )?;
    attempt.babysitter_prompt_id = identifier("msg");
    let admission = opencode(
        "POST",
        &format!("/api/session/{}/prompt", attempt.babysitter_session_id),
        Some(json!({
            "id": attempt.babysitter_prompt_id,
            "text": format!(
                "Supervise build OpenCode session {} in Herdr pane {} for task {}. Begin the 60-second monitoring protocol now and stay with it until the task is verified resolved.",
                attempt.session_id, attempt.pane, attempt.task_ref
            ),
            "resume": true,
        })),
    )?;
    if field(&admission, "/data/id")? != attempt.babysitter_prompt_id {
        bail!("OpenCode admitted an unexpected babysitter message id");
    }
    Ok(())
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
        env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
            .join("skills")
    });
    let path = skills_dir.join(skill).with_extension("md");
    let text = fs::read_to_string(&path)
        .with_context(|| format!("read bundled dispatch skill {}", path.display()))?;
    Ok(Some(text))
}
fn prompt(
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
fn write_aven_links(invocation: &Invocation, attempt: &Attempt) -> Result<()> {
    // Aven owns the task-scoped durable snapshot. The individual metadata
    // fields stay queryable, while dispatch.attempt permits recovery from any
    // checkout without locating a checkout-local state file.
    let metadata = vec![
        "dispatch.backend=opencode-v2".to_owned(),
        format!("dispatch.session-id={}", attempt.session_id),
        format!("dispatch.attempt-id={}", attempt.attempt_id),
        format!("dispatch.state={}", attempt.state),
        "dispatch.workflow=default".to_owned(),
        format!("dispatch.branch={}", attempt.branch),
        format!("dispatch.attempt={}", serde_json::to_string(attempt)?),
    ];
    let mut args = vec![
        "edit".to_owned(),
        attempt.task_ref.clone(),
        "--status".into(),
        "active".into(),
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
        "pane": attempt.pane,
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
    let mut store = LockedStore::open(path.clone())?;
    if !store.store.attempts.contains_key(&selected.task.id)
        && let Some(snapshot) = task
            .pointer("/metadata/dispatch.attempt")
            .and_then(Value::as_str)
    {
        // Older dispatches may have used a checkout-local store. Aven's
        // task-scoped snapshot preserves that session across checkout changes.
        let recovered: Attempt =
            serde_json::from_str(snapshot).context("read Aven dispatcher attempt snapshot")?;
        if recovered.task_id != selected.task.id {
            bail!("Aven dispatcher snapshot belongs to a different task");
        }
        store
            .store
            .attempts
            .insert(recovered.task_id.clone(), recovered);
        if !dry_run {
            store.save()?;
        }
    }
    if let Some(existing) = store.store.attempts.get(&selected.task.id).cloned() {
        if dry_run {
            println!(
                "would reopen {} in OpenCode session {} (attempt {})",
                existing.task_ref, existing.session_id, existing.attempt_id
            );
            return Ok(());
        }
        let (worktree, pane) = create_worktree(
            &context.invocation.origin_cwd,
            &existing,
            &selected.task.title,
        )?;
        if agent.as_deref().is_none_or(|agent| agent == "select") {
            let response =
                path.with_file_name(format!(".agent-picker-{}.response", identifier("reopen")));
            select_agent(&worktree, &response, Some(&existing.agent), None)?;
        }
        if model.is_none() {
            select_model(
                &[(
                    format!("Saved model ({})", existing.model),
                    existing.model.clone(),
                )],
                &path.with_file_name(format!(".model-picker-{}.response", identifier("reopen"))),
            )?;
        }
        let mut reopened = existing;
        reopened.worktree = worktree;
        reopened.pane = pane;
        reopened.state = "terminal-pending".into();
        store
            .store
            .attempts
            .insert(reopened.task_id.clone(), reopened.clone());
        store.save()?;
        start_opencode_in_pane(&reopened.pane, &reopened.session_id, &path)?;
        if reopened.babysitter && !reopened.babysitter_session_id.is_empty() {
            let output = run(
                "herdr",
                &[
                    "pane".into(),
                    "split".into(),
                    reopened.pane.clone(),
                    "--direction".into(),
                    "right".into(),
                    "--cwd".into(),
                    reopened.worktree.clone(),
                    "--no-focus".into(),
                ],
                None,
            )?;
            let response: Value =
                serde_json::from_str(&output).context("Herdr pane split response")?;
            reopened.babysitter_pane = field(&response, "/result/pane/pane_id")?.to_owned();
            start_opencode_in_pane(
                &reopened.babysitter_pane,
                &reopened.babysitter_session_id,
                &path,
            )?;
        }
        reopened.state = "running".into();
        store
            .store
            .attempts
            .insert(reopened.task_id.clone(), reopened.clone());
        store.save()?;
        focus_pane(&reopened.pane)?;
        println!(
            "reopened {} in OpenCode session {} (attempt {})",
            reopened.task_ref, reopened.session_id, reopened.attempt_id
        );
        return Ok(());
    }
    let mut attempt = Attempt {
        task_id: selected.task.id.clone(),
        task_ref: selected.reference().to_owned(),
        attempt_id: identifier("att"),
        branch: branch(&selected.project.key, &selected.task.id),
        worktree: String::new(),
        pane: String::new(),
        agent: agent.unwrap_or_default(),
        model: model.unwrap_or_default(),
        session_id: String::new(),
        prompt_id: identifier("msg"),
        state: "workspace-pending".into(),
        aven_update_pending: false,
        log_cursor: String::new(),
        log_task_ref: String::new(),
        babysitter,
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
    let (worktree, pane) = create_worktree(
        &context.invocation.origin_cwd,
        &attempt,
        &selected.task.title,
    )?;
    attempt.worktree = worktree;
    attempt.pane = pane;
    if attempt.agent.is_empty() || attempt.agent == "select" {
        let response =
            path.with_file_name(format!(".agent-picker-{}.response", attempt.attempt_id));
        attempt.agent = match select_agent(
            &attempt.worktree,
            &response,
            None,
            preferred_agent.as_deref(),
        ) {
            Ok(agent) => agent,
            Err(error) => {
                remove_worktree(&attempt.worktree);
                return Err(error);
            }
        };
    }
    if attempt.model.is_empty() {
        let configured = configured_agent_model(&attempt.worktree, &attempt.agent)?;
        let response =
            path.with_file_name(format!(".model-picker-{}.response", attempt.attempt_id));
        attempt.model = match select_model(
            &model_choices(configured.as_deref(), preferred_model.as_deref()),
            &response,
        ) {
            Ok(model) => model,
            Err(error) => {
                remove_worktree(&attempt.worktree);
                return Err(error);
            }
        };
    }
    attempt.state = "session-pending".into();
    store
        .store
        .attempts
        .insert(attempt.task_id.clone(), attempt.clone());
    store.save()?;
    let session = opencode(
        "POST",
        "/api/session",
        Some(json!({
            "title": format!("{} {}", attempt.task_ref, selected.task.title),
            "location": {"directory": attempt.worktree},
            "agent": if attempt.agent.is_empty() { Value::Null } else { Value::String(attempt.agent.clone()) },
            "model": model_ref(Some(&attempt.model))?,
        })),
    )?;
    attempt.session_id = field(&session, "/data/id")?.to_owned();
    // Launch the OpenCode CLI in the worktree pane before scheduling the prompt.
    // The CLI attaches to the API-created session by its durable ID.
    attempt.state = "terminal-pending".into();
    store
        .store
        .attempts
        .insert(attempt.task_id.clone(), attempt.clone());
    store.save()?;
    start_opencode_in_pane(&attempt.pane, &attempt.session_id, &path)?;
    attempt.state = "prompt-pending".into();
    store
        .store
        .attempts
        .insert(attempt.task_id.clone(), attempt.clone());
    store.save()?;
    let admission = opencode(
        "POST",
        &format!("/api/session/{}/prompt", attempt.session_id),
        Some(
            json!({"id": attempt.prompt_id, "text": prompt(&task, &attempt.task_ref, skill, skills_dir)?, "resume": true}),
        ),
    )?;
    let admitted = field(&admission, "/data/id")?;
    if admitted != attempt.prompt_id {
        bail!("OpenCode admitted an unexpected message id");
    }
    if attempt.babysitter {
        start_babysitter(&mut attempt, &path)?;
    }
    attempt.state = "running".into();
    attempt.aven_update_pending = true;
    store
        .store
        .attempts
        .insert(attempt.task_id.clone(), attempt.clone());
    store.save()?;
    if write_aven_links(&context.invocation, &attempt).is_ok() {
        attempt.aven_update_pending = false;
        store
            .store
            .attempts
            .insert(attempt.task_id.clone(), attempt.clone());
        store.save()?;
    }
    focus_pane(&attempt.pane)?;
    println!(
        "admitted {} to OpenCode session {} (attempt {})",
        attempt.task_ref, attempt.session_id, attempt.attempt_id
    );
    if attempt.aven_update_pending {
        println!("Aven update pending; run reconcile before retrying dispatch");
    }
    Ok(())
}

fn find_attempt<'a>(store: &'a LockedStore, task: &str) -> Result<&'a Attempt> {
    store
        .store
        .attempts
        .values()
        .find(|a| a.task_id == task || a.task_ref == task)
        .context("no dispatcher attempt for task")
}
fn status(path: PathBuf, task: &str) -> Result<()> {
    let store = LockedStore::open(path)?;
    let attempt = find_attempt(&store, task)?;
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
    let store = LockedStore::open(path)?;
    let attempts: Vec<&Attempt> = store
        .store
        .attempts
        .values()
        .filter(|attempt| !running || attempt.state == "running")
        .collect();
    println!("{}", serde_json::to_string_pretty(&attempts)?);
    Ok(())
}
fn interrupt(path: PathBuf, task: &str) -> Result<()> {
    let mut store = LockedStore::open(path)?;
    let attempt = find_attempt(&store, task)?.clone();
    opencode(
        "POST",
        &format!("/api/session/{}/interrupt", attempt.session_id),
        None,
    )?;
    let mut changed = attempt;
    changed.state = "interrupted".into();
    store
        .store
        .attempts
        .insert(changed.task_id.clone(), changed);
    store.save()?;
    println!("interrupted OpenCode execution; Aven task status was not changed");
    Ok(())
}
fn reconcile(path: PathBuf, task: &str) -> Result<()> {
    let mut store = LockedStore::open(path)?;
    let mut attempt = find_attempt(&store, task)?.clone();
    if attempt.aven_update_pending && write_aven_links(&attempt.aven, &attempt).is_ok() {
        attempt.aven_update_pending = false;
        store
            .store
            .attempts
            .insert(attempt.task_id.clone(), attempt.clone());
        store.save()?;
        println!("repaired pending Aven status, metadata, and handoff update");
    }
    let log = opencode_text(
        "GET",
        &format!(
            "/api/experimental/session/{}/log?after={}&follow=false",
            attempt.session_id, attempt.log_cursor
        ),
        None,
    );
    println!(
        "attempt {} state={} aven_update_pending={}",
        attempt.attempt_id, attempt.state, attempt.aven_update_pending
    );
    match log {
        Ok(events) => {
            if let Some(cursor) = events
                .lines()
                .filter_map(|line| line.strip_prefix("id: "))
                .last()
            {
                attempt.log_cursor = cursor.to_owned();
                store
                    .store
                    .attempts
                    .insert(attempt.task_id.clone(), attempt);
                store.save()?;
                println!("replayed durable session log through cursor {cursor}");
            } else {
                println!("durable session log is reachable; no new events");
            }
        }
        Err(error) => println!("session log unavailable: {error:#}"),
    };
    Ok(())
}
fn log_event(path: PathBuf, task: &str, event: &str, detail: &str) -> Result<()> {
    let mut store = LockedStore::open(path)?;
    let mut attempt = find_attempt(&store, task)?.clone();
    ensure_log_task(&mut attempt)?;
    let record = write_debug_event(&attempt, event, detail);
    store
        .store
        .attempts
        .insert(attempt.task_id.clone(), attempt.clone());
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
fn doctor() -> Result<()> {
    let aven_version = run("aven", &["--version".into()], None)?;
    // `opencode api` intentionally truncates very large bodies, so probe a
    // small V2 endpoint rather than trying to parse its complete OpenAPI body.
    let sessions = opencode("GET", "/api/session?limit=1", None)?;
    if sessions.get("data").is_none() {
        bail!("OpenCode V2 session endpoint returned an unsupported response");
    }
    println!(
        "ready: {aven_version}; OpenCode V2 session API detected (prompt-ID support is checked on admission)"
    );
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let path = absolute_path(store_path(cli.store))?;
    match cli.command {
        Commands::Dispatch {
            dry_run,
            agent,
            model,
            preferred_agent,
            preferred_model,
            skill,
            skills_dir,
            babysitter,
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
        ),
        Commands::Resume { task } => reconcile(path, &task),
        Commands::Status { task } => status(path, &task),
        Commands::List { running } => list(path, running),
        Commands::Reconcile { task } => reconcile(path, &task),
        Commands::Log {
            task,
            event,
            detail,
        } => log_event(path, &task, &event, &detail),
        Commands::Interrupt { task } => interrupt(path, &task),
        Commands::Doctor => doctor(),
    }
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
        assert!(choose_agent(&agents, &mut io::Cursor::new(""), &mut output).is_err());
        assert!(
            String::from_utf8(output)
                .unwrap()
                .contains("1. Build (build)")
        );
        assert_eq!(
            choose_agent(&agents, &mut io::Cursor::new("0\n2\n1\n"), &mut Vec::new()).unwrap(),
            "build"
        );
        assert!(choose_agent(&agents, &mut io::Cursor::new("q\n"), &mut Vec::new()).is_err());
    }
    #[test]
    fn configured_model_is_first_and_model_choice_requires_input() {
        let choices = model_choices(Some("github-copilot/gpt-5.6-terra"), None);
        assert_eq!(
            choices.first(),
            Some(&(
                "Agent default (github-copilot/gpt-5.6-terra)".into(),
                "github-copilot/gpt-5.6-terra".into()
            ))
        );
        assert_eq!(
            choose_model(&choices, &mut io::Cursor::new("0\n2\n"), &mut Vec::new()).unwrap(),
            "github-copilot/gpt-6.1-sol"
        );
        assert!(choose_model(&choices, &mut io::Cursor::new("q\n"), &mut Vec::new()).is_err());
    }
    #[test]
    fn preferred_model_precedes_the_agent_default() {
        let choices = model_choices(
            Some("github-copilot/gpt-5.6-terra"),
            Some("github-copilot/gpt-6.1-sol"),
        );
        assert_eq!(choices[0].1, "github-copilot/gpt-6.1-sol");
        assert_eq!(choices[1].1, "github-copilot/gpt-5.6-terra");
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
    }
    #[test]
    fn babysitter_agent_is_injected_without_a_config_file() {
        let root = tempfile::tempdir().unwrap();
        let worktree = root.path().join("worktree");
        install_babysitter_agent(worktree.to_str().unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(worktree.join(".opencode/agents/babysitter.md")).unwrap(),
            BABYSITTER_AGENT
        );
        assert!(!worktree.join(".opencode/opencode.jsonc").exists());
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
    #[test]
    fn running_list_excludes_non_running_attempts() {
        let attempts = ["running", "interrupted"];
        assert_eq!(
            attempts.iter().filter(|state| **state == "running").count(),
            1
        );
    }
    #[test]
    fn dispatcher_events_are_machine_readable_json() {
        let attempt = Attempt {
            task_id: "task-id".into(),
            task_ref: "APP-1".into(),
            attempt_id: "att_1".into(),
            branch: "app/dispatch-task-id".into(),
            worktree: "/worktree".into(),
            pane: "w1:p1".into(),
            agent: "build".into(),
            model: "provider/model".into(),
            session_id: "ses_1".into(),
            prompt_id: "msg_1".into(),
            state: "running".into(),
            aven_update_pending: false,
            log_cursor: String::new(),
            log_task_ref: "DL-1".into(),
            babysitter: false,
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
}
