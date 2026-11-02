#!/bin/sh
# The optional herdr-app mod is repository-owned, presents only, and the old
# herdr plugin/popup runtime is retired.
set -eu
. "$(dirname "$0")/helpers.sh"

[ -f "$PLUGIN_ROOT/app/main.js" ] || fail 'missing app/main.js'
[ -f "$PLUGIN_ROOT/app/mod.json" ] || fail 'missing app/mod.json'
[ -f "$PLUGIN_ROOT/app/keys.json" ] || fail 'missing app/keys.json'
[ -f "$PLUGIN_ROOT/app/aven-worktree/main.js" ] || fail 'missing app/aven-worktree/main.js'
[ -f "$PLUGIN_ROOT/app/aven-worktree/mod.json" ] || fail 'missing app/aven-worktree/mod.json'
assert_file_contains "$PLUGIN_ROOT/app/main.js" '--outlive-parent' 'mod terminals outlive the window'
assert_file_contains "$PLUGIN_ROOT/app/main.js" '--no-parent' 'mod terminals are not tied to the app'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'terminal.peek' 'mod reveals a terminal instead of owning it'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'terminal.peek' 'mod reveals hidden terminals in the current tab'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'aven-tui-' 'mod reuses a live Aven TUI terminal'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'terminals().find' 'mod reuses live core terminals instead of a stale snapshot'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'revealReady' 'mod waits for herdr-app to adopt a new terminal before revealing it'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'exec("herdr-app"' 'mod probes reveal readiness without surfacing an early error'
assert_file_contains "$PLUGIN_ROOT/app/mod.json" '"place": "none"' 'mod does not take layout space'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" 'mod.open:aven-tasks' 'mod opens from an app command'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" '"mod:aven-tasks"' 'overlay keys are scoped to the mod'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" 'aven-tasks.open' 'overlay has an open key'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" 'aven-tasks.add' 'overlay has an add key'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" 'aven-tasks.inspect' 'overlay has an inspector key'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'aven-inspector-' 'mod reuses a live inspector terminal'
assert_file_contains "$PLUGIN_ROOT/app/main.js" '"aven-dispatch", "tui"' 'mod launches the Rust inspector'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/mod.json" '"place": "none"' 'worktree panel does not take layout space'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" 'aven-dispatch' 'worktree panel reads persisted dispatch state'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" 'aven", ["show"' 'worktree panel reads the epic and task from Aven'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" 'epic_children' 'worktree panel shows phase progress'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" 'terminal.peek' 'worktree panel reveals the attempt terminal'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" 'write_to_clipboard' 'worktree panel copies the displayed task ref through GPUI'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" 'yank-id' 'worktree panel exposes a task-ID yank control'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" 'ID copied' 'worktree panel confirms a copied task ID'

[ ! -e "$PLUGIN_ROOT/herdr-plugin.toml" ] || fail 'legacy herdr plugin manifest must be retired'
[ ! -e "$PLUGIN_ROOT/bin/run.sh" ] || fail 'legacy herdr popup entrypoint must be retired'
[ ! -e "$PLUGIN_ROOT/scripts/install-keybindings.sh" ] || fail 'legacy herdr keybinding installer must be retired'

if command -v herdr-app >/dev/null 2>&1; then
  for mod in app app/aven-worktree; do
    if herdr-app check "$PLUGIN_ROOT/$mod" >/tmp/app-check.log 2>&1; then
      assert_file_contains /tmp/app-check.log 'check passed' "herdr-app accepts $mod"
    else
      fail "herdr-app rejected $mod: $(cat /tmp/app-check.log)"
    fi
  done
fi

printf 'app mod ok\n'
