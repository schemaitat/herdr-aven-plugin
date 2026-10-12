#!/bin/sh
# The manifest must stay in sync with the scripts it launches.
set -eu
. "$(dirname "$0")/helpers.sh"

manifest=$PLUGIN_ROOT/herdr-plugin.toml
[ -f "$manifest" ] || fail "missing herdr-plugin.toml"

body=$(cat "$manifest")

# Required top-level metadata.
assert_contains "$body" 'id = "aven.tasks"'
assert_contains "$body" 'name = "aven tasks"'
assert_contains "$body" 'version = "0.4.0"'
assert_contains "$body" 'min_herdr_version = "0.9.0"'
assert_contains "$body" 'description ='
assert_contains "$body" 'platforms = ["linux", "macos"]'

# Actions the wrapper dispatches on.
for action in open compose install-keybindings install-aven-command doctor; do
  assert_contains "$body" "id = \"$action\"" "action $action"
done

# The aven custom command the installer wires up.
[ -f "$PLUGIN_ROOT/bin/dispatch.sh" ] || fail "missing bin/dispatch.sh"
[ -f "$PLUGIN_ROOT/scripts/install-aven-command.sh" ] || fail "missing scripts/install-aven-command.sh"
[ -f "$PLUGIN_ROOT/aven-commands.yaml" ] || fail "missing aven-commands.yaml"

# The bundled example workflow the dispatcher can insert.
[ -f "$PLUGIN_ROOT/skills/aven/sdd.md" ] || fail "missing skills/aven/sdd.md"

# Panes, both popovers, one per entrypoint.
assert_contains "$body" 'id = "tui"'
assert_contains "$body" 'id = "compose"'
assert_contains "$body" 'placement = "popup"'

# Every command is invoked through sh and points at a real file.
commands=$(grep -E '^command = ' "$manifest" | sed -n 's/.*"\([^"]*\.sh\)".*/\1/p' | sort -u)
[ -n "$commands" ] || fail "no script commands found in the manifest"
for script in $commands; do
  [ -f "$PLUGIN_ROOT/$script" ] || fail "manifest references missing $script"
done

printf 'manifest ok\n'
