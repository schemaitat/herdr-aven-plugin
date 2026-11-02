#!/bin/sh
# Install the repository-owned herdr-app mods for Aven.
#
# Owned files only: mods/aven-tasks, mods/aven-worktree, mods/aven-panel,
# mods/aven-panel-tabs, and layouts/aven-right.json. Keys are merged into
# the person's keys.json only when the chord is free; an existing binding is
# never replaced. Shipped mods and the app's generated guide/types are never
# edited. The mods are optional: headless dispatch does not require herdr-app.
#
# Usage: scripts/install-app-mod.sh [--no-keys]
# Report lines:
#   app: PATH
#   installed: mods/aven-tasks
#   installed: mods/aven-worktree
#   installed: mods/aven-panel
#   installed: mods/aven-panel-tabs
#   installed: layouts/aven-right.json
#   bound KEY -> ACTION
#   kept: KEY -> ACTION
#   warning: TEXT
set -eu

here=$(dirname "$0")
PLUGIN_ROOT=$(cd "$here/.." && pwd)
install_keys=yes
[ "${1:-}" = "--no-keys" ] && install_keys=no

if [ -n "${HERDR_APP_HOME:-}" ]; then
  app_home=$HERDR_APP_HOME
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  app_home=$XDG_CONFIG_HOME/herdr-app
elif [ -n "${HOME:-}" ]; then
  app_home=$HOME/.config/herdr-app
else
  printf 'warning: neither HERDR_APP_HOME, XDG_CONFIG_HOME nor HOME is set; cannot install the Herdr app mod\n'
  exit 1
fi
printf 'app: %s\n' "$app_home"

# New right-panel assets have durable sentinels. Refuse a same-name asset that
# is not ours before copying anything, so a failed preflight never partly
# installs the feature or overwrites the person's work.
assert_owned_or_missing() {
  target=$1
  marker=$2
  if [ -e "$target" ] && [ ! -f "$marker" ]; then
    printf 'warning: refusing to overwrite foreign asset: %s\n' "$target" >&2
    exit 1
  fi
}
assert_owned_or_missing "$app_home/mods/aven-panel" "$app_home/mods/aven-panel/.herdr-aven-plugin-owner"
assert_owned_or_missing "$app_home/mods/aven-panel-tabs" "$app_home/mods/aven-panel-tabs/.herdr-aven-plugin-owner"
assert_owned_or_missing "$app_home/layouts/aven-right.json" "$app_home/layouts/.aven-right.herdr-aven-plugin-owner"

mod_dir=$app_home/mods/aven-tasks
mkdir -p "$mod_dir"
cp "$PLUGIN_ROOT/app/main.js" "$mod_dir/main.js"
cp "$PLUGIN_ROOT/app/mod.json" "$mod_dir/mod.json"
printf 'installed: mods/aven-tasks\n'

mod_dir=$app_home/mods/aven-worktree
mkdir -p "$mod_dir"
cp "$PLUGIN_ROOT/app/aven-worktree/main.js" "$mod_dir/main.js"
cp "$PLUGIN_ROOT/app/aven-worktree/mod.json" "$mod_dir/mod.json"
printf 'installed: mods/aven-worktree\n'

for name in aven-panel aven-panel-tabs; do
  mkdir -p "$app_home/mods/$name"
  cp -R "$PLUGIN_ROOT/app/$name/." "$app_home/mods/$name/"
  printf 'installed: mods/%s\n' "$name"
done
mkdir -p "$app_home/layouts"
cp "$PLUGIN_ROOT/app/layouts/aven-right.json" "$app_home/layouts/aven-right.json"
cp "$PLUGIN_ROOT/app/layouts/.aven-right.herdr-aven-plugin-owner" "$app_home/layouts/.aven-right.herdr-aven-plugin-owner"
printf 'installed: layouts/aven-right.json\n'

if [ "$install_keys" = yes ] && [ -f "$PLUGIN_ROOT/app/keys.json" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    printf 'warning: python3 is required to merge keys.json safely; the mod was installed without a key binding\n'
    exit 1
  fi
  python3 - "$PLUGIN_ROOT/app/keys.json" "$app_home/keys.json" <<'PY'
import json
import os
import shutil
import sys
import tempfile

source_path, target_path = sys.argv[1:]
source = json.load(open(source_path, encoding="utf-8"))
target = {}
if os.path.exists(target_path):
    with open(target_path, encoding="utf-8") as handle:
        target = json.load(handle)
changed = False
for section, bindings in source.items():
    current = target.setdefault(section, {})
    for key, action in bindings.items():
        existing = current.get(key)
        if existing is not None:
            print(f"kept: {key} -> {existing}")
            continue
        current[key] = action
        changed = True
        print(f"bound {key} -> {action}")
if changed:
    if os.path.exists(target_path):
        shutil.copy2(target_path, f"{target_path}.aven-backup")
    directory = os.path.dirname(target_path) or "."
    fd, temporary = tempfile.mkstemp(dir=directory, prefix="keys.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(target, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, target_path)
PY
fi

if command -v herdr-app >/dev/null 2>&1; then
  for name in aven-tasks aven-worktree aven-panel aven-panel-tabs; do
    if ! herdr-app check "$app_home/mods/$name" >/dev/null 2>&1; then
      printf 'warning: herdr-app rejected %s; inspect it before relying on the mod\n' "$app_home/mods/$name" >&2
      exit 1
    fi
  done
else
  printf 'warning: herdr-app is not installed; the mods were written but cannot be checked\n'
fi
