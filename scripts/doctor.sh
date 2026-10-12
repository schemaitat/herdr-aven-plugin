#!/bin/sh
# Reports the state of the aven.tasks plugin: where a popover would open, and
# which workspace and project aven infers from that directory.
# Usage: scripts/doctor.sh
#
# Read-only. Prints a short report to stdout; exits non-zero only when aven
# itself cannot be found, so the action log flags a broken setup.
set -eu

here=$(dirname "$0")
PLUGIN_ROOT=$(cd "$here/.." && pwd)
# shellcheck source=../lib/plugin.sh
. "$PLUGIN_ROOT/lib/plugin.sh"

row() {
  printf '  %-12s %s\n' "$1" "$2"
}

printf 'aven tasks popover\n'
row plugin "$PLUGIN_ID"
row root "${HERDR_PLUGIN_ROOT:-$PLUGIN_ROOT}"
row config "${HERDR_PLUGIN_CONFIG_DIR:-(not set)}"
row state "${HERDR_PLUGIN_STATE_DIR:-(not set)}"
row herdr "$(herdr_bin)"

start_dir=$(resolve_start_dir)
workspace_dir=$(context_field workspace_cwd)
[ -n "$workspace_dir" ] || workspace_dir="(unknown)"
row start "$start_dir"
row workspace "$workspace_dir"

if ! aven=$(find_aven); then
  printf '  %-12s %s\n' aven "NOT FOUND"
  printf '\naven is not installed: install it from https://aventasks.dev,\n'
  printf 'or set AVEN_BIN to the aven executable and run this again.\n'
  exit 1
fi

version=$("$aven" --version 2>/dev/null | head -n 1) || version="(unknown version)"
row aven "$aven ($version)"

project=$(aven_project_for_dir "$aven" "$start_dir")
if [ -n "$project" ]; then
  row project "$project"
  printf '\nThe popover opens scoped to project %s (aven tui -p).\n' "$project"
else
  row project "(none)"
  printf '\nNo project is inferred from %s; the popover opens at workspace scope.\n' "$start_dir"
fi
