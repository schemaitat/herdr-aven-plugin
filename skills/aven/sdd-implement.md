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
- If `{ref}` is an epic child, its context identifies `epic_parent`. Read that
   parent with `aven context <parent-ref> --full` and `aven show <parent-ref>
   --json`; it is the root only when it has `sdd.plan-worked-out=true` and
   `sdd.plan-kind=multi-phase`. This is the durable fallback for every
   dispatcher-provisioned phase tasks.
- Otherwise there is no worked-out plan.

**Do not implement when the root marker is absent or not `true`.** Leave the
task unchanged, report that planning is required, and direct the user to run
`z p` for planning only or `z s` for plan then implement. Do not infer the plan
from a title, description, or old note; use only the explicit marker or the
verified epic-parent fallback above.

Once the marker is confirmed, read the root `## Plan` note, the task's own
description, existing notes, relations, and current status. Reuse the stated
decision, dependencies, risks, and done criteria; revise the plan only when a
real discovery invalidates it, recording the change in an appended plan-revision
note before proceeding.

## 1. Choose work in plan order

- For a selected phase child, verify it is unblocked with `aven list
  --ready --project <key>` and implement that child only.
- For a selected root epic, inspect `aven epic list {ref}` and use
  the dispatcher-supplied **Execution mode** guidance for this attempt. Do not
  infer or coordinate a different execution topology. Do not dispatch children
  separately, run phases in parallel, or admit a successor before predecessor
  verification and any required integration evidence. The root stays an epic:
  it is the overarching ADR/specification and its children are the phase
  subtasks. Never use `--epic off` or otherwise convert the root into a task.

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
