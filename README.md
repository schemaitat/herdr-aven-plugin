# herdr-aven-plugin

[![Herdr plugin](https://img.shields.io/badge/herdr-plugin-76e6a3)](https://herdr.dev/plugins)
[![Requires Herdr 0.9.0 or newer](https://img.shields.io/badge/herdr-%E2%89%A50.9.0-6db8ff)](https://herdr.dev/docs/plugins/)
![Platforms: Linux and macOS](https://img.shields.io/badge/platform-linux%20%7C%20macos-f2c66d)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Open the [aven](https://aventasks.dev) task TUI as a [Herdr](https://herdr.dev)
popover, scoped to the project aven infers from the focused pane's directory.

Press the key, get the full aven TUI floating over your work, quit with `q`, and
the pane underneath is exactly as you left it.

```
   focused pane  (cwd: ~/code/app)                 aven popover  (prefix+a)
   ┌──────────────────────────────┐                ┌──────────────────────────────┐
   │ $ opencode                   │   prefix+a     │ aven v0.1.47                 │
   │                              │ ─────────────▶ │ ws default │ scope project    │
   │                              │                │ view queue │ order ranked     │
   └──────────────────────────────┘                │  › APP-7KQ9  Decide the ...   │
                                                   │    APP-79F0  Planner: ...     │
                                                   └──────────────────────────────┘
```

## Features

- **Popover TUI** — `prefix+a` opens the full aven TUI over the focused pane
  (80% × 80%). It is session-modal, changes no layout, tab, or pane focus, and
  disappears when aven exits.
- **Project inferred from the cwd** — the popover starts in the focused pane's
  directory and runs `aven tui -p`, so aven scopes to the project inferred from
  that directory and falls back to workspace scope when there is none.
- **Quick capture** — `prefix+shift+c` opens aven's add-task composer in a small
  popover and closes it after you submit.
- **Dispatch to an agent** — with the aven command installed, select a task and
  press `z d`: the plugin creates a Git worktree on a task branch, starts a
  coding agent there, and prompts it to implement the task (see
  [Dispatch a task to an agent](#dispatch-a-task-to-an-agent)). An
  [example aven-native task workflow](#example-an-aven-native-task-workflow) is
  installed next to it, and you can add more in `aven-commands.yaml`.
- **Follows the pane** — Herdr panes and worktrees each carry their own
  directory, so the popover follows whichever pane you opened it from.
- **No build step** — POSIX shell, run through `sh`. Nothing to compile or
  install beyond `aven` itself.

## Requirements

- [Herdr](https://herdr.dev) 0.9.0 or newer.
- [aven](https://aventasks.dev) on `PATH`. Set `AVEN_BIN` (see
  [Configuration](#configuration)) if it is installed somewhere Herdr's
  environment does not see.
- `jq` or `python3` for **dispatch only** (aven's custom-command context is
  nested JSON; the popover itself needs neither).
- A coding agent on `PATH`. Dispatch defaults to [opencode](https://opencode.ai);
  `herdr integration install opencode` teaches Herdr to track its
  working/idle/done state.
- No extra tooling for the bundled workflow: the
  [example task workflow](#example-an-aven-native-task-workflow) is plain prompt
  text that ships in the plugin and is inserted into the agent prompt.

## Install

From GitHub:

```sh
herdr plugin install schemaitat/herdr-aven-plugin
```

Or link a local checkout:

```sh
herdr plugin link /path/to/herdr-aven-plugin
```

Then add the key bindings and reload the config:

```sh
herdr plugin action invoke aven.tasks.install-keybindings
```

To send selected tasks to a coding agent, also install the aven command:

```sh
herdr plugin action invoke aven.tasks.install-aven-command
```

Finally, check the setup:

```sh
herdr plugin action invoke aven.tasks.doctor
```

`doctor` names the directory and project a popover would open in:

```
aven tasks popover
  plugin       aven.tasks
  root         /home/you/.local/share/herdr/plugins/aven.tasks
  config       /home/you/.config/herdr/plugins/config/aven.tasks
  state        /home/you/.local/state/herdr/plugins/aven.tasks
  herdr        /home/you/.local/bin/herdr
  start        /home/you/code/app
  workspace    /home/you/code/app
  aven         /home/you/.local/bin/aven (aven 0.1.47)
  project      app

The popover opens scoped to project app (aven tui -p).
```

### Key bindings

| Chord | Action | Does |
| --- | --- | --- |
| `prefix+a` | `open` | Open the aven TUI popover, scoped to the inferred project |
| `prefix+shift+c` | `compose` | Add a task in a small popover (`aven tui -p --add-task-only`) |

`prefix` is `ctrl+b` by default.

`install-keybindings` is idempotent and safe to re-run: it appends a binding
only when the action is not bound yet and the chord is free, never takes a chord
Herdr uses itself, validates the file with `herdr config check`, and restores
the previous config if Herdr rejects it. If a chord is taken, it reports the
conflict and leaves the existing binding alone. Add your own entry instead:

```toml
[[keys.command]]
key = "prefix+shift+e"
type = "plugin_action"
command = "aven.tasks.open"
description = "open the aven task popover"
```

## Actions

| Action | Does |
| --- | --- |
| `open` | Open the aven TUI popover over the focused pane |
| `compose` | Open aven's add-task composer in a popover |
| `install-keybindings` | Add the bindings above and reload the config |
| `install-aven-command` | Add the `dispatch` command and the `aven-commands.yaml` examples to aven's `config.yaml` |
| `doctor` | Show the directory, workspace and project a popover would open in |

Every action is also available from the command line and the Herdr action menu:

```sh
herdr plugin action invoke aven.tasks.open
herdr plugin action invoke aven.tasks.doctor
herdr plugin action list --plugin aven.tasks
```

## Dispatch a task to an agent

With `install-aven-command` run once, the aven popover gains a `dispatch`
command. Select a task in the list (or open its detail) and press **`z d`**, or
run `:dispatch` from the palette. The popover closes and Herdr switches to a new
worktree workspace where an agent is already working on the task:

```
   aven popover  (prefix+a)                        new worktree workspace
   ┌──────────────────────────────┐                ┌──────────────────────────────┐
   │  › APP-7KQ9  Decide the ...   │     z d        │ opencode                      │
   │    APP-79F0  Planner: ...     │ ─────────────▶ │ > Implement APP-7KQ9: ...     │
   │                              │                │   branch app/7kq9-decide-...  │
   └──────────────────────────────┘                └──────────────────────────────┘
```

What the `dispatch` command does:

1. reads the selected task from aven's versioned JSON context,
2. creates a Git worktree on a branch named `<project>/<task-suffix>-<slug>`
   (`herdr worktree create`), or opens the task's existing worktree
   (`herdr worktree open`) when that branch is already on disk,
3. starts the agent in the worktree's root pane (`herdr agent start`), or
   prompts the agent already there,
4. prompts it with the ref, title, and description, telling it to use
   `aven context`, `aven note`, and `aven edit … --status done` as it works
   (`herdr agent prompt`),
5. sets the task to `active` and leaves a handoff note naming the worktree,
   branch, and pane.

Task text is passed to `herdr` and `aven` only as argv or standard input, never
evaluated as shell, so titles and descriptions need no escaping.

### Configuration

Set these in the environment Herdr starts from, or in the `env:` map of an
[extra command](#extra-commands). `install-aven-command` owns the built-in
`dispatch` entry, so a hand edit to its `env:` map is dropped the next time the
installer runs.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AVEN_DISPATCH_AGENT` | `opencode` | Agent to start in the worktree |
| `AVEN_DISPATCH_KIND` | the agent name | Herdr agent kind passed to `agent start` |
| `AVEN_DISPATCH_BASE` | Herdr's choice | Base ref for the new branch |
| `AVEN_DISPATCH_PROMPT` | `Implement {ref}: {title}` | Opening instruction for the agent; `{ref}` and `{title}` are filled from the selected task |
| `AVEN_DISPATCH_SKILL` | unset | Name of a bundled workflow under `skills/aven` (e.g. `sdd`); its text replaces `AVEN_DISPATCH_PROMPT` |
| `AVEN_DISPATCH_NO_FOCUS` | unset | `1` leaves focus where it is instead of switching to the worktree |
| `AVEN_DISPATCH_DRY_RUN` | unset | `1` prints the plan and changes nothing |
| `AVEN_DISPATCH_BACKEND` | `shell` | Set to `rust` to opt into the durable OpenCode V2 dispatcher |

`AVEN_DISPATCH_PROMPT` starts any agent workflow, and `AVEN_DISPATCH_SKILL`
takes precedence by inserting a bundled workflow (see the
[example task workflow](#example-an-aven-native-task-workflow)). Either way the
aven handoff guidance is appended, so the agent still reads the task and leaves
notes.

### Rust OpenCode V2 dispatcher (preview)

The shell dispatcher remains the default migration fallback. To route the
existing **`z d`** and **`z s`** entries through the Rust dispatcher without
changing Aven's safe stdin context handling, set this in the environment that
starts Herdr:

```sh
export AVEN_DISPATCH_BACKEND=rust
```

The first use builds the bundled binary with Cargo; deployers can build it in
advance and set `AVEN_DISPATCH_BIN=/path/to/aven-dispatch`. The binary accepts
the versioned Aven command context on stdin and supports:

```sh
aven-dispatch doctor
aven-dispatch dispatch --agent build < context.json
aven-dispatch list --running
aven-dispatch status HAP-FTYE
aven-dispatch reconcile HAP-FTYE
aven-dispatch interrupt HAP-FTYE
```

Operational state defaults to `.aven-dispatch/state.json` (override with
`AVEN_DISPATCH_STORE`). It links immutable task IDs, attempt IDs,
branch/worktree, OpenCode session IDs, caller-selected prompt IDs, and pending
Aven mutations. It never stores credentials in Aven. `status` surfaces pending
OpenCode permissions/forms without approving them, and prompt admission is not
task completion. `list` prints all persisted attempts; `list --running` limits
the output to attempts whose dispatcher execution state is `running`.

Set the primary OpenCode agent for a dispatch with `--agent <name>` (or the
`AVEN_DISPATCH_AGENT` environment variable). The selected agent is sent during
session creation and persisted with the attempt, so operators can see which
agent owns a running dispatch:

```sh
aven-dispatch dispatch --agent build < context.json
# equivalent for an Aven custom-command environment
export AVEN_DISPATCH_AGENT=build
```

Example extra command, wired to a second agent (the full file is documented
[below](#extra-commands)):

```yaml
- name: dispatch-claude
  description: Implement the selected task with Claude in a Herdr worktree
  program: sh
  args: ["${PLUGIN_ROOT}/bin/dispatch.sh"]
  keys: [z c]
  target: focused
  execution: wait
  on_success: quit
  env:
    AVEN_DISPATCH_AGENT: claude
```

### Example: an aven-native task workflow

`install-aven-command` also installs one example command, `sdd` on **`z s`**,
that shows how to use `dispatch` plus aven for efficient task management. It is
an example, not a built-in command: edit it, rebind it, or delete it in
`aven-commands.yaml`.

| In the popover | Command | Inserted workflow |
| --- | --- | --- |
| `z s` | `sdd` | `skills/aven/sdd.md` |

The command sets `AVEN_DISPATCH_SKILL: sdd`, and `dispatch.sh` inserts that
file's text into the agent prompt with the task as its `$ARGUMENTS`, dropping
the file's front matter and filling `{ref}` and `{title}`. The file is plain
prompt text that ships in the plugin, so **nothing extra needs installing**.

The workflow keeps aven as the only task store: it writes the spec into the
selected task's description, the plan into a note, the breakdown into real aven
child tasks (making the root an epic and linking children with `aven epic add`
and `aven dep add`), and tracks progress with task statuses and notes — no
`specs/`, `plan.md`, or `tasks.md` files. It resumes from what is already in
aven, so running it again on the same task continues instead of starting over.

It uses the plugin's generic `AVEN_DISPATCH_SKILL` mechanism, so it is not wired
into the plugin itself. To make your own workflow, add a `<name>.md` under
`skills/aven/` and an `aven-commands.yaml` entry that sets
`AVEN_DISPATCH_SKILL: <name>`; see
[Extra commands](#extra-commands) and `skills/aven/README.md`.

The command targets the task's worktree: re-running it opens and reuses the
worktree and the agent session already there (`herdr worktree open`), so the
work continues in one place.

### Extra commands

`aven-commands.yaml` in the plugin directory declares the commands
`install-aven-command` writes under `tui.commands`, after the built-in
`dispatch`. It ships with the one
[example workflow](#example-an-aven-native-task-workflow) active and more
examples commented out. Comment out or add an entry, then re-run the installer
to apply the change:

```sh
herdr plugin action invoke aven.tasks.install-aven-command
```

Reopen the popover afterwards; aven reads `tui.commands` at startup.

Each active entry is written at the file's left margin (`- name:`) with its
fields indented relative to it. The installer indents the whole entry under
`tui.commands` and replaces `${PLUGIN_ROOT}` with the plugin directory, so a
command can point at `bin/dispatch.sh` or another script here. Fields and
defaults follow aven's [custom TUI command
schema](https://aventasks.dev/custom-commands/); `name` and `program` are
required, and names must be unique across custom and built-in commands. Set
`AVEN_COMMANDS_FILE` to a different path to use another set of extra commands.

The installer writes dispatch and the extras as one managed block. When the
commands change it rewrites that block in place, leaving anything outside it
untouched, and restores the previous file if aven can no longer parse the
result.

## How it works

1. You press `prefix+a`. The bound action runs
   `herdr plugin pane open --plugin aven.tasks --entrypoint tui`, which Herdr
   answers by opening the manifest's `tui` pane as a session-modal popup.
2. Herdr starts the pane command (`sh bin/run.sh pane`) with the plugin
   directory as its working directory, and injects the invocation context as
   `HERDR_PLUGIN_CONTEXT_JSON`.
3. The pane script reads `focused_pane_cwd` — the focused pane's current
   directory — falls back to `workspace_cwd` and then `$HOME`, `cd`s there, and
   runs `aven tui -p`.
4. Aven infers the workspace and project from that directory and opens the TUI.
   The bare `-p` means "infer from the current directory, otherwise use
   workspace scope", so nothing breaks outside a project.

`focused_pane_cwd` is preferred over the workspace root because Herdr panes and
worktrees each carry their own directory: the popover opens where you are, not
where the whole workspace is. Paths are read with `jq`, then `python3`, then a
built-in `awk` fallback, so the plugin has no runtime dependency of its own.

The manifest declares both panes with `placement = "popup"`, so each one is
session-modal, changes no layout, and closes when aven exits. Popups have no
pane ID and do not appear in the pane list, so they never become part of your
saved layout.

Dispatch is the mirror image: `install-aven-command` writes a `tui.commands`
entry into aven's own `config.yaml` whose program is `sh` with
`bin/dispatch.sh` as its argument (aven execs programs directly, and this keeps
the script runnable wherever it lives). Because the popover is a child of the
plugin pane, aven and its command inherit `HERDR_BIN_PATH` and
`HERDR_SOCKET_PATH`, so the dispatcher can drive Herdr from inside the popup.

### Popover or overlay?

If you would rather have the TUI as a normal zoomed pane you can move and
resize, Herdr can override the placement at open time:

```sh
herdr plugin pane open --plugin aven.tasks --entrypoint tui --placement overlay
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `AVEN_BIN` | Path or command name of the aven executable, when it is not on `PATH` |

Herdr sets the rest of the plugin environment (`HERDR_PLUGIN_*`,
`HERDR_BIN_PATH`); you do not set those yourself. Dispatch has its own
`AVEN_DISPATCH_*` overrides, listed
[above](#dispatch-a-task-to-an-agent).

## Troubleshooting

**The popover flashes and closes immediately.** The pane command failed. Read
its output from the plugin log:

```sh
herdr plugin log list --plugin aven.tasks
```

The most common cause is that `aven` is not on the environment Herdr runs panes
in. Check with `herdr plugin action invoke aven.tasks.doctor`; if `aven` is
`NOT FOUND`, set `AVEN_BIN` in the environment Herdr starts from.

**The popover opens, but at workspace scope instead of a project.** Aven infers
the project from the popover's directory. Run `doctor` to see the directory it
resolved, and confirm the focused pane is really inside the repository and that
aven maps it to a project (`aven project list`, `aven doctor`).

**A key does nothing after installing bindings.** Another binding may own the
chord. `install-keybindings` reports this rather than clobber it; re-run it and
read the `warning:` lines, then pick another chord.

**`aven` runs, but without your project's tasks.** Aven resolves its own
workspace and database; make sure the focused pane's directory is a place aven
routes to the workspace you expect (`aven doctor` from that directory).

**`z d` or the `z s` workflow key does nothing, and nothing is shown.** aven
reads `tui.commands` once, at startup, so a session that was already running
before the commands were installed (or updated) will not have them — including
an `aven tui` you started by hand in a pane. Quit and reopen aven. If a fresh
session still misses them, run `herdr plugin action invoke
aven.tasks.install-aven-command` and reopen. If the action printed a `warning:`
about an existing `tui:` section, merge the printed block by hand.

**The `z s` workflow runs, but the agent treats it as a plain implementation
request.** The workflow only tells the agent to use aven; it runs whatever aven
and the selected task provide. Check that the agent has `aven` on its `PATH`
and can read the task (`aven context <ref>`), and that the command's
`AVEN_DISPATCH_SKILL` points at a file under `skills/aven/`.

**Dispatch says it needs `jq` or `python3`.** Installing jq or Python 3 is
enough; the popover itself does not need either.

**Dispatch fails with "not inside a Git repository".** The popover was opened
from a pane whose directory is not inside a Git work tree, so there is nothing
to branch from. Open the popover from a repository pane.

**Dispatch created the worktree but the agent did not start.** `herdr agent
start` needs the worktree pane to reach an interactive shell prompt. Check
`herdr agent list`; the worktree is left in place so nothing is lost. Also
install the integration (`herdr integration install opencode`) so Herdr can
track the agent's state.

## Development

The plugin is POSIX shell, run through `sh`, so there is nothing to build. Run
the tests with:

```sh
sh test/run.sh
```

The suite covers the manifest, the context parsing that picks the popover
directory and reads task text (all JSON backends, missing keys, paths with
spaces, stale directories), the exact flags each pane entrypoint launches aven
with, action dispatch, key-binding install/idempotency/conflict/restore,
`doctor`, the aven-command installer (the default dispatch + workflow block,
`aven-commands.yaml` extras, the in-place rewrite and restore), and the
dispatcher's `herdr worktree create` / `agent start` / `agent prompt` argv
including task titles with quotes, a `AVEN_DISPATCH_PROMPT` override, and
`AVEN_DISPATCH_SKILL` insertion. The tests run aven and herdr through `/bin/sh`
and `/bin/echo`, so they never start the real TUI, create a worktree, or touch
your configs.

The entry points are small and worth reading first:

```
herdr-plugin.toml            manifest: five actions, two popup panes
bin/run.sh                   action dispatcher (open, compose, ...) and pane launcher
bin/dispatch.sh              aven custom command: task -> worktree -> agent -> note
aven-commands.yaml           extra aven commands (the example workflow + examples)
skills/aven/                 example agent workflows the dispatcher can insert
lib/plugin.sh                context JSON, directory resolution, aven lookup, replace_all
scripts/install-keybindings.sh
scripts/install-aven-command.sh
scripts/doctor.sh
```

## Uninstall

```sh
herdr plugin unlink aven.tasks       # for a local `plugin link`
herdr plugin uninstall aven.tasks    # for a `plugin install` from GitHub
```

Then remove the `[[keys.command]]` blocks that name `aven.tasks.*` from your
Herdr config, or run `herdr config reset-keys` to drop all custom bindings.

## License

MIT. See [LICENSE](LICENSE).
