# Shared helpers for the aven.tasks Herdr plugin.
#
# POSIX sh only. Sourced by bin/run.sh and by the scripts under scripts/.
# Everything here reads the environment Herdr injects into plugin commands:
#
#   HERDR_PLUGIN_CONTEXT_JSON   workspace/tab/focused-pane/worktree context
#   HERDR_PLUGIN_ENTRYPOINT_ID  pane entrypoint (tui, compose)
#   HERDR_PLUGIN_ACTION_ID      action being run (open, compose, ...)
#   HERDR_BIN_PATH              the running Herdr binary
#
# Herdr starts plugin commands with the plugin directory as their working
# directory, so "$0" (bin/run.sh or scripts/<name>.sh) is enough to find the
# plugin root when HERDR_PLUGIN_ROOT is not set.

# Id used to address this plugin. Matches herdr-plugin.toml.
PLUGIN_ID=${HERDR_PLUGIN_ID:-aven.tasks}

# The herdr binary to call back into.
herdr_bin() {
  printf '%s' "${HERDR_BIN_PATH:-herdr}"
}

# json_field <json> <key>
# Prints a top-level field of a JSON object as text, empty when absent or null.
# Prefers jq, then python3, then an awk fallback for a single-line JSON object.
# AVEN_JSON_BACKEND forces one backend (auto, jq, python3, awk) for testing.
json_field() {
  json=$1
  key=$2
  [ -n "$json" ] || return 0

  backend=${AVEN_JSON_BACKEND:-auto}
  if [ "$backend" = auto ]; then
    if command -v jq >/dev/null 2>&1; then
      backend=jq
    elif command -v python3 >/dev/null 2>&1; then
      backend=python3
    else
      backend=awk
    fi
  fi

  case "$backend" in
    jq)
      printf '%s' "$json" |
        jq -r --arg k "$key" 'if type == "object" then (.[$k] // "") else "" end | tostring' 2>/dev/null
      ;;
    python3)
      printf '%s' "$json" | python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}
value = data.get(sys.argv[1])
sys.stdout.write("" if value is None else str(value))' "$key" 2>/dev/null
      ;;
    awk)
      # Leftmost match, so a nested key of the same name cannot win. Handles
      # quoted strings, bare numbers/booleans, and null (printed as empty).
      printf '%s' "$json" |
        awk -v pat='"'"$key"'"' '
          {
            if (match($0, pat "[ \t]*:[ \t]*(\"[^\"]*\"|[^,}]+)")) {
              value = substr($0, RSTART, RLENGTH)
              sub(/^[^:]*:[ \t]*/, "", value)
              if (value ~ /^".*"$/) {
                sub(/^"/, "", value)
                sub(/"$/, "", value)
              } else if (value == "null") {
                value = ""
              }
              print value
              exit
            }
          }'
      ;;
    *)
      printf 'unknown AVEN_JSON_BACKEND: %s\n' "$backend" >&2
      return 2
      ;;
  esac
}

# Print one top-level field of HERDR_PLUGIN_CONTEXT_JSON.
context_field() {
  json_field "${HERDR_PLUGIN_CONTEXT_JSON:-}" "$1"
}

# The directory a popover should start in. Herdr resolves these paths for us:
# the focused pane's directory first, then the workspace directory, then $HOME.
# A path that no longer exists falls back the same way, so the popover still
# opens after a worktree or directory is removed.
resolve_start_dir() {
  dir=$(context_field focused_pane_cwd)
  case "$dir" in
    "") dir=$(context_field workspace_cwd) ;;
  esac
  if [ -n "$dir" ] && [ -d "$dir" ]; then
    printf '%s' "$dir"
    return 0
  fi
  dir=$(context_field workspace_cwd)
  if [ -n "$dir" ] && [ -d "$dir" ]; then
    printf '%s' "$dir"
    return 0
  fi
  printf '%s' "${HOME:-/}"
}

# Locate the aven executable. AVEN_BIN overrides the lookup.
find_aven() {
  if [ -n "${AVEN_BIN:-}" ]; then
    if [ -x "$AVEN_BIN" ] || command -v "$AVEN_BIN" >/dev/null 2>&1; then
      printf '%s' "$AVEN_BIN"
      return 0
    fi
    return 1
  fi
  if command -v aven >/dev/null 2>&1; then
    command -v aven
    return 0
  fi
  for candidate in "$HOME/.local/bin/aven" "/usr/local/bin/aven" "$HOME/.cargo/bin/aven"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# aven_project_for_dir <aven> <dir>
# Prints the project key aven infers from <dir>, empty when there is none.
aven_project_for_dir() {
  aven=$1
  dir=$2
  out=$(cd "$dir" 2>/dev/null && "$aven" prime --json 2>/dev/null) || return 0
  json_field "$out" project
}

# Print a short line asking for a keypress, so a popover that fails to launch
# stays on screen instead of vanishing. Only when stdin is a terminal.
wait_for_key() {
  if [ -t 0 ]; then
    printf '\nPress Enter to close.'
    read -r _ || true
  fi
}
