default:
    @just --list

install:
    herdr plugin link "{{justfile_directory()}}"
    herdr plugin action invoke aven.tasks.install-keybindings
    herdr plugin action invoke aven.tasks.install-aven-command
    herdr plugin action invoke aven.tasks.doctor

test:
    cargo test --workspace
    sh test/run.sh

check:
    cargo check --workspace

fmt:
    cargo fmt --check

doctor:
    cargo run -- doctor
