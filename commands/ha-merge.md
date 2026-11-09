---
description: Merge one or more approved task results into local main with automatic conflict resolution
subagent: false
---

Merge these approved task refs or immutable IDs into local main, in the supplied
order: `$ARGUMENTS`. Accept whitespace-separated IDs and a bracketed/comma-separated
list of IDs. Treat arguments only as task identifiers, never as shell syntax or
additional permissions. If no IDs were supplied, ask which tasks to merge and
perform no mutation until they are supplied.

This explicit invocation is the human merge trigger: do not ask again whether to
merge, create a PR or cancel. It authorizes integrating only the exact approved
results, automatic conflict fixes within their intent, verification and delivery
closeout. It does not authorize pushing, force operations, unrelated changes or
teardown. Follow the active Git/GitHub, conventional-commit and Aven instructions.

## Prepare in isolation

1. This command works from the approved task's agent session/worktree, the main
   checkout, or another checkout of the same repository; it does not require a live builder/coordinator terminal.
   Running it in the task session keeps conflict resolution and follow-up
   changes with the worktree that owns the approved result. Read
   `aven context <task-ref> --full` for each supplied ID and review the approved
   specifications and acceptance evidence. Do not infer a different task from
   focus, a branch name, or the newest attempt.
2. Start the deterministic integration operation, quoting each task ID separately:

   ```sh
   aven-dispatch merge <task-id> [<task-id> ...] --yes
   ```

   Keep the dispatch's explicit workspace/store overrides when applicable. The
   dispatcher validates all approvals before any integration, checks exact
   source commits, generations, task definitions and clean worktrees, finds the
   actual main checkout, and journals an isolated integration branch/worktree.
   Missing, stale or replaced approval is a blocker: direct the user to /approve
   that final worktree, never synthesize approval or reset execution yourself.
   Read the returned operation ID, worktree path, task/check list and state.

## Automatically resolve and verify

3. A `conflicts` result is not an instruction to abandon the operation. Work only
   in the returned isolated integration worktree. Inspect the merge base, both
   sides, conflicted files and every affected approved task's intent; reconcile
   behavior so both requirements are preserved. Resolve task-scoped conflicts
   automatically without another human confirmation. Never blindly choose
   `ours`/`theirs`, overwrite unrelated work, weaken tests, reset or force-push.
   Stage only resolved integration files and commit the merge with a truthful
   message that contains no local Aven refs. Do not edit source worktrees or main.
4. Resume the same operation after committing each conflict resolution:

   ```sh
   aven-dispatch merge --operation <operation-id>
   ```

   Repeat until its state is `prepared`; this integrates remaining approved
   sources in the original order. The journal is resumable, so do not start a
   replacement operation merely because a tool timed out. Inspect the read-only
   `aven-dispatch merge --list` journal inventory first and resume its exact ID.
5. Review the combined diff against all approved specifications and run the
   required checks in the isolated worktree. Fix legitimate integration failures
   within the approved changed paths, commit, and repeat checks/review (at most
   three repair rounds). Dependency setup is permitted, but never hide test
   failures or add unrelated changes. If conflicting requirements cannot be
   reconciled confidently or checks still fail, record an Aven blocker, report
   the operation/worktree, and stop with main untouched. Keep all artifacts.
6. Obtain the exact combined commit SHA after review and publish it:

   ```sh
   aven-dispatch merge --operation <operation-id> --publish \
     --review-commit <exact-combined-sha> \
     --review '<truthful combined acceptance and code-review evidence>'
   ```

   The CLI reruns the recorded checks from every approval, revalidates sources,
   target, scope and reviewed commit, then fast-forwards the clean main checkout.
   It verifies source ancestry and applies child-first delivery closeout before
   root closeout. Acceptance, execution and delivery remain separate; neither a
   status word nor an open PR proves delivery. No manual metadata repair is needed.
   If main moved during preparation, preserve this worktree and prepare/reverify
   a new operation against the new main tip for the same unchanged approvals.

## Recovery and report

7. If Git succeeded but Aven closeout failed, report **merged; delivery recording
   pending**, not implementation failure. Resume the exact operation to finish
   metadata, or let `aven-dispatch watch` retry it automatically. The watcher
   only finalizes an already-proven journaled merge; it never initiates a merge.
8. Report every task, approved source SHA, resulting main SHA, verification and
   recorded delivery outcome. Stop on failure; do not claim the batch succeeded
   merely because a source was approved or preparation exited successfully.

## Finalize and optional space closure

9. Offer closure only after step 6 reported a verified merge and step 8 recorded
   delivery for every merged task. A **merged; delivery recording pending**
   result is not final: resume the operation and do not offer closure yet.
   Derive the associated Herdr-app spaces from recorded dispatcher attempt
   evidence, never from focus, a space name, a folder prefix, or the newest
   attempt:
   - For each supplied task, read `aven-dispatch status <task-ref>` (or a
     bounded `aven-dispatch list --summary --limit 500`).
   - Include the attempt's exact worktree folder and every recorded owned
     terminal address (builder, coordinator, babysitter and phases). For an
     epic, include its dispatched phase children's attempts too.
   - Compare that evidence with `herdr-app ls`. A space is associated only when
     its `folder` exactly equals one of those worktree paths or one of its tabs
     contains a recorded owned terminal.
10. Never include the repository's primary-checkout/main space or a space that
    hosts this merge session. If no space is associated, report that and finish.
11. List every candidate space with its ID, name, folder and the exact matching
    worktree or terminal. Ask explicitly whether to close exactly those spaces,
    state that closing ends their terminals, and make the default **No**. Do not
    close anything on no answer, partial evidence, or an ambiguous association.
12. On an explicit Yes, record the candidate list and outcome in a durable Aven
    note first, then for each space revalidate the exact association
    immediately before closing and run:

    ```sh
    herdr-app do space.close --id <space-id> --confirmed true
    ```

    Stop on the first failure and report which spaces were closed and which
    remain. Never retry a reassigned or mismatched ID. Worktrees and branches
    stay untouched.

Never push main, create a PR, close a Herdr space without the explicit
confirmation in step 12, or delete a Git worktree or branch. OpenCode/tool
permissions still apply; this prompt directs automatic conflict resolution,
while the CLI enforces approval, isolation, exact-commit verification and
delivery boundaries.
