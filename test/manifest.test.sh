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
[ -f "$PLUGIN_ROOT/scripts/install-aven-command.sh" ] || fail "missing scripts/install-aven-command.sh"
[ -f "$PLUGIN_ROOT/aven-commands.yaml" ] || fail "missing aven-commands.yaml"

# The bundled example workflow the dispatcher can insert.
[ -f "$PLUGIN_ROOT/skills/aven/sdd.md" ] || fail "missing skills/aven/sdd.md"
[ -f "$PLUGIN_ROOT/.opencode/opencode.jsonc" ] || fail "missing plugin OpenCode configuration"
[ -f "$PLUGIN_ROOT/.opencode/agents/babysitter.md" ] || fail "missing babysitter agent"
babysitter=$(cat "$PLUGIN_ROOT/.opencode/agents/babysitter.md")
assert_contains "$babysitter" 'mode: primary' 'babysitter is primary-capable'
assert_contains "$babysitter" 'model: github-copilot/gpt-6-luna' 'babysitter Luna model'
assert_contains "$babysitter" 'steps: 1000' 'babysitter step limit'
assert_contains "$babysitter" 'every 60 seconds' 'babysitter monitoring cadence'
assert_contains "$babysitter" 'herdr status' 'babysitter checks Herdr status'
assert_contains "$babysitter" 'herdr pane read' 'babysitter reads the build pane'
assert_contains "$babysitter" 'last resort' 'babysitter escalates only as a last resort'
assert_file_contains "$PLUGIN_ROOT/README.md" 'dispatch --agent build --babysitter' 'documented opt-in babysitter dispatch'
assert_file_contains "$PLUGIN_ROOT/README.md" 'OpenCode V2 API' 'documented API-owned sessions'

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
