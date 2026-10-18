# herdr-aven-plugin

Use [Aven](https://aventasks.dev) inside a [Herdr](https://herdr.dev) popup.
Capture tasks, select an OpenCode agent, and dispatch work into a Git worktree
without leaving your terminal.

## Installation

**Requirements:** Linux or macOS, Herdr ≥ 0.9.0, Aven with custom-command
`terminal` execution support, Git, OpenCode V2, and Rust/Cargo. Keep `aven`,
`opencode`, and Cargo's bin directory on `PATH`. Tested with Herdr 0.9.5 and
Aven 0.1.49.

Install from GitHub:

```sh
herdr plugin install schemaitat/herdr-aven-plugin
```

Or link a local checkout:

```sh
herdr plugin link /path/to/herdr-aven-plugin
```

From inside Herdr, install the bindings and Aven commands:

```sh
herdr plugin action invoke aven.tasks.install-keybindings
herdr plugin action invoke aven.tasks.install-aven-command
herdr integration install opencode
herdr plugin action invoke aven.tasks.doctor
```

The command installer builds and installs `aven-dispatch` with Cargo, then
writes its resolved executable path into Aven's configuration. Existing
unmanaged settings are preserved; conflicting settings are reported.

## Getting started

Open Herdr in your repository. If needed, map it to an Aven project:

```sh
aven project create "My app" --path "$PWD"
```

| Keys | Action |
| --- | --- |
| `prefix+a` | Open Aven for the focused pane's project |
| `prefix+shift+c` | Quickly add a task |
| `z d` in Aven | Dispatch the selected task |
| `z s` in Aven | Dispatch with the bundled spec/plan/implement workflow |
| `z b` in Aven | Dispatch with an adjacent babysitter agent |

The default prefix is `ctrl+b`. Task-detail dispatch bindings use uppercase
`D`, `S`, and `B`. Press `q` to close Aven and return to your pane.

### Dispatch flow

1. Select a task and press `z d`.
2. Choose an agent by number in the **existing Herdr popup**, then press Enter.
   The picker appears even with one agent. `q` cancels without moving focus.
3. The dispatcher creates an OpenCode session, attaches its terminal in the
   task worktree, and submits the task through the OpenCode V2 API.
4. Aven records the handoff and marks the task `active`; focus then moves to
   the worktree pane. Prompt admission does **not** mean the task is complete.

Dispatch works from the primary checkout **or any linked worktree**. You do
not need to switch to `main`. Worktrees are created/opened without taking
focus while you choose. Re-dispatch confirms the existing session's agent
and reuses that session without admitting a duplicate prompt.

The `z s` workflow keeps specs, plans, subtasks, and progress in Aven. The
optional `z b` babysitter supervises the build agent in a sibling pane.

## Configuration

### Paths and overrides

| Variable | Purpose |
| --- | --- |
| `AVEN_BIN` | Aven executable override; defaults to `aven` |
| `AVEN_CONFIG_DIR` | Aven config directory; otherwise `$XDG_CONFIG_HOME/aven` or `~/.config/aven` |
| `AVEN_COMMANDS_FILE` | Extra-command YAML; defaults to this plugin's `aven-commands.yaml` |
| `AVEN_DISPATCH_STORE` | Dispatcher state file override; also accepts `--store` |

By default, every linked worktree uses the primary checkout's
`.aven-dispatch/state.json`. Older checkout-local attempts can also be
recovered from the dispatcher snapshot stored on their Aven task.

Aven starts in the focused pane's directory and infers its project, falling
back to workspace scope when no project is mapped. The plugin does not copy
or replace your OpenCode configuration. Opt-in babysitting adds only the
bundled `.opencode/agents/babysitter.md` definition.

### Agents and custom workflows

Installed commands use `--agent select` and the default model
`github-copilot/gpt-5.6-terra`. Edit `aven-commands.yaml` to add commands or
change CLI options. For example:

```yaml
- name: dispatch-custom
  description: Dispatch with a custom agent and model
  program: aven-dispatch
  args: [dispatch, --agent, build, --model, provider/model]
  keys: [z c]
  target: focused
  execution: terminal
  on_success: quit
```

Use `--agent select` for the picker or `--agent <id>` to bypass it. Keep
**`execution: terminal`** for picker commands: Aven passes task JSON through
`AVEN_COMMAND_CONTEXT` and lends the popup terminal to the picker. Herdr
cannot nest a second popup inside Aven.

Use `--skill aven/sdd --skills-dir /path/to/plugin/skills` for the bundled
workflow, or add a namespaced Markdown workflow under `skills/`.

Apply command changes and **close/reopen Aven**:

```sh
herdr plugin action invoke aven.tasks.install-aven-command
```

### Inspect a dispatch

```sh
aven-dispatch doctor
aven-dispatch list --running
aven-dispatch status HAP-XXXX
aven-dispatch reconcile HAP-XXXX
aven-dispatch interrupt HAP-XXXX
```

`status` includes pending permissions and questions without approving them.
`interrupt` stops execution without marking the task done. For direct dispatch,
pass Aven's versioned command context on stdin; opt-in babysitting uses
`aven-dispatch dispatch --agent select --babysitter`.

## Development

```sh
just fmt       # Check Rust formatting
just check     # Compile checks
just test      # Unit, fixture, and terminal/PTY regression tests
just test-e2e  # Real Herdr + Aven popup test; run inside Herdr
```

The E2E test verifies the picker, cancellation, deferred focus, session reuse,
and dispatch from linked worktrees without switching branches. It uses the
installer-generated commands and disposable config, database, repository,
worktrees, and Herdr session. OpenCode and Cargo installation are stubbed:
no real agent runs, no tokens are spent, and user sessions/configs stay intact.
Failure artifacts are retained for debugging.

Main entrypoints: `src/main.rs` (dispatcher), `bin/run.sh` (plugin actions and
panes), `herdr-plugin.toml` (manifest), and `scripts/install-aven-command.sh`
(Aven command installation).

**Troubleshooting:** Reopen Aven after changing commands. Check executable and
project resolution with `aven.tasks.doctor`; inspect plugin failures with
`herdr plugin log list --plugin aven.tasks`. If the picker is missing, confirm
the installed command uses `--agent select` and `execution: terminal`.

## License

MIT — see [LICENSE](LICENSE).
