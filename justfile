default:
    @just --list

install:
    herdr plugin link "{{justfile_directory()}}"
    sh scripts/install-keybindings.sh
    sh scripts/install-aven-command.sh
    sh scripts/doctor.sh

test:
    cargo test --workspace
    sh test/run.sh

# Real Herdr/Aven popup lifecycle in an isolated session; no real agent runs.
test-e2e:
    cargo build --workspace
    python3 test/herdr-popup-e2e.py

check:
    cargo check --workspace

fmt:
    cargo fmt --check

doctor:
    cargo run -- doctor

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

# Deterministic graph/accessibility and live-status fixtures; no live agents.
ui-test-e2e:
    npm --prefix web run test:browser -- graph.spec.ts live-status.spec.ts
