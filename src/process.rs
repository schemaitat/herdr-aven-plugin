//! External command execution and transport helpers.

use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::{
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::model::Invocation;

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn identifier(prefix: &str) -> String {
    format!("{prefix}_{:x}", now())
}
pub(crate) fn absolute_path(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
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

/// Resolve the OpenCode executable in the dispatcher's environment. herdr-core
/// may run with a smaller `PATH` than the dispatcher (for example when the
/// desktop app starts the core), so terminal launches must not rely on the
/// core's `PATH`. `OPENCODE_BIN` is the explicit override, `PATH` selects
/// normally, and the usual install locations are the fallback when a
/// core-launched dispatcher inherits only the core's minimal environment.
pub(crate) fn opencode_binary() -> Result<String> {
    if let Some(binary) = env::var_os("OPENCODE_BIN").filter(|value| !value.is_empty()) {
        return Ok(binary.to_string_lossy().into_owned());
    }
    let name = if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    };
    if let Some(found) = executable_in(env::var_os("PATH").as_deref(), "opencode") {
        return Ok(found.to_string_lossy().into_owned());
    }
    let mut searched = vec!["PATH".to_owned()];
    let mut candidates = Vec::new();
    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        candidates.push(home.join(".opencode/bin").join(name));
        candidates.push(home.join(".local/bin").join(name));
        candidates.push(home.join("bin").join(name));
    }
    if let Some(bin) = env::var_os("XDG_BIN_HOME").filter(|value| !value.is_empty()) {
        candidates.push(PathBuf::from(bin).join(name));
    }
    candidates.extend(
        ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"]
            .iter()
            .map(|directory| Path::new(directory).join(name)),
    );
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
        searched.push(candidate.display().to_string());
    }
    bail!(
        "cannot find the OpenCode executable; set OPENCODE_BIN or install OpenCode (searched: {})",
        searched.join(", ")
    )
}

fn executable_in(path: Option<&OsStr>, name: &str) -> Option<PathBuf> {
    let name = if cfg!(windows) && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    env::split_paths(path?)
        .map(|directory| directory.join(&name))
        .find(|candidate| candidate.is_file())
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
    let program = opencode_binary()?;
    run_in(&program, &args, None, directory)
}
pub(crate) fn field<'a>(value: &'a Value, pointer: &str) -> Result<&'a str> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .context(pointer.to_owned())
}

/// Run a read-only source command with a hard deadline and a combined
/// stdout/stderr byte cap. Inspector collection never uses the unbounded
/// lifecycle runner: a stalled Aven/hc call must not freeze the caller.
pub(crate) fn run_bounded(
    program: &str,
    args: &[String],
    directory: Option<&Path>,
    timeout: Duration,
    max_bytes: usize,
) -> Result<String> {
    use std::{
        io::Read,
        process::Stdio,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Instant,
    };
    let mut command = Command::new(program);
    command.args(args);
    if let Some(directory) = directory {
        command.current_dir(directory);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .with_context(|| format!("start {program}"))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().context("capture source stdout")?;
    let stderr = child.stderr.take().context("capture source stderr")?;
    let read = |mut stream: Box<dyn Read + Send>, overflow: Arc<AtomicBool>| {
        thread::spawn(move || {
            let mut output = Vec::new();
            let mut chunk = [0_u8; 8192];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        if output.len() + count > max_bytes {
                            output.extend_from_slice(
                                &chunk[..max_bytes.saturating_sub(output.len())],
                            );
                            overflow.store(true, Ordering::SeqCst);
                            break;
                        }
                        output.extend_from_slice(&chunk[..count]);
                    }
                    Err(_) => break,
                }
            }
            output
        })
    };
    let stdout = read(Box::new(stdout), Arc::clone(&overflow));
    let stderr = read(Box::new(stderr), Arc::clone(&overflow));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if overflow.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{program} exceeded the {max_bytes}-byte source output limit");
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{program} timed out after {} ms", timeout.as_millis());
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if overflow.load(Ordering::SeqCst) {
        bail!("{program} exceeded the {max_bytes}-byte source output limit");
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        bail!("{} failed: {}", program, detail.trim());
    }
    String::from_utf8(stdout)
        .map(|value| value.trim().to_owned())
        .with_context(|| format!("{program} returned non-UTF-8 output"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_executable_from_the_dispatcher_path() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join(if cfg!(windows) {
            "opencode.exe"
        } else {
            "opencode"
        });
        std::fs::write(&binary, b"").unwrap();
        let path = env::join_paths([dir.path()]).unwrap();
        assert_eq!(executable_in(Some(&path), "opencode"), Some(binary));
        assert_eq!(executable_in(Some(&path), "missing"), None);
        assert_eq!(executable_in(None, "opencode"), None);
    }
}
