#!/bin/sh
# Repository shape: minimal justfile entrypoints and no legacy runtime files.
set -eu
. "$(dirname "$0")/helpers.sh"

for entry in install install-app-mod test test-unit test-extended test-integration test-all test-rust test-module test-suite test-list test-e2e check fmt quality doctor watch watch-status watch-stop app-check ui-install ui-check ui-test ui-build; do
  grep -Eq "^$entry(:|[[:space:]])" "$PLUGIN_ROOT/justfile" || fail "missing just entrypoint $entry"
done

# The default test tier is fast, manifest-driven and budgeted at 10 seconds.
assert_file_contains "$PLUGIN_ROOT/justfile" 'sh test/run.sh unit' 'default test tier'
assert_file_contains "$PLUGIN_ROOT/justfile" 'TEST_BUDGET_SECONDS=${TEST_BUDGET_SECONDS:-10}' 'default test budget'
assert_file_contains "$PLUGIN_ROOT/test/suites.txt" 'approval|integration||approval.test.sh' 'heavy approval suite is opt-in'
assert_file_contains "$PLUGIN_ROOT/test/suites.txt" 'dispatch|integration||rust-dispatch.test.sh' 'dispatch process fixture is opt-in'
assert_file_contains "$PLUGIN_ROOT/test/suites.txt" 'inspect|extended||inspect.test.sh' 'slow inspector contract is opt-in'
assert_file_contains "$PLUGIN_ROOT/test/suites.txt" 'install-app-mod|extended||install-app-mod.test.sh' 'slow installer contract is opt-in'
[ -f "$PLUGIN_ROOT/test/rust-modules.txt" ] || fail 'missing test/rust-modules.txt'

for script in scripts/doctor.sh scripts/install-aven-command.sh scripts/install-app-mod.sh; do
  [ -f "$PLUGIN_ROOT/$script" ] || fail "missing $script"
done
for legacy in herdr-plugin.toml bin/run.sh scripts/install-keybindings.sh; do
  [ ! -e "$PLUGIN_ROOT/$legacy" ] || fail "legacy file still present: $legacy"
done

# Aven commands still use an interactive terminal and the bundled SDD example.
commands=$PLUGIN_ROOT/aven-commands.yaml
assert_file_contains "$commands" 'execution: terminal'
assert_file_contains "$commands" 'aven/sdd-plan-implement'
assert_file_contains "$commands" '--skills-dir'
assert_file_contains "$commands" 'name: describe-llm'
assert_file_contains "$commands" 'args: [describe, --llm]'
assert_file_lacks "$commands" 'herdr plugin'
assert_file_lacks "$commands" 'herdr worktree'

# Agents no longer instruct the retired runtime.
for agent in agents/babysitter.md agents/orchestrator.md; do
  body=$(cat "$PLUGIN_ROOT/$agent")
  assert_contains "$body" 'herdr-core'
  assert_not_contains "$body" 'herdr pane'
  assert_not_contains "$body" 'herdr status'
  # Hidden primary agents cannot be adopted by an attached OpenCode TUI, which
  # would show `build` and switch the session agent on the next prompt.
  assert_not_contains "$body" 'hidden: true'
done

printf 'repo ok\n'
