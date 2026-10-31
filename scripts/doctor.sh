#!/bin/sh
# Report the local Aven + herdr-core + optional herdr-app setup.
#
# Read-only. Exits non-zero only when Aven or herdr-core is missing, so a
# headless machine with no desktop app still reports ready.
set -eu

here=$(dirname "$0")
PLUGIN_ROOT=$(cd "$here/.." && pwd)
# shellcheck source=../lib/plugin.sh
. "$PLUGIN_ROOT/lib/plugin.sh"

row() {
  printf '  %-12s %s\n' "$1" "$2"
}

printf 'aven tasks\n'
row root "$PLUGIN_ROOT"
row cwd "$(pwd)"

if ! aven=$(find_aven); then
  row aven "NOT FOUND"
  printf '\naven is not installed: install it from https://aventasks.dev,\n'
  printf 'or set AVEN_BIN to the aven executable and run this again.\n'
  exit 1
fi
row aven "$aven ($("$aven" --version 2>/dev/null | head -n 1))"
project=$(aven_project_for_dir "$aven" "$(pwd)")
row project "${project:-(none)}"

if ! command -v hc >/dev/null 2>&1; then
  row herdr-core "NOT FOUND"
  printf '\nherdr-core is required: install hc, then run this again.\n'
  exit 1
fi
row herdr-core "$(hc --version 2>/dev/null | head -n 1)"
if status=$(hc server status --json 2>/dev/null); then
  core_name=$(printf '%s' "$status" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("core",{}).get("name",""))' 2>/dev/null || true)
  core_id=$(printf '%s' "$status" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("core",{}).get("id",""))' 2>/dev/null || true)
  version=$(printf '%s' "$status" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)
  row core "${core_name:-(unknown)}"
  row core-id "${core_id:-(unknown)}"
  row version "${version:-(unknown)}"
else
  row core "not running (dispatch starts it on demand)"
fi
if command -v aven-dispatch >/dev/null 2>&1; then
  row watcher "$(aven-dispatch watch --status 2>/dev/null | sed -n 's/.*"running": \(true\|false\).*/running=\1/p' | head -n 1 || printf 'unknown')"
else
  row watcher "aven-dispatch not on PATH"
fi

if command -v herdr-app >/dev/null 2>&1 && herdr-app status >/dev/null 2>&1; then
  row herdr-app "available (optional overlay)"
else
  row herdr-app "unavailable (headless dispatch remains supported)"
fi

app_home=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}
if [ -f "$app_home/mods/aven-tasks/main.js" ]; then
  row app-mod "installed"
else
  row app-mod "not installed (optional)"
fi

printf '\nDispatch uses herdr-core terminals and OpenCode V2 API admission.\n'
printf 'Worktree operations run through hc exec, and Aven remains the task source of truth.\n'
