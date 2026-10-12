# Changelog

## 0.2.0

- `install-aven-command`: adds the `dispatch` custom TUI command to aven's
  `config.yaml` (backed up and validated), so a selected task can be sent to an
  agent with `z d`.
- `bin/dispatch.sh`: creates a Git worktree on a `<project>/<task>-<slug>`
  branch, starts a coding agent in it, prompts it with the task, then sets the
  task active and leaves a handoff note in aven.
- Nested JSON path support in the shared helpers (`json_query`), with jq and
  python3 backends; dispatch requires one of them.

## 0.1.0

- Open the aven TUI as a Herdr popover over the focused pane, scoped to the
  project aven infers from the pane's directory (`aven tui -p`).
- Add-task composer popover (`aven tui -p --add-task-only`).
- `install-keybindings` action that appends `prefix+a` and `prefix+shift+c`,
  validates the config with `herdr config check`, and restores it on failure.
- `doctor` action that reports the popover directory, workspace and inferred
  project.
