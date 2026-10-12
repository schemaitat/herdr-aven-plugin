# Changelog

## 0.4.0

- Replace the four vendored spec-kit SDD commands with one aven-native example
  workflow. `sdd` (`z s`) now takes the selected task from a rough request to
  shipped with aven as the only task store: the spec goes in the task
  description, the plan in a note, the breakdown in real aven child tasks
  (epic + `aven dep add`), and progress in task statuses and notes. It resumes
  from what is already in aven instead of writing `specs/`, `plan.md`, or
  `tasks.md`.
- `skills/aven/`: the workflow is plain prompt text, so nothing extra needs
  installing. `bin/dispatch.sh` inserts it via `AVEN_DISPATCH_SKILL`, drops its
  front matter, and fills `$ARGUMENTS`/`{ARGS}`, `{ref}` and `{title}` from the
  task. The `__SPECKIT_COMMAND_*__` rewriting is gone.
- The workflow is an example, not a built-in command: edit it in
  `aven-commands.yaml`, or add your own `<name>.md` under `skills/aven/`, and
  point an entry's `AVEN_DISPATCH_SKILL` at it.

## 0.3.0

- `aven-commands.yaml`: a plugin file declaring extra aven TUI commands next to
  the built-in `dispatch`. It ships with four spec-kit
  [SDD](https://github.com/github/spec-kit) commands active — `speckit-specify`
  (`z s`), `speckit-plan` (`z p`), `speckit-tasks` (`z t`), and
  `speckit-implement` (`z i`) — each of which runs that skill on the selected
  task in the task's worktree. Every entry is written under `tui.commands` with
  `${PLUGIN_ROOT}` replaced by the plugin directory; comment out or add entries
  as wanted. Point `AVEN_COMMANDS_FILE` at another file to use a different set.
- `skills/sdd/`: the four spec-kit SDD command files, vendored (MIT) so no
  spec-kit install or `specify` binary is needed. `bin/dispatch.sh` inserts the
  named skill into the agent prompt, dropping its front matter, rewriting its
  `/speckit-*` references, and filling `$ARGUMENTS` from the task.
- `bin/dispatch.sh`: `AVEN_DISPATCH_SKILL` names a bundled skill to insert into
  the prompt; `AVEN_DISPATCH_PROMPT` overrides the opening instruction, with
  `{ref}` and `{title}` filled from the selected task.
- `bin/dispatch.sh`: re-dispatching a task opens its existing worktree
  (`herdr worktree open`) and reuses the agent already in its pane, instead of
  failing when `herdr worktree create` finds the deterministic branch on disk.
  The SDD phases therefore share one worktree, and repeated dispatch is safe.
- `install-aven-command`: writes the built-in command and the extras as one
  managed block, reports each installed command, and rewrites the block in place
  when the commands change, so editing `aven-commands.yaml` and re-running
  applies it. Content outside the block is left untouched, and blocks written by
  older versions are upgraded.

## 0.2.1

- Fix dispatch from a pane inside a linked worktree: Herdr refuses to branch a
  new worktree from a linked worktree (`linked_worktree_source`), so the
  dispatcher resolves the repository's parent checkout
  (`git worktree list --porcelain`) before calling `herdr worktree create`.
- Surface Herdr's own error (`code` and `message`) when `worktree create`,
  `agent start`, or `agent prompt` fails, instead of a generic message.

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
