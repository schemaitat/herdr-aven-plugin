---
name: sdd-plan-implement
description: Plan a selected Aven task with durable metadata, then implement and verify it in the same workflow.
---

# Plan then implement an Aven task

> This is an **example** workflow bundled with the plugin, not a built-in
> command. It shows one efficient way to use `dispatch` plus aven for task
> management: define, refine, plan, break down, and implement, with every
> artifact kept in aven. Copy it, trim it, or replace it with your own.

## What you were given

You are working a single aven task: the **root task** `{ref}` — "{title}". The
title and description also arrive as `$ARGUMENTS` below.

**Aven is the only task store.** Throughout this workflow:

- the **spec** lives in the root task's description,
- the **plan** lives in a note on the root task,
- the **breakdown** lives in aven as child tasks of the root task,
- the **progress** lives in each task's status and notes.

Do not create `specs/`, `plan.md`, `tasks.md`, or checklist files, and do not
keep a task list anywhere else. Never invent a task ref: use the refs aven
prints, preferably the qualified form (`APP-7KQ9`).

If `{ref}` above was not replaced with a real ref, read it from the handoff
guidance at the end of this prompt (the `aven context <ref>` line).

## Dispatcher diagnostics

When dispatch or OpenCode needs debugging, create diagnostic records **only**
through the dispatcher CLI. Do not create ad-hoc log tasks or write dispatcher
diagnostics to the work task yourself:

```sh
aven-dispatch log {ref} \
  --event agent-startup-debug \
  --detail "Describe the observed failure and relevant IDs."
```

This creates or reuses the attempt's linked task in the **Dispatcher Logs**
project, links it to `{ref}`, and appends the event there. Do not include
credentials, tokens, or prompt text in `--detail`.

## 0. Check the plan marker and find where to resume

```sh
aven context {ref} --full
aven show {ref} --json
aven epic list {ref}          # existing child tasks, if any
```

`context` prints the description, metadata, relations, and recent notes; when
earlier notes are omitted it ends with a `read=` command that prints their
bodies in one call.

`sdd.plan-worked-out=true` on the root task is the authoritative signal that an
ADR-style plan already exists. Decide where to resume instead of redoing work:

| Already present | Skip |
| --- | --- |
| `sdd.plan-worked-out=true` | phases 1–3; go directly to phase 4 |
| the description is a real spec | phase 1 |
| a note headed `## Plan` | phase 2 |
| child tasks under the root | phase 3 |
| nothing yet | start at phase 1 |

When the marker is absent, work phases 1–3 in order and set it only after the
plan is complete. Do not implement before that point. A finished
`sdd-plan-implement` run therefore plans first and then implements in the same
session; it never treats
an old title, description, or unmarked note as a worked-out plan.

## 1. Define (and refine) the spec in the description

Turn the request into a precise, testable specification and write it into the
root task description. Keep it as short as the task allows.

```sh
aven text get {ref} description --output description.md
# ... edit description.md ...
aven text diff {ref} description --file description.md
aven text set {ref} description --file description.md --if-sha256 HASH_FROM_TEXT_GET
```

If the description does not exist yet, `aven edit {ref} --description-stdin`
with the text on standard input is enough.

Cover, as headings, only what applies:

- **Goal** — the outcome in one or two sentences.
- **Scenarios** — the primary user/actor flows, each with an expected result.
- **Requirements** — functional, numbered, each testable.
- **Acceptance criteria** — concrete, verifiable statements that say when this
  is done; these drive the checks in phase 4.
- **Out of scope** — what this task deliberately does not do.
- **Assumptions** — the defaults you chose, so a reader can challenge them.
- **Open questions** — only if a decision genuinely blocks the work.

**Refine like a tester.** Re-read the spec and make every requirement testable
and unambiguous. Resolve a vague requirement by choosing a sensible default and
recording it under Assumptions rather than stopping. Only when a choice is
high-impact and has no reasonable default, leave a short question and ask the
user — at most three, prioritising scope, then security/privacy, then UX.

Keep the task `todo` while planning; implementation will move the active work
item to `active` in phase 4:

```sh
aven edit {ref} --status todo
```

## 2. Plan (as a note on the root task)

Work out *how* before writing code. The root `## Plan` note must read as an
Architectural Decision Record: include **Context**, **Decision** (and why it
was chosen), **Alternatives considered**, **Consequences**, **Affected files**,
**Open questions**, **Trade-offs and risks**, and concrete **Done criteria**.
It contains a table of phase titles and actual child refs. Every plan root is
an epic, including a plan with one phase.
Keep the plan in Aven:

```sh
aven note {ref} --stdin <<'EOF'
## Plan

- Approach: …
- Files / modules touched: …
- Data or interface changes: …
- Dependencies: …
- Risks and how to test them: …
- Verification: the exact commands that prove it works.
EOF
```

Prefer notes over a `plan.md` file: notes travel with the task, survive the
worktree, and are what the next agent reads. Add more notes as the plan changes
rather than editing the first one away.

## 3. Persist the plan shape and its marker

Make `{ref}` an epic and keep it as the overarching ADR/specification record for
the lifetime of the work. Add one child task per phase, including a single
phase. The children are the independently executable subtasks; they do not
replace or redefine the epic. Do not create parallel branches or a child with
more than one blocker:

1. Make the root task an epic and add a child per piece:

   ```sh
    aven edit {ref} --epic on --status todo \
      --metadata sdd.plan-kind=multi-phase \
      --metadata sdd.plan-schema=v1
    aven add "<piece title>" --project <key> --status todo --description-stdin <<'EOF'
    ADR-style phase goal, why this slice exists, ordered TASK-NNN steps,
    trade-offs and risks, plus its own acceptance criteria.
    EOF
    aven epic add <child-ref> {ref}
   ```

   Give every child enough context to stand alone: rationale, scope, and
   acceptance criteria, in its own description.

2. Express execution order with one dependency chain:

   ```sh
   aven dep add <blocked-child> <blocker-child>   # this before that
   ```

3. Record the actual child refs in the root ADR plan and finalise the marker:

   ```sh
   aven note {ref} --stdin <<'EOF'
   ## Breakdown
   - APP-XXXX piece one (ready first)
    - APP-YYYY piece two (after APP-XXXX)
    EOF
    aven edit {ref} --status todo \
      --metadata sdd.plan-worked-out=true \
      --metadata sdd.plan-kind=multi-phase \
      --metadata sdd.plan-schema=v1
    ```

Validate that all phases and tasks form one linear chain before setting the
marker. Phase 4 may run only after `sdd.plan-worked-out=true` exists.

## 4. Implement, tracking each task in aven

Pick the work that is ready and unblocked, in dependency order:

```sh
aven list --ready --project <key>
aven epic list {ref}
```

For a root epic selected through `z s`, follow only the
dispatcher-supplied **Execution mode** guidance for this attempt. Do not infer
or coordinate a different execution topology. Do not dispatch children
separately, run phases in parallel, or release a successor before predecessor
verification. Never use `aven edit {ref} --epic off`, convert the epic into a
task, or move its ADR/specification onto a phase task.
For each child piece:

1. Mark it active: `aven edit <ref> --status active`.
2. Make the change.
3. Run the project's own checks (the commands from Verification in the plan).
4. Leave a durable note — what changed, how it was verified, what is left:

   ```sh
   aven note <ref> --stdin <<'EOF'
   Implemented … Verified with `…`. Follow-up: ….
   EOF
   ```

5. Mark it done **only when verified**: `aven edit <ref> --status done`.

If a piece turns out to be blocked or larger than expected, leave a note
explaining the blocker and, if it is real new work, add a task for it and link
it (`aven dep add <new> <ref>`). Do not mark unverified work done, and do not
mark a task canceled just to make the board look clean.

When every child is done and the root task's acceptance criteria hold, close the
root:

```sh
aven edit {ref} --status done
```

## 5. Report and hand off

Finish with a short summary:

- the spec written (and any assumptions you made),
- the plan note and the child refs, with their order,
- which tasks are done, which are open and why,
- the checks you ran and their result.

Keep aven refs out of commit messages and pull request descriptions: they
identify local tasks. Keep secrets out of titles, descriptions, notes, and
metadata.

## Command cheat sheet

```sh
aven context <ref>              # full task: description, relations, notes
aven text get <ref> description --output description.md
aven text set <ref> description --file description.md --if-sha256 HASH
aven edit <ref> --status active|done|todo|backlog|canceled
aven edit <ref> --epic on
aven note <ref> --stdin                 # append durable context
aven add "<title>" --project <key> --status todo --description-stdin
aven epic add <child> <epic>            # group children under the root
aven dep add <blocked> <blocker>        # execution order
aven related add <a> <b>                # symmetric context link
aven-dispatch log <ref> --event <name> --detail "<safe diagnostic>"
aven list --ready --project <key>       # what to do next
aven search --project <key> "<terms>"
```
