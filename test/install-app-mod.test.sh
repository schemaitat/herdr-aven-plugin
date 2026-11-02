#!/bin/sh
# scripts/install-app-mod.sh: owns only the mod files, merges free keys, and
# never replaces a binding the person already has.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
app_home=$work/herdr-app
mkdir -p "$app_home"
printf '%s\n' '{' \
  '  "global": { "ctrl-shift-a": "mod.open:other", "ctrl-shift-k": "mod.open:picker" },' \
  '  "terminal": { "ctrl-shift-c": "terminal.copy" }' \
  '}' > "$app_home/keys.json"

fake=$work/bin
mkdir -p "$fake"
printf '%s\n' '#!/bin/sh' '[ "${1:-}" = check ] && { printf "check passed\n"; exit 0; }' 'exit 0' > "$fake/herdr-app"
chmod +x "$fake/herdr-app"

out=$(PATH="$fake:$PATH" HERDR_APP_HOME=$app_home sh "$PLUGIN_ROOT/scripts/install-app-mod.sh")
assert_contains "$out" "installed: mods/aven-tasks" "overlay mod installed"
assert_contains "$out" "installed: mods/aven-worktree" "worktree panel mod installed"
assert_contains "$out" "kept: ctrl-shift-a -> mod.open:other" "existing binding is preserved"
[ -f "$app_home/mods/aven-tasks/main.js" ] || fail 'mod main.js not installed'
[ -f "$app_home/mods/aven-tasks/mod.json" ] || fail 'mod.json not installed'
[ -f "$app_home/mods/aven-worktree/main.js" ] || fail 'worktree panel main.js not installed'
[ -f "$app_home/mods/aven-worktree/mod.json" ] || fail 'worktree panel mod.json not installed'
assert_file_contains "$app_home/mods/aven-worktree/main.js" 'this.tab(t, "plan", "Plan")' 'plan tab installed'
assert_file_contains "$app_home/mods/aven-worktree/main.js" 'this.tab(t, "implementation", "Implementation")' 'implementation tab installed'
assert_file_contains "$app_home/keys.json" '"ctrl-shift-a": "mod.open:other"' 'conflicting key unchanged'
assert_file_contains "$app_home/keys.json" '"ctrl-shift-c": "terminal.copy"' 'unrelated section preserved'
assert_file_contains "$app_home/keys.json" '"mod:aven-tasks"' 'overlay key section installed'
assert_file_contains "$app_home/keys.json" '"o": "aven-tasks.open"' 'overlay open key installed'
assert_file_contains "$app_home/keys.json" '"a": "aven-tasks.add"' 'overlay add key installed'
[ -f "$app_home/keys.json.aven-backup" ] || fail 'changed keys need a backup'

before=$(cat "$app_home/keys.json")
PATH="$fake:$PATH" HERDR_APP_HOME=$app_home sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" >/dev/null
assert_eq "$(cat "$app_home/keys.json")" "$before" 'reinstall leaves keys unchanged'

fresh=$work/fresh
mkdir -p "$fresh"
PATH="$fake:$PATH" HERDR_APP_HOME=$fresh sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" --no-keys >/dev/null
[ ! -e "$fresh/keys.json" ] || fail '--no-keys must not write keys.json'

printf 'install app mod ok\n'
