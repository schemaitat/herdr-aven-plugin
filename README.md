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

Install Node 24 using your existing Node version manager or the official
[Node.js downloads](https://nodejs.org/en/download); npm is included. Verify
`node --version` is `v24.x` and `npm --version` works. The locked package supports
`>=24 <25`; the recorded baseline uses Node 24.22.0 / npm 11.19.1. `ui-install`
uses `npm ci` (a reproducible clean dependency install), not a global app install.

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
Search, type/state/time/epic filters, keyboard-selectable entries, related-entity buttons,
and a provenance/detail panel provide the non-canvas inspection path. Task
acceptance, persisted attempt state, and terminal-observed state are separate.
Live OpenCode V2 activity drives **Working** indicators on linked sessions,
agents and tasks, including pane-less sessions. A task badge means linked
execution, not acceptance: Aven status never changes. Approval/input are separate
facets and may coexist with Working. Herdr observations remain inspectable even
when they contradict the API. Missing/unsupported API data is unknown, not idle
or done; observations expire after 4.5 seconds, including in disconnected browsers.

The graph canvas is edge-to-edge within the browser viewport; controls float in
one compact full-width strip and **Sources** discloses detailed source health on
demand. Selection is pinned across the top rather than buried in the Entity list:
**Inspect details** expands canonical identity, provenance and relationships,
including **Copy full ID**. **Entities** opens the complete paged list, while
**Live activity**, **Event history** and **Help & legend** open other inspection
surfaces on demand. Escape or
**Close panel** closes the inspector and returns focus to its opener; background
graph controls remain reachable. The skip link opens and focuses Entities.
**Hide graph** and a failed optional canvas load both expose the list/detail path.

Press **/** outside editable controls, or choose **Search /**, for transactional
search. Matching is case-insensitive over label, ref and ID: exact matches rank
before prefixes, then subsequence matches, with stable ID ties. Queries are bounded
to 256 characters and each field to 4,096 characters; no search service is used.
Drafts preview the same graph/list scope. Up/Down previews a result; Enter or
**Apply search** commits the query and active result (the first match if none is
active). Escape or **Cancel search** restores the previous query, selection and
camera and returns keyboard focus. Live refreshes remain authoritative: vanished
IDs are not resurrected. Preview never saves temporary positions. The dialog
windows 40 results around the active result; arrows can traverse every match.
The inline Search entities field also filters directly, without a transaction.

**Filters** opens a compact keyboard-accessible scope popover (Tab to controls;
Escape closes it and returns focus). Entity types are independent checkboxes:
**epic, task, attempt, agent and session** are initially selected. **All types**
also includes workspace, pane, worktree and boundary entities. Unchecking every
type means no matches, not All. Source state initially includes all states.
Epic choices always come from the loaded snapshot, independent of other filters.
Epic scope follows nested containment and explicit execution ownership only;
blockers/related links and shared sessions, panes or workspaces never pull in
unrelated owners. **Clear epic** removes only that scope. A vanished epic remains
explicitly unavailable with an empty result until cleared; refresh never silently
broadens the scope. Chips show the current scope, matching count and canvas count.
**Reset filters** restores the default types, all states/time and no epic/query;
it does not erase selection or saved node positions. Selected off-canvas entities
retain their details and all source relationships without overriding filters.

Recent source changes initially includes **All time**. Rolling presets are
**24 hours, 72 hours, 7 days, 14 days and 30 days** (not a calendar month), with an
inclusive cutoff. Time is valid Aven `updated_at`, falling back to `created_at`,
or persisted attempt `created_at` (explicitly normalized from seconds-based records
or the current dispatcher's milliseconds). Explicitly owned agents/sessions/panes/
worktrees inherit the maximum valid source time of their task/attempt owners;
standalone resources with no known source date stay undated. Polling, provenance
observations, API activity and heartbeats **never** establish recency. Finite
ranges exclude unknown, invalid and future dates and report their exclusion count
within the other filters/search. These are current known source records, not a
historical graph or a guarantee of exhaustive task coverage. Filtering never
expands source collection.

**Graph guide.** Large violet circular epic hubs and smaller blue task bubbles
form deterministic orbital groups (concentric rings for larger epics). Shapes
distinguish agents, attempts, sessions, panes and worktrees; labels include the
entity kind and source state, so color is never the only cue. The expandable
legend explains each relationship: containment ends in a circle; **blocks**
points **from blocker to blocked task**, not the reverse. Dashed derived-agent
dependencies come only from recorded task blockers plus assignments; dashed
assignment, dotted placement and diamond worktree endpoints stay distinct.
Click an edge for its direction, source identities and evidence. No connection
or dependency is inferred from visual proximity.

Drag bubbles or the background, wheel to zoom, or use compact +/-/Fit/Reset
controls. Clicking a canvas entity, Entity-list row, or related entity selects
and focuses its connected component; edge clicks remain evidence inspection.
Double-click remains a toggle shortcut. **Show all**, clear selection, or
**Focus component** in details leave/re-enter focus without clearing other filters.
Connectivity uses actual source and evidenced derived relationships in the
current type/state/time/epic/search scope, before collapse and the canvas cap;
it never traverses hidden kinds. Entry fits the component; exit restores the
previous camera. If its anchor leaves the eligible scope, focus clears with an
announcement. Use an epic's explicit list button to collapse/expand. Collapsed
external relationships are explicitly summarized at the hub, not invented;
internal blockers remain in details.
Focused components arrange by deterministic undirected shortest-hop shells around
the selected entity (computed before collapse/cap); clicking another focused
entity reanchors the shells. The 500-node cap can promote an eligible anchor
without changing the cap. Updates do not reset the camera, selection or manually positioned nodes. Window
resizing also preserves the camera: use **Fit graph** after narrowing a window.
**Hide graph** leaves the list/detail route usable without a canvas. A keyboard
skip link bypasses the graph; list buttons and related-entity buttons share the
same selection. Focus is outlined; there are no particle/starfield or activity
animations.

**Motion:** bounded, damped d3-force springs react to real relationships,
with many-body repulsion, radius-aware collision avoidance and weak deterministic
orbital anchors to preserve epic groups. Selection anchors a tighter immediate
neighborhood while unrelated nodes stay at their settled overview positions.
**Clear selection** and leaving component focus return to the saved overview
without cumulative drift. Search Escape restores the pre-preview geometry and
camera. Physical proximity never creates source relationships or changes state,
direction, provenance, execution activity or task acceptance.

Dragging fixes the grabbed node to the pointer while connected neighbors follow
elastically. Release leaves a **manual pin until Reset positions**, surviving
ordinary refreshes and filter hide/reveal. Pins take precedence over automatic
forces; overlapping user pins intentionally remain fixed. **Reset positions**
clears all saved positions/pins and restores the deterministic baseline.
**Pause motion / Resume motion** is one keyboard-accessible toggle: Pause freezes
the current geometry immediately; Resume allows another bounded relaxation.
Reduced-motion preferences (including changes while the page is open) disable
simulation and animated returns, applying stable non-overlapping geometry
immediately instead. Fixed-pin conflicts cannot be resolved without moving pins.

Physics runs on copied geometry with a seeded random source, never canonical
records. One requestAnimationFrame scheduler manually ticks the stopped d3 timer
at most twice per frame, batches only changed positions, cools to sleep and stops
scheduling within 1,500ms of the latest interaction. Labels, status and heartbeat
refreshes do not wake or extend it. Background visibility suspends ticks without
catch-up; an expired activation settles on return. Project switching, preview
rollback, Reset, hiding the canvas and unmounting cancel the old activation.

The canvas has an explicit **500-visible-node budget**, applied after scoped
search/type/state/time/epic filters, component focus and collapse. A warning gives additional matches and
off-canvas relationship counts; scope totals and source relationships are never
silently reduced. **Entities** retains every matching entity supplied by the
bounded source snapshot, including those beyond the canvas budget; select one
there for full details, or narrow search to its label/identity to reveal it on
the graph. This is not a claim of unlimited upstream task coverage (see source
caps below). Large entity, relationship and event/history lists use explicit
40-row page windows with Previous/Next buttons and position/total announcements:
bounded DOM, variable-height text and complete keyboard traversal without a
scroll-only virtual list. Live/history retention remains separately capped.
At dense overview scale, graph labels are suppressed until zoomed to a legible
size; concise captions use collision suppression and full facts remain in the
list/pinned inspector. Opaque session, attempt and UUID-style tokens show a
recognizable prefix plus four payload characters only; canonical identities stay
distinct for search, evidence, requests and copying. Viewport texture caching
and pixel ratio 1 bound canvas cost. Current linked API worker/session activity
has a green CSS ring; direct one-hop neighbors of a selection have a static cyan
glow plus restrained CSS pulse, a visible **1 hop** list badge, and their actual
incident source/evidenced edges are emphasized without changing arrows/dashes.
These CSS cues freeze for Pause, reduced motion and hidden tabs, do not wake
physics, and may coexist without implying task acceptance.

Startup settings are trusted environment variables, never browser parameters:

| Setting | Default / behavior |
| --- | --- |
| `UI_PROJECT` | Primary checkout directory name (`herdr-aven-plugin` here); set explicitly if your Aven project key differs |
| `UI_WORKSPACE` | `default`; set explicitly for another Aven workspace |
| `UI_PORT` | `4318` (unprivileged ports only) |
| `UI_HOST` | Only `127.0.0.1` is accepted |
| `AVEN_DISPATCH_STORE` | Existing configured store; relative paths resolve from the repository checkout. Otherwise reads the primary checkout's `.aven-dispatch/state.json` |
| `UI_OPENCODE_URL` | Explicit existing OpenCode server origin; takes precedence over `OPENCODE_SERVER_URL` and local discovery. No fallback to a different service when this server fails |
| `UI_OPENCODE_AUTHORIZATION` | Server-only Authorization header for that explicit server; otherwise `OPENCODE_TOKEN` (Bearer) or `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` (Basic, username defaults to `opencode`) |
| `UI_OPENCODE_SERVICE_FILE` | Optional trusted registration file for local discovery; otherwise `$XDG_STATE_HOME/opencode/service.json` or `~/.local/state/opencode/service.json`. Its origin is checked for loopback before the client's authenticated health probe |

Run inside Herdr to inherit its existing session/socket context. Outside Herdr,
the Aven explorer still works and topology is labelled unavailable. The server
does not start or control any upstream service. Missing/malformed optional data
is visible in source-health cards. Aven outages retain the previous snapshot
with an explicit stale label; connection failures retain selection and label
displayed data stale.

Without an explicit server URL, the pinned V2 client uses `Service.discover()`
and `Service.headers()` for the existing authenticated local service, **never**
`ensure()` or `stop()`. A CLI's `--server` flag is not inherited by a separately
started dashboard: configure the same origin/authentication using the startup
settings above. Credentials stay in the server process, not browser storage,
requests, logs or query strings. The installed server's OpenAPI document gates
optional events, waiting facets, parent-filtered child reads and durable logs.
Only dispatcher-linked sessions and explicitly related API children are read;
Herdr terminal detection alone does not authorize session reads.

Open the printed **127.0.0.1 URL** directly (not `localhost` or a remote tunnel).
The page automatically requests `/bootstrap` from that same origin, keeps its
per-run API bearer token in memory, then authenticates snapshot/stream/history
reads. There is no login URL, token copy/paste or browser-stored upstream secret.
Restarting the server invalidates that token; automatic retry/bootstrap obtains
the new one. Use a trusted local browser/profile: bootstrap protects the
same-origin boundary, not other software running as your local user. Do not
publish the listener, reverse-proxy it publicly or paste service credentials into
browser URLs. The dashboard does not launch a browser automatically.

**Project** switches exactly one loaded project in the configured Aven workspace.
Each tab/browser owns its selection; there is no server-global selected project,
mutation endpoint, URL/cwd override, cross-workspace browsing or combined graph.
The configured startup project is selected initially. Switching aborts old reads
and streams and ignores late results, clears query/epic scope, selection, history,
collapse and graph positions/camera, and retains type/state/time preferences.
Discovery failures keep the current project and offer **Retry project discovery**;
the startup alias remains usable even if discovery fails on first load.

Choices come only from a fixed `aven project list --workspace <configured>
--limit 100 --json` read, cached for 30 seconds. Only key/name reach the browser;
capped or invalid-key coverage is disclosed. Unknown/malformed keys fail closed.
Non-startup projects recover execution from their scoped Aven metadata and linked
authenticated OpenCode sessions. Their local dispatcher store and Herdr topology
coverage is explicitly unavailable: the startup store/repository topology is
never borrowed, and other repositories/paths are not discovered.

Reads use explicit project/workspace scope, a 500-item cap for each of Aven's
available and upcoming lists, and at most 80 context hydrations per snapshot
(four concurrent, four-second hydration admission budget). Contexts cache for five seconds, with actual read timestamps in
provenance and rotating hydration when coverage exceeds the batch. One collector
per loaded project serves its browsers, with at most four collectors across all
clients. Streams and in-flight reads hold leases; unreferenced collectors expire
after 60 seconds since their last successful bounded read (or creation). Full
admission returns retryable HTTP 503; close streams and retry after idle expiry.
Eviction/shutdown closes readers, timers and each collector's own API subscription.
CLI concurrency remains four process-wide, not four per project.
API and Herdr lanes poll independently at approximately
two seconds; Aven/dispatcher use a five-second lane. No lane overlaps itself.
Authenticated same-origin fetch/SSE delivers versioned complete snapshots and
health heartbeats; clients reconnect with backoff, resnapshot on gaps/restarts,
and fall back to polling. Ordinary same-project updates preserve graph camera,
positions and selection; project switches deliberately reset them.
Reaching a list cap or missing context is labelled **incomplete**, never silently
treated as full coverage. Cross-project/unhydrated/missing references remain
boundary stubs, without reading their details. CLI reads time out after four
seconds and allow at most 4 MiB combined stdout/stderr; store reads are bounded
to 4 MiB. API activity reads have four workers, a 1.9-second collection budget
and a 64-session cap, with incomplete coverage explicitly labelled. Child lists
are parent-filtered and capped at 32, with propagation through at most four explicit
ancestry levels. These bounds may require a narrower scope;
missing observations are never presented as confirmed inactivity.

Select an entity to inspect live event summaries; select a linked session or
dispatcher attempt and explicitly load **Event history** for durable summaries.
Live-only subscriptions have neither replay nor automatic upstream reconnection;
the bridge re-subscribes and reports reconnect gaps.
An upstream event read idle for 30 seconds is renewed and labelled continuity
unverified (not an API activity outage); received SSE heartbeat/comment bytes reset
that watchdog. Polling remains the authority/freshness fallback throughout.
History is 100 entries/page, with source/session/attempt cursors, deduplication,
and at most 1,000 retained live
events (and 1,000 displayed history entries per selection). Experimental durable
logs may be unavailable. Linked dispatcher notes are a fallback: the installed
Aven CLI supplies a bounded context window, not upstream note pagination, so
older history is explicitly reported as potentially unavailable. History reads
share a process-wide two-request limit and a 32-page/five-second cache per project
across browsers. Every request authorizes its node/cursor against that project's
current snapshot before cache lookup; caches include workspace/project identity. Prompt,
reasoning, tool payloads and raw note bodies are omitted; summaries strip terminal
controls, redact known credentials, cap text at 2,048 characters and render as
untrusted text. Slow SSE readers are disconnected instead of queued without bound;
there are at most 16 local streaming connections shared across scoped and alias routes.
Authenticated GET `/api/projects` lists choices; `/api/projects/:project/snapshot`,
`/api/projects/:project/stream` and `/api/projects/:project/logs/:scope/:cursor`
resolve the same allowlisted project scope. Existing `/api/snapshot`, `/api/stream`
and `/api/logs/:scope/:cursor` remain startup-project aliases.

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
# Deterministic graph/live, accessibility/outage and performance cases:
UI_CHROME=/usr/bin/google-chrome just ui-test-e2e
# Verify the development server too:
UI_CHROME=/usr/bin/google-chrome UI_TEST_DEV=1 just ui-test-browser
```

Existing Rust/shell entrypoints remain unchanged (`just check`, `just test`).

Minimal UI entrypoints: `ui-install` (locked clean install), `ui-dev` (watching
local server with Vite middleware), `ui-check` (all TypeScript), `ui-test`
(unit/integration fixtures), `ui-build` (production client and server),
`ui-start` (serve that build), and `ui-test-e2e` (deterministic Chromium suite).
Build before browser tests; Playwright starts/stops its own server on port 4320
and refuses to reuse an existing listener. `ui-test-browser` additionally runs
real-source/API-security smoke; this extra smoke needs a nonempty mapped Aven
project. `ui-start` defaults to 4318. Keep generated dependencies, builds and
Playwright output out of commits (`web/node_modules`, `web/dist`,
`web/test-results`, `web/playwright-report`). Aven stores planning and handoffs;
there is no second dashboard task store.

#### Performance baseline and limits

`web/test/fixtures/large-graph.ts` deterministically supplies 500 nodes (20 epic
hubs / 480 tasks) and 1,000 edges (480 containment / 520 directed blockers).
`web/e2e/performance.spec.ts` asserts initial interactivity **≤3 seconds** and
rendered pan/zoom **≥45 FPS**, separately with active physics and when settled.
Select **All types** to exercise the complete fixture. Run the built production app through
`UI_CHROME=/usr/bin/google-chrome just ui-test-e2e`; the performance case prints
`PERFORMANCE_BASELINE` JSON and attaches it to Playwright results. There is no
network throttle or simulated CPU speed; source reads are deterministic HTTP
fixtures, not real Aven hydration latency.

Method: time navigation through canvas creation, a real entity selection and
visible details plus two paint frames; then drive simultaneous pan/zoom over
three seconds around zoom 0.35 with every element unmuted, plus a separate active
physics/pan/zoom sample (up to one second, ending when the solver sleeps).
Count Cytoscape
**render events**, not merely requestAnimationFrame callbacks; record rAF cadence,
95th-percentile render gap, initial layout/sync and status-update sync costs.
The viewport uses the same production texture cache. A status-only snapshot
must leave positions/camera unchanged and must not compute a new layout.
Dense labels become readable on zoom-in rather than flooding the overview.
This is a local canvas/interaction baseline, not a guarantee of 60 FPS for every
GPU, huge label payload, graph topology, browser or upstream service.

Historical pre-physics local baseline (2026-10-20): Ubuntu/Linux x86_64, Intel Core Ultra 5
238V (8 CPUs), Node 24.22.0, npm 11.19.1, Google Chrome 155.0.8059.84 headless,
Playwright 1.64.1, 1440×1000 viewport, device/canvas pixel ratio 1, one worker.
A final deterministic production run measured **600 ms** initial interactivity
and **59.4 rendered FPS** (179 rendered frames / 3.013 seconds; p95 render gap
19.7 ms). Initial layout cost was 0.6 ms, initial mutation/style/fit sync 154 ms,
and status-only sync 44.7 ms with no relayout. The subsequent full production
suite measured 536 ms / 58.9 FPS; development measured 943 ms / 58.6 FPS. Both
targets passed throughout these runs. Actual per-run JSON and review/verification evidence are retained in
Aven handoff notes. The canvas is lazy-loaded separately from the list/detail
shell (approximately 443 kB / 141 kB gzip graph chunk and 244 kB / 77 kB gzip
shell at this baseline), with no >500 kB chunk warning hidden or suppressed.

Privacy/non-goals: this is read-only local project inspection, not task editing,
dispatch/reset/reconcile, prompting/interrupting/approving sessions, terminal
control, focus changes, worktree creation, a remote/multi-user host, Neo4j or
durable full-history analytics. Optional capabilities can be unavailable and
history/source windows can be incomplete. The existing terminal dispatcher and
popup actions stay independent; no new dispatch behavior or automatic browser
launch action is installed.

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
| `z r` in Aven | Reset dispatch execution while preserving the focused task plan |
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
it makes every selected root an epic and creates one ordered phase subtask per
implementation phase, including a single phase. That epic remains the
overarching ADR and specification throughout implementation and reset; phases
never replace or demote it. `z i` enforces the same marker before changing code, so it will
direct you to plan first rather than infer an incomplete plan.
Babysitting is available only for the implementation workflows: `z S` for
plan-then-implement and `z b` for implementation of an existing plan.

For every plan, select the **root epic** and run `z s` or `z i` once.
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
or replace a project's OpenCode configuration. When needed, it installs its
bundled global profiles as `~/.config/opencode/agents/aven-babysitter.md` and
`aven-orchestrator.md` (or the equivalent under `$XDG_CONFIG_HOME`). These
names are reserved for this plugin; differing user-defined files are never
overwritten.

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

On success reset removes only local/Aven dispatch attempts and writes a
superseding audit note. It preserves the root status and type, all `sdd.plan-*`
metadata, epic membership and order, phase dependencies, task descriptions,
priorities, schedules, and unrelated task metadata and links. An epic remains
the overarching ADR with its existing phase subtasks attached; current phase
membership is recorded only as audit inventory.

Legacy reset records can contain `detached_children` from the former
implementation. Recovery treats that field as historical audit data only: it
never attaches, detaches, or otherwise overrides the current Aven graph. A
future explicit replanning workflow must be separate from reset and preserve
task history.

OpenCode sessions, Git branches, worktrees, and source files are retained.
Reset never deletes sessions or cleans a checkout. The generation fence
prevents old snapshots from being reconciled into a fresh dispatch, while the
retained approved plan can be dispatched again without duplicate planning.

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

Main entrypoints: `src/main.rs` (dispatcher orchestration), `bin/run.sh`
(plugin actions and panes), `herdr-plugin.toml` (manifest), and
`scripts/install-aven-command.sh` (Aven command installation).

The Rust dispatcher keeps its internal boundaries deliberately small:

- `src/model.rs` owns Aven command-context parsing and the serde-backed
  dispatcher state model.
- `src/process.rs` owns command execution, OpenCode/Aven transport helpers,
  and dispatcher state-path handling.
- `src/main.rs` owns command lifecycle orchestration and integrations.

This separation is intentionally not a framework: add a module only when a
shared concern has a clear owner.

**Troubleshooting:** Reopen Aven after changing commands. Check executable and
project resolution with `aven.tasks.doctor`; inspect plugin failures with
`herdr plugin log list --plugin aven.tasks`. Terminal dispatch failures display
their complete error chain and wait for Enter before returning to Aven. If the
picker is missing, confirm the installed command uses `--agent select` and
`execution: terminal`.

## License

MIT — see [LICENSE](LICENSE).
