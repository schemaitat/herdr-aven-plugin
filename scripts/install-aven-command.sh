#!/bin/sh
# Adds the "dispatch" custom TUI command to aven's config.yaml and validates it.
# Usage: scripts/install-aven-command.sh
#
# The config file is resolved the way aven resolves it: AVEN_CONFIG_DIR, then
# $XDG_CONFIG_HOME/aven, then ~/.config/aven. The command is written once: a
# file it created, or an existing file without a top-level `tui:` key, gets the
# managed block appended. An existing `tui:` section is never rewritten; the
# block is printed for you to merge instead. The file is backed up and restored
# if aven can no longer parse it.
#
# Report lines on stdout:
#   config: PATH
#   installed: dispatch (keys: z d)
#   already installed: PATH
#   warning: TEXT
set -eu

here=$(dirname "$0")
PLUGIN_ROOT=$(cd "$here/.." && pwd)
# shellcheck source=../lib/plugin.sh
. "$PLUGIN_ROOT/lib/plugin.sh"

if [ -n "${AVEN_CONFIG_DIR:-}" ]; then
  config_dir=$AVEN_CONFIG_DIR
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  config_dir=$XDG_CONFIG_HOME/aven
elif [ -n "${HOME:-}" ]; then
  config_dir=$HOME/.config/aven
else
  printf 'warning: neither AVEN_CONFIG_DIR, XDG_CONFIG_HOME nor HOME is set; cannot find the aven config\n'
  exit 1
fi
config=$config_dir/config.yaml
marker='# Managed by herdr-aven-plugin (install-aven-command).'

block() {
  cat <<EOF
$marker Remove this block to uninstall.
tui:
  commands:
    - name: dispatch
      aliases: [custom-dispatch]
      description: Implement the selected task with a coding agent in a Herdr worktree
      program: sh
      args:
        - $PLUGIN_ROOT/bin/dispatch.sh
      keys: [z d]
      detail_keys: [z D]
      target: focused
      execution: wait
      on_success: quit
EOF
}

printf 'config: %s\n' "$config"

if [ -f "$config" ] && grep -qF "$marker" "$config"; then
  printf 'already installed: %s\n' "$config"
  printf 'dispatch is available in aven as ":dispatch" or "z d".\n'
  exit 0
fi

if [ -f "$config" ] && grep -qE '^tui[[:space:]]*:' "$config"; then
  printf 'warning: %s already has a top-level tui: section; nothing was written.\n' "$config"
  printf 'Add this under tui.commands (or set AVEN_CONFIG_DIR to a separate config):\n\n'
  block
  exit 1
fi

[ -d "$config_dir" ] || mkdir -p "$config_dir"

created=0
[ -f "$config" ] || created=1
backup=$config.aven-backup.$$
if [ "$created" = 0 ]; then
  cp "$config" "$backup"
fi

{
  if [ "$created" = 0 ]; then
    printf '\n'
  fi
  block
} >> "$config"

aven=$(find_aven || true)
if [ -n "$aven" ] && ! "$aven" config get sync.enabled >/dev/null 2>&1; then
  if [ "$created" = 1 ]; then
    rm -f "$config"
  else
    cp "$backup" "$config"
  fi
  rm -f "$backup"
  printf 'warning: aven could not parse the config after the change; it was restored\n'
  exit 1
fi
rm -f "$backup"

printf 'installed: dispatch (keys: z d)\n'
if [ -z "$aven" ]; then
  printf 'warning: aven was not found; the config is written, run "aven doctor" to check it\n'
fi
printf 'Open the aven popover, select a task, and press "z d", or run ":dispatch".\n'
