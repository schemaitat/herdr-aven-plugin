#!/bin/sh
# bin/run.sh pane: starts aven in the right directory with the right flags.
#
# The sandbox used for development refuses chmod, so the tests run aven through
# /bin/sh: AVEN_BIN is /bin/sh and a tiny script named "tui" lives in the pane
# directory, which sh runs with the flags the plugin passes.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
notedir=$work/project
mkdir -p "$notedir"

FAKE_AVEN_LOG=$work/aven.log
AVEN_BIN=/bin/sh
HERDR_PLUGIN_ROOT=$PLUGIN_ROOT
HERDR_PLUGIN_ENTRYPOINT_ID=tui
export FAKE_AVEN_LOG AVEN_BIN HERDR_PLUGIN_ROOT HERDR_PLUGIN_ENTRYPOINT_ID

cat > "$notedir/tui" <<'SCRIPT'
{
  printf 'cwd=%s\n' "$PWD"
  printf 'args=%s\n' "$0 $*"
} >> "$FAKE_AVEN_LOG"
SCRIPT

run_pane() {
  sh "$PLUGIN_ROOT/bin/run.sh" pane
}

# TUI popover: aven tui -p in the focused pane's directory.
HERDR_PLUGIN_CONTEXT_JSON=$(printf '{"focused_pane_cwd":"%s","workspace_cwd":"%s"}' "$notedir" "$work")
export HERDR_PLUGIN_CONTEXT_JSON
: > "$FAKE_AVEN_LOG"
run_pane
assert_file_contains "$FAKE_AVEN_LOG" "cwd=$notedir"
assert_file_contains "$FAKE_AVEN_LOG" "args=tui -p"

# Composer popover: aven tui -p --add-task-only.
: > "$FAKE_AVEN_LOG"
HERDR_PLUGIN_ENTRYPOINT_ID=compose
run_pane
assert_file_contains "$FAKE_AVEN_LOG" "cwd=$notedir"
assert_file_contains "$FAKE_AVEN_LOG" "args=tui -p --add-task-only"

# Agent picker is a Herdr popup that returns the selected OpenCode ID through
# the response file instead of consuming the Aven command's JSON stdin.
picker_response=$work/picker-response
HERDR_PLUGIN_ENTRYPOINT_ID=agent-picker
AVEN_DISPATCH_PICKER_RESPONSE=$picker_response
AVEN_DISPATCH_PICKER_CHOICES='  1. Build (build)'
AVEN_DISPATCH_PICKER_IDS=build
export AVEN_DISPATCH_PICKER_RESPONSE AVEN_DISPATCH_PICKER_CHOICES AVEN_DISPATCH_PICKER_IDS
printf '1\n' | run_pane
assert_file_contains "$picker_response" 'build'
unset AVEN_DISPATCH_PICKER_RESPONSE AVEN_DISPATCH_PICKER_CHOICES AVEN_DISPATCH_PICKER_IDS

# A stale focused-pane directory falls back to the workspace directory.
HERDR_PLUGIN_CONTEXT_JSON=$(printf '{"focused_pane_cwd":"%s/gone","workspace_cwd":"%s"}' "$work" "$notedir")
: > "$FAKE_AVEN_LOG"
HERDR_PLUGIN_ENTRYPOINT_ID=tui
run_pane
assert_file_contains "$FAKE_AVEN_LOG" "cwd=$notedir"

# An unknown entrypoint is a hard error.
HERDR_PLUGIN_ENTRYPOINT_ID=nope
set +e
run_pane 2>/dev/null
rc=$?
set -e
assert_eq "$rc" "2" "unknown entrypoint exit code"

# Missing aven prints guidance and exits 127.
HERDR_PLUGIN_ENTRYPOINT_ID=tui
AVEN_BIN=/nonexistent/aven
set +e
out=$(run_pane 2>&1)
rc=$?
set -e
assert_eq "$rc" "127" "missing aven exit code"
assert_contains "$out" "aven is not installed" "missing aven message"
AVEN_BIN=/bin/sh

# AVEN_BIN may name a command on PATH, not only a path.
: > "$FAKE_AVEN_LOG"
AVEN_BIN=sh
run_pane
assert_file_contains "$FAKE_AVEN_LOG" "args=tui -p"

printf 'pane ok\n'
