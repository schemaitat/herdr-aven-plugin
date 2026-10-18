---
name: sdd-plan
description: Turn a selected Aven task idea into a durable, ADR-style implementation plan. Keep single-phase plans on the task; make multi-phase plans an epic with ordered phase tasks.
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

| Plan shape | Aven representation |
| --- | --- |
| One phase | Keep `{ref}` as one ordinary task. Its description is the concise spec; an ADR-style `## Plan` note holds the decision and ordered steps. |
| Two or more phases | Make `{ref}` an epic. Its description is the concise feature spec; an ADR-style `## Plan` note is the index; create one ordered child task for each phase. |

Do not create a one-child epic. Do not create a separate "planning" task: the
selected task is the plan root and remains the future implementation task or
epic.

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

For a single-phase plan, add `### Steps`, `### Trade-offs and risks`, and
`### Done criteria` to that same note. Render every ordered task as
`- [ ] TASK-NNN: <file> — <change>` and include an inline `Why:` explanation
when it is not obvious. The done criteria are the applicable `TEST-NNN` items.

For a multi-phase plan, wait to append the root note until the child tasks have
been created; then add a `### Phases` table with their actual refs:

```markdown
| # | Phase | Task | Status |
| --- | --- | --- | --- |
| 1 | <GOAL-001> | <actual Aven child ref> | todo |
```

Never put a guessed child ref in the note.

## 4. Persist a single-phase plan

When there is exactly one phase, append the completed root plan note, then mark
its planning state without marking implementation done:

```sh
aven edit {ref} --status todo \
  --metadata sdd.plan-worked-out=true \
  --metadata sdd.plan-kind=single-phase \
  --metadata sdd.plan-schema=v1
```

The root task is now the implementation task. It remains `todo` until someone
starts implementation; planning alone is not completion.

## 5. Persist a multi-phase plan as an epic

When there are two or more phases, make the root an epic and record its plan
kind before creating the children. Do not set the worked-out marker yet: a
partially-created epic is not a completed plan.

```sh
aven edit {ref} --epic on --status todo \
  --metadata sdd.plan-kind=multi-phase \
  --metadata sdd.plan-schema=v1
```

For every phase, in sequence, create exactly one child task. Its description
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

Record execution order with a single dependency chain after every child ref is
known. The second command means phase 02 is blocked by phase 01:

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
4. A one-phase plan has no epic children; a multi-phase plan has one child per
   phase, each attached to `{ref}` and chained by `aven dep add`.
5. `{ref}` has `sdd.plan-worked-out=true`, plus an accurate
   `sdd.plan-kind=single-phase|multi-phase` value.

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
