# Changelog

## Unreleased

- Fix the Kanban **Merge** and **Ship PR** handoff choosing the wrong app space:
  the selector now uses the live terminal of a space's first tab to find the
  repository's primary checkout instead of the space's configured `folder`,
  which is only where its new terminals start. A `$HOME`-foldered main space is
  found again, and another project's space carrying a stale checkout folder can
  no longer capture the handoff.
- Paint the optional **Aven right** layout in the Kanban Board palette: the
  graphite near-black canvas and chrome, lilac accent, JetBrains Mono/Geist
  type, compact pane frames and focus border. The look is scoped to that layout
  and leaves the personal `main` layout and global app theme alone.
- Give each Aven project a stable colour in the right-side Aven panel using the
  Board chip palette and project-name hash. Epic rows show a project-colour
  left bar and chip; the colour is presentation-only and matches the Kanban
  project chips.
- Show the focused root epic's full phase plan in the Aven worktree card, mark
  the currently active phase, and mark the selected phase worktree when it is
  different so a reviewer can see both the plan and their checkout at once.
  Each phase carries a one-line description and opens its full description in
  a single-open accordion; the current task also shows a small description.
- Paint the Aven Kanban board as soon as its bounded list reads finish instead
  of waiting for every epic detail and local-main ancestry check. Details and
  delivery evidence now enrich the same cards in the background with a
  four-worker limit, the board labels incomplete enrichment, and Archive stays
  fail-closed until classification is complete while Merge and Ship keep their
  exact fresh-approval re-read. The ancestry check waits briefly for the space's
  live checkout, and early navigation and archive presses replay on the
  authoritative board.
- Redraw the Kanban overlay in the herdr-layouts Board style: a today strip,
  NEXT MOVE banner, project chips, and BACKLOG / NEEDS YOU / WORKING / READY TO
  LAND / DONE columns with colour bars, agent glyphs, timers, facts and
  warnings. Cards gain **Answer** and **Go to agent** for live blocked agents,
  **Ship PR** as a separate approved agent handoff, and local **Archive** /
  **Archive all** for Done. Questions are read from the blocked agent's screen;
  Merge keeps the durable `/ha-merge` gate and the board still never mutates
  Git or Aven itself.
- Fix the Kanban **Merge into main** handoff for OpenCode: Herdr appends the
  first message as a positional argument, so launch OpenCode with `--prompt`
  instead of letting `/ha-merge <task-id>` be mistaken for a project directory
  and fail with `ENOENT ... chdir`. Non-OpenCode merge agents are unchanged.
- Gate Kanban's "ready to merge" label and merge action on the complete
  dispatcher approval marker (`approval.state`, id, commit, workflow) and a
  `done` task, re-reading approval-sensitive details every refresh and again
  before opening `/ha-merge`. Incomplete or stale approvals stay visible as an
  explanation instead of a misleading merge handoff.
- Remove the `aven-worktree` herdr-app panel and stop splitting an Aven pane
  beside dispatched agent terminals. The Aven-right layout panel now describes
  the focused worktree: root epic and progress, focused phase and position,
  task status, dispatch/agent state, and one lifecycle stage. A first visit to
  a dispatched worktree reveals Aven while explicit Files/Changes choices win,
  and focus changes refresh the card immediately. An upgrade removes the
  retired plugin-installed panel while leaving an edited or foreign copy alone.
- Tune Cargo profiles: release builds use `opt-level = "s"`, thin LTO, a single
  codegen unit, and stripped symbols for a much smaller `aven-dispatch` binary,
  while dependency crates build at `opt-level = 2` in dev for faster local runs.
- Add `/approve` and commit-bound approval journals: the actual required checks
  run before accepting a final task/epic result, independently of terminal state.
  Remove the circular root-done/delivery gate from bundled implementation agents.
- Make `/ha-merge <task-id> [<task-id> ...]` a human-triggered batch workflow from
  main. Approved source commits are integrated in an isolated worktree, conflicts
  are resolved by the finish agent, and combined review/checks precede the only
  update of main. Child-first delivery closeout is automatic and journaled;
  the watcher retries metadata-only finalization after an already-proven merge.
- Install both finish commands; `just install-commands --upgrade` explicitly
  backs up older regular definitions without replacing symlinks. Add
  `just test-approval` for real-Git/disposable-source regression coverage.

- Remove the obsolete interactive dispatcher TUI (`aven-dispatch tui`) and its
  `ratatui` dependency, PTY fixtures, `just tui`/`just test-tui` recipes, and
  herdr-app inspector launchers. The non-interactive `aven-dispatch inspect
  --json` snapshot remains the diagnostics surface, and Aven's own TUI is
  unchanged.
- Install a bundled `herdr-aven-tasks` OpenCode skill with `just install`. It
  triages Aven tasks against dispatcher attempts, `hc` terminals, and OpenCode
  sessions, and reports running, awaiting-review, stale, and not-started work.
  The installer never overwrites a differing skill or a symlink; re-run
  `just install-skill` after an upgrade.
- Reveal the Aven terminal on the first overlay attempt. herdr-app adopts a
  terminal a moment after `hc run --bg` returns its address, so the overlay now
  probes the peek with a bounded retry before closing, and reuses live core
  terminals instead of a stale snapshot. This removes the intermittent
  terminal-not-found error that always disappeared on the second try.
- List every chat model enabled by the configured OpenCode providers in the
  dispatcher's model picker instead of a curated GitHub Copilot list. The
  listing is scoped to the dispatch worktree and falls back to the built-in
  choices if OpenCode cannot answer.
- Let the agent and model pickers filter live as you type after `/`, with
  arrow-key navigation and Enter to select. Piped input keeps the numbered
  line protocol for scripts and tests.
- Stop hiding the bundled `aven-babysitter` and `aven-orchestrator` profiles.
  OpenCode's TUI cannot adopt a hidden session agent, so an attached terminal
  showed `build` and silently switched the session agent on the next prompt.
  Existing installed copies of the previous bundled form are upgraded in place;
  user-edited files are still never overwritten.
- Point the babysitter's supervision prompt at the builder terminal instead of
  its own pane, which previously instructed it to supervise itself.
- Add the optional `aven-worktree` herdr-app panel. Each dispatched worktree
  space now opens an **Aven** pane beside the agent terminal showing the root
  epic, phase progress, the current task, the persisted dispatcher/agent state,
  and a click-to-peek attempt terminal. The dispatcher passes the immutable task
  ref and records whether the panel was created, so re-dispatch never
  duplicates it. The empty shell started by `space.new` is removed once the
  attempt terminal is adopted. Aven and dispatcher data stay read-only.
- Resolve the OpenCode executable before launching it and pass the absolute path
  to herdr-core. A core started by the desktop app can have a smaller `PATH`
  that omits `~/.opencode/bin`, which previously made the agent terminal exit
  127 even though the dispatcher's API calls worked. The dispatcher now checks
  `OPENCODE_BIN`, the first `opencode` on `PATH`, `~/.opencode/bin`,
  `~/.local/bin`, standard bin directories, and reports those locations if none
  exist.

## 1.0.0

- Migrate the dispatcher runtime from the retired `herdr` plugin interface to
  herdr-core (`hc`). Terminals are dedicated herdr-core terminals that survive
  the short-lived Aven popup; every worktree discovery, creation, cleanliness
  check, fast-forward integration, and removal now runs through
  `hc exec --cwd <repo> git ...`.
- Persist durable core and terminal identities (`core_id`, address, ownership
  labels, role) for builders, coordinators, babysitters, and phase workers,
  alongside the legacy pane fields as read-only historical evidence. A kept
  terminal recovered with a shell is not treated as a resumed OpenCode process.
- Add the event-driven `aven-dispatch watch` supervisor with explicit
  start/status/stop and one-owner-per-store locking. It starts from a core
  snapshot, records ordered fact changes and missed-event gaps, and reconciles
  authoritative OpenCode/Aven state without repeating launches or prompt
  admission. A bounded periodic pass covers changes without a core event.
- Add `aven-dispatch message` for guarded `hc send --if idle --wait` supervisor
  interaction. It refuses blocked programs instead of bypassing permission
  dialogs.
- Make admission and advancement crash-safe: phase prompts are checkpointed
  before admission and a prompt-pending phase re-admits the exact same message
  id. A reservation that crashed before session creation is discarded only when
  its checkout is proven owned and clean; a reused or dirty checkout is
  preserved for inspection.
- Persist worktree ownership intent and the attempt reservation before pickers
  or OpenCode side effects, and remove exactly that reservation when
  provisioning fails.
- When herdr-app is available, every dispatched worktree gets a sidebar space
  named for the task. The attempt terminal is labelled with that space/tab so
  it appears immediately; headless dispatch is unchanged when the app is
  absent.
- Add `dispatch --relaunch` for an explicit, safe migration of a legacy Herdr
  attempt's durable OpenCode session. Normal dispatch refuses legacy records
  rather than reinterpreting pane ids as core terminal addresses.
- Replace the legacy `herdr-plugin.toml` popup manifest, `bin/run.sh`, and
  Herdr keybinding installer with the repository-owned optional
  `app/` herdr-app mod. `scripts/install-app-mod.sh` installs only owned mod
  files, merges free keys, preserves unrelated settings, and never replaces an
  existing binding. Inside the overlay, `o` opens the Aven TUI, `a` opens the
  add-task composer, `r` refreshes terminals, and `Esc` closes it.
- Dashboard sources now split herdr-core terminal facts, `hc exec` Git worktree
  inventory, and optional herdr-app placement. Terminals are entities distinct
  from legacy panes; core status, persisted execution state, OpenCode API
  activity, and Aven acceptance remain separately labelled.
- Update bundled agents for `hc ls/get/read/wait/send` supervision, no sleep or
  poll loops, permission escalation, and safe recovery.
- `aven-dispatch doctor` now validates the core identity and required
  `events.subscribe`/`terminal.send` capabilities, and treats a missing desktop
  app as a supported headless state.

- `aven-dispatch` now keeps all execution state in one central SQLite database
  at `$XDG_STATE_HOME/aven/dispatch.sqlite` (fallback
  `~/.local/state/aven/dispatch.sqlite`), shared by every checkout, worktree,
  and project. `--store` / `AVEN_DISPATCH_STORE` still override the path and the
  resolved path still propagates to spawned panes.
- Hard cut: no JSON `.aven-dispatch/state.json` store is created, read, or
  migrated. Finish or `aven-dispatch reset` older in-flight attempts recorded
  only in JSON, then re-dispatch them.
- SQLite WAL, `busy_timeout`, and a transactional check-then-insert replace the
  fs2 advisory lock. The `(task_id, workflow)` primary key preserves same-task
  uniqueness while different tasks/projects may dispatch concurrently.
- The web dashboard reads the same central store read-only through `node:sqlite`
  (bounded to 2000 attempts), so every configured project sees its dispatcher
  attempts. An absent or locked store keeps the existing `unavailable` health
  and Aven recovery snapshots.
- Fixed dispatch from a linked worktree: Herdr worktree create/open now start
  from the repository's primary checkout while the branch lookup stays scoped
  to that repository.

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
