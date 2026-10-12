#!/bin/sh
# scripts/install-aven-command.sh: writes the dispatch command into aven's
# config.yaml, once, without rewriting an existing tui: section.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
export AVEN_CONFIG_DIR=$work/aven

run_installer() {
  sh "$PLUGIN_ROOT/scripts/install-aven-command.sh"
}

config=$AVEN_CONFIG_DIR/config.yaml

# A fresh config directory gets the managed block.
out=$(run_installer)
assert_contains "$out" "config: $config" "config path"
assert_contains "$out" "installed: dispatch (keys: z d)" "installed line"
assert_file_contains "$config" "# Managed by herdr-aven-plugin"
assert_file_contains "$config" "name: dispatch"
assert_file_contains "$config" "program: sh"
assert_file_contains "$config" "args:"
assert_file_contains "$config" "$PLUGIN_ROOT/bin/dispatch.sh"
assert_file_contains "$config" "keys: [z d]"
assert_file_contains "$config" "target: focused"
assert_file_contains "$config" "on_success: quit"

# aven can parse the result.
aven config get sync.enabled >/dev/null ||
  fail "aven cannot parse the config after install"

# Running again changes nothing and says so.
lines=$(wc -l < "$config")
out=$(run_installer)
assert_contains "$out" "already installed" "idempotent"
assert_eq "$(wc -l < "$config")" "$lines" "reinstall must not add a second block"

# An existing config without a tui: section gets the block appended.
other=$work/other
AVEN_CONFIG_DIR=$other
export AVEN_CONFIG_DIR
mkdir -p "$other"
printf 'local:\n  db_path: null\n' > "$other/config.yaml"
out=$(run_installer)
assert_contains "$out" "installed: dispatch" "append to existing config"
assert_file_contains "$other/config.yaml" "local:" "original settings kept"
assert_file_contains "$other/config.yaml" "name: dispatch" "block appended"
aven config get sync.enabled >/dev/null || fail "appended config does not parse"

# A config that already has a top-level tui: section is never rewritten.
busy=$work/busy
AVEN_CONFIG_DIR=$busy
export AVEN_CONFIG_DIR
mkdir -p "$busy"
printf 'tui:\n  sidebar:\n    views: [queue]\n' > "$busy/config.yaml"
before=$(cat "$busy/config.yaml")
set +e
out=$(run_installer 2>&1)
rc=$?
set -e
assert_eq "$rc" "1" "busy config exit code"
assert_contains "$out" "already has a top-level tui: section" "busy config warning"
assert_contains "$out" "name: dispatch" "busy config prints the snippet"
assert_eq "$(cat "$busy/config.yaml")" "$before" "busy config must be untouched"

printf 'install-aven-command ok\n'
