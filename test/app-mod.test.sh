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
[ -f "$PLUGIN_ROOT/app/aven-panel/main.js" ] || fail 'missing app/aven-panel/main.js'
[ -f "$PLUGIN_ROOT/app/aven-panel/logic.js" ] || fail 'missing app/aven-panel/logic.js'
[ -f "$PLUGIN_ROOT/app/aven-panel/mod.json" ] || fail 'missing app/aven-panel/mod.json'
[ -f "$PLUGIN_ROOT/app/aven-kanban/main.js" ] || fail 'missing app/aven-kanban/main.js'
[ -f "$PLUGIN_ROOT/app/aven-kanban/logic.js" ] || fail 'missing app/aven-kanban/logic.js'
[ -f "$PLUGIN_ROOT/app/aven-kanban/mod.json" ] || fail 'missing app/aven-kanban/mod.json'
[ -f "$PLUGIN_ROOT/app/aven-panel-tabs/main.js" ] || fail 'missing app/aven-panel-tabs/main.js'
[ -f "$PLUGIN_ROOT/app/aven-panel-tabs/logic.js" ] || fail 'missing app/aven-panel-tabs/logic.js'
[ -f "$PLUGIN_ROOT/app/aven-panel-tabs/mod.json" ] || fail 'missing app/aven-panel-tabs/mod.json'
[ -f "$PLUGIN_ROOT/app/layouts/aven-right.json" ] || fail 'missing app/layouts/aven-right.json'
assert_file_contains "$PLUGIN_ROOT/app/main.js" '--outlive-parent' 'mod terminals outlive the window'
assert_file_contains "$PLUGIN_ROOT/app/main.js" '--no-parent' 'mod terminals are not tied to the app'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'terminal.peek' 'mod reveals a terminal instead of owning it'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'terminal.peek' 'mod reveals hidden terminals in the current tab'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'aven-tui-' 'mod reuses a live Aven TUI terminal'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'terminals().find' 'mod reuses live core terminals instead of a stale snapshot'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'revealReady' 'mod waits for herdr-app to adopt a new terminal before revealing it'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'exec("herdr-app"' 'mod probes reveal readiness without surfacing an early error'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'on_size_change' 'mod refocuses after the overlay has completed its first layout'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'if (!this.closed) this.handle.focus();' 'mod does not refocus after it has closed'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'run("terminal.peek", { terminal: address });' 'mod transfers focus to Aven through the app after readiness probing'
assert_file_contains "$PLUGIN_ROOT/app/mod.json" '"place": "none"' 'mod does not take layout space'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" 'mod.open:aven-tasks' 'mod opens from an app command'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" '"mod:aven-tasks"' 'overlay keys are scoped to the mod'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" 'aven-tasks.open' 'overlay has an open key'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" 'aven-tasks.add' 'overlay has an add key'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" 'aven-tasks.inspect' 'overlay has an inspector key'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" 'mod.open:aven-kanban' 'Kanban has a global open binding'
assert_file_contains "$PLUGIN_ROOT/app/keys.json" '"mod:aven-kanban"' 'Kanban keys are scoped to the board'
assert_file_contains "$PLUGIN_ROOT/app/main.js" 'openKanban' 'launcher exposes the Kanban board'
assert_file_contains "$PLUGIN_ROOT/app/aven-kanban/main.js" 'overflow_x_scrollbar' 'Kanban columns scroll horizontally'
assert_file_contains "$PLUGIN_ROOT/app/aven-kanban/main.js" 'Merge into main' 'review cards expose the merge handoff'
assert_file_contains "$PLUGIN_ROOT/app/aven-kanban/main.js" 'mergeArgs(epic' 'merge uses dispatcher messaging rather than Git mutation'
assert_file_contains "$PLUGIN_ROOT/app/aven-kanban/logic.js" '"message", epic.id' 'merge command targets the immutable epic task ID'
assert_file_contains "$PLUGIN_ROOT/app/aven-kanban/logic.js" '"--attempt-id", attempt.attemptId' 'merge pins the selected attempt ID'
assert_file_contains "$PLUGIN_ROOT/app/aven-kanban/logic.js" '"--generation", String(attempt.generation)' 'merge pins the selected generation'
assert_file_contains "$PLUGIN_ROOT/app/aven-kanban/logic.js" '"--terminal", target.address' 'merge pins the selected role terminal'
assert_file_contains "$PLUGIN_ROOT/app/aven-kanban/main.js" '"--summary"' 'dispatcher reads use bounded prompt-free summaries'
assert_file_contains "$PLUGIN_ROOT/app/aven-kanban/logic.js" '"/ha-merge merge into local main"' 'merge handoff selects the existing local-main workflow'
assert_file_lacks "$PLUGIN_ROOT/app/aven-kanban/main.js" '"git", ["merge"' 'board never merges Git directly'
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
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" 'open-task' 'worktree panel exposes a task opener'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" '"Open task"' 'worktree panel labels the task opener'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" '"aven", "tui", ref' 'task opener starts Aven at the displayed task'
assert_file_contains "$PLUGIN_ROOT/app/aven-worktree/main.js" 'aven-task-' 'task opener uses task-specific terminals'
assert_file_contains "$PLUGIN_ROOT/app/aven-panel/logic.js" '"--workspace", workspace' 'browser and popup use explicit workspace'
assert_file_contains "$PLUGIN_ROOT/app/aven-panel/logic.js" '"--outlive-parent"' 'epic popup survives panel close'
assert_file_contains "$PLUGIN_ROOT/app/aven-panel/main.js" 'terminal.peek' 'epic popup is explicitly revealed'
assert_file_contains "$PLUGIN_ROOT/app/aven-panel/main.js" 'pendingLaunches' 'rapid epic activation is deduplicated'
assert_file_contains "$PLUGIN_ROOT/app/aven-panel/logic.js" '"--upcoming"' 'scheduled epics have a separate query lane'
assert_file_contains "$PLUGIN_ROOT/app/aven-panel-tabs/logic.js" 'herdr-aven-plugin.aven-panel-tabs.v1' 'tabs use isolated panel state'
assert_file_contains "$PLUGIN_ROOT/app/aven-panel-tabs/main.js" 'selector("aven", "Aven"' 'tabs expose the Aven selector'
assert_file_contains "$PLUGIN_ROOT/app/layouts/aven-right.json" '"aven-panel-tabs"' 'owned layout selects the owned tabs mod'
assert_file_contains "$PLUGIN_ROOT/app/layouts/aven-right.json" '"id": "aven"' 'owned layout has Aven stack child'

[ ! -e "$PLUGIN_ROOT/herdr-plugin.toml" ] || fail 'legacy herdr plugin manifest must be retired'
[ ! -e "$PLUGIN_ROOT/bin/run.sh" ] || fail 'legacy herdr popup entrypoint must be retired'
[ ! -e "$PLUGIN_ROOT/scripts/install-keybindings.sh" ] || fail 'legacy herdr keybinding installer must be retired'

if command -v herdr-app >/dev/null 2>&1; then
  for mod in app app/aven-worktree app/aven-panel app/aven-kanban app/aven-panel-tabs; do
    if herdr-app check "$PLUGIN_ROOT/$mod" >/tmp/app-check.log 2>&1; then
      assert_file_contains /tmp/app-check.log 'check passed' "herdr-app accepts $mod"
    else
      fail "herdr-app rejected $mod: $(cat /tmp/app-check.log)"
    fi
  done
fi

printf 'app mod ok\n'
