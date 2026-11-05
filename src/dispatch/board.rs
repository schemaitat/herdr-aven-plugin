//! Reviewed board hygiene proposals.
//!
//! Ordinary ideas stay non-epic until a plan is persisted. This command
//! proposes repairs for childless/incomplete epics and never removes history,
//! plan metadata or children automatically.

use super::{
    aven::{list_tasks, refresh_task_by_ref},
    closeout::invocation,
};
use crate::process::aven;
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub(crate) struct BoardProposal {
    pub(crate) reference: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) reason: String,
    pub(crate) action: String,
}

pub(crate) struct BoardArgs {
    pub(crate) project: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) apply: bool,
    pub(crate) tasks: Vec<String>,
    pub(crate) json: bool,
}

fn reference(task: &Value) -> String {
    task.pointer("/task/display_ref")
        .or_else(|| task.pointer("/task/ref"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn status(task: &Value) -> &str {
    task.pointer("/task/status")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn worked_out(task: &Value) -> bool {
    task.pointer("/metadata/sdd.plan-worked-out")
        .and_then(Value::as_str)
        == Some("true")
}

fn children(task: &Value) -> usize {
    task.get("epic_children")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

pub(crate) fn run(args: BoardArgs) -> Result<()> {
    let invocation = invocation(args.workspace.clone());
    let project = args.project.clone().or_else(|| {
        std::env::current_dir().ok().and_then(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
    });
    let project = project.context("board requires --project when the cwd has no project name")?;
    let listed = list_tasks(&invocation, &project, None)
        .context("read scoped Aven board; no repair was attempted")?;
    let mut proposals = Vec::new();
    for task in listed {
        let is_epic = task
            .get("is_epic")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !is_epic {
            continue;
        }
        let task_ref = task
            .get("ref")
            .or_else(|| task.get("display_ref"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if task_ref.is_empty() {
            continue;
        }
        let task_status = task
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(task_status, "done" | "canceled") {
            continue;
        }
        let context = refresh_task_by_ref(&invocation, &task_ref)?;
        let reason = if children(&context) == 0 {
            "open epic has no phase children; a childless plan hides actionable work from --ready"
        } else if !worked_out(&context) {
            "epic has children but sdd.plan-worked-out=true was never published; the plan is visibly incomplete"
        } else {
            continue;
        };
        proposals.push(BoardProposal {
            reference: reference(&context),
            title: context
                .pointer("/task/title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            status: status(&context).to_owned(),
            reason: reason.into(),
            action: if children(&context) == 0 {
                "propose non-epic until a worked-out plan exists".into()
            } else {
                "resume planning before implementation".into()
            },
        });
    }
    if args.apply {
        let requested = args.tasks.iter().map(String::as_str).collect::<Vec<_>>();
        if requested.is_empty() {
            bail!("board --apply requires one or more explicit --task references");
        }
        for reference in requested {
            let proposal = proposals
                .iter()
                .find(|proposal| proposal.reference == reference)
                .with_context(|| format!("{reference} is not a current board repair proposal"))?;
            if !proposal.action.starts_with("propose non-epic") {
                bail!(
                    "{reference} is an incomplete plan, not a childless idea; record plan progress instead of changing epic status"
                );
            }
            let repaired_at = format!("board.repaired-at={}", crate::process::now());
            aven(
                &invocation,
                &[
                    "edit",
                    reference,
                    "--epic",
                    "off",
                    "--metadata",
                    &repaired_at,
                ],
                None,
            )?;
            aven(
                &invocation,
                &["note", reference, "--stdin"],
                Some(&format!(
                    "## Board repair\n\nReviewed proposal: {}\n\nThe task was returned to a non-epic idea so it is visible to the ready board. No plan, note, child or history was removed.",
                    proposal.reason
                )),
            )?;
        }
    }
    if args.json {
        println!("{}", serde_json::to_string_pretty(&proposals)?);
    } else {
        for proposal in &proposals {
            println!(
                "board {} status={} action={} ({})",
                proposal.reference, proposal.status, proposal.action, proposal.reason
            );
        }
        if proposals.is_empty() {
            println!("board clean: no childless or incomplete open epic proposals");
        }
    }
    Ok(())
}
