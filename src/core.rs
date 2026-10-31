//! The herdr-core (`hc`) contract.
//!
//! `hc` owns terminals, not acceptance. Everything here observes or starts
//! terminals; OpenCode's API and Aven's durable state remain authoritative for
//! prompt admission and task acceptance.

use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::{
    env,
    io::{BufRead, BufReader, Read},
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::model::{TerminalObservation, TerminalRef};

const HC_TIMEOUT: Duration = Duration::from_secs(60);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn binary() -> String {
    env::var("HC_BIN").unwrap_or_else(|_| "hc".into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CoreIdentity {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) machine: String,
}
/// Resolve the durable core identity. A terminal address is only meaningful
/// together with this identity, so every launch and observation records it.
pub(crate) fn identity() -> Result<CoreIdentity> {
    let value = run_json(&["server".into(), "status".into(), "--json".into()])?;
    let id = value
        .pointer("/core/id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .context("hc server status did not report a durable core id")?
        .to_owned();
    Ok(CoreIdentity {
        id,
        name: value
            .pointer("/core/name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        version: value
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        machine: env::var("HOSTNAME").unwrap_or_else(|_| "local".into()),
    })
}

fn command(args: &[String]) -> Command {
    let mut command = Command::new(binary());
    command.args(args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn text_result(program: &str, args: &[String], output: std::process::Output) -> Result<String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{program} {} failed ({}): {}",
            args.iter().take(3).cloned().collect::<Vec<_>>().join(" "),
            output.status,
            stderr.trim()
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim_end().to_owned())
}

fn with_timeout(
    mut command: Command,
    timeout: Duration,
    describe: &str,
) -> Result<std::process::Output> {
    // hc enforces its own timeouts. This outer guard only protects the
    // dispatcher from an `exec` that hangs before hc can answer.
    let mut child = command
        .spawn()
        .with_context(|| format!("start herdr-core for {describe}"))?;
    let started = SystemTime::now();
    loop {
        if child.try_wait()?.is_some() {
            return child
                .wait_with_output()
                .context("collect herdr-core output");
        }
        if started.elapsed().unwrap_or_default() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("herdr-core timed out while running {describe}; inspect before retrying");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub(crate) fn run_text(args: &[String]) -> Result<String> {
    let output = with_timeout(command(args), HC_TIMEOUT, &args.join(" "))?;
    text_result(&binary(), args, output)
}

pub(crate) fn run_json(args: &[String]) -> Result<Value> {
    let text = run_text(args)?;
    serde_json::from_str(&text)
        .with_context(|| format!("herdr-core returned non-JSON for {}", args.join(" ")))
}

/// Run Git through core and report its exact output and success. Nonzero is a
/// result here: callers inspect the exit code before deciding.
pub(crate) fn git_status(cwd: &str, git_args: &[String]) -> Result<(bool, String, String)> {
    let mut args = vec!["exec".into(), "--cwd".into(), cwd.into(), "git".into()];
    args.extend(git_args.iter().cloned());
    let output = with_timeout(command(&args), HC_TIMEOUT, &args.join(" "))?;
    let stdout = String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr)
        .trim_end()
        .to_owned();
    Ok((output.status.success(), stdout, stderr))
}

pub(crate) fn git(cwd: &str, git_args: &[String]) -> Result<String> {
    let (success, stdout, stderr) = git_status(cwd, git_args)?;
    if !success {
        bail!(
            "git {} failed in {cwd}: {}",
            git_args.join(" "),
            if stderr.is_empty() { &stdout } else { &stderr }
        );
    }
    Ok(stdout)
}

#[derive(Debug, Clone)]
pub(crate) struct LaunchSpec {
    pub(crate) name: String,
    pub(crate) cwd: String,
    pub(crate) labels: Vec<(String, String)>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) argv: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct Terminal {
    pub(crate) address: String,
    pub(crate) name: String,
    pub(crate) state: String,
    pub(crate) status: String,
    pub(crate) status_kind: String,
    pub(crate) program: String,
    pub(crate) reason: String,
    pub(crate) turn: u64,
    pub(crate) labels: Vec<(String, String)>,
    pub(crate) reported: bool,
}
impl Terminal {
    pub(crate) fn live(&self) -> bool {
        self.state == "live"
    }
    pub(crate) fn recovered_shell(&self) -> bool {
        matches!(
            self.program.as_str(),
            "sh" | "bash" | "zsh" | "fish" | "dash" | "ksh" | "pwsh" | "powershell"
        )
    }
    pub(crate) fn observe(
        &self,
        core: &CoreIdentity,
        seq: u64,
        recovery: &str,
    ) -> TerminalObservation {
        TerminalObservation {
            core_id: core.id.clone(),
            address: self.address.clone(),
            state: self.state.clone(),
            status: self.status.clone(),
            status_kind: self.status_kind.clone(),
            program: self.program.clone(),
            reason: self.reason.clone(),
            turn: self.turn,
            seq,
            updated_at: now_ms(),
            recovery: recovery.into(),
        }
    }
}

pub(crate) fn terminal_ref(
    core: &CoreIdentity,
    terminal: &Terminal,
    role: &str,
    created: bool,
) -> TerminalRef {
    TerminalRef {
        core_id: core.id.clone(),
        core_name: core.name.clone(),
        address: terminal.address.clone(),
        name: terminal.name.clone(),
        role: role.into(),
        created_by_attempt: created,
    }
}

fn parse_terminal(value: &Value) -> Result<Terminal> {
    let address = value
        .get("address")
        .and_then(Value::as_str)
        .context("hc terminal is missing its address")?
        .to_owned();
    let labels = value
        .get("labels")
        .and_then(Value::as_object)
        .map(|labels| {
            labels
                .iter()
                .map(|(key, value)| (key.clone(), value.as_str().unwrap_or_default().to_owned()))
                .collect()
        })
        .unwrap_or_default();
    let foreground = value.get("foreground");
    let program = foreground
        .and_then(|foreground| foreground.get("name"))
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("argv")
                .and_then(Value::as_array)
                .and_then(|argv| argv.first())
                .and_then(Value::as_str)
        })
        .unwrap_or_default()
        .to_owned();
    Ok(Terminal {
        address,
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        state: value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned(),
        status: value
            .pointer("/status/state")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        status_kind: value
            .pointer("/status/kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        program,
        reason: value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        turn: value
            .get("turn")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        labels,
        reported: value
            .get("reported")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// Start a program in a dedicated terminal owned by this attempt.
pub(crate) fn launch(spec: &LaunchSpec) -> Result<Terminal> {
    if spec.name.is_empty() {
        bail!("a herdr-core terminal needs an explicit name");
    }
    let mut args = vec![
        "run".into(),
        "--bg".into(),
        "--json".into(),
        "--no-parent".into(),
        "--no-notify".into(),
        "--outlive-parent".into(),
        "--name".into(),
        spec.name.clone(),
        "--cwd".into(),
        spec.cwd.clone(),
    ];
    for (key, value) in &spec.labels {
        args.extend(["--label".into(), format!("{key}={value}")]);
    }
    args.push("--".into());
    args.push("env".into());
    for (key, value) in &spec.env {
        args.push(format!("{key}={value}"));
    }
    args.extend(spec.argv.iter().cloned());
    let value = run_json(&args)
        .with_context(|| format!("start herdr-core terminal {} in {}", spec.name, spec.cwd))?;
    parse_terminal(&value)
}

/// First terminal facts snapshot matching every label. This is how recovery
/// proves ownership instead of trusting a persisted address alone.
pub(crate) fn snapshot(labels: &[(String, String)]) -> Result<Vec<Terminal>> {
    let mut args = vec!["events".into(), "--json".into()];
    for (key, value) in labels {
        args.extend(["--label".into(), format!("{key}={value}")]);
    }
    let mut child = Command::new(binary())
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("start {} for a terminal snapshot", binary()))?;
    let started = SystemTime::now();
    let mut reader = BufReader::new(child.stdout.take().context("hc events stdout")?);
    let mut line = String::new();
    let result = loop {
        if started.elapsed().unwrap_or_default() > SNAPSHOT_TIMEOUT {
            break Err(anyhow::anyhow!(
                "herdr-core did not deliver an events snapshot within {} seconds",
                SNAPSHOT_TIMEOUT.as_secs()
            ));
        }
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break Err(anyhow::anyhow!(
                "herdr-core events ended before delivering a snapshot"
            ));
        }
        if let Ok(Some(EventLine::Snapshot { terminals, .. })) = parse_event_line(&line) {
            break Ok(terminals);
        }
    };
    let _ = child.kill();
    let mut stderr = String::new();
    if let Some(mut stream) = child.stderr.take() {
        let _ = stream.read_to_string(&mut stderr);
    }
    let _ = child.wait();
    let values = result?;
    values.iter().map(parse_terminal).collect()
}

/// Find one owned live terminal for a role. A recovered shell is not agent
/// execution, and an ambiguous match is never adopted silently.
pub(crate) fn find_owned(
    labels: &[(String, String)],
    expected_name: &str,
) -> Result<Option<Terminal>> {
    let terminals = snapshot(labels)?;
    let live = terminals
        .into_iter()
        .filter(|terminal| terminal.live())
        .collect::<Vec<_>>();
    match live.as_slice() {
        [] => Ok(None),
        [terminal] => Ok(Some(terminal.clone())),
        _ => bail!(
            "multiple live herdr-core terminals match {}; refusing to adopt an ambiguous match",
            expected_name
        ),
    }
}

pub(crate) fn get(address: &str) -> Result<Terminal> {
    let value = run_json(&["get".into(), address.into(), "--json".into()])?;
    parse_terminal(&value)
}

pub(crate) fn label(address: &str, labels: &[(String, String)]) -> Result<Terminal> {
    let mut args = vec!["label".into(), address.into(), "--json".into()];
    for (key, value) in labels {
        args.push(format!("{key}={value}"));
    }
    parse_terminal(&run_json(&args)?)
}

pub(crate) fn kill(address: &str) -> Result<Terminal> {
    parse_terminal(&run_json(&[
        "kill".into(),
        address.into(),
        "--json".into(),
    ])?)
}

pub(crate) fn remove(address: &str) -> Result<()> {
    run_text(&["rm".into(), address.into(), "--json".into()])?;
    Ok(())
}

/// Guarded supervisor interaction. Never used for prompt admission.
pub(crate) fn send_if_idle(address: &str, text: &str, wait: bool) -> Result<Value> {
    let mut args = vec![
        "send".into(),
        "--if".into(),
        "idle".into(),
        "--json".into(),
        address.into(),
        text.into(),
    ];
    if wait {
        args.push("--wait".into());
    }
    run_json(&args)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EventLine {
    Snapshot {
        seq: u64,
        terminals: Vec<Value>,
    },
    Notification {
        seq: u64,
        terminal: String,
        kind: String,
        data: Value,
    },
    Heartbeat,
    Missed {
        seq: u64,
        terminals: Vec<Value>,
    },
}

/// Parse one line of `hc events --json`. The first line is always a snapshot;
/// later lines are JSON-RPC notifications (`event`, `heartbeat`, `missed`).
pub(crate) fn parse_event_line(line: &str) -> Result<Option<EventLine>> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(line).context("herdr-core event line")?;
    if let Some(method) = value.get("method").and_then(Value::as_str) {
        if method != "event" {
            if method == "heartbeat" {
                return Ok(Some(EventLine::Heartbeat));
            }
            if method == "missed" {
                let params = value.get("params").cloned().unwrap_or(Value::Null);
                return Ok(Some(EventLine::Missed {
                    seq: params
                        .get("seq")
                        .and_then(Value::as_u64)
                        .unwrap_or_default(),
                    terminals: params
                        .get("terminals")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                }));
            }
            return Ok(None);
        }
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        let kind = params
            .get("type")
            .and_then(Value::as_str)
            .context("herdr-core event is missing its type")?;
        if kind == "heartbeat" {
            return Ok(Some(EventLine::Heartbeat));
        }
        if kind == "missed" {
            let data = params.get("data").cloned().unwrap_or(Value::Null);
            return Ok(Some(EventLine::Missed {
                seq: params
                    .get("seq")
                    .and_then(Value::as_u64)
                    .unwrap_or_default(),
                terminals: data
                    .get("terminals")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            }));
        }
        return Ok(Some(EventLine::Notification {
            seq: params
                .get("seq")
                .and_then(Value::as_u64)
                .unwrap_or_default(),
            terminal: params
                .get("terminal")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            kind: kind.to_owned(),
            data: params.get("data").cloned().unwrap_or(Value::Null),
        }));
    }
    if let Some(terminals) = value.get("terminals").and_then(Value::as_array) {
        return Ok(Some(EventLine::Snapshot {
            seq: value.get("seq").and_then(Value::as_u64).unwrap_or_default(),
            terminals: terminals.clone(),
        }));
    }
    Ok(None)
}

/// A stream of core facts for the long-running watcher.
pub(crate) struct EventStream {
    child: std::process::Child,
    reader: BufReader<std::process::ChildStdout>,
}
impl EventStream {
    pub(crate) fn subscribe(labels: &[(String, String)]) -> Result<Self> {
        let mut args = vec!["events".into(), "--json".into()];
        for (key, value) in labels {
            args.extend(["--label".into(), format!("{key}={value}")]);
        }
        let mut child = Command::new(binary())
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("subscribe to herdr-core events with {}", binary()))?;
        let reader = BufReader::new(child.stdout.take().context("hc events stdout")?);
        Ok(Self { child, reader })
    }
    pub(crate) fn next(&mut self) -> Result<Option<EventLine>> {
        let mut line = String::new();
        if self.reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        parse_event_line(&line)
    }
}
impl Drop for EventStream {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
