default:
    @just --list

# Install the dispatcher, the Aven commands, the optional herdr-app mods, and
# report readiness. No legacy herdr plugin/runtime is installed.
install:
    cargo install --path . --force
    sh scripts/install-aven-command.sh
    sh scripts/install-opencode-command.sh
    sh scripts/install-app-mod.sh
    sh scripts/doctor.sh

install-app-mod:
    sh scripts/install-app-mod.sh

test:
    cargo test --workspace
    sh test/run.sh

# Read-only, sanitized correlation snapshot (JSON).
inspect *args:
    cargo run -- inspect --json {{args}}

# Interactive read-only dispatcher inspector.
tui *args:
    cargo run -- tui {{args}}

# Terminal lifecycle, rendering, stalled-source and focus-effect PTY checks.
test-tui:
    cargo build --workspace
    sh test/dispatcher-tui.test.sh

# Real herdr-core + fake OpenCode/Aven processes in an isolated HC_SESSION.
test-e2e:
    cargo build --workspace
    sh test/rust-dispatch.test.sh

check:
    cargo check --workspace

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
    herdr-app check app/aven-worktree
    herdr-app check app/aven-panel
    herdr-app check app/aven-panel-tabs

# Node 24 is a development-only dependency for deterministic desktop-mod tests.
app-test:
    node test/aven-panel.test.mjs
    node test/aven-panel-tabs.test.mjs

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
    npm --prefix web run test:e2e
