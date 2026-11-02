---
description: Reconcile a dispatched task and merge its worktree or open a pull request
subagent: false
---

Finish the current worktree with the user's explicit choices. `$ARGUMENTS` is
optional context, not permission to skip any confirmation or safety check.
This is an agent workflow, not an atomic transaction. Follow the active Git,
GitHub, conventional-commit, and Aven instructions and permissions. Never
invent a task ref or include local Aven refs in commits or PR descriptions.

## Identify and choose

1. Determine the current repository root, branch, worktree inventory, status,
   staged and unstaged changes, untracked files, and commits relative to local
   `main`. Stop if the branch is detached, is `main`, or the target is ambiguous.
   Show a concise summary, including already-staged and unrelated changes.
2. Ask the user to choose **merge into local main**, **create a pull request**,
   or **cancel**. Cancel or no answer means no commit, push, merge, PR, or
   teardown. Do not select for them.
3. Identify the root task and workflow from the current session's handoff or
   `aven-dispatch inspect --json` attempt/phase worktree and session evidence.
   Check source health and ambiguity; never assume the newest or first attempt
   belongs to this session. If uncertain, ask for the qualified task ref and
   workflow and verify them using `aven context <ref> --full` and
   `aven-dispatch status <ref> --workflow <workflow>`. If no matching dispatch
   can be established, stop without integration. Read the task's full context,
   child tasks and acceptance criteria; do not treat execution state as task
   acceptance. If this is a phase worker worktree, do not bypass the root
   workflow's ordered integration or merge a partial phase into `main`; stop
   and direct the user to the completed root/coordinator worktree.

## Commit and integrate

4. Preserve unrelated work. If changes need a commit, identify the exact files
   and staged content to include, ask the user when ownership or inclusion is
   unclear, and commit only approved task changes using the project's commit
   conventions. Verify the proposed commit cannot include unrelated staged
   content; if it cannot be isolated without changing another person's index,
   stop and ask. Never blindly stage all files, overwrite or discard changes,
   or amend an unrelated commit. If there are no changes, use the existing
   branch commits. Stop on failure. After a successful commit, perform the task
   and dispatcher reconciliation described below even if later integration fails.
5. For **merge into local main**, locate the one actual checkout of `main` from
   the worktree inventory. Require it to be clean (including untracked files),
   verify it still has `main` checked out, and verify the source branch has no
   uncommitted changes before integration. If `main` is not checked out, dirty,
   ambiguous, or otherwise unsafe, stop and explain; do not switch or clean a
   checkout. Merge the selected branch there without force or destructive
   recovery. On conflict or error, stop, leave the state intact, and report it.
   Verify the source commit is an ancestor of the resulting `main` and report
   the resulting commit. Do not push `main` unless separately authorized.
6. For **create a pull request**, push the selected branch without force and
   create or identify its PR targeting `main` using the applicable GitHub
   workflow. Report its URL. An open PR is not a successful merge: do not ask
   to close the space on this path. Stop and report any failure.

## Reconcile and optional closure

7. After a commit, PR creation, or merge, re-read `aven context <ref> --full` and
   review actual verification and acceptance evidence. Add a durable Aven note
   with the outcome, checks, and remaining work; update statuses only where
   justified by verified acceptance, never mark unverified work done. Run
   `aven-dispatch reconcile <ref> --workflow <workflow>` for the identified
   attempt, then inspect its output and status: a pending Aven update or failed
   repair is a failure even if the command exits successfully. Re-read the
   task, because reconciliation may repair pending metadata/status. If either
   task or dispatcher reconciliation fails, stop, report it and keep the
   worktree and space; never proceed to integration or teardown. Repeat this
   step after integration if it already ran after the commit.
8. Only after a verified successful merge and successful reconciliation, use
   `herdr-app ls` and the attempt's exact terminal/space ownership evidence to
   identify the one associated Herdr space. Never use the currently focused
   space as a fallback. If missing, stale or ambiguous, report and keep it. Ask
   explicitly whether to close that specific space, explaining that closing it
   ends its terminals, potentially including this session. The default is No.
   Only an explicit Yes authorizes `herdr-app do space.close --id <space-id>
   --confirmed true`; revalidate the exact association immediately beforehand.
   Write the final handoff and outcome to Aven before closing, since this session
   may end. Report any failure if the session remains alive.

Never delete a Git worktree or branch as part of this command. On cancellation,
conflict, uncertain ownership, failure, or an open PR, retain the Herdr space.
