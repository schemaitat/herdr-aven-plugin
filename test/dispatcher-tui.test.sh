#!/bin/sh
# Terminal runtime: fixture rendering, help/quit, Ctrl+C/startup restoration,
# and non-TTY diagnostics through a real PTY.
set -eu
. "$(dirname "$0")/helpers.sh"

cargo build --quiet --bin aven-dispatch
binary=$PLUGIN_ROOT/target/debug/aven-dispatch
python3 "$PLUGIN_ROOT/test/dispatcher-tui.py" "$binary" "$PLUGIN_ROOT/test/tui-fixture.json"
printf 'dispatcher tui ok\n'
