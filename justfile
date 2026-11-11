default:
    @just --list

# Install the dispatcher, the Aven commands, the optional herdr-app mods, and
# report readiness. No legacy herdr plugin/runtime is installed.
install:
    cargo install --path . --force
    sh scripts/install-aven-command.sh
    sh scripts/install-opencode-command.sh
    sh scripts/install-skill.sh
    sh scripts/install-app-mod.sh
    sh scripts/doctor.sh

install-skill:
    sh scripts/install-skill.sh

# Install finish commands/profiles; --upgrade explicitly backs up old definitions.
install-commands *args:
    sh scripts/install-opencode-command.sh {{args}}

# Isolated approval, batch merge/conflict, stale-evidence and closeout contracts.
test-approval:
    cargo build --workspace
    sh test/run.sh approval

install-app-mod:
    sh scripts/install-app-mod.sh

# Default fast tier: Rust unit tests plus unit/contract suites, budgeted at 20s.
test:
    cargo test --workspace
    cargo build --workspace
    TEST_BUDGET_SECONDS=${TEST_BUDGET_SECONDS:-20} sh test/run.sh unit

# Explicit alias for the default fast tier.
test-unit: test

# Heavy approval, dispatch and lifecycle fixtures; opt in when needed.
test-integration:
    cargo build --workspace
    sh test/run.sh integration

# Every local Rust and shell suite: unit tier first, then integration.
test-all:
    cargo test --workspace
    cargo build --workspace
    sh test/run.sh all

# Rust unit tests scoped by module/test name, e.g. `just test-rust dispatch::plan`.
test-rust *filter:
    cargo test --workspace {{filter}}

# Named use-case suites, e.g. `just test-suite lifecycle` or `just test-suite install`.
test-suite *names:
    cargo build --workspace
    sh test/run.sh {{names}}

# Discover suite names, tiers, dependencies and files.
test-list:
    sh test/run.sh --list

# Lifecycle isolation, delivery/closeout, cancellation and audit contracts.
test-lifecycle:
    cargo build --workspace
    sh test/run.sh lifecycle

# Read-only work-queue contract: stage classification, filtering, truncation.
test-work:
    cargo build --workspace
    sh test/work.test.sh

# Root-epic cascade deletion, leaves-first order, and dispatcher state cleanup.
test-board-delete:
    cargo build --workspace
    sh test/run.sh board-delete

# Read-only lifecycle audit. Exit: 0 clean, 1 violations, 2 incomplete source.
tasks-audit *args:
    cargo run -- audit {{args}}

# Report tool/executable provenance and isolated per-run paths.
preflight:
    sh scripts/preflight.sh

# Read-only, sanitized correlation snapshot (JSON).
inspect *args:
    cargo run -- inspect --json {{args}}

# Real herdr-core + fake OpenCode/Aven processes in an isolated HC_SESSION.
test-e2e:
    cargo build --workspace
    sh test/run.sh dispatch

check:
    cargo check --workspace
    cargo clippy --workspace --all-targets -- -D warnings

fmt:
    cargo fmt --check

doctor:
    cargo run -- doctor

# Long-running event-driven supervisor. Start it under a service manager or
# with `nohup`; `just watch-status` and `just watch-stop` manage it explicitly.
watch:
    cargo run -- watch

watch-once:
    cargo run -- watch --once

watch-status:
    cargo run -- watch --status

watch-stop:
    cargo run -- watch --stop

app-check:
    herdr-app check app
    herdr-app check app/aven-panel
    herdr-app check app/aven-kanban
    herdr-app check app/aven-panel-tabs

# Node 24 is a development-only dependency for deterministic desktop-mod tests.
app-test:
    node test/aven-kanban.test.mjs
    node test/aven-panel.test.mjs
    node test/aven-panel-tabs.test.mjs

# Read-only replay of the Kanban board's bounded reads: row counts, bytes,
# spawned processes, and per-stage timings as JSON. Never mutates Aven or Git.
board-profile *args:
    node scripts/kanban-profile.mjs {{args}}

# Real isolated herdr-app/core, dummy Aven epics, merge-handoff assertion and screenshots.
app-test-e2e:
    sh test/aven-kanban-e2e.sh

# Optional local read-only dashboard (Node 24 LTS).
ui-install:
    npm --prefix web ci

ui-dev:
    npm --prefix web run dev

ui-check:
    npm --prefix web run check

ui-test:
    npm --prefix web test

ui-build:
    npm --prefix web run build

ui-start:
    npm --prefix web start

# Requires a built UI and Chromium (or UI_CHROME=/path/to/chrome).
ui-test-browser:
    npm --prefix web run test:browser

# Deterministic graph, live, accessibility, outage and measured performance fixtures.
ui-test-e2e:
    cargo build --workspace
    npm --prefix web run test:e2e
