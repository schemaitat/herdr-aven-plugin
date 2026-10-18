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

check:
    cargo check --workspace

fmt:
    cargo fmt --check

doctor:
    cargo run -- doctor
