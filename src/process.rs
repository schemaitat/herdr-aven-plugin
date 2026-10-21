//! External command execution and local dispatcher state-path utilities.

use anyhow::{Context, Result, bail};
use fs2::FileExt;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::model::{Attempt, Invocation, Store, attempt_key};
use serde_json::Value;

pub(crate) fn store_attempt(store: &mut LockedStore, attempt: Attempt) {
    store
        .store
        .attempts
        .insert(attempt_key(&attempt.task_id, &attempt.workflow), attempt);
}
pub(crate) struct LockedStore {
    pub(crate) path: PathBuf,
    // Keep the advisory lock alive for the lifetime of the store. Unlike the
    // previous create_new lock-file sentinel, the operating system releases
    // this lock when a dispatcher is killed, so a crashed terminal command
    // cannot permanently block future Aven dispatches.
    lock_file: fs::File,
    pub(crate) store: Store,
}
impl LockedStore {
    pub(crate) fn open(path: PathBuf) -> Result<Self> {
        let parent = path.parent().context("store path has no parent")?;
        fs::create_dir_all(parent).context("create dispatcher state directory")?;
        let lock = path.with_extension("lock");
        let lock_file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(&lock)
            .with_context(|| format!("open dispatcher store lock {}", lock.display()))?;
        lock_file.try_lock_exclusive().with_context(|| {
            format!(
                "dispatcher store is locked by another running dispatcher: {}; use status/reconcile instead of concurrent dispatch",
                lock.display()
            )
        })?;
        let store = if path.exists() {
            serde_json::from_slice(&fs::read(&path)?)?
        } else {
            Store::default()
        };
        Ok(Self {
            path,
            lock_file,
            store,
        })
    }
    pub(crate) fn save(&self) -> Result<()> {
        let temporary = self.path.with_extension("new");
        fs::write(&temporary, serde_json::to_vec_pretty(&self.store)?)?;
        fs::rename(temporary, &self.path)?;
        Ok(())
    }
}
impl Drop for LockedStore {
    fn drop(&mut self) {
        let _ = self.lock_file.unlock();
    }
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn identifier(prefix: &str) -> String {
    format!("{prefix}_{:x}", now())
}
pub(crate) fn store_path(value: Option<PathBuf>) -> PathBuf {
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
pub(crate) fn absolute_path(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

/// Resolve a caller-provided directory to the root of its current Git
/// worktree. Dispatcher commands can be invoked from any subdirectory, while
/// Herdr workspace creation needs a stable checkout path.
pub(crate) fn repository_root(directory: &str) -> Result<String> {
    let root = run(
        "git",
        &[
            "-C".into(),
            directory.into(),
            "rev-parse".into(),
            "--show-toplevel".into(),
        ],
        None,
    )?;
    if root.is_empty() {
        bail!("Git did not return a repository root for {directory}");
    }
    Ok(root)
}

pub(crate) fn run_in(
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
pub(crate) fn run(program: &str, args: &[String], input: Option<&str>) -> Result<String> {
    run_in(program, args, input, None)
}
pub(crate) fn aven_args(invocation: &Invocation, command: &[&str]) -> Vec<String> {
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
pub(crate) fn aven(
    invocation: &Invocation,
    command: &[&str],
    input: Option<&str>,
) -> Result<String> {
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
pub(crate) fn opencode(method: &str, path: &str, data: Option<Value>) -> Result<Value> {
    let output = opencode_text(method, path, data)?;
    serde_json::from_str(&output).with_context(|| format!("OpenCode returned non-JSON for {path}"))
}
/// Issue an OpenCode request in a worktree's configuration scope. Session
/// creation resolves an agent before it reads the session `location`, so the
/// request itself must carry this scope for worktree-local agents.
pub(crate) fn opencode_in(
    method: &str,
    path: &str,
    data: Option<Value>,
    directory: &Path,
) -> Result<Value> {
    let output = opencode_text_in(method, path, data, Some(directory))?;
    serde_json::from_str(&output).with_context(|| format!("OpenCode returned non-JSON for {path}"))
}
pub(crate) fn opencode_text(method: &str, path: &str, data: Option<Value>) -> Result<String> {
    opencode_text_in(method, path, data, None)
}
pub(crate) fn header_value(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                vec![byte as char]
            }
            byte => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}
pub(crate) fn opencode_text_in(
    method: &str,
    path: &str,
    data: Option<Value>,
    directory: Option<&Path>,
) -> Result<String> {
    let mut args = vec!["api".into(), method.into(), path.into()];
    if let Some(directory) = directory {
        // The OpenCode CLI's working directory is not used as the API request
        // location. Scope this request explicitly so worktree-local agents
        // (including the bundled babysitter) are discovered.
        args.extend([
            "--header".into(),
            format!(
                "x-opencode-directory:{}",
                header_value(&directory.to_string_lossy())
            ),
        ]);
    }
    if let Some(data) = data {
        args.extend(["--data".into(), serde_json::to_string(&data)?]);
    }
    run_in("opencode", &args, None, directory)
}
pub(crate) fn field<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .context(pointer.to_owned())
}
