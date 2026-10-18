# Bundled aven workflows

Example agent workflows that the plugin can insert into a dispatch prompt with
`--skill` (for example, `--skill aven/sdd`). They are plain prompt text, not code: the Rust dispatcher
drops the YAML front matter, fills `$ARGUMENTS`/`{ARGS}`, `{ref}`, and
`{title}` from the selected task, and appends the aven handoff guidance.

- `sdd.md` — take one aven task from a rough request to shipped, keeping the
  spec in the task description, the plan in a note, the breakdown in child
  tasks, and progress in statuses and notes. It sends dispatcher diagnostics
  through `aven-dispatch log`, which maintains task-linked log entries in the
  Dispatcher Logs project.

These are examples to make your own: edit them, copy the pattern into a new
`<name>.md`, and point an `aven-commands.yaml` entry at it with
`--skill <namespace>/<name>`. Nothing here is required by the plugin, and a
skill file with its own front matter is used verbatim otherwise.
