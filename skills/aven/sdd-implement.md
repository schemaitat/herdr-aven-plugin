---
name: sdd-implement
description: Implement a selected Aven task only after its SDD plan has been worked out; require the durable planning metadata before changing code.
---

# Implement an already planned Aven task

You are implementing the selected Aven task `{ref}` — "{title}". Aven is the
source of truth for the specification, plan, phase tasks, progress, and
verification. Do not create or maintain repository planning documents.

## 0. Mandatory plan gate

Before inspecting or changing code, run:

```sh
aven context {ref} --full
aven show {ref} --json
```

Find the plan root:

- If `{ref}` itself has `sdd.plan-worked-out=true`, it is the root.
- If `{ref}` has `sdd.plan-root=<root-ref>`, read that root with
  `aven context <root-ref> --full` and `aven show <root-ref> --json`; it is the
  root only when it has `sdd.plan-worked-out=true`.
- Otherwise there is no worked-out plan.

**Do not implement when the root marker is absent or not `true`.** Leave the
task unchanged, report that planning is required, and direct the user to run
`z p` for planning only or `z s` for plan then implement. Do not infer the plan
from a title, description, old note, or epic membership.

Once the marker is confirmed, read the root `## Plan` note, the task's own
description, existing notes, relations, and current status. Reuse the stated
decision, dependencies, risks, and done criteria; revise the plan only when a
real discovery invalidates it, recording the change in an appended plan-revision
note before proceeding.

## 1. Choose work in plan order

- For a single-phase root task, implement `{ref}`.
- For a selected multi-phase child, verify it is unblocked with `aven list
  --ready --project <key>` and implement that child only.
- For a selected multi-phase root epic, inspect `aven epic list {ref}` and work
  **every** child in dependency order in this one OpenCode session and its one
  worktree. Do not dispatch child tasks separately, switch worktrees, skip a
  blocked phase, or run phases in parallel. Continue through the next child
  until every epic child is done or a real blocker is recorded.

Mark each task `active` immediately before changing it:

```sh
aven edit <task-ref> --status active
```

## 2. Implement and verify

For each planned task:

1. Make only the changes described by its ADR-style plan and acceptance criteria.
2. Follow the repository's established patterns and run the exact verification
   commands recorded in the plan.
3. Append a durable Aven note stating what changed, verification results, and
   any follow-up or deviation:

   ```sh
   aven note <task-ref> --stdin <<'EOF'
   ## Implementation

   Changed: …
   Verified: `…` — passed.
   Plan deviation or follow-up: None.
   EOF
   ```

4. Mark the task `done` only after its done criteria pass:

   ```sh
   aven edit <task-ref> --status done
   ```

If a task is blocked, leave it active or return it to `todo` as appropriate and
append a note with the concrete blocker. If new work is necessary, create a new
task, attach it to the epic where applicable, and express its ordering with
`aven dep add`; do not silently expand the completed plan.

When every child of a root epic is done and the root acceptance criteria hold,
append a final verification note and mark the root done. Never mark an epic or
task done merely because code was written.

## 3. Report

Summarise the confirmed plan root and its `sdd.plan-worked-out=true` marker,
the tasks completed or blocked, changed files, verification results, and any
plan revision or follow-up. Keep Aven refs out of commits and pull requests.
