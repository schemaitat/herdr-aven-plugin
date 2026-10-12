#!/bin/sh
# bin/run.sh action: dispatches to "herdr plugin pane open" for the popovers.
# HERDR_BIN_PATH is /bin/echo, so the action's argv is printed and checked.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
notedir=$work/app
mkdir -p "$notedir"

export HERDR_PLUGIN_ROOT=$PLUGIN_ROOT
export HERDR_BIN_PATH=/bin/echo

run_action() {
  sh "$PLUGIN_ROOT/bin/run.sh" action
}

HERDR_PLUGIN_CONTEXT_JSON=$(printf '{"focused_pane_cwd":"%s","workspace_cwd":"%s"}' "$notedir" "$work")
export HERDR_PLUGIN_CONTEXT_JSON

HERDR_PLUGIN_ACTION_ID=open
export HERDR_PLUGIN_ACTION_ID
out=$(run_action)
assert_eq "$out" "plugin pane open --plugin aven.tasks --entrypoint tui" "open action"

HERDR_PLUGIN_ACTION_ID=compose
out=$(run_action)
assert_eq "$out" "plugin pane open --plugin aven.tasks --entrypoint compose" "compose action"

# The pane is opened without --cwd: the pane command must stay in the plugin
# directory so its relative bin/run.sh resolves. The pane script moves to the
# focused pane's directory itself.
assert_not_contains "$out" "--cwd" "no cwd override"

# Unknown and missing action ids fail.
HERDR_PLUGIN_ACTION_ID=nope
set +e
out=$(run_action 2>&1)
rc=$?
set -e
assert_eq "$rc" "2" "unknown action exit code"
assert_contains "$out" "unknown action: nope"

set +e
out=$(HERDR_PLUGIN_ACTION_ID= run_action 2>&1)
rc=$?
set -e
assert_eq "$rc" "2" "missing action exit code"
assert_contains "$out" "HERDR_PLUGIN_ACTION_ID is not set"

printf 'action ok\n'
