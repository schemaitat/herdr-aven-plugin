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
   └──────────────────────────────┘                │  › APP-H8Q4  Decide the ...   │
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
- **Follows the pane** — Herdr panes and worktrees each carry their own
  directory, so the popover follows whichever pane you opened it from.
- **No build step** — POSIX shell, run through `sh`. Nothing to compile or
  install beyond `aven` itself.

## Requirements

- [Herdr](https://herdr.dev) 0.9.0 or newer.
- [aven](https://aventasks.dev) on `PATH`. Set `AVEN_BIN` (see
  [Configuration](#configuration)) if it is installed somewhere Herdr's
  environment does not see.

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

Finally, check the setup:

```sh
herdr plugin action invoke aven.tasks.doctor
```

`doctor` names the directory and project a popover would open in:

```
aven tasks popover
  plugin       aven.tasks
  start        /home/dev/app
  workspace    /home/dev/app
  aven         /home/dev/.local/bin/aven (aven 0.1.47)
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
| `doctor` | Show the directory, workspace and project a popover would open in |

Every action is also available from the command line and the Herdr action menu:

```sh
herdr plugin action invoke aven.tasks.open
herdr plugin action invoke aven.tasks.doctor
herdr plugin action list --plugin aven.tasks
```

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
`HERDR_BIN_PATH`); you do not set those yourself.

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

## Development

The plugin is POSIX shell, run through `sh`, so there is nothing to build. Run
the tests with:

```sh
sh test/run.sh
```

The suite covers the manifest, the context parsing that picks the popover
directory (all three JSON backends, missing keys, paths with spaces, stale
directories), the exact flags each pane entrypoint launches aven with, action
dispatch, key-binding install/idempotency/conflict/restore, and `doctor`. The
tests run aven through `/bin/sh` and Herdr through `/bin/echo`, so they never
start the real TUI or touch your Herdr config.

The entry points are small and worth reading first:

```
herdr-plugin.toml            manifest: four actions, two popup panes
bin/run.sh                   action dispatcher (open, compose, ...) and pane launcher
lib/plugin.sh                context JSON, directory resolution, aven lookup
scripts/install-keybindings.sh
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
