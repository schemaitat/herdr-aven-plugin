#!/bin/sh
# json_field and resolve_start_dir against every backend.
set -eu
. "$(dirname "$0")/helpers.sh"

# shellcheck source=../lib/plugin.sh
. "$PLUGIN_ROOT/lib/plugin.sh"

json='{"workspace_cwd":"/tmp/app","focused_pane_cwd":"/tmp/app/sub","nested":{"focused_pane_cwd":"/wrong"},"num":3,"null":null}'

for backend in jq python3 awk; do
  command -v "$backend" >/dev/null 2>&1 || continue
  AVEN_JSON_BACKEND=$backend
  export AVEN_JSON_BACKEND
  assert_eq "$(json_field "$json" focused_pane_cwd)" "/tmp/app/sub" "$backend top-level key"
  assert_eq "$(json_field "$json" workspace_cwd)" "/tmp/app" "$backend workspace"
  assert_eq "$(json_field "$json" missing)" "" "$backend missing key"
  assert_eq "$(json_field "$json" null)" "" "$backend null value"
  assert_eq "$(json_field '' focused_pane_cwd)" "" "$backend empty json"
  assert_eq "$(json_field "$json" num)" "3" "$backend numeric value"
done
unset AVEN_JSON_BACKEND

# A path with spaces survives parsing.
spaces='{"focused_pane_cwd":"/tmp/my project/src"}'
AVEN_JSON_BACKEND=awk
export AVEN_JSON_BACKEND
assert_eq "$(json_field "$spaces" focused_pane_cwd)" "/tmp/my project/src" "space in path"
unset AVEN_JSON_BACKEND

workdir=$(mkworkdir)
mkdir -p "$workdir/project/sub"
home=$workdir/home
mkdir -p "$home"

# Focused pane directory wins when it exists.
HERDR_PLUGIN_CONTEXT_JSON=$(printf '{"focused_pane_cwd":"%s/project/sub","workspace_cwd":"%s/project"}' "$workdir" "$workdir")
export HERDR_PLUGIN_CONTEXT_JSON
assert_eq "$(resolve_start_dir)" "$workdir/project/sub" "focused pane cwd"

# A stale focused-pane path falls back to the workspace directory.
HERDR_PLUGIN_CONTEXT_JSON=$(printf '{"focused_pane_cwd":"%s/gone","workspace_cwd":"%s/project"}' "$workdir" "$workdir")
assert_eq "$(resolve_start_dir)" "$workdir/project" "stale pane cwd falls back to workspace"

# Nothing usable falls back to HOME.
HOME=$home
export HOME
HERDR_PLUGIN_CONTEXT_JSON='{}'
assert_eq "$(resolve_start_dir)" "$home" "empty context falls back to HOME"

# No context at all is handled too.
HERDR_PLUGIN_CONTEXT_JSON=''
assert_eq "$(resolve_start_dir)" "$home" "no context falls back to HOME"

printf 'context ok\n'
