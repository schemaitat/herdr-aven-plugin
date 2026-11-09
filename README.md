# herdr-aven-plugin

Use [Aven](https://aventasks.dev) with [herdr-core](https://herdr.dev) (`hc`).
Capture tasks, select an OpenCode agent, and dispatch work into a Git worktree
without leaving your terminal. `hc` owns terminals and keeps them alive when a
window or popup closes; Aven remains the task source of truth; OpenCode's V2
API owns sessions and prompt admission. The desktop [herdr-app](https://herdr.dev)
mod is optional and only changes what you see.

## Installation

**Requirements:** Linux or macOS, herdr-core ≥ 0.1.15 (`hc`), Aven with
custom-command `terminal` execution support, Git, OpenCode V2, and Rust/Cargo ≥ 1.89.
Keep `aven`, `hc`, `opencode`, and Cargo's bin directory on `PATH`.
`herdr-app` is optional. Tested with herdr-core 0.1.15.

Install the dispatcher, Aven commands, and the optional app mods:

```sh
git clone https://github.com/schemaitat/herdr-aven-plugin
cd herdr-aven-plugin
just install
```

`just install` builds and installs `aven-dispatch` with Cargo, writes the Aven
commands, installs the global OpenCode `/approve` and `/ha-merge` commands and the
`herdr-aven-tasks` skill, and installs `mods/aven-tasks`, `mods/aven-panel`,
`mods/aven-kanban`, `mods/aven-panel-tabs`, and the personal
`layouts/aven-right.json` into `$HERDR_APP_HOME` (or `~/.config/herdr-app`), and
reports readiness with `just doctor`. The app mods are optional; when
`herdr-app` is absent the same dispatch, supervision, and recovery work
headlessly. The installer preserves unrelated app settings, never replaces a
key the person bound to another action, and refuses a differing skill file. It
does reconcile its own mod key sections, so a moved board key such as `h` is
updated by an upgrade instead of staying on an old action. Re-run
`just install-app-mod` after an upgrade to refresh owned assets; an upgrade also
removes the retired `mods/aven-worktree` panel when it is still the
plugin-installed copy. Both commands install the Aven-right assets by default,
including with `--no-keys`, but never select a layout, open a panel, or change
panel preferences. A foreign asset named `aven-right`, `aven-panel`,
`aven-kanban`, or `aven-panel-tabs` is refused rather than overwritten.

There is no legacy `herdr` plugin manifest, popup entrypoint, or keybinding
installer to install. The retired runtime is not started or migrated in place.

For the dashboard, install Node 24 LTS and run `just ui-install` once.

## Getting started

### Dispatcher diagnostics

```sh
aven-dispatch inspect --json --project HAP
```

`inspect` prints the scoped, read-only dispatcher snapshot as JSON: overview,
task/epic, attempt, session/agent and herdr-core terminal tables, with worktree
placement, source health and provenance. Aven acceptance, persisted dispatcher
state, OpenCode API activity and terminal observations remain separate; missing,
stale, capped or contradictory evidence is labelled accordingly. Reads are
bounded (500 tasks per list, 80 context admissions per cycle, 2,000 attempts,
64 linked sessions, 4,000 terminals, 4 MiB responses, four workers, four-second
timeouts) and never migrate or mutate the dispatcher store.

This JSON contract, not a web-side parser, is the dashboard's structural source
of truth. `--no-api` suppresses the one-shot OpenCode activity read for callers
that own the live OpenCode transport.

There is no interactive dispatcher TUI. Use the Kanban board, the Aven overlay,
and `aven tui` for interactive work.

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

The dashboard reads its structural snapshot from `aven-dispatch inspect --json`
(see [ADR 0001](docs/adr/0001-inspect-snapshot-source-of-truth.md)). Build the
dispatcher first (`cargo build --workspace`) or install it; the server resolves
`UI_INSPECT_BIN`, then `target/debug/aven-dispatch`, then `aven-dispatch` from
`PATH`. A missing or incompatible inspector marks those sources unavailable
instead of falling back to a second parser. OpenCode events/activity and log
pagination stay in the web server because they are live-stream concerns; the
inspector is called with `--no-api` for that reason.

The explorer lists project tasks/epics and their typed relationships, dispatcher
attempts/roles, API session identities, herdr-core terminals and their observed
status, optional herdr-app placement, and Git worktrees.
Search, type/state/time/epic filters, keyboard-selectable entries, related-entity buttons,
and a provenance/detail panel provide the non-canvas inspection path. Task
acceptance, persisted attempt state, and terminal-observed state are separate.
Live OpenCode V2 activity drives **Working** indicators on linked sessions,
agents and tasks, including pane-less sessions. A task badge means linked
execution, not acceptance: Aven status never changes. Approval/input are separate
facets and may coexist with Working. herdr-core observations remain inspectable
even when they contradict the API. Missing/unsupported API data is unknown, not idle
or done; observations expire after 4.5 seconds, including in disconnected browsers.

The graph canvas occupies the remaining browser viewport below a single compact,
top-pinned header row: the project selector, **Search /**, the inline search
field, **Filters**, one condensed status item (matching and on-canvas counts plus
a nonzero unknown/invalid/future-time exclusion indicator), the **Graph tools**
disclosure, a visible **?** shortcut, the four panel buttons (**Panels** on
narrow viewports) and a compact connection indicator. **Filters** and
**Search /** stay one click away; **Graph tools**, **Panels** and **Sources**
disclose secondary controls on demand. Selecting an entity does not open
information. Press the visible **i** shortcut outside editable controls to toggle
a bounded, scrollable entity-info surface containing canonical identity,
provenance, relationships and **Copy full ID**. The shortcut is inert without a
selection and never opens information during search. **Entities** opens the
complete paged list, while **Live activity**, **Event history** and
**Help & legend** open other inspection surfaces on demand. Escape or
**Close panel** closes the inspector and returns focus to its opener; background
graph controls remain reachable. The skip link opens and focuses Entities.
**List only** and a failed optional canvas load both preserve the list route;
select an entry, then press **i** to inspect it without the canvas.

Press **?** outside editable controls, or choose the visible **?** button, to
toggle **Help & legend**, which documents every keybinding (/, i, ?, Escape and
the canvas gestures) and returns focus to its opener when closed. **/** and **i**
behavior is unchanged.

Press **/** outside editable controls, with or without Shift when that is how
the keyboard produces `/`, or choose **Search /**, for transactional
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
**epic, task, attempt, agent and session** are initially selected. **Select all
types** also includes workspace, pane, worktree and boundary entities;
**Deselect all types** clears them, and an empty selection means no matches, not
All. Independent relationship checkboxes initially show every source kind plus
evidenced agent dependencies (contains, blocks, related, assigned, session,
placed-in, worktree and agent-dependency); **Deselect all relationships** leaves
eligible nodes isolated. Hidden relations never connect or attract visible
entities, but remain in canonical info evidence. Source state initially includes
all states.
Epic choices always come from the loaded snapshot, independent of other filters.
Epic scope follows nested containment and explicit execution ownership only;
blockers/related links and shared sessions, panes or workspaces never pull in
unrelated owners. **Clear epic** removes only that scope. A vanished epic remains
explicitly unavailable with an empty result until cleared; refresh never silently
broadens the scope. The popover lists the current scope facts; the header's
condensed status item shows the matching and on-canvas counts plus a nonzero
exclusion count. **Reset filters** restores epic/task types, all relationship
kinds, all states/time and no epic/query;
it does not erase selection or saved node positions. Selected off-canvas entities
retain their information and all source relationships when opened with **i**.

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
seed deterministic evidenced connected groups, packed apart from unrelated
components. The overview is radial by kind: epic hubs at the centre, then tasks,
attempts, agents, sessions, panes/worktrees, and finally workspace or boundary
resources on successive rings. Nodes of one kind share a ring; an epic's children
stay grouped in one arc facing it, and sibling tasks are ordered around the ring
by recorded **blocks** relationships so blocker direction is readable and
crossings stay low. A same-kind blocker cycle is ordered deterministically
without changing the direction drawn by any edge.
Shapes
distinguish agents, attempts, sessions, panes and worktrees; labels include the
entity kind and source state, so color is never the only cue. The expandable
legend explains each relationship: containment ends in a circle; **blocks**
points **from blocker to blocked task**, not the reverse. Dashed derived-agent
dependencies come only from recorded task blockers plus assignments; dashed
assignment, fine-dot placement and diamond worktree endpoints stay distinct.
Every directed edge carries a slow source→target dash flow while motion is
allowed; arrowheads remain the primary, static direction cue and the flow is
presentation only. Surfaces and unrelated elements are translucent, with larger
radius-aware gutters between bubbles.
Select an edge, then press **i**, for direction, source identities and evidence. No connection
or dependency is inferred from visual proximity.

Drag bubbles or the background, wheel to zoom, or use compact +/-/Fit/Reset
controls. Clicking a canvas entity, Entity-list row, or related entity only
selects and highlights it; it does not change the component camera or open info.
Double-click toggles explicit component focus. The **Focus component** button
in the i-opened info surface enters or reanchors focus; **Show all** exits focus
without clearing selection or other filters.
Connectivity uses actual source and evidenced derived relationships in the
current type/state/time/epic/search scope, before collapse and the canvas cap;
it never traverses hidden kinds. Entry fits the component; exit restores the
previous camera. If its anchor leaves the eligible scope, focus clears with an
announcement. Use an epic's explicit list button to collapse/expand. Collapsed
external relationships are explicitly summarized at the hub, not invented;
internal blockers remain in details.
Focused components re-apply the kind-ranked radial placement to the component and
fit the camera, so double-clicking an entity shows the ranking instead of shortest-hop
shells. Pins still win. Selecting a different entity while focused does not
reanchor or re-rank it; an explicit focus action does.
The 500-node cap can promote an eligible anchor
without changing the cap. Updates do not reset the camera, selection or manually positioned nodes. Window
resizing also preserves the camera: use **Fit graph** after narrowing a window.
**List only** leaves the list/info route usable without a canvas. A keyboard
skip link bypasses the graph; list buttons and related-entity buttons share the
same selection. Focus is outlined; there are no particle/starfield effects.
Directional edge flow and selection pulses are restrained presentation cues,
not activity claims.

**Motion:** bounded, damped d3-force springs react to real relationships,
with many-body repulsion, radius-aware collision avoidance and weak deterministic
kind-ranked radial anchors (epic → task → attempt → agent → session → pane/worktree →
workspace/boundary) that preserve epic groups. Selection anchors a tighter immediate
neighborhood while unrelated nodes stay at their settled overview positions.
Clearing selection changes highlights only; leaving component focus returns to the saved overview
without cumulative drift. Search Escape restores the pre-preview geometry and
camera. Physical proximity never creates source relationships or changes state,
direction, provenance, execution activity or task acceptance.

Edge flow uses a separate throttled requestAnimationFrame overlay canvas that
draws a short moving segment along each directed edge's rendered bezier; it never
restyles the styled edges, ticks physics, changes positions/camera or extends the
1,500ms activation deadline. Pause, reduced motion, hidden tabs and unmounting
cancel that loop as well as the spring simulation. Selected entities and their
degree-1 neighbours pulse in the DOM cue layer; the pulse is a stable static glow
under reduced motion.

Dragging fixes the grabbed node to the pointer and its direct neighbours follow
elastically. On release the node stays pinned and those neighbours settle close
on radius-aware arcs around it — same kinds flanking, each lower kind on a
successive arc above and each higher kind on an arc below — while every
unconnected node stays exactly where it was. Release leaves
a **manual pin until Reset positions**, surviving
ordinary refreshes and filter hide/reveal. Pins take precedence over automatic
forces; overlapping user pins intentionally remain fixed. **Reset positions**
clears all saved positions/pins and restores the deterministic baseline.
**Pause motion / Resume motion** is one keyboard-accessible toggle: Pause freezes
the current geometry, edge flow and cue pulse immediately; Resume allows another
bounded relaxation. Reduced-motion preferences (including changes while the page
is open) disable simulation, animated returns, edge flow and pulses, applying
stable non-overlapping geometry instead. Fixed-pin conflicts cannot be resolved
without moving pins.

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
list/i-opened info surface. Opaque session, attempt and UUID-style tokens show a
recognizable prefix plus four payload characters only; canonical identities stay
distinct for search, evidence, requests and copying. Viewport texture caching
and pixel ratio 1 bound canvas cost; edge-flow overlay redraws are throttled well
below the render cadence. Current linked API worker/session activity
has a green CSS ring; the selected entity has a pulsing amber ring, and direct
one-hop neighbors have a pulsing cyan ring, a visible **1 hop** list badge, and
their actual incident source/evidenced edges are emphasized without changing
arrows/dashes. These CSS cues freeze for Pause, reduced motion and hidden tabs,
do not wake physics, and may coexist without implying task acceptance.

Startup settings are trusted environment variables, never browser parameters:

| Setting | Default / behavior |
| --- | --- |
| `UI_PROJECT` | Primary checkout directory name (`herdr-aven-plugin` here); set explicitly if your Aven project key differs |
| `UI_WORKSPACE` | `default`; set explicitly for another Aven workspace |
| `UI_PORT` | `4318` (unprivileged ports only) |
| `UI_HOST` | Only `127.0.0.1` is accepted |
| `AVEN_DISPATCH_STORE` | Optional override for the central SQLite store; relative paths resolve from the repository checkout. Otherwise reads `$XDG_STATE_HOME/aven/dispatch.sqlite` (fallback `~/.local/state/aven/dispatch.sqlite`) |
| `UI_PROJECT_CHECKOUTS` | Optional JSON object mapping Aven project keys to absolute, server-local checkout paths, for example `{"rofm-argo-apps":"/work/rofm-argo-apps"}`. Paths are canonicalized at startup; selected projects without a mapping keep scoped Aven recovery only and read no Git worktree inventory. This mapping is never exposed to the browser. |
| `UI_OPENCODE_URL` | Explicit existing OpenCode server origin; takes precedence over `OPENCODE_SERVER_URL` and local discovery. No fallback to a different service when this server fails |
| `UI_OPENCODE_AUTHORIZATION` | Server-only Authorization header for that explicit server; otherwise `OPENCODE_TOKEN` (Bearer) or `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` (Basic, username defaults to `opencode`) |
| `UI_OPENCODE_SERVICE_FILE` | Optional trusted registration file for local discovery; otherwise `$XDG_STATE_HOME/opencode/service.json` or `~/.local/state/opencode/service.json`. Its origin is checked for loopback before the client's authenticated health probe |

herdr-core and Git worktree reads use `hc` on `PATH`. The desktop app is optional:
when it is absent or closed, core facts and worktrees remain observable and app
placement is labelled unavailable. The server
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
herdr-core terminal detection alone does not authorize session reads.

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
authenticated OpenCode sessions. Every project collector reads the same central
dispatcher SQLite store read-only via `node:sqlite`, so mapped projects show
their own attempts without borrowing the startup project's store. Dispatcher
attempts are filtered to the loaded project's Aven task ids; core terminals are
included only when an attempt or an ownership label ties them to the loaded
project. Non-startup worktree inventory is read from that project's configured
checkout; the startup repository topology is never reused. Other
repositories/paths are not discovered.

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
API, core, worktree, and optional app lanes poll independently at approximately
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
Choose **Select all types** to exercise the complete fixture. Run the built production app through
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

### Aven overlay and dispatch

Open herdr-app in your repository. The optional `aven-tasks` mod adds the
**Open aven** and **Add a task** commands and binds `ctrl-shift-a` when that
chord is free. You can also run the same actions from the app command palette
(`mod.open:aven-tasks`). Headless use needs neither the app nor the mod:
`aven tui -p` works in any terminal.

The overlay waits briefly for herdr-app to adopt a terminal that `hc run` just
started, so the first open reveals it instead of reporting that the terminal
was not found. Pressing the key again while that terminal is still starting
reuses it rather than opening a second Aven.

### Aven Kanban board

Open the native **Aven Kanban** overlay with `ctrl-shift-h` (requested only when
that chord is free), with `ctrl-shift-a` followed by `k`, or with:

```sh
herdr-app do mod.open --name aven-kanban
```

The board fills the whole Herdr window and is drawn in the visual language of
the Board layout from
[jkuepker/herdr-layouts](https://github.com/jkuepker/herdr-layouts): a dark
Graphite-style palette, a compact top bar, a today strip, a NEXT MOVE banner,
project chips, and colour-accented, independently scrolling columns. It lists
nondeleted root epics from every Aven project in the explicit local `default`
workspace. On open it resolves the Aven project that owns the selected Herdr
space/worktree through Aven's own checkout inference and starts on that
project's chip; the **all** chip widens the board to every project. Scheduled
open epics and terminal done/canceled epics are included. Five flexible columns
always fit the window width without horizontal scrolling and combine
independent Aven and dispatcher facts instead of creating another task store.
The selected card has
a bright accent border and the focused column header carries an accent rule and
count chip; every board text colour meets WCAG AA contrast on the surface it is
drawn on:

| Column | Contents |
| --- | --- |
| **Backlog** | Inbox, backlog, and todo epics. A todo epic with `sdd.plan-worked-out=true` stays here with a **planned out** badge. |
| **Needs you** | A presentation split of Working cards whose related live agent (or live terminal observation) reports `blocked`. The card quotes the lowest question on the agent's screen, read with `hc read`; questions stay in memory. |
| **Working** | Active epics and running, pending, failed, or interrupted execution. |
| **Ready to land** | Needs-review/completed execution awaiting approval or delivery, explicit `pending`/`committed` delivery not verified on local main, and accepted work that is merged but still has a root or child-phase delivery obligation or open child task blocking Done. |
| **Done** | Delivered or legacy accepted done epics, terminal work whose exact attempt result is verified on local main with no open tasks, and canceled epics. |

Startup paints the board as soon as the bounded epic, scheduled-epic, and
dispatcher list reads finish. Epic details and the read-only local-main
ancestry check then enrich the same cards in the background through a
four-worker limit; a note above the columns says when metadata or delivery
evidence is still loading. **Merge** and **Ship PR** still re-read the exact
approval before opening a handoff, and **Archive** stays closed until the board
and card are fully classified, so a provisional column can never hide work that
enrichment would reclassify. The ancestry check waits briefly for the space's
live checkout, and navigation or archive presses made while the board is still
settling are replayed against the authoritative cards.

The today strip counts **Landed today** (with seven daily bars), **Needs you**,
**Working**, **Ready to land**, and **Open**. **Next move** quotes the oldest
needs-you card and offers **Answer** and **Go to agent**. Cards show the agent
glyph, project chip, qualified ref, timer or status, title, an **ASKS YOU** box
for needs-you cards, phase plan/execution/delivery facts, warnings, and a 3px
left bar in their column colour. Cards whose description is longer than 100
characters and has a stored LLM summary keep the title as the primary content
and expose a clickable **LLM SUMMARY** chip (or `u` on the selected card) that
expands the three summary bullets in the card's strongest text colour, with
stale and generating hints on the muted ramp; a stale digest is marked and short
or unsummarized descriptions are unchanged.

**Project chips** filter by project and show per-project counts plus a yellow
dot when a card there needs you; the **all** chip clears the filter and shows
every project in the workspace. The first chip is the project Aven resolves from
the selected space/worktree (linked worktrees and project path mappings
included), unless the person has chosen a chip before. An explicit choice,
including **all**, persists across overlay openings; automatic resolution is
never persisted and falls back to **all** when the project has no visible card.
A **Created** control filters visible cards by
`created_at` with `All`, `1w`, `2w`, `1mo`, and `1y` windows (fixed
7/14/30/365-day lookbacks). Both choices persist across overlay openings, and a
hidden card cannot stay selected. Cards whose root epic or any child task has a
working dispatcher attempt pulse a working indicator. A live herdr agent whose
address matches a recorded role terminal corroborates activity; conversely, an
attempt whose recorded role terminals have all stopped (`finished`/`removed`)
or whose lifecycle observation is `stopped-*` no longer pulses even when the
read-only dispatcher summary still exposes an unreconciled pending checkpoint.
Done and canceled epics never pulse. They move to Ready to land with a
terminal/execution contradiction warning only when a live herdr agent still
matches a recorded role terminal or the attempt carries a durable lifecycle
contradiction. A stored `running` attempt with a dispatch-time `live` terminal
observation is stale evidence, not active execution, because the read-only
summary never reconciles it.

For terminal done/canceled cards, the board performs a bounded read-only check
of the exact attempt branch/worktree commit against the current local `main`;
verified ancestry moves the card to Done with an `on main` badge and, when
closeout is absent or pending, an explicit **closeout not recorded** warning.
This is presentation evidence only: it never edits Aven delivery metadata or
treats active epics as complete. Legacy done epics without delivery metadata
remain Done as accepted historical work. Failed/interrupted non-merged
execution stays Working rather than appearing ready to land.

A Ready to land card lists every task that still blocks Done under
**STILL OPEN**: the root's open delivery obligation, the open delivery
obligations of its accepted child phases, then any open child phases, each by
ref and title. Approval attaches delivery obligations to accepted child phases
while the board draws only root epics, so the root card surfaces its children's
open obligations too. Local-main ancestry alone cannot finish the card
while those tasks remain open, so an approved result that is already merged but
still needs a manual integration check stays in Ready to land with an explicit
`open task still blocks done` warning instead of claiming Done. Because its
result is already on main, that card has no second **Merge** or **Ship PR**
action. Resolving the obligation or child on the next refresh removes it from
the list and restores the normal classification. Unrelated related links, such
as dispatcher log tasks, are never shown as blockers.

**Open** starts or reveals the exact epic's Aven TUI. **Dispatch** offers the
same dispatch, plan, plan-and-implement, implement, reset, and babysitter
variants as Aven detail: the board opens that exact detail and sends its
existing lower-case shortcut, so dispatcher eligibility and picker behavior are
not bypassed. Live terminals are reused only by workspace and immutable epic
identity; repeated activation is deduplicated.

Navigation follows Aven's columns view: vertical movement wraps inside the
focused column, horizontal movement skips empty columns and keeps the row, and
`g`/`G` jump to the top/bottom of the focused column. The app's key map
normalises shifted letters, so `G`, `S` and `A` are installed as `shift-g`,
`shift-s` and `shift-a`.

| Board key | Action |
| --- | --- |
| `j` / `k` or `Down` / `Up` | Next / previous card in the focused column |
| `h` / `l` or `Left` / `Right` | Previous / next non-empty column |
| `g` or `Home` | Jump to the top of the focused column |
| `G` (Shift-G) or `End` | Jump to the bottom of the focused column |
| `Tab` / `Shift-Tab` | Next / previous column |
| `1`–`5` | Jump to a column (the nearest non-empty one) |
| `Enter` | Focus the epic's agent; reopen a closed worktree from its saved session; open the epic when neither exists |
| `o` | Open the selected epic in Aven |
| `a` | Answer on a Needs you card; Archive on a Done card |
| `A` (Shift-A) | Archive all visible Done cards |
| `S` (Shift-S) | Ship PR for an approved Ready to land card |
| `d` | Toggle the selected epic's Dispatch menu |
| `u` | Expand/collapse the selected card's LLM summary |
| `s`, `p`, `i` | Plan-and-implement, plan, or implement the selected epic |
| `m` | Open `/ha-merge` for an approved Ready to land epic in the main space |
| `?` | Open the in-board keyboard reference |
| `r` | Refresh |
| `Esc` | Close help, a Dispatch menu, then the board |

The footer names the core keys. 

**Answer** focuses the blocked agent's exact terminal (and its pane) so the
question can be answered immediately. **Go to agent** selects the live agent's
space and tab and focuses it. When the worktree space/tab or terminal was
closed, `Enter`/**Go to agent** calls `aven-dispatch reopen` for the card's
saved attempt: the dispatcher reuses or recreates the branch worktree,
relaunches the same OpenCode session in a core terminal, reveals it, and focuses
it without agent/model pickers or a duplicate prompt. Cards with no saved
attempt still fall back to the epic's Aven TUI. Done and canceled cards never
restart an agent.

An approved Ready to land card shows a green **✓ ready to merge** check and
offers **Merge** and **Ship PR**. Approval means the root task metadata contains
a complete durable approval (`approval.state=approved` plus `approval.id`,
`approval.commit`, and `approval.workflow`); execution state alone never unlocks
either handoff. Cards without approval say **awaiting approval** and have no
handoff buttons.

**Merge** opens a tab named `merge <task-ref>` in the main app space and starts
the user's installed agent with `/ha-merge <immutable-task-id>`. **Ship PR**
opens a tab named `ship <task-ref>` with a separate explicit prompt to push only
the approved task branch, open a pull request following repository conventions,
and not merge, force-push, rewrite history, or change Aven acceptance. Both
re-read the exact durable approval before opening a tab. OpenCode is launched
with its `--prompt` flag because Herdr appends the first message as a positional
argument and a bare OpenCode positional is a project directory; other selected
agents keep their existing first-message behavior. The main space is the visible
space whose first tab's terminal lives in the repository's primary checkout (the
parent of the Git common directory), because a space's configured folder is only
where its new terminals start and can point at `$HOME` or a stale checkout; if
no space matches, the active space is used and the tab still starts in that
primary checkout. Clicking again reuses the task-named tab.
Merge is a handoff to the existing
[finish workflow](#finish-a-dispatched-worktree), not a one-click Git mutation:
`/ha-merge` requires a durable `/approve` result and clean worktrees. Its
invocation is the explicit merge trigger; no second confirmation is required.

**Archive** and **Archive all** hide Done cards in local shared state keyed by
workspace and immutable epic ID. They never edit Aven status, metadata, delivery
or history, and they are per app user. The board itself never commits, merges,
pushes, opens a pull request, changes Aven acceptance, applies closeout, or
closes a space; Merge and Ship PR are agent handoffs that keep the human in
control.

Refresh is non-overlapping. The top-bar **Refresh** control keeps a constant
label and a reserved spinner slot, so starting or finishing a refresh never
reflows the toolbar or moves the adjacent `Esc` hint. Once a board is visible,
a refresh stages all metadata reads and local-main evidence and replaces the
board in one publish; merged/main badges and columns never flicker through
provisional states while the read is in flight. Full Aven metadata is
cached by immutable epic ID
and `updated_at`, with four bounded readers and 500-item caps on each Aven list,
the merged epic set, and dispatcher attempts. Dispatcher reads use read-only,
prompt-free `aven-dispatch list --summary --limit 500`; exceeding a cap is an
explicit error, not silent truncation. Attempts are indexed once per refresh by
immutable task ID. Local-main ancestry checks are limited to terminal cards with
a matching attempt and cached by resolved main head plus commit. An unavailable
`main` leaves cards in their metadata-derived lifecycle and reports incomplete
evidence instead of asserting delivery. Failed refreshes retain clearly labeled
stale results; partial metadata failures are not presented as complete coverage.

For native verification, `just app-test-e2e` creates an isolated app home, core
session, Aven DB, dispatcher store, and six dummy epics. It opens the board
full-window, moves through columns with the vim commands, opens and closes the
`?` reference, asserts that Merge launches a main-space tab with the exact
`/ha-merge <immutable-task-id>` prompt, asserts that Ship PR launches a separate
task-named tab with its ship prompt, and asserts that Archive and Archive all
persist both Done IDs without editing Aven. It retains `kanban-board.png`,
`kanban-navigation.png`, `kanban-keys.png`, `kanban-handoff.png`,
`kanban-ship.png`, and `kanban-archive.png` under
`/tmp/opencode/aven-kanban-e2e.*` for visual inspection. The test needs
herdr-app, herdr-core, Aven, and a display; it is intentionally separate from
headless `just test` and cleans up only the app/core/resources it created.

The separate `aven-worktree` pane is retired. Dispatch no longer splits a
second Aven surface into a worktree space; the **Aven** child of the Aven-right
layout describes the focused dispatched worktree instead (see below).

### Aven right-side panel

Select **Aven right** explicitly from Herdr's layout picker (or run
`herdr-app do layout.switch --name aven-right`). It is a personal copy of the
Herdr 0.1.12 main composition: Spaces and Agents stay on the left, while the
right stack offers **Files**, **Changes**, and **Aven**. Clicking the active
selector closes the stack; clicking another selector reveals that child. The
selector remembers only an explicit valid choice per space in its own mod-local
storage. An ordinary new space starts with the panel hidden; a first visit to a
dispatched worktree reveals **Aven** so the focused work shows its context. An
explicit Files/Changes choice for that space still wins, and the shipped main
layout's panel preference is neither read nor changed.

The layout paints itself in the Kanban board's Board/Slate palette: graphite
near-black canvas and chrome, the lilac `#b4a0db` accent, JetBrains Mono labels
and Geist UI text, 1px `#1e1e20` dividers, and compact radius-6 pane frames
with a `#625187` focus border. The look is scoped to `aven-right`; the shipped
`main` layout and the app's global theme are untouched. Text resolves from the
theme's readable ramp rather than the graphite `dim` token (1.9–2.6:1 on the
panel surfaces): task content and LLM summary bullets use `foreground`, while
refs, counts, and section labels use `muted`; `dim` stays reserved for
decorative chevrons.

When the focused space is a dispatched worktree, the Aven panel shows a compact
worktree card above the epic list: root epic and status, phase progress, the
full phase list in order with the active phase marked ACTIVE and the selected
phase worktree marked WORKTREE when it differs from the active phase, the
current task and Aven status with a one-line description, the persisted dispatch
state with agent/model and execution mode, and one lifecycle stage (Backlog,
Planned, In progress, Review, Done, Canceled). Each phase shows a small
description snippet; clicking the phase opens its cleaned full description as
an accordion (one phase open at a time). A phase worktree resolves through
its attempt's phase entry, so the card names the phase task rather than the
root. The card also exposes Open task/Open phase buttons, which reuse the same
exact Aven terminal launcher. Dispatcher facts stay read-only; an unknown or
missing attempt is labelled, never guessed as running. Focus changes refresh the
card immediately in addition to the gentle ten-second data refresh.

When a description is longer than 100 characters and has a stored LLM summary,
the task line, collapsed phase snippet, and expanded phase body show that
summary under an **LLM SUMMARY** label instead of the raw description. A digest
mismatch shows **stale** but never hides the summary; short descriptions and
tasks without a summary keep the existing raw text. Summaries are generated on
demand with `d l`/`z l` in Aven and are never written during a panel refresh.

The Aven panel lists nondeleted open epics (inbox, backlog, todo, active),
including future-available epics, from the repository's inferred project in the
explicit local `default` workspace. It merges normal open-epic and per-project
upcoming reads, deduplicates canonical IDs, orders valid `created_at` values
newest first (stable ID ties; invalid dates last), and labels loading, empty,
stale, errors, and incomplete coverage separately. A list cap, malformed data,
timeout, or project failure is never displayed as a complete empty list.

Every row carries its project's stable colour as a 3px left bar and a coloured
project chip. The colour comes from the same eight-colour Board chip palette
and name hash as the Kanban project chips, so a project reads the same in both
surfaces; an unassigned project stays neutral. The project name, qualified ref
and status remain the authoritative cues, so colour is never the only signal,
and nothing is written to Aven.

Clicking an epic starts or reveals its exact `aven --workspace default tui
<ref>` terminal. Its Dispatch menu sends the same existing Aven detail shortcuts
as the Kanban board; the panel does not edit task fields directly. The panel
reuses only a live terminal with the same workspace and canonical epic identity,
suppresses duplicate launches while one is pending, and does not kill a terminal
when the panel closes. Data polling is gentle (about ten seconds, never
overlapping); only the panel tabs mod reacts to a focused dispatched worktree by
revealing Aven, and it never selects a layout. Native app review requires an
isolated `HERDR_APP_HOME` **and** isolated core/window; do not use a personal
active app/core as a test target.

If needed, map the checkout to an Aven project:

```sh
aven project create "My app" --path "$PWD"
```

| Keys | Action |
| --- | --- |
| `ctrl-shift-a` | Open the Aven overlay (when the app mod is installed) |
| `ctrl-shift-h` | Open the Kanban board when the chord is free |
| `o` | In the overlay: open the Aven TUI |
| `a` | In the overlay: open Aven's add-task composer |
| `k` | In the overlay: open the Kanban board |
| `r` | In the overlay: refresh live terminals |
| `Esc` | In the overlay: close it |
| `z d` in Aven | Dispatch the marked or focused task(s) (list or detail) |
| `z s` in Aven | Plan then implement the marked or focused task(s) (list or detail) |
| `z p` in Aven | Turn each marked or focused task idea into a durable implementation plan (list or detail) |
| `z i` in Aven | Implement an already worked-out plan for the marked or focused task(s) (list or detail) |
| `z r` in Aven | Reset dispatch execution while preserving the focused task plan (list or detail) |
| `z S` in an Aven list; `z x` in task detail | Plan then implement with an adjacent babysitter |
| `z b` in Aven | Implement an existing plan with an adjacent babysitter (list or detail) |
| `d l` or `z l` in Aven | Generate an LLM summary for the focused task and its long phases (list or detail) |

The default prefix is `ctrl+b`. `z s` runs the normal SDD workflow from either
the task list or task detail. The plan-and-implement babysitter uses `z S` in
lists and `z x` in task detail to avoid colliding with `z s`. Press `q` to close
Aven and return to your pane.

### LLM task summaries

`d l` (or the reserved-namespace `z l`) runs
`aven-dispatch describe --llm` for the focused task. It reads the task with
`aven show --full --json`, summarizes the description with the installed
OpenCode CLI (`opencode run --archived --format json`), and stores plain display
text in Aven metadata:

| Metadata key | Meaning |
| --- | --- |
| `summary.llm` | At most three short bullet lines (one per line), kept within Aven's metadata limit. |
| `summary.llm.digest` | 32-bit FNV-1a of the normalized source description; the UI uses it for the **stale** hint. |
| `summary.llm.generated-at` | Unix milliseconds when the summary was written. |
| `summary.llm.model` | The OpenCode model used for the summary. |
| `summary.llm.state` | Background coordination: `generating`, `done`, or `error`. |
| `summary.llm.state-at` | Unix milliseconds for the state marker. |
| `summary.llm.error` | Bounded error text when a run fails. |

Only descriptions longer than 100 characters are summarized. Each summary is
at most three short bullet lines (about 18 words each); Markdown emphasis and
numbering are stripped. For an epic, the
command also summarizes up to 20 long phase descriptions. A description of 100
characters or fewer is skipped, and a plain `aven-dispatch describe <ref>`
(without `--llm`) only prints the stored summary and never mutates Aven. Select
a model with `--model provider/model` or `AVEN_DISPATCH_SUMMARY_MODEL`; otherwise
it uses `github-copilot/gpt-6-luna`, the build agent's configured model.

Generation is both explicit and automatic. Pressing `d l`/`z l` always
regenerates the focused task in a terminal. Separately, the sidebar and Kanban
board enqueue a background `describe --auto` for a long description without a
current summary: the selected/focused card first, one run at a time, with a
per-task lock. Done and canceled epics are never enqueued automatically: they
already show their final card, and summarizing them would restart the board's
refresh chain for no user-visible benefit. The UI shows **generating…** while
`summary.llm.state` is `generating`, retries a failed run only after ten
minutes, and treats a `generating` marker older than ten minutes as retryable.
Set `AVEN_DISPATCH_SUMMARY_AUTO=0` (also `false`, `off`, or `no`) to disable
automatic generation.

### Dispatch flow

1. Select a task or mark several tasks, then press `z d`. Marked tasks are
   dispatched in visible order with an independent worktree and session each;
   the focused row may be another task and never joins or blocks the batch.
   When nothing is marked, the focused task is dispatched. A batch uses the
   selected workflow and asks for implementation mode, agent, and model only
   once for its new attempts, using the first new worktree for discovery.
   Existing attempts reopen with their saved configuration without repeated
   confirmation pickers; they do not determine the new attempts' settings.
2. Choose an agent by number in the existing Aven terminal, or in a dedicated
   herdr-core picker terminal when dispatched outside Aven. The picker appears
   even with one agent. In the terminal picker, press `/` and type to filter
   live: Up/Down (or PageUp/PageDown) move, Enter selects, Esc clears the
   search or cancels when it is empty, and Ctrl-C always cancels. `q` also
   cancels when the search is not active, without creating a session or prompt.
3. Choose a model from every model enabled by your currently configured
   OpenCode providers. The same live `/` search applies, so the list stays
   workable as more providers and models are configured.
4. Worktree discovery, creation, cleanliness checks, and integration run through
   `hc exec --cwd <repo> git ...`. The dispatcher creates the OpenCode session,
   starts the OpenCode CLI in a dedicated herdr-core terminal, and submits the
   task through the OpenCode V2 API. If herdr-app is running, the worktree gets
   a sidebar space named for the task, the terminal is labelled into its tab,
   and an **Aven** pane opens beside the agent with the root epic, phase
   progress, the current task, and the persisted dispatcher/agent state.
   Headless dispatch is unchanged. The panel reads Aven and
   `aven-dispatch list` only; it never edits tasks, dispatches, or prompts.
   The empty shell `space.new` starts is removed once the attempt terminal is
   adopted, so the space holds the agent and Aven.
5. Aven records the handoff and marks the task `active`. Prompt admission does
   **not** mean the task is complete, and a core status word is not acceptance.

Dispatch works from the primary checkout **or any linked worktree**. You do
not need to switch to `main`. Worktrees are created/opened through core without
taking focus while you choose. Re-dispatch confirms the existing session's
agent, adopts the existing owned terminal, and reuses the session without
admitting a duplicate prompt. A missing status stays unknown; a terminal
recovered with a shell is never treated as a resumed OpenCode process.

The `z s` workflow keeps specs, plans, subtasks, and progress in Aven, then
implements only after it has set `sdd.plan-worked-out=true`. `z p` plans only:
it makes every selected root an epic and creates one ordered phase subtask per
implementation phase, including a single phase. That epic remains the
overarching ADR and specification throughout implementation and reset; phases
never replace or demote it. `z i` enforces the same marker before changing code, so it will
direct you to plan first rather than infer an incomplete plan.
Babysitting is available only for the implementation workflows: `z S` for
plan-then-implement and `z b` for implementation of an existing plan. The
babysitter session uses `github-copilot/gpt-6-luna` by default; select a
different supervisor model independently of the build/phase worker with
`--babysitter-model provider/model[#variant]` or
`AVEN_DISPATCH_BABYSITTER_MODEL`. The effective model is persisted with the
attempt, so a missing babysitter session is recreated with the original choice
even when a different override is supplied on reopen. Overrides apply when the
babysitter session is created; reopening never changes the model of an
already-created session. The bundled `aven-babysitter.md` frontmatter keeps
Luna as its direct-use default.

For every plan, select the **root epic** and run `z s` or `z i` once.
Implementation supports `single-session` (the compatible default),
`subsessions`, and `worktrees`; use `--mode` for unattended dispatch. Worktree
mode creates one coordinator worktree plus one dedicated worker worktree for
each ordered phase. The coordinator uses the bundled `aven-orchestrator` agent
(1000 steps) with `github-copilot/gpt-6-luna` by default; override it
independently with `--orchestrator-model provider/model[#variant]` or
`AVEN_DISPATCH_ORCHESTRATOR_MODEL`. The chosen agent/model applies only to
phase workers, and the effective coordinator model is recorded as
`coordinator_model` on the attempt. Overrides apply when the coordinator
session is created; reopening preserves the existing session's model. The
first ready phase is admitted immediately;
successors remain provisioned until their predecessors are verified and
integrated. Reopened attempts retain their saved mode rather than silently
changing topology.
When `z p` precedes `z i`, planning and implementation retain separate OpenCode
sessions so they can use different agents/models, but both use the same
deterministic task worktree branch (`{project}/{task-slug}-dispatch-{task-id}`;
phase worktrees insert `phase-NN` before the dispatch id).

## Configuration

### Paths and overrides

| Variable | Purpose |
| --- | --- |
| `AVEN_BIN` | Aven executable override; defaults to `aven` |
| `AVEN_CONFIG_DIR` | Aven config directory; otherwise `$XDG_CONFIG_HOME/aven` or `~/.config/aven` |
| `AVEN_COMMANDS_FILE` | Extra-command YAML; defaults to this plugin's `aven-commands.yaml` |
| `AVEN_DISPATCH_STORE` | Dispatcher SQLite store override; also accepts `--store` |
| `AVEN_DISPATCH_BABYSITTER_MODEL` | Babysitter session model as `provider/model[#variant]`; also accepts `--babysitter-model`; defaults to `github-copilot/gpt-6-luna` |
| `AVEN_DISPATCH_ORCHESTRATOR_MODEL` | Worktree coordinator model as `provider/model[#variant]`; also accepts `--orchestrator-model`; defaults to `github-copilot/gpt-6-luna` and applies only in `worktrees` mode |
| `AVEN_WORKTREE_ROOT` | Worktree root override; defaults to `~/.herdr/worktrees` |
| `HC_BIN` | herdr-core executable override; defaults to `hc` |
| `OPENCODE_BIN` | OpenCode executable override; defaults to the first `opencode` on `PATH`, then `~/.opencode/bin`, `~/.local/bin`, and the standard bin directories |
| `HERDR_APP_BIN` | herdr-app executable override; defaults to `herdr-app` |
| `HC_SESSION` | Isolated herdr-core session for integration tests; never set it for normal work |

By default, every checkout, worktree, and project shares one central SQLite
store at `$XDG_STATE_HOME/aven/dispatch.sqlite` (fallback
`~/.local/state/aven/dispatch.sqlite`). It is the only dispatcher state store:
JSON state files are not created, read, or migrated. The dispatcher snapshot on
each Aven task remains the task-facing recovery surface across checkouts.
The watcher writes `<store dir>/watch.json` (ownership and last event sequence)
and `<store dir>/terminals.json` (bounded terminal facts for the read-only
dashboard). Both are observations; neither is acceptance.

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
picker remains interactive, so any visible agent or any model enabled by a
configured OpenCode provider can still be selected. At either picker, press `/`
and type to filter live by name or `provider/model` id; Up/Down move the
highlight, Enter selects, and Esc clears the filter or cancels. `q` cancels
while no search is active, and Ctrl-C always cancels. When the picker input is
piped (tests or scripts), a `/query` line filters and a number selects from the
filtered list. Entering `q` at either picker cancels the dispatch and removes
the newly created herdr-core worktree. If OpenCode cannot list models, the
picker falls back to the built-in choices so dispatch can continue. Edit
`aven-commands.yaml` to add commands or change CLI options. `--model` /
`AVEN_DISPATCH_MODEL` selects the build or phase worker. The optional babysitter
and the worktree coordinator have independent `--babysitter-model` and
`--orchestrator-model` overrides, so supervision can use a different model
without changing worker behavior; all three apply only when the corresponding
session is created. For example:

```yaml
- name: dispatch-custom
  description: Dispatch with a custom agent and model
  program: aven-dispatch
  args: [dispatch, --agent, build, --model, provider/model]
  keys: [z c]
  target: marked-or-focused
  execution: terminal
  on_success: quit
```

Use `--agent select` for the picker or `--agent <id>` to bypass it; use
`--model provider/model` to bypass model selection for scripts. Keep
**`execution: terminal`** for picker commands: Aven passes task JSON through
`AVEN_COMMAND_CONTEXT` and lends its terminal to the picker. Outside Aven the
dispatcher opens a dedicated herdr-core picker terminal instead.

An implementation command can also select the optional babysitter model without
touching the worker model:

```yaml
- name: implement-with-supervisor
  description: Implement an existing plan with an adjacent babysitter
  program: aven-dispatch
  args: [dispatch, --agent, build, --model, provider/worker, --skill, aven/sdd-implement, --babysitter, --babysitter-model, provider/supervisor]
  keys: [z 2]
  target: marked-or-focused
  execution: terminal
  on_success: quit
```

Use `--skill aven/sdd-plan-implement --skills-dir /path/to/plugin/skills` for the bundled
plan-and-implement workflow, `--skill aven/sdd-plan` for planning only, or
`--skill aven/sdd-implement` for plan-gated implementation. You can also add a
namespaced Markdown workflow under `skills/`.

Apply command changes and **close/reopen Aven**:

```sh
sh scripts/install-aven-command.sh
```

### Finish a dispatched worktree

The finish workflow has two checkpoints:

1. **In the final feature/coordinator worktree:** run `/approve` (optionally with
   the root task ID). The agent reviews the specification and children, commits
   only task-owned changes, runs the actual required tests/checks, and repairs
   failures within scope. `aven-dispatch approve` reruns the selected commands
   and binds acceptance to the exact commit, specification, child dispositions,
   attempt and generation. All worktree phases must already be integrated.
   Success marks the root **done as accepted, not delivered**, with explicit
   pending delivery. Bundled implementation workflows perform this approval
   checkpoint automatically after implementation; the slash command also works
   as an explicit final-worktree action. Stale session badges do not grant or
   revoke approval.
2. **From the main checkout:** run `/ha-merge <task-id>` or
   `/ha-merge <task-id> <task-id> ...`. Qualified refs and immutable IDs both work;
   bracketed/comma-separated lists are accepted by the command prompt. This is
   the human merge trigger, with no second merge/PR confirmation. All supplied
   approvals are validated before preparation. The dispatcher merges their exact
   source commits, in order, into an isolated integration worktree. The agent
   automatically resolves conflicts against the approved requirements, reviews
   the combined result and repairs legitimate integration failures (up to three
   rounds). It never blindly chooses ours/theirs or weakens failing tests.

Only after the recorded checks from all approvals pass on the exact reviewed
combined commit does the CLI fast-forward clean local main. A moved target,
changed source, missing approval, dirty worktree, incompatible requirements or
failed verification leaves main untouched. Extra integration changes outside the
approved changed paths require a new approval. Source worktrees, branches and
Herdr spaces are retained; this workflow never pushes main, creates a PR or
performs teardown. OpenCode/tool permissions still apply.

Delivery is finalized automatically, children first and root last. If Aven fails
after Git succeeds, the SQLite journal retains the exact merged result; resume
the operation, or run the watcher to retry **metadata only**. The watcher never
initiates a merge. These low-level commands back the slash workflows:

```sh
# From the final worktree; checks are trusted, explicit shell commands via hc.
aven-dispatch approve <task-id> --workflow implementation \
  --check 'just test' --check 'just check' --review 'Acceptance and diff reviewed'
# From main (also works from another checkout of the same repository):
aven-dispatch merge <task-id> <task-id> --yes
# Recover operation identities after a tool timeout/restart (read-only):
aven-dispatch merge --list
# Resolve/commit conflicts only in the returned integration worktree, then:
aven-dispatch merge --operation <operation-id>
# After review, rerun recorded checks and publish the exact combined commit:
aven-dispatch merge --operation <operation-id> --publish \
  --review-commit <combined-sha> --review 'Combined requirements reviewed'
```

These are agent workflows with deterministic CLI safety boundaries, not claims
that an LLM's semantic conflict resolution is infallible. Verification is bounded
to 600 seconds per command; select actual checks rather than arbitrary task text.
Do not put credentials or other secrets in check commands or review evidence.
The central store retains full approval evidence; compact `approval.*` metadata
on Aven tasks exposes its identity. Losing the approval journal requires rerunning
approval rather than trusting an unverifiable marker.

`just install` installs both global commands under
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/commands/` and the bundled
`aven-orchestrator`/`aven-babysitter` implementation profiles under `agents/`. Use
`just install-commands` separately. Identical files are left untouched; different
definitions and symlinks are refused by default. For an intentional upgrade use
`just install-commands --upgrade`: differing command/profile regular files are backed up before
replacement; symlinks are still refused. Project-local commands override global
ones, and OpenCode reloads commands on save. `just test-approval` exercises the
approval, batch/conflict, stale-evidence and post-merge recovery contracts using
real Git and disposable Aven/OpenCode/core fixtures.

### Analyze task and dispatch state

`just install` also installs the `herdr-aven-tasks` OpenCode skill at
`${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/herdr-aven-tasks/SKILL.md`.
Ask OpenCode to "check running tasks" — or what is stale, what an epic's phases
are doing, or whether a project's attempts are healthy — and the skill walks
Aven status, dispatcher attempts, `hc` terminals, and OpenCode sessions, then
reports running, awaiting-review, stale, and not-started work without mutating
anything. Run `sh scripts/install-skill.sh` to install or refresh it separately.
Identical files are left untouched; different files and symlinks are refused.
The bundled copy lives at `opencode-skills/herdr-aven-tasks/SKILL.md`.

### Inspect a dispatch

```sh
aven-dispatch doctor
aven-dispatch list --running
aven-dispatch list --summary --limit 500  # bounded read-only, prompt-free JSON
aven-dispatch status HAP-XXXX
aven-dispatch reconcile HAP-XXXX
aven-dispatch reopen HAP-XXXX --json
aven-dispatch interrupt HAP-XXXX
aven-dispatch reset HAP-XXXX --dry-run
aven-dispatch reset HAP-XXXX --yes
```

`status` includes pending permissions and questions without approving them.
`reopen` reuses or recreates the saved attempt's worktree and relaunches its
durable OpenCode session without agent/model pickers; `--json` reports the
focused terminal so the Kanban board can reveal it.
`interrupt` stops execution without marking the task done. For direct dispatch,
pass Aven's versioned command context on stdin; opt-in babysitting uses
`aven-dispatch dispatch --agent select --babysitter`.

Supervision is event-driven:

```sh
aven-dispatch watch              # long-running owner; subscribe to owned terminals
aven-dispatch watch --once       # bounded reconcile pass, then exit
aven-dispatch watch --status     # lock owner and durable state
aven-dispatch watch --stop       # stop the owner explicitly
aven-dispatch message HAP-XXXX --text "..." --role builder --wait
```

`watch` subscribes to herdr-core events filtered by dispatcher ownership labels,
starts from a snapshot, handles `missed` events by resubscribing, and uses core
events only as triggers to reconcile authoritative OpenCode/Aven state. A
bounded periodic pass covers changes that have no core event. Duplicate
notifications, reconnects, and watcher restarts never submit a prompt or launch
a worker twice. `message` uses guarded `hc send --if idle --wait`; it refuses
blocked programs rather than bypassing a permission dialog. Callers that rendered
an attempt earlier can also supply `--attempt-id`, `--generation`, and
`--terminal`; each supplied expectation is validated under the store lock before
any core/message call, so replacement attempts fail closed. The positional task
accepts either its immutable ID or qualified ref.

A legacy attempt created by the retired `herdr` runtime remains read-only
evidence. Move its durable OpenCode session to herdr-core explicitly with
`aven-dispatch dispatch --relaunch` (it preserves the session and never
re-admits an already admitted prompt), or reset and redispatch it.

### Track delivery and close out accepted work

`done` means accepted, not delivered. Acceptance, execution, verification and
delivery are separate facts. The dispatcher journal (store schema version 2)
records durable publication intent and its verified read-back, while the
task-facing delivery facet uses `delivery.*` metadata.

```sh
aven-dispatch closeout HAP-XXXX --project <key>                 # read-only
aven-dispatch closeout HAP-XXXX --project <key> --apply         # record evidence
aven-dispatch closeout HAP-XXXX --project <key> --pr 42         # record PR identity
aven-dispatch closeout HAP-XXXX --project <key> --not-applicable
aven-dispatch closeout HAP-XXXX --project <key> --waive "<reason>"
aven-dispatch closeout HAP-XXXX --project <key> --superseded-by HAP-YYYY
```

The configured local target (initially `main`) is the only delivery provider in
this release. Closeout verifies:
the exact accepted source commit, a clean source and target tree, a canonical
repository, and source ancestry in the freshly observed target commit. A dirty
result has no fabricated SHA. An open PR, an unrelated merge, a branch name,
session success, or an unchanged baseline cannot satisfy delivery. An
accepted-but-unmerged result gets exactly one open related delivery follow-up;
repeated apply is idempotent. A human merge plus `--apply` resolves only the
matching obligation. A root epic closes only when every child is dispositioned
and every obligation is verified delivered, waived or superseded. This is delivery
closeout, not the root's acceptance gate: `/approve` may accept the root before
delivery with explicit pending obligations.

The supported repair actions are all dry-run by default:

```sh
aven-dispatch disposition HAP-XXXX --reason "<why>" --successor HAP-YYYY
aven-dispatch disposition HAP-XXXX --reason "<why>" --no-successor --apply
aven-dispatch recovery                  # read-only recovery-record inventory
aven-dispatch recovery --apply --task DR-XXXX --reason "<why>"
aven-dispatch board --project <key>     # childless/incomplete epic proposals
aven-dispatch board --project <key> --apply --task HAP-XXXX
aven-dispatch audit --project <key>     # read-only lifecycle audit
```

`disposition` requires a durable reason and a real successor or explicit
no-successor decision, preserves branch/worktree/commit/uncommitted artifacts,
and transfers or explicitly waives an open delivery obligation. It refuses to
cancel accepted work. Logs close only from proven stopped execution. Recovery
records prefer a retained/canceled disposition over deletion; absence from the
local store alone is never proof of orphanhood.

`board` keeps ideas visible: an ordinary idea stays non-epic until a worked-out
plan exists. It proposes but never automatically removes epic status, children,
notes or history; apply only explicit proposal refs. Incomplete plans stay
visible instead of being treated as implemented.

`audit` is scoped and read-only. It never migrates or writes the store, Aven,
sessions or Git refs. Exit codes are `0` (complete and clean), `1` (policy
violations), and `2` (a required source is missing/incomplete; findings are
still reported). Missing evidence is not clean.

Terminal tasks are inert for dispatch. Rejecting a mixed open/terminal batch
happens before any side effect. To reopen accepted or canceled work, perform an
explicit reviewed Aven status transition first, then reset the task so a new
fenced generation owns the next attempt. `resume`, `relaunch`, and `reset` never
reopen a task by themselves.

Verification helpers:

```sh
just preflight       # tool/executable provenance and per-run isolated paths
just test-lifecycle  # terminal guards, reduction, closeout, disposition, audit
just tasks-audit --project <key>
```

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
just test      # Rust unit tests and shell/integration fixtures
just test-e2e  # Process fixture using herdr-core, fake OpenCode/Aven, and real Git
just app-test  # Node 24 Kanban and right-panel model/tabs fixtures
just app-check # herdr-app check all optional Aven mods
just app-test-e2e # Isolated native Kanban dummy epics, handoff and screenshots
just ui-check  # Dashboard TypeScript
just ui-test   # Dashboard unit tests
```

The shell/integration suites and the independent approval scenarios run in
parallel by default, bounded by the logical CPU count. Set `TEST_JOBS=1` or
`APPROVAL_TEST_JOBS=1` to force serial execution when diagnosing a failure.
The `web/` UI tier is separate and only needed for UI work.

The E2E fixture uses `test/hc_fixture.py` as `HC_BIN`; its `hc exec` runs real
Git, so worktree operations are exercised through the same boundary as
production. OpenCode and Aven are stubbed: no real agent runs, no tokens are
spent, and user sessions/configs stay intact. `watch.test.sh` uses an isolated
`HC_FIXTURE_STATE` and its own store, never the user's core or terminals.

Main entrypoints: `src/main.rs` (CLI composition and final terminal error
handling), `app/` (optional
herdr-app mod), `scripts/install-aven-command.sh` (Aven commands),
`scripts/install-app-mod.sh` (owned mod files and free-key merge), and
`justfile` (the minimal working set).

The Rust dispatcher keeps its internal boundaries deliberately small:

- `src/model.rs` owns Aven command-context parsing and the serde-backed
  dispatcher state model, including durable core/terminal identities.
- `src/agents.rs` and `src/picker.rs` own agent/model selection and terminal
  picker mechanics.
- `src/store.rs` owns durable SQLite state; `src/store/read_only.rs` owns the
  non-mutating inspection reader.
- `src/process.rs` owns bounded Aven/OpenCode/process transport helpers, not
  central-store persistence. Worktree Git is not here.
- `src/dispatch/` owns dispatcher command behavior: planning/admission,
  runtime terminals/worktrees, Aven links, reset, supervision, and phases.
- `src/inspect/sources/` owns every bounded read-only structural source
  (scope, Aven, dispatcher store, herdr-core, Git worktrees, optional
  herdr-app, and one-shot OpenCode activity); `sources/assemble.rs` owns pure
  deterministic snapshot correlation and assembly. The dashboard consumes this
  `aven-dispatch-inspect/v1` contract instead of re-reading those sources.
- `src/core.rs` owns the herdr-core CLI contract: identity, launches, facts,
  snapshots, safe event parsing, and guarded sends.
- `src/worktrees.rs` owns every Git worktree operation through `hc exec`.
- `src/watch.rs` owns watcher ownership, durable supervision state, terminal
  correlation, and the bounded dashboard inventory.
- `src/app.rs` owns optional herdr-app focus, peek, space, and Aven-panel
  placement; every call is bounded and never gates dispatch.

The `web/` server owns only presentation and live transport: graph projection,
SSE, and the OpenCode event/activity/log client. Its one structural source is
`web/server/sources/inspect.ts`. Add new structural sources to the Rust
inspector, not to `web/server/sources/`.

This separation is intentionally not a framework: add a module only when a
shared concern has a clear owner.

**Troubleshooting:** Reopen Aven after changing commands. Check readiness with
`aven-dispatch doctor` (or `just doctor`). `hc --version`, `hc server status
--json`, `hc ls --json`, and `hc get <address> --json` show the core contract;
`aven-dispatch watch --status` shows whether a supervisor owns the store. A
missing desktop app is normal. Validate the optional mod with `just app-check`.
Terminal dispatch failures keep the complete error chain visible in the borrowed
Aven terminal. If the picker is missing, confirm the installed command uses
`--agent select` and `execution: terminal`.

## License

MIT — see [LICENSE](LICENSE).
