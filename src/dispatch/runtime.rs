//! Terminal identity and focus ownership.

use super::plan::{
    autonomous_permissions, has_worked_out_multi_phase_plan, phase_branch, phase_is_eligible,
    phase_prompt, validate_epic_phases,
};
use crate::{
    agents::{
        BABYSITTER_AGENT, BABYSITTER_AGENT_ID, BABYSITTER_MODEL, install_global_agent, model_ref,
    },
    app, core,
    model::{Attempt, PhaseAttempt, TerminalRef},
    process::{self, field, identifier, opencode, opencode_in, opencode_text},
    store::{LockedStore, store_attempt},
    worktrees::{self, WorktreeResource},
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(crate) fn focus_terminal(address: &str) {
    // A dispatcher terminal is a hidden core terminal until it gets a pane.
    // Focus alone fails then; peek is the supported way to reveal it in the
    // current app tab. Both are best-effort and never affect dispatch.
    if !app::focus(address) {
        let _ = app::peek(address);
    }
}
pub(crate) struct TerminalOwner<'a> {
    pub(crate) task_id: &'a str,
    pub(crate) task_ref: &'a str,
    pub(crate) workflow: &'a str,
    pub(crate) attempt_id: &'a str,
    pub(crate) generation: u64,
}
pub(crate) fn terminal_labels(
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
pub(crate) fn sanitize_name(value: &str) -> String {
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
pub(crate) fn terminal_name(owner: &TerminalOwner<'_>, role: &str) -> String {
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
pub(crate) fn terminal_ref_for(
    core: &core::CoreIdentity,
    terminal: &core::Terminal,
    role: &str,
    created: bool,
) -> TerminalRef {
    core::terminal_ref(core, terminal, role, created)
}

pub(crate) fn launch_opencode_terminal(
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
pub(crate) fn record_terminal(
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

pub(crate) fn launch_and_record(
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

// Babysitter session lifecycle.
pub(crate) fn babysitter_message(attempt: &Attempt) -> String {
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
pub(crate) fn admit_babysitter(attempt: &mut Attempt, store: &mut LockedStore) -> Result<()> {
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
pub(crate) fn start_babysitter(
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
        &attempt.terminal.address,
        &worktree,
        &format!("Babysit {}", attempt.task_ref),
        &attempt.task_ref,
        &mut attempt.aven_panel,
    );
    admit_babysitter(attempt, store)
}

pub(crate) fn wait_for_global_agent(agent_id: &str) -> Result<()> {
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

pub(crate) fn start_optional_babysitter(
    attempt: &mut Attempt,
    path: &Path,
    store: &mut LockedStore,
) -> Result<()> {
    if attempt.babysitter {
        start_babysitter(attempt, path, store)?;
    }
    attempt.state = "running".into();
    attempt.aven_update_pending = true;
    store_attempt(store, attempt.clone());
    store.save()?;
    Ok(())
}

// Worktree resources owned by dispatch attempts.
pub(crate) fn create_worktree(
    origin: &str,
    branch: &str,
    _label: &str,
    base: Option<&str>,
) -> Result<WorktreeResource> {
    worktrees::create(origin, branch, base)
}
pub(crate) fn remove_owned_worktree(worktree: &str, created_by_attempt: bool) {
    worktrees::remove_owned(worktree, created_by_attempt);
}

// Worktree phase provisioning and first-phase admission.
pub(crate) fn provision_phase_worktrees(
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

// Branch naming for durable attempts.

#[cfg(test)]
mod moved_owner_tests {
    use super::*;
    use crate::model::Attempt;
    use serde_json::json;

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
}
