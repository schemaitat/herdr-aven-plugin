#!/bin/sh
# Entry point for every command herdr-plugin.toml declares.
#
#   run.sh action   Run the action named by HERDR_PLUGIN_ACTION_ID.
#   run.sh pane     Run the pane entrypoint named by HERDR_PLUGIN_ENTRYPOINT_ID.
#
# Herdr runs this with the plugin directory as the working directory, so the
# helpers are found relative to $0. Everything the plugin prints goes to the
# plugin command log; exit codes are recorded there too.

here=$(dirname "$0")
PLUGIN_ROOT=$(cd "$here/.." && pwd)
export PLUGIN_ROOT

# shellcheck source=../lib/plugin.sh
. "$PLUGIN_ROOT/lib/plugin.sh"

# open_pane <entrypoint>
# Ask Herdr to open one of this plugin's panes over the focused pane. Herdr runs
# the pane command from the plugin directory (bin/run.sh's relative path depends
# on that); the pane script then moves to the focused pane's directory, so aven
# infers the workspace and project from there.
open_pane() {
  entrypoint=$1
  set -- "$(herdr_bin)" plugin pane open --plugin "$PLUGIN_ID" --entrypoint "$entrypoint"
  exec "$@"
}

action_main() {
  action=${HERDR_PLUGIN_ACTION_ID:-}
  case "$action" in
    open)
      open_pane tui
      ;;
    compose)
      open_pane compose
      ;;
    install-keybindings)
      exec sh "$PLUGIN_ROOT/scripts/install-keybindings.sh"
      ;;
    install-aven-command)
      exec sh "$PLUGIN_ROOT/scripts/install-aven-command.sh"
      ;;
    doctor)
      exec sh "$PLUGIN_ROOT/scripts/doctor.sh"
      ;;
    "")
      printf 'HERDR_PLUGIN_ACTION_ID is not set. Run this through Herdr.\n' >&2
      exit 2
      ;;
    *)
      printf 'unknown action: %s\n' "$action" >&2
      exit 2
      ;;
  esac
}

pane_main() {
  entrypoint=${HERDR_PLUGIN_ENTRYPOINT_ID:-tui}

  if [ "$entrypoint" = agent-picker ] || [ "$entrypoint" = model-picker ]; then
    response=${AVEN_DISPATCH_PICKER_RESPONSE:-}
    choices=${AVEN_DISPATCH_PICKER_CHOICES:-}
    ids=${AVEN_DISPATCH_PICKER_IDS:-}
    if [ -z "$response" ] || [ -z "$choices" ] || [ -z "$ids" ]; then
      printf 'dispatch picker was opened without choices.\n' >&2
      exit 2
    fi
    case "$entrypoint" in
      agent-picker) heading='Select an OpenCode build agent:' ;;
      model-picker) heading='Select an OpenCode model:' ;;
    esac
    printf '%s\n\n%s\n\nChoice [1-]: ' "$heading" "$choices"
    IFS= read -r choice || choice=q
    case "$choice" in
      q|Q|"") selected=cancelled ;;
      *[!0-9]*) selected=cancelled ;;
      *) selected=$(printf '%s\n' "$ids" | sed -n "${choice}p")
         [ -n "$selected" ] || selected=cancelled ;;
    esac
    temporary="${response}.new"
    (umask 077 && printf '%s\n' "$selected" > "$temporary" && mv "$temporary" "$response")
    exit 0
  fi

  # Start where the focused pane was, so `aven tui -p` infers the project from
  # the current directory and falls back to workspace scope when there is none.
  start_dir=$(resolve_start_dir)
  cd "$start_dir" 2>/dev/null || cd "${HOME:-/}"

  if ! aven=$(find_aven); then
    printf 'aven is not installed.\n\n'
    printf 'Install it from https://aventasks.dev, or set AVEN_BIN to the\n'
    printf 'aven executable and reopen this popover.\n'
    wait_for_key
    exit 127
  fi

  case "$entrypoint" in
    tui)
      exec "$aven" tui -p
      ;;
    compose)
      exec "$aven" tui -p --add-task-only
      ;;
    *)
      printf 'unknown pane entrypoint: %s\n' "$entrypoint" >&2
      exit 2
      ;;
  esac
}

case "${1:-}" in
  action) action_main ;;
  pane) pane_main ;;
  *)
    printf 'usage: run.sh <action|pane>\n' >&2
    exit 2
    ;;
esac
