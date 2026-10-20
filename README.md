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

### Optional read-only local dashboard

The separate `web/` package requires **Node 24 LTS and npm**; terminal plugin
users do not need Node. From this repository's primary or phase checkout:

```sh
just ui-install
just ui-dev
# Open http://127.0.0.1:4318 explicitly; Ctrl+C stops the server.
```

For a production build (same-origin Fastify server, no Vite listener):

```sh
just ui-check
just ui-test
just ui-build
just ui-start
```

The explorer lists project tasks/epics and their typed relationships, dispatcher
attempts/roles, API session identities, Herdr panes/workspaces, and Git worktrees.
Search, type/state filters, keyboard-selectable entries, related-entity buttons,
and a provenance/detail panel provide the non-canvas inspection path. Task
acceptance, persisted attempt state, and terminal-observed state are separate.
**Live OpenCode API activity is not yet connected:** session activity is explicitly
unknown, even when a Herdr terminal reports working. No task completion is
inferred from terminal or dispatcher state.

Startup settings are trusted environment variables, never browser parameters:

| Setting | Default / behavior |
| --- | --- |
| `UI_PROJECT` | Primary checkout directory name (`herdr-aven-plugin` here); set explicitly if your Aven project key differs |
| `UI_WORKSPACE` | `default`; set explicitly for another Aven workspace |
| `UI_PORT` | `4318` (unprivileged ports only) |
| `UI_HOST` | Only `127.0.0.1` is accepted |
| `AVEN_DISPATCH_STORE` | Existing configured store; relative paths resolve from the repository checkout. Otherwise reads the primary checkout's `.aven-dispatch/state.json` |

Run inside Herdr to inherit its existing session/socket context. Outside Herdr,
the Aven explorer still works and topology is labelled unavailable. The server
does not start or control any upstream service. Missing/malformed optional data
is visible in source-health cards. Aven outages retain the previous snapshot
with an explicit stale label; connection failures retain selection and label
displayed data stale.

Reads use explicit project/workspace scope, a 500-item cap for each of Aven's
available and upcoming lists, and at most 80 context hydrations per snapshot
(four concurrent, four-second hydration admission budget). Contexts cache for 15 seconds, with actual read timestamps in
provenance and rotating hydration when coverage exceeds the batch. Snapshots
coalesce/cache for four seconds and the client polls after each response.
Reaching a list cap or missing context is labelled **incomplete**, never silently
treated as full coverage. Cross-project/unhydrated/missing references remain
boundary stubs, without reading their details. CLI reads time out after four
seconds and allow at most 4 MiB combined stdout/stderr; store reads are bounded
to 4 MiB. These are snapshot bounds, not a claim of live activity freshness.

Security: the server rejects hostile Host/Origin and cross-site browser requests,
disables CORS, and authenticates API reads with an in-memory per-run token obtained
by same-origin bootstrap (never a URL token or service credential). It has no
command/path/URL proxy and accepts no API query parameters or write methods.
Sources use fixed read command shapes without a shell; neither `reconcile` nor
`list --running` is used. The store is read directly without its mutating lock
path; scoped Aven recovery metadata is merged by task/workflow/reset generation.
Obsolete generations and incomplete resets are rejected. Raw store snapshots,
invocations, auth headers, pending prompts, and Aven note bodies never reach the
browser. Labels and values are rendered as untrusted text. This is a local,
single-user inspection tool, not a remote or multi-user hosting configuration.

Unit/integration tests include source fixtures, identity/merge contracts, a
stub-executable read-command audit, source non-mutation, and security/timeout/
output-bound checks. An additional real-source Chromium smoke test checks both
list/details and the API boundary (requires Aven project entities):

```sh
# Once, if Chromium is not already installed:
cd web
npx playwright install chromium
cd ..
just ui-test-browser
# Or use an existing browser, without downloading one:
UI_CHROME=/usr/bin/google-chrome just ui-test-browser
# Verify the development server too:
UI_CHROME=/usr/bin/google-chrome UI_TEST_DEV=1 just ui-test-browser
```

Existing Rust/shell entrypoints remain unchanged (`just check`, `just test`).

### Terminal popup

Open Herdr in your repository. If needed, map it to an Aven project:

```sh
aven project create "My app" --path "$PWD"
```

| Keys | Action |
| --- | --- |
| `prefix+a` | Open Aven for the focused pane's project |
| `prefix+shift+c` | Quickly add a task |
| `z d` in Aven | Dispatch the selected task |
| `z s` in Aven | Plan then implement the selected task |
| `z p` in Aven | Turn the selected task idea into a durable implementation plan |
| `z i` in Aven | Implement an already worked-out plan |
| `z r` in Aven | Reset dispatch and planning state for the focused task |
| `z S` in Aven | Plan then implement with an adjacent babysitter |
| `z b` in Aven | Implement an existing plan with an adjacent babysitter |

The default prefix is `ctrl+b`. `z s` runs the normal SDD workflow from either
the task list or task detail. In task detail, `z S` runs the SDD babysitter
command; the other dispatch bindings use uppercase `D`, `P`, `I`, `B`, and
`R`. Press `q` to close Aven and return to your pane.

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

The `z s` workflow keeps specs, plans, subtasks, and progress in Aven, then
implements only after it has set `sdd.plan-worked-out=true`. `z p` plans only:
it keeps a single-phase plan on the root task or makes a multi-phase plan an
epic with ordered phase tasks. `z i` enforces the same marker before changing
code, so it will direct you to plan first rather than infer an incomplete plan.
Babysitting is available only for the implementation workflows: `z S` for
plan-then-implement and `z b` for implementation of an existing plan.

For a multi-phase plan, select the **root epic** and run `z s` or `z i` once.
Implementation supports `single-session` (the compatible default),
`subsessions`, and `worktrees`; use `--mode` for unattended dispatch. Worktree
mode creates one coordinator worktree plus one dedicated worker worktree for
each ordered phase. It always uses the bundled fixed-Luna, 1000-step
coordinator in the coordinator worktree while the chosen agent/model applies
only to phase workers. The first ready phase is admitted immediately;
successors remain provisioned until their predecessors are verified and
integrated. Reopened attempts retain their saved mode rather than silently
changing topology.
When `z p` precedes `z i`, planning and implementation retain separate OpenCode
sessions so they can use different agents/models, but both use the same
deterministic task worktree branch.

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

Installed commands ask for an agent, then a model. Planning (`z p`) puts the
`plan` agent and latest Sol model first; plan-and-implement (`z s`) and
implementation (`z i`) put the `build` agent and latest Terra model first. The
picker remains interactive, so any visible agent or supported model can still
be selected. Entering `q` at either picker cancels the dispatch and removes the
newly created Herdr worktree. Edit `aven-commands.yaml` to add commands or
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

Use `--agent select` for the picker or `--agent <id>` to bypass it; use
`--model provider/model` to bypass model selection for scripts. Keep
**`execution: terminal`** for picker commands: Aven passes task JSON through
`AVEN_COMMAND_CONTEXT` and lends the popup terminal to the picker. Herdr
cannot nest a second popup inside Aven.

Use `--skill aven/sdd-plan-implement --skills-dir /path/to/plugin/skills` for the bundled
plan-and-implement workflow, `--skill aven/sdd-plan` for planning only, or
`--skill aven/sdd-implement` for plan-gated implementation. You can also add a
namespaced Markdown workflow under `skills/`.

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
aven-dispatch reset HAP-XXXX --dry-run
aven-dispatch reset HAP-XXXX --yes
```

`status` includes pending permissions and questions without approving them.
`interrupt` stops execution without marking the task done. For direct dispatch,
pass Aven's versioned command context on stdin; opt-in babysitting uses
`aven-dispatch dispatch --agent select --babysitter`.

### Reset a task safely

`z r` (or `aven-dispatch reset <task>`) starts the task over at the dispatcher
boundary. It inventories every workflow snapshot, asks for a default-No
confirmation, then interrupts any associated active OpenCode coordinator,
worker, or babysitter session and waits for them to become inactive before
cleanup. It refuses reset if session activity cannot be inspected. Use
`--dry-run` to inspect the target and preserved artifacts; scripts must pass
`--yes` deliberately.

On success reset removes local/Aven dispatch attempts and the three SDD plan
markers, returns the root task to ordinary `todo`, and writes a superseding
audit note. Generated phase children are detached only when their ownership
metadata proves they belong to the root; ambiguous children cause a refusal.
Task identity, spec, notes, attachments, unrelated task metadata and links,
OpenCode sessions, Git branches, worktrees, and source files are retained.
Reset never deletes sessions or cleans a checkout. Plan the task again before
implementation; a generation fence prevents old snapshots from being
reconciled into the new plan.

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
`herdr plugin log list --plugin aven.tasks`. Terminal dispatch failures display
their complete error chain and wait for Enter before returning to Aven. If the
picker is missing, confirm the installed command uses `--agent select` and
`execution: terminal`.

## License

MIT — see [LICENSE](LICENSE).
