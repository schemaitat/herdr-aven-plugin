#!/bin/sh
# scripts/install-app-mod.sh: owns only the mod files, merges free keys, never
# replaces a binding the person gave another action, and reconciles its own mod
# sections when a shipped key moves or disappears.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
app_home=$work/herdr-app
mkdir -p "$app_home"
printf '%s\n' '{' \
  '  "global": { "ctrl-shift-a": "mod.open:other", "ctrl-shift-h": "mod.open:picker" },' \
  '  "terminal": { "ctrl-shift-c": "terminal.copy" }' \
  '}' > "$app_home/keys.json"

fake=$work/bin
mkdir -p "$fake"
printf '%s\n' '#!/bin/sh' '[ "${1:-}" = check ] && { printf "check passed\n"; exit 0; }' 'exit 0' > "$fake/herdr-app"
chmod +x "$fake/herdr-app"

out=$(PATH="$fake:$PATH" HERDR_APP_HOME=$app_home sh "$PLUGIN_ROOT/scripts/install-app-mod.sh")
assert_contains "$out" "installed: mods/aven-tasks" "overlay mod installed"
assert_contains "$out" "installed: mods/aven-panel" "browser mod installed"
assert_contains "$out" "installed: mods/aven-kanban" "Kanban mod installed"
assert_contains "$out" "installed: mods/aven-panel-tabs" "selector mod installed"
assert_contains "$out" "installed: layouts/aven-right.json" "right layout installed"
assert_contains "$out" "kept: ctrl-shift-a -> mod.open:other" "existing binding is preserved"
assert_contains "$out" "kept: ctrl-shift-h -> mod.open:picker" "existing Kanban chord is preserved"
[ -f "$app_home/mods/aven-tasks/main.js" ] || fail 'mod main.js not installed'
[ -f "$app_home/mods/aven-tasks/mod.json" ] || fail 'mod.json not installed'
[ ! -e "$app_home/mods/aven-worktree" ] || fail 'retired worktree panel must not be installed'
[ -f "$app_home/mods/aven-panel/main.js" ] || fail 'browser main.js not installed'
[ -f "$app_home/mods/aven-kanban/main.js" ] || fail 'Kanban main.js not installed'
[ -f "$app_home/mods/aven-kanban/logic.js" ] || fail 'Kanban logic.js not installed'
[ -f "$app_home/mods/aven-panel-tabs/main.js" ] || fail 'selector main.js not installed'
[ -f "$app_home/layouts/aven-right.json" ] || fail 'layout not installed'
assert_file_contains "$app_home/keys.json" '"ctrl-shift-a": "mod.open:other"' 'conflicting key unchanged'
assert_file_contains "$app_home/keys.json" '"ctrl-shift-c": "terminal.copy"' 'unrelated section preserved'
assert_file_contains "$app_home/keys.json" '"mod:aven-tasks"' 'overlay key section installed'
assert_file_contains "$app_home/keys.json" '"o": "aven-tasks.open"' 'overlay open key installed'
assert_file_contains "$app_home/keys.json" '"a": "aven-tasks.add"' 'overlay add key installed'
assert_file_contains "$app_home/keys.json" '"ctrl-shift-h": "mod.open:picker"' 'conflicting Kanban key unchanged'
assert_file_contains "$app_home/keys.json" '"mod:aven-kanban"' 'Kanban key section installed'
assert_file_contains "$app_home/keys.json" '"m": "aven-kanban.merge"' 'Kanban merge key installed'
[ -f "$app_home/keys.json.aven-backup" ] || fail 'changed keys need a backup'

# An upgrade reconciles this plugin's own mod bindings: moved keys are updated,
# removed commands disappear, and a key bound to someone else's action stays.
stale=$work/stale
mkdir -p "$stale"
printf '%s\n' \
  '{' \
  '  "mod:aven-kanban": {' \
  '    "G": "aven-kanban.last",' \
  '    "g": "aven-kanban.first-prefix",' \
  '    "h": "aven-kanban.ship",' \
  '    "l": "aven-kanban.summary",' \
  '    "q": "aven-kanban.removed",' \
  '    "z": "other.command"' \
  '  }' \
  '}' > "$stale/keys.json"
stale_out=$(PATH="$fake:$PATH" HERDR_APP_HOME=$stale sh "$PLUGIN_ROOT/scripts/install-app-mod.sh")
assert_contains "$stale_out" 'updated: h -> aven-kanban.column-previous (was aven-kanban.ship)' 'stale h is moved to column-left'
assert_contains "$stale_out" 'updated: l -> aven-kanban.column-next (was aven-kanban.summary)' 'stale l is moved to column-right'
assert_contains "$stale_out" 'updated: g -> aven-kanban.first (was aven-kanban.first-prefix)' 'stale g is moved to the column top'
assert_contains "$stale_out" 'removed stale: q -> aven-kanban.removed' 'a removed owned binding is dropped'
assert_contains "$stale_out" 'removed stale: G -> aven-kanban.last' 'an uppercase binding is dropped for Shift-G'
assert_file_contains "$stale/keys.json" '"h": "aven-kanban.column-previous"' 'h is column-left after upgrade'
assert_file_contains "$stale/keys.json" '"l": "aven-kanban.column-next"' 'l is column-right after upgrade'
assert_file_contains "$stale/keys.json" '"g": "aven-kanban.first"' 'g jumps to the column top after upgrade'
assert_file_contains "$stale/keys.json" '"shift-g": "aven-kanban.last"' 'Shift-G selects the last card after upgrade'
assert_file_contains "$stale/keys.json" '"shift-s": "aven-kanban.ship"' 'Ship PR is installed on Shift-S after upgrade'
assert_file_contains "$stale/keys.json" '"z": "other.command"' 'a foreign binding in the mod section is preserved'
assert_file_lacks "$stale/keys.json" '"q": "aven-kanban.removed"' 'the removed owned binding is gone'
assert_file_lacks "$stale/keys.json" '"h": "aven-kanban.ship"' 'the old h ship binding is gone'
assert_file_lacks "$stale/keys.json" '"G": "aven-kanban.last"' 'the uppercase G binding is gone'

# An upgrade removes only the exact retired plugin-owned panel.
mkdir -p "$app_home/mods/aven-worktree"
git -C "$PLUGIN_ROOT" show de10127906360da6d1a2357bd874b4d923df2319:app/aven-worktree/main.js > "$app_home/mods/aven-worktree/main.js"
git -C "$PLUGIN_ROOT" show de10127906360da6d1a2357bd874b4d923df2319:app/aven-worktree/mod.json > "$app_home/mods/aven-worktree/mod.json"
cp "$app_home/mods/aven-worktree/main.js" "$work/retired-main.js"
cp "$app_home/mods/aven-worktree/mod.json" "$work/retired-mod.json"
before=$(cat "$app_home/keys.json")
retired_out=$(PATH="$fake:$PATH" HERDR_APP_HOME=$app_home sh "$PLUGIN_ROOT/scripts/install-app-mod.sh")
assert_contains "$retired_out" "removed: mods/aven-worktree" "retired worktree panel is removed on upgrade"
[ ! -e "$app_home/mods/aven-worktree" ] || fail 'retired worktree panel directory must be gone'
assert_eq "$(cat "$app_home/keys.json")" "$before" 'reinstall leaves keys unchanged'

mkdir -p "$app_home/mods/aven-worktree"
cp "$work/retired-main.js" "$app_home/mods/aven-worktree/main.js"
cp "$work/retired-mod.json" "$app_home/mods/aven-worktree/mod.json"
printf '\n// user modification\n' >> "$app_home/mods/aven-worktree/main.js"
PATH="$fake:$PATH" HERDR_APP_HOME=$app_home sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" > "$work/edited.out" 2> "$work/edited.log"
assert_file_contains "$work/edited.log" 'leaving unrecognised mods/aven-worktree' 'edited panel is reported'
assert_file_contains "$app_home/mods/aven-worktree/main.js" 'user modification' 'edited panel is preserved'
cp "$work/retired-main.js" "$app_home/mods/aven-worktree/main.js"
printf 'personal data\n' > "$app_home/mods/aven-worktree/extra.txt"
PATH="$fake:$PATH" HERDR_APP_HOME=$app_home sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" > "$work/extra.out" 2> "$work/extra.log"
assert_file_contains "$work/extra.log" 'leaving unrecognised mods/aven-worktree' 'extra files are reported'
assert_file_contains "$app_home/mods/aven-worktree/extra.txt" 'personal data' 'extra files are preserved'

fresh=$work/fresh
mkdir -p "$fresh"
PATH="$fake:$PATH" HERDR_APP_HOME=$fresh sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" --no-keys >/dev/null
[ ! -e "$fresh/keys.json" ] || fail '--no-keys must not write keys.json'
[ -f "$fresh/mods/aven-panel/main.js" ] || fail '--no-keys must still install browser'
[ -f "$fresh/mods/aven-kanban/main.js" ] || fail '--no-keys must still install Kanban'
[ -f "$fresh/mods/aven-kanban/logic.js" ] || fail '--no-keys must still install Kanban logic'
[ -f "$fresh/mods/aven-panel-tabs/main.js" ] || fail '--no-keys must still install selector'
[ -f "$fresh/layouts/aven-right.json" ] || fail '--no-keys must still install layout'

free=$work/free
mkdir -p "$free"
PATH="$fake:$PATH" HERDR_APP_HOME=$free sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" >/dev/null
assert_file_contains "$free/keys.json" '"ctrl-shift-h": "mod.open:aven-kanban"' 'free board chord is installed'

foreign=$work/foreign
mkdir -p "$foreign/mods/aven-panel" "$foreign/layouts"
printf 'not ours\n' > "$foreign/mods/aven-panel/main.js"
if PATH="$fake:$PATH" HERDR_APP_HOME=$foreign sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" >/tmp/install-foreign.log 2>&1; then
  fail 'foreign mod collision must fail'
fi
assert_file_contains /tmp/install-foreign.log 'refusing to overwrite foreign asset' 'foreign mod collision is reported'
assert_file_contains "$foreign/mods/aven-panel/main.js" 'not ours' 'foreign mod stays unchanged'

foreign_kanban=$work/foreign-kanban
mkdir -p "$foreign_kanban/mods/aven-kanban"
printf 'not ours\n' > "$foreign_kanban/mods/aven-kanban/main.js"
if PATH="$fake:$PATH" HERDR_APP_HOME=$foreign_kanban sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" >/tmp/install-kanban-foreign.log 2>&1; then
  fail 'foreign Kanban collision must fail'
fi
assert_file_contains /tmp/install-kanban-foreign.log 'refusing to overwrite foreign asset' 'foreign Kanban collision is reported'
assert_file_contains "$foreign_kanban/mods/aven-kanban/main.js" 'not ours' 'foreign Kanban stays unchanged'

foreign_worktree=$work/foreign-worktree
mkdir -p "$foreign_worktree/mods/aven-worktree"
printf 'not ours\n' > "$foreign_worktree/mods/aven-worktree/main.js"
printf '{ "title": "Aven" }\n' > "$foreign_worktree/mods/aven-worktree/mod.json"
PATH="$fake:$PATH" HERDR_APP_HOME=$foreign_worktree sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" >/tmp/install-worktree-foreign.out 2>/tmp/install-worktree-foreign.log
assert_file_contains /tmp/install-worktree-foreign.log 'leaving unrecognised mods/aven-worktree' 'foreign worktree directory is reported'
assert_file_contains "$foreign_worktree/mods/aven-worktree/main.js" 'not ours' 'foreign worktree directory stays unchanged'

foreign_layout=$work/foreign-layout
mkdir -p "$foreign_layout/layouts"
printf '{}\n' > "$foreign_layout/layouts/aven-right.json"
if PATH="$fake:$PATH" HERDR_APP_HOME=$foreign_layout sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" >/tmp/install-layout-foreign.log 2>&1; then
  fail 'foreign layout collision must fail'
fi
assert_file_contains /tmp/install-layout-foreign.log 'refusing to overwrite foreign asset' 'foreign layout collision is reported'

# The top-level route must retain the default desktop installation even when
# Cargo and the unrelated command installer are represented by test doubles.
top=$work/top
mkdir -p "$top/bin" "$top/home"
cat > "$top/bin/cargo" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$top/bin/aven" <<'EOF'
#!/bin/sh
case "${1:-}" in
  --version) printf 'aven fake\n' ;;
  project) printf '[]\n' ;;
esac
EOF
cat > "$top/bin/hc" <<'EOF'
#!/bin/sh
case "${1:-}" in --version) printf 'hc fake\n' ;; server) exit 1 ;; esac
EOF
cp "$fake/herdr-app" "$top/bin/herdr-app"
chmod +x "$top/bin"/*
top_out=$(PATH="$top/bin:$PATH" HOME="$top/home" XDG_CONFIG_HOME="$top/home/config" HERDR_APP_HOME="$top/home/herdr" just install)
assert_contains "$top_out" 'installed: layouts/aven-right.json' 'top-level install includes right layout'
[ -f "$top/home/herdr/mods/aven-panel/main.js" ] || fail 'top-level install browser missing'
[ -f "$top/home/herdr/mods/aven-kanban/main.js" ] || fail 'top-level install Kanban missing'
[ -f "$top/home/herdr/mods/aven-panel-tabs/main.js" ] || fail 'top-level install selector missing'
[ -f "$top/home/herdr/layouts/aven-right.json" ] || fail 'top-level install layout missing'

printf 'install app mod ok\n'
