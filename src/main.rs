use anyhow::Result;
use clap::{Parser, Subcommand};
use std::{
    env,
    io::{self, IsTerminal, Write},
    path::PathBuf,
};

mod agents;
mod app;
mod core;
mod dispatch;
mod inspect;
mod model;
mod picker;
mod process;
mod store;
mod tui;
mod watch;
mod worktrees;

use dispatch::DispatchOptions;
use dispatch::reset::reset;
use dispatch::supervision::{
    interrupt, list, log_event, message, reconcile, status, watch_command,
};
use model::ExecutionMode;
#[cfg(test)]
use model::{Attempt, Invocation, TerminalRef, attempt_key, normalize_attempt, workflow_for_skill};
use picker::pick;
use process::absolute_path;
#[cfg(test)]
use process::header_value;
#[cfg(test)]
use process::now;
#[cfg(test)]
use std::collections::BTreeMap;
use store::store_path;

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
        } => dispatch::dispatch(DispatchOptions {
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
            requested_mode: mode,
            relaunch,
        }),
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
        Commands::Doctor => dispatch::doctor(&path),
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
}
