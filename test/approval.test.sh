#!/bin/sh
# Real Git through hc; disposable Aven/OpenCode/store, never live tasks/sessions.
set -eu
. "$(dirname "$0")/helpers.sh"
work=$(mktemp -d /tmp/opencode/aven-approval.XXXXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
python3 "$PLUGIN_ROOT/test/approval_fixture_test.py" "$PLUGIN_ROOT" "$work"
