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
