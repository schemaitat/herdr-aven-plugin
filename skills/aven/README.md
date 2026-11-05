# Bundled aven workflows

Example agent workflows that the plugin can insert into a dispatch prompt with
`--skill` (for example, `--skill aven/sdd-plan`). They are plain prompt text, not code: the Rust dispatcher
drops the YAML front matter, fills `$ARGUMENTS`/`{ARGS}`, `{ref}`, and
`{title}` from the selected task, and appends the aven handoff guidance.

- `sdd-plan-implement.md` — take one aven task from a rough request to shipped, keeping the
  spec in the task description, creates the durable plan marker, then
  implements it. The plan lives in a note, the breakdown in child tasks, and
  progress in statuses and notes. It sends dispatcher diagnostics through
  `aven-dispatch log`, which maintains task-linked log entries in the Dispatcher
  Logs project.
- `sdd-plan.md` — turn a selected task idea into an ADR-style Aven plan without
  implementing it. Every plan turns the root into an epic with one ordered
  child task per implementation phase, including a single phase. The root's
  `sdd.plan-worked-out=true` metadata prevents accidental duplicate plans.
- `sdd-implement.md` — implements only a plan whose root has
  `sdd.plan-worked-out=true`; otherwise it stops and directs the user to plan
  first. It handles a selected phase child or planned root epic.

All three workflows treat `done` as acceptance and require a separate delivery
checkpoint. Use the dispatcher commands rather than prose-only promises:

- `aven-dispatch closeout <ref> --project <key>` — read-only delivery
  verification against the configured local target; `--apply` records evidence
  and resolves only matching obligations after a human-triggered merge.
- `aven-dispatch disposition <ref>` — read-only cancellation inventory;
  `--apply --reason ... --successor ...|--no-successor` preserves artifacts and
  an auditable decision.
- `aven-dispatch recovery` — read-only recovery-record inventory; retirement
  needs `--apply --task ... --reason ...` and is non-destructive.
- `aven-dispatch board --project <key>` — reviewed proposals for childless or
  incomplete epics; apply only explicit task refs.
- `aven-dispatch audit --project <key>` — read-only lifecycle audit. Exit codes:
  `0` complete and clean, `1` violations, `2` incomplete/unknown required source.

These are examples to make your own: edit them, copy the pattern into a new
`<name>.md`, and point an `aven-commands.yaml` entry at it with
`--skill <namespace>/<name>`. Nothing here is required by the plugin, and a
skill file with its own front matter is used verbatim otherwise.
