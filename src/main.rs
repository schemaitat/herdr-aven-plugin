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
mod watch;
mod worktrees;

use dispatch::DispatchOptions;
use dispatch::reset::reset;
use dispatch::supervision::{
    interrupt, list, log_event, message, reconcile, reopen, status, watch_command,
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
    /// Reopen a saved attempt's worktree and OpenCode session without prompting.
    Reopen {
        task: String,
        /// Explicit workflow selector when a task has more than one attempt.
        #[arg(long)]
        workflow: Option<String>,
        /// Print the reopened attempt and terminal identity as JSON.
        #[arg(long)]
        json: bool,
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
        /// Bound results; bounded summary reads fail instead of truncating.
        #[arg(long)]
        limit: Option<usize>,
        /// Omit prompts and Aven invocation details from the JSON payloads.
        #[arg(long)]
        summary: bool,
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
        /// Refuse if the selected attempt was replaced after the caller read it.
        #[arg(long)]
        attempt_id: Option<String>,
        /// Refuse if the selected reset generation changed.
        #[arg(long)]
        generation: Option<u64>,
        /// Refuse if the selected role now has a different terminal address.
        #[arg(long)]
        terminal: Option<String>,
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
    /// Generate or print an LLM summary for a long Aven description.
    Describe {
        /// Task ref, or omit when invoked by an Aven focused-task command.
        task: Option<String>,
        /// Generate a new summary with the LLM; the default is read-only.
        #[arg(long)]
        llm: bool,
        /// Background form: skip current work and record generating/done/error.
        #[arg(long, requires = "llm")]
        auto: bool,
        /// OpenCode model in provider/model form (or AVEN_DISPATCH_SUMMARY_MODEL).
        #[arg(long, env = "AVEN_DISPATCH_SUMMARY_MODEL")]
        model: Option<String>,
        /// Aven workspace key; the focused command context supplies it otherwise.
        #[arg(long)]
        workspace: Option<String>,
        /// Print the structured outcome as JSON.
        #[arg(long)]
        json: bool,
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
    /// Test and approve the exact committed result in the current final worktree.
    Approve {
        /// Task ref or immutable ID; inferred only from an unambiguous final worktree.
        task: Option<String>,
        #[arg(long)]
        workflow: Option<String>,
        /// Trusted verification command, executed through hc (repeatable).
        #[arg(long = "check", required = true)]
        checks: Vec<String>,
        /// Acceptance/code-review evidence, not a substitute for executed checks.
        #[arg(long)]
        review: String,
        #[arg(long)]
        workspace: Option<String>,
    },
    /// Prepare approved results in isolation; publish only after combined review/checks.
    Merge {
        /// Approved task refs or immutable IDs, merged in the supplied order.
        tasks: Vec<String>,
        /// Read-only journal inventory for recovery after a timeout/restart.
        #[arg(long, conflicts_with_all = ["tasks", "yes", "operation", "publish", "review_commit", "review"])]
        list: bool,
        /// Explicit authorization; required when starting an operation.
        #[arg(long)]
        yes: bool,
        /// Resume the exact journaled operation (including metadata-only recovery).
        #[arg(long)]
        operation: Option<String>,
        /// Verify and fast-forward local main, then automatically close out delivery.
        #[arg(long)]
        publish: bool,
        /// Exact integration commit reviewed by the finish agent.
        #[arg(long, requires = "publish")]
        review_commit: Option<String>,
        #[arg(long, requires = "publish")]
        review: Option<String>,
        #[arg(long)]
        workspace: Option<String>,
    },
    /// Verify accepted delivery and optionally record/resolve obligations.
    Closeout {
        task: String,
        /// Explicit workflow selector when a task has more than one attempt.
        #[arg(long)]
        workflow: Option<String>,
        /// Record evidence and resolve matching obligations. The default is a
        /// read-only dry run.
        #[arg(long)]
        apply: bool,
        /// Configured local target branch used as the delivery provider.
        #[arg(long, default_value = "main")]
        target: String,
        /// Exact accepted source commit; defaults to the attempt worktree HEAD.
        #[arg(long)]
        commit: Option<String>,
        /// Supplied PR identity/state. An open PR is never treated as merged.
        #[arg(long)]
        pr: Option<String>,
        /// Explicitly reviewed no-code disposition.
        #[arg(long)]
        not_applicable: bool,
        /// Explicit human waiver reason. Retains artifacts and is never inferred.
        #[arg(long)]
        waive: Option<String>,
        /// Explicit successor reference for superseded delivery.
        #[arg(long)]
        superseded_by: Option<String>,
        /// Aven project key; inferred from the task when possible.
        #[arg(long)]
        project: Option<String>,
        /// Aven workspace key.
        #[arg(long)]
        workspace: Option<String>,
        /// Print the structured outcome as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Inventory and apply a reviewed cancellation disposition.
    Disposition {
        task: String,
        /// Publish the decision and cancel the task. The default is read-only.
        #[arg(long)]
        apply: bool,
        /// Human reason retained with the decision.
        #[arg(long)]
        reason: Option<String>,
        /// Real successor task reference that carries the work forward.
        #[arg(long)]
        successor: Option<String>,
        /// Explicit reviewed decision that no successor exists.
        #[arg(long)]
        no_successor: bool,
        /// Explicit human waiver for a pending delivery obligation.
        #[arg(long)]
        waive_delivery: bool,
        /// Aven workspace key.
        #[arg(long)]
        workspace: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Inventory and non-destructively retire owned recovery records.
    Recovery {
        /// Retire exactly this record. The default is a read-only inventory.
        #[arg(long)]
        apply: bool,
        /// Explicit recovery record reference required with --apply.
        #[arg(long)]
        task: Option<String>,
        /// Human reason required with --apply.
        #[arg(long)]
        reason: Option<String>,
        /// Aven workspace key.
        #[arg(long)]
        workspace: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Inventory, and with --apply delete, a root task tree and its state.
    Delete {
        /// Root task reference; its epic children are discovered from Aven.
        task: String,
        /// Perform the cascade and remove dispatcher state. Default is inventory.
        #[arg(long)]
        apply: bool,
        /// Aven workspace key.
        #[arg(long)]
        workspace: Option<String>,
        /// Print the structured inventory/outcome as JSON.
        #[arg(long)]
        json: bool,
    },
    /// Propose (and, with explicit tasks, apply) reviewed board hygiene repairs.
    Board {
        /// Aven project key; inferred from the repository name when omitted.
        #[arg(long)]
        project: Option<String>,
        /// Aven workspace key.
        #[arg(long)]
        workspace: Option<String>,
        /// Apply only the explicitly listed proposal references.
        #[arg(long)]
        apply: bool,
        /// Explicit proposal references to repair with --apply.
        #[arg(long)]
        task: Vec<String>,
        #[arg(long)]
        json: bool,
    },
    /// Run a scoped, read-only lifecycle audit.
    Audit {
        /// Aven project key; inferred from the repository name when omitted.
        #[arg(long)]
        project: Option<String>,
        /// Aven workspace key.
        #[arg(long)]
        workspace: Option<String>,
        /// Directory used to infer the project and repository.
        #[arg(long, default_value = ".")]
        cwd: PathBuf,
        /// Repository used for read-only worktree/ancestry evidence.
        #[arg(long)]
        repository: Option<String>,
        #[arg(long)]
        json: bool,
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
        /// Skip the one-shot OpenCode activity read; callers that own the live
        /// OpenCode transport use this to avoid duplicate activity semantics.
        #[arg(long)]
        no_api: bool,
    },
    /// Read-only work queue for automation: plan, dispatch, review, and land.
    Work {
        /// Aven project key; inferred from the repository when omitted.
        #[arg(long)]
        project: Option<String>,
        /// Aven workspace key; defaults to the Aven default workspace.
        #[arg(long)]
        workspace: Option<String>,
        /// Directory used to infer the project and repository.
        #[arg(long, default_value = ".")]
        cwd: PathBuf,
        /// Restrict output to these stages; repeat to select more than one.
        #[arg(long, value_enum)]
        stage: Vec<dispatch::work::WorkStage>,
        /// Maximum cards emitted per stage.
        #[arg(long, default_value_t = dispatch::work::DEFAULT_LIMIT)]
        limit: usize,
        /// Print the stable work report as JSON.
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
        Commands::Reopen {
            task,
            workflow,
            json,
        } => reopen(path, &task, workflow.as_deref(), json),
        Commands::Status { task, workflow } => status(path, &task, workflow.as_deref()),
        Commands::List {
            running,
            limit,
            summary,
        } => list(path, running, limit, summary),
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
            attempt_id,
            generation,
            terminal,
            wait,
        } => message(
            path,
            &task,
            workflow.as_deref(),
            &role,
            &text,
            attempt_id.as_deref(),
            generation,
            terminal.as_deref(),
            wait,
        ),
        Commands::Watch {
            once,
            stop,
            status,
            interval,
            reconcile_all,
        } => watch_command(path, once, stop, status, interval, reconcile_all),
        Commands::Describe {
            task,
            llm,
            auto,
            model,
            workspace,
            json,
        } => dispatch::summary::run(path, task, llm, auto, model, workspace, json),
        Commands::Reset { task, yes, dry_run } => reset(path, task, yes, dry_run),
        Commands::Approve {
            task,
            workflow,
            checks,
            review,
            workspace,
        } => dispatch::approval::run(path, task, workflow, checks, review, workspace),
        Commands::Merge {
            tasks,
            list,
            yes,
            operation,
            publish,
            review_commit,
            review,
            workspace,
        } => dispatch::integration::run(
            path,
            dispatch::integration::MergeArgs {
                tasks,
                list,
                yes,
                operation,
                publish,
                review_commit,
                review,
                workspace,
            },
        ),
        Commands::Closeout {
            task,
            workflow,
            apply,
            target,
            commit,
            pr,
            not_applicable,
            waive,
            superseded_by,
            project,
            workspace,
            json,
        } => dispatch::closeout::run(
            path,
            dispatch::closeout::CloseoutArgs {
                task,
                workflow,
                apply,
                target,
                commit,
                pr,
                not_applicable,
                waive,
                superseded_by,
                project,
                workspace,
                json,
            },
        ),
        Commands::Disposition {
            task,
            apply,
            reason,
            successor,
            no_successor,
            waive_delivery,
            workspace,
            json,
        } => dispatch::disposition::run(
            path,
            dispatch::disposition::DispositionArgs {
                task,
                apply,
                reason,
                successor,
                no_successor,
                waive_delivery,
                workspace,
                json,
            },
        ),
        Commands::Recovery {
            apply,
            task,
            reason,
            workspace,
            json,
        } => dispatch::disposition::recovery(
            path,
            dispatch::disposition::RecoveryArgs {
                apply,
                task,
                reason,
                workspace,
                json,
            },
        ),
        Commands::Delete {
            task,
            apply,
            workspace,
            json,
        } => dispatch::delete::run(
            path,
            dispatch::delete::DeleteArgs {
                task,
                workspace,
                apply,
                json,
            },
        ),
        Commands::Board {
            project,
            workspace,
            apply,
            task,
            json,
        } => dispatch::board::run(dispatch::board::BoardArgs {
            project,
            workspace,
            apply,
            tasks: task,
            json,
        }),
        Commands::Audit {
            project,
            workspace,
            cwd,
            repository,
            json,
        } => dispatch::audit::run(dispatch::audit::AuditArgs {
            project,
            workspace,
            cwd,
            store: path,
            repository,
            json,
        }),
        Commands::Inspect {
            project,
            workspace,
            cwd,
            json,
            no_api,
        } => inspect::run(inspect::Args {
            project,
            workspace,
            cwd,
            store: path,
            json,
            skip_api: no_api,
        }),
        Commands::Work {
            project,
            workspace,
            cwd,
            stage,
            limit,
            json,
        } => dispatch::work::run(dispatch::work::WorkArgs {
            store: path,
            project,
            workspace,
            cwd,
            stages: stage,
            limit,
            json,
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
            lifecycle: crate::model::LifecycleState::default(),
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
