---
description: Example workflow for taking one aven task from a rough request to shipped, with aven as the only task store.
---

# Take an aven task from request to shipped

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

## 0. Read the task and find where to resume

```sh
aven context {ref}
aven show {ref} --full
aven epic list {ref}          # existing child tasks, if any
```

`context` prints the description, metadata, relations, and recent notes; when
earlier notes are omitted it ends with a `read=` command that prints their
bodies in one call.

Decide where to resume instead of redoing work:

| Already present | Skip |
| --- | --- |
| the description is a real spec | phase 1 |
| a note headed `## Plan` | phase 2 |
| child tasks under the root | phase 3 |
| nothing yet | start at phase 1 |

Work the phases below in order, but only the ones that are missing, then go
straight to implementing whatever is still open.

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

Then move the task to active:

```sh
aven edit {ref} --status active
```

## 2. Plan (as a note on the root task)

Work out *how* before writing code, and keep the plan in aven:

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

## 3. Break down into aven child tasks

Only decompose when the work is more than a trivial single change. For anything
with independent or ordered pieces:

1. Make the root task an epic and add a child per piece:

   ```sh
   aven edit {ref} --epic on
   aven add "<piece title>" --project <key> --status todo --description-stdin <<'EOF'
   Why this piece exists, plus its own acceptance criteria.
   EOF
   aven epic add <child-ref> {ref}
   ```

   Give every child enough context to stand alone: rationale, scope, and
   acceptance criteria, in its own description.

2. Express execution order with dependencies and otherwise unrelated pieces
   with relations:

   ```sh
   aven dep add <blocked-child> <blocker-child>   # this before that
   aven related add <child-a> <child-b>
   ```

3. Record the breakdown on the root task so it is discoverable:

   ```sh
   aven note {ref} --stdin <<'EOF'
   ## Breakdown
   - APP-XXXX piece one (ready first)
   - APP-YYYY piece two (after APP-XXXX)
   EOF
   ```

If the task is a single small change, skip this phase — just implement it.

## 4. Implement, tracking each task in aven

Pick the work that is ready and unblocked, in dependency order:

```sh
aven list --ready --project <key>
aven epic list {ref}
```

For each piece, and for the root task when it is not decomposed:

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
aven list --ready --project <key>       # what to do next
aven search --project <key> "<terms>"
```
