#!/bin/sh
# scripts/doctor.sh: reports the directory and the project aven infers.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
notedir=$work/repo
mkdir -p "$notedir"

PLUGIN_ROOT=$PLUGIN_ROOT
AVEN_BIN=/bin/sh
HERDR_PLUGIN_ROOT=$PLUGIN_ROOT
HERDR_PLUGIN_CONTEXT_JSON=$(printf '{"focused_pane_cwd":"%s","workspace_cwd":"%s"}' "$notedir" "$work")
HERDR_PLUGIN_CONFIG_DIR=$work/config
export PLUGIN_ROOT AVEN_BIN HERDR_PLUGIN_ROOT HERDR_PLUGIN_CONTEXT_JSON HERDR_PLUGIN_CONFIG_DIR

# aven is /bin/sh here; "sh prime --json" runs this script.
cat > "$notedir/prime" <<'SCRIPT'
printf '{"project":"app"}\n'
SCRIPT

out=$(sh "$PLUGIN_ROOT/scripts/doctor.sh")
assert_contains "$out" "aven tasks popover" "header"
assert_contains "$out" "$notedir" "start directory"
assert_contains "$out" "$work" "workspace directory"
assert_contains "$out" "$work/config" "config directory"
assert_contains "$out" "app" "inferred project"
assert_contains "$out" "aven tui -p" "scope hint"

# No project inferred: doctor still succeeds and says so.
: > "$notedir/prime"
out=$(sh "$PLUGIN_ROOT/scripts/doctor.sh")
assert_contains "$out" "workspace scope" "no-project hint"
assert_contains "$out" "(none)" "no-project row"

# Missing aven fails so the action log flags it.
set +e
out=$(AVEN_BIN=/nonexistent/aven sh "$PLUGIN_ROOT/scripts/doctor.sh" 2>&1)
rc=$?
set -e
assert_eq "$rc" "1" "missing aven exit code"
assert_contains "$out" "NOT FOUND" "missing aven row"

printf 'doctor ok\n'
