# Bundled aven workflows

Example agent workflows that the plugin can insert into a dispatch prompt with
`AVEN_DISPATCH_SKILL`. They are plain prompt text, not code: `bin/dispatch.sh`
drops the YAML front matter, fills `$ARGUMENTS`/`{ARGS}`, `{ref}`, and
`{title}` from the selected task, and appends the aven handoff guidance.

- `sdd.md` — take one aven task from a rough request to shipped, keeping the
  spec in the task description, the plan in a note, the breakdown in child
  tasks, and progress in statuses and notes.

These are examples to make your own: edit them, copy the pattern into a new
`<name>.md`, and point an `aven-commands.yaml` entry at it with
`AVEN_DISPATCH_SKILL: <name>`. Nothing here is required by the plugin, and a
skill file with its own front matter is used verbatim otherwise.
