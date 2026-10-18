#!/bin/sh
# Adds the built-in "dispatch" custom TUI command and any extra commands
# declared in aven-commands.yaml to aven's config.yaml, and validates the
# result. Usage: scripts/install-aven-command.sh
#
# The config file is resolved the way aven resolves it: AVEN_CONFIG_DIR, then
# $XDG_CONFIG_HOME/aven, then ~/.config/aven. The commands are written as one
# managed block delimited by markers: a file this script created, or an existing
# file without a top-level `tui:` key, gets the block appended; a block that is
# already there is rewritten in place when it changed, so editing
# aven-commands.yaml and re-running applies the change. An existing `tui:`
# section that is not ours is never rewritten; the block is printed for you to
# merge instead. The file is backed up and restored if aven can no longer parse
# it.
#
# The block is built from the built-in dispatch command plus the extra commands
# in $AVEN_COMMANDS_FILE (default: aven-commands.yaml in the plugin directory).
# ${PLUGIN_ROOT} in either one is replaced with the plugin directory.
#
# Report lines on stdout:
#   config: PATH
#   installed: NAME (keys: KEYS)
#   installed: NAME (EXTRA)
#   updated: PATH
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
commands_file=${AVEN_COMMANDS_FILE:-$PLUGIN_ROOT/aven-commands.yaml}
start_marker='# Managed by herdr-aven-plugin (install-aven-command). Remove this block to uninstall.'
end_marker='# End of the herdr-aven-plugin managed block.'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
block=$tmp/block

# Install the Rust dispatcher into Cargo's global bin directory before writing
# commands that invoke it by name. Aven executes custom commands directly, so
# the installed binary must be available on PATH in the environment that starts
# Aven/Herdr.
if ! command -v cargo >/dev/null 2>&1; then
  printf 'warning: cargo is required to install aven-dispatch; no Aven commands were changed\n'
  exit 1
fi
if ! cargo install --path "$PLUGIN_ROOT" --force >&2; then
  printf 'warning: cargo could not install aven-dispatch; no Aven commands were changed\n'
  exit 1
fi
if ! command -v aven-dispatch >/dev/null 2>&1; then
  printf "warning: aven-dispatch was installed but is not on PATH; add Cargo's bin directory to PATH, then retry\n"
  exit 1
fi
dispatcher=$(command -v aven-dispatch)

# --- build the managed block ------------------------------------------------

# The built-in dispatch command. ${PLUGIN_ROOT} is replaced below.
dispatch_item() {
  cat <<'EOF'
    - name: dispatch
      aliases: [custom-dispatch]
      description: Implement the selected task with a coding agent in a Herdr worktree
      program: aven-dispatch
      args:
        - dispatch
        - --agent
        - select
        - --model
        - github-copilot/gpt-5.6-terra
      keys: [z d]
      detail_keys: [z D]
      target: focused
      execution: wait
      on_success: quit
EOF
}

# The active commands from $commands_file, indented under tui.commands. Comment
# and blank lines are documentation and are dropped; four spaces are prepended
# to each remaining line, so an entry is written at the file's left margin with
# its fields indented relative to it.
extra_items() {
  [ -f "$commands_file" ] || return 0
  sed -e 's/[[:space:]]*$//' "$commands_file" |
    grep -v '^[[:space:]]*#' |
    grep -v '^[[:space:]]*$' |
    sed -e 's/^/    /'
}

# The active command names from $commands_file, one per line, for the report.
extra_names() {
  [ -f "$commands_file" ] || return 0
  sed -e 's/[[:space:]]*$//' "$commands_file" |
    grep -v '^[[:space:]]*#' |
    sed -n 's/^[[:space:]]*-[[:space:]]*name:[[:space:]]*//p' |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# Replace every literal ${PLUGIN_ROOT} with the plugin directory. The path is
# treated as text, so & or \ in it are not interpreted.
substitute_root() {
  replace_all '${PLUGIN_ROOT}' "$PLUGIN_ROOT"
}

# Aven may be started by the long-running Herdr server, whose PATH need not
# contain Cargo's bin directory even when this installer does. Persist the
# resolved executable path so custom commands such as z b are launchable from
# the popup as well as an interactive shell.
substitute_dispatcher() {
  replace_all 'program: aven-dispatch' "program: $dispatcher"
}

build_block() {
  printf '%s\n' "$start_marker"
  printf 'tui:\n'
  printf '  commands:\n'
  dispatch_item
  extra_items
  printf '%s\n' "$end_marker"
}

build_block | substitute_root | substitute_dispatcher > "$block"

# report_installed: the stdout lines naming the commands that were written.
report_installed() {
  printf 'installed: dispatch (keys: z d)\n'
  extras=$(extra_names)
  for name in $extras; do
    printf 'installed: %s (extra)\n' "$name"
  done
  printf 'Open the aven popover, select a task, and press "z d", or run ":dispatch".\n'
  if [ -n "$extras" ]; then
    printf 'Extra commands: %s\n' "$(printf '%s' "$extras" | tr '\n' ' ')"
  fi
}

# validate_config: true when aven can still parse the config. A missing aven is
# not an error here; the caller warns that it could not be checked.
validate_config() {
  aven=$(find_aven || true)
  if [ -n "$aven" ] && ! "$aven" config get sync.enabled >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

warn_missing_aven() {
  aven=$(find_aven || true)
  [ -n "$aven" ] ||
    printf 'warning: aven was not found; the config is written, run "aven doctor" to check it\n'
}

printf 'config: %s\n' "$config"

# --- a managed block is already present -------------------------------------

start_line=
end_line=
if [ -f "$config" ]; then
  start_line=$(grep -nF -m1 "$start_marker" "$config" 2>/dev/null | sed 's/:.*//')
  end_line=$(grep -nF -m1 "$end_marker" "$config" 2>/dev/null | sed 's/:.*//')
fi

if [ -n "$start_line" ]; then
  existing=$tmp/existing
  if [ -n "$end_line" ]; then
    sed -n "${start_line},${end_line}p" "$config" > "$existing"
  else
    # Written by an older version: the block runs to the end of the file.
    tail -n "+$start_line" "$config" > "$existing"
  fi

  if cmp -s "$existing" "$block"; then
    printf 'already installed: %s\n' "$config"
    report_installed
    exit 0
  fi

  updated=$tmp/updated
  head -n "$((start_line - 1))" "$config" > "$updated"
  cat "$block" >> "$updated"
  if [ -n "$end_line" ]; then
    tail -n "+$((end_line + 1))" "$config" >> "$updated"
  fi

  backup=$config.aven-backup.$$
  cp "$config" "$backup"
  cp "$updated" "$config"
  if ! validate_config; then
    cp "$backup" "$config"
    rm -f "$backup"
    printf 'warning: aven could not parse the config after the change; it was restored\n'
    exit 1
  fi
  rm -f "$backup"
  printf 'updated: %s\n' "$config"
  report_installed
  warn_missing_aven
  exit 0
fi

# --- first install ----------------------------------------------------------

if [ -f "$config" ] && grep -qE '^tui[[:space:]]*:' "$config"; then
  printf 'warning: %s already has a top-level tui: section; nothing was written.\n' "$config"
  printf 'Add this under tui.commands (or set AVEN_CONFIG_DIR to a separate config):\n\n'
  cat "$block"
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
  cat "$block"
} >> "$config"

if ! validate_config; then
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

report_installed
warn_missing_aven
