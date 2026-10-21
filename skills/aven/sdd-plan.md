---
name: sdd-plan
description: Turn a selected Aven task idea into a durable, ADR-style implementation plan with an epic root and ordered phase tasks.
---

# Plan an Aven task

You are planning the selected Aven task: the **root task** `{ref}` —
"{title}". The title and current description also arrive as `$ARGUMENTS`.

This workflow turns a rough task idea into a durable implementation plan. It
does **not** implement the plan. Aven is the only planning store: do not create
`.ronin/plans`, `plan.md`, `specs/`, `tasks.md`, or another planning artifact in
the repository. Keep all durable plan content in the root task, its notes, and
(when needed) its epic children.

Never invent an Aven ref. Use the qualified refs Aven prints. If `{ref}` was not
substituted, take it from the `aven context <ref>` command in the dispatcher
handoff at the end of this prompt.

## 0. Read the idea and resume safely

Start with the current task and its existing planning state:

```sh
aven context {ref} --full
aven show {ref} --json
aven epic list {ref}
```

The root task uses `sdd.plan-worked-out=true` as the authoritative marker that
this workflow has already produced a plan. Inspect the metadata returned by
`context` or `show` for that exact key **before** researching or writing.

- If it is `true`, do not create a second plan, duplicate phase tasks, or alter
  the prior breakdown. Read the existing plan note and epic children, report the
  existing plan's kind and refs, and stop. Only revise a worked-out plan when
  the user explicitly asks for a revision; append a dated `## Plan revision`
  note and update the existing tasks rather than replacing their history.
- If the marker is absent or not `true`, continue. Existing description, notes,
  relations, and children are evidence to incorporate, not content to discard.

## 1. Gather and label the decision

Confirm the goal in one sentence when it is not clear from the task. Explore
the codebase enough to identify affected files, established patterns,
dependencies, and verification commands. Ask questions only when a high-impact
choice has no reasonable default; otherwise record the chosen default as an
assumption.

Use these labels as in-context reasoning scaffolding while drafting; do not
write them to a separate file. Declare every label once and reuse it by
reference where useful:

- `REQ-NNN`, `SEC-NNN`, `CON-NNN`, `GUD-NNN`, `PAT-NNN` — requirements and
  constraints
- `GOAL-NNN`, `TASK-NNN` — one goal and its ordered tasks per implementation
  phase
- `ALT-NNN`, `DEP-NNN`, `FILE-NNN`, `TEST-NNN`, `RISK-NNN`,
  `ASSUMPTION-NNN` — decisions, dependencies, files, verification, and risk

Flatten the result into one strictly linear delivery sequence. A phase may
depend only on its immediately preceding phase. Within a phase, each task may
depend only on the immediately preceding task. Do not create parallel branches,
merges, forward references, or cycles.

## 2. Decide the Aven layout

Count the implementation phases from the labelled plan:

Make `{ref}` an epic for every plan. Its description is the concise feature
spec; its ADR-style `## Plan` note is the permanent index; and every
implementation phase is an ordered child task.

Create exactly one child for a one-phase plan and one child per phase for a
multi-phase plan. Do not create a separate "planning" task: the selected task
is the permanent epic root, never the executable implementation task.

## 3. Write the root spec and ADR-style plan

First refine the root description into a short, testable specification. Preserve
useful existing text and replace it directly with `aven edit {ref}
--description-stdin`; do not create a repository file just to draft the plan.
Include Goal, Requirements, Acceptance criteria, Out of scope, Assumptions, and
Open questions when they apply.

Draft one root note headed `## Plan`. It must read as an
Architectural Decision Record, not merely a checklist:

```markdown
## Plan

### Context
Why this work is needed now, the relevant current state, and the requirements
or constraints shaping it.

### Decision
The chosen approach and why it wins over the alternatives. State the accepted
trade-offs and the constraints that shaped the choice.

### Alternatives considered
| Option | Why rejected |
| --- | --- |
| … | … |

### Consequences
What becomes easier, harder, or different. Include dependencies, risks, and
assumptions.

### Affected files
- `path/to/file` — intended change

### Open questions
Unresolved assumptions, or `None.`
```

Wait to append the root note until the child tasks have been created; then add
a `### Phases` table with their actual refs. A one-phase plan has one row:

```markdown
| # | Phase | Task | Status |
| --- | --- | --- | --- |
| 1 | <GOAL-001> | <actual Aven child ref> | todo |
```

Never put a guessed child ref in the note.

## 4. Persist every plan as an epic

Make the root an epic and record its plan kind before creating its one or more
children. Do not set the worked-out marker yet: a partially-created epic is not
a completed plan.

```sh
aven edit {ref} --epic on --status todo \
  --metadata sdd.plan-kind=multi-phase \
  --metadata sdd.plan-schema=v1
```

For every phase, including the only phase of a one-phase plan, create exactly
one child task. Its description
must be an ADR-style vertical-slice record containing:

- **Goal** — what the phase achieves and why it is the next slice.
- **Why this phase exists** — why this boundary is preferable, naming only the
  immediately preceding phase as its dependency (or none for phase 1).
- **Steps** — unchecked, ordered `TASK-NNN` items with `Why:` notes when useful.
- **Trade-offs and risks** — applicable risks and assumptions.
- **Done criteria** — the phase's concrete verification items.

Create each child with its actual scope and then attach the returned ref to the
root epic:

```sh
aven add "<phase title>" --project <root-project-key> --status todo \
  --description-stdin \
  --metadata sdd.plan-root={ref} \
  --metadata sdd.plan-phase=01 <<'EOF'
## Goal
…
EOF
aven epic add <actual-phase-ref> {ref}
```

For plans with multiple phases, record execution order with a single dependency
chain after every child ref is known. The second command means phase 02 is
blocked by phase 01. A one-phase plan has no dependency:

```sh
aven dep add <phase-02-ref> <phase-01-ref>
```

Continue this pattern through the final phase; do not add a child with multiple
blockers. Then append the one root `## Plan` note with the real phase refs and
the phase table, and finalise the completed plan marker:

```sh
aven edit {ref} --status todo \
  --metadata sdd.plan-worked-out=true \
  --metadata sdd.plan-kind=multi-phase \
  --metadata sdd.plan-schema=v1
```

The root epic stays `todo`; each child is the independently trackable
implementation unit.

## 6. Validate before finalising

Before writing the final metadata, inspect the content you assembled:

1. Every identifier is declared exactly once.
2. The phases and the tasks within each phase are a single linear chain, with no
   branches, merges, cycles, or forward references.
3. The decision, alternatives, consequences, risks, affected files, open
   questions, and verification are all present in the root plan or applicable
   phase task.
4. Every plan root is an epic. A one-phase plan has exactly one child; a
   multi-phase plan has one child per phase. Every child is attached to `{ref}`
   and multiple phases are chained by `aven dep add`.
5. `{ref}` has `sdd.plan-worked-out=true`, plus
   `sdd.plan-kind=multi-phase`.

Fix and re-check any failure before reporting completion. Do not set
`sdd.plan-worked-out=true` until the plan is durable and all required tasks are
attached.

## 7. Report and hand off

Finish with a short summary of the decision, the root task/epic ref, plan kind,
and every phase-child ref in execution order. State that
`sdd.plan-worked-out=true` prevents accidental replanning. Mention the most
important assumptions or open questions and the verification criteria. Do not
implement code or mark the root or any child `done` during this workflow.

## Command cheat sheet

```sh
aven context <ref> --full
aven show <ref> --json
aven edit <ref> --status todo --epic on --metadata key=value
aven note <ref> --stdin
aven add "<phase title>" --project <key> --status todo --description-stdin
aven epic add <child-ref> <epic-ref>
aven epic list <epic-ref>
aven dep add <blocked-child> <blocker-child>
```
