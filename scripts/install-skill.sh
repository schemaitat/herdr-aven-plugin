#!/bin/sh
# Install the bundled OpenCode skill without replacing a user's own version.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  config_dir=$XDG_CONFIG_HOME
elif [ -n "${HOME:-}" ]; then
  config_dir=$HOME/.config
else
  printf 'error: neither XDG_CONFIG_HOME nor HOME is set\n' >&2
  exit 1
fi

name=herdr-aven-tasks
directory=$config_dir/opencode/skills/$name
destination=$directory/SKILL.md
source=$root/opencode-skills/$name/SKILL.md

if [ ! -f "$source" ]; then
  printf 'error: bundled skill is missing: %s\n' "$source" >&2
  exit 1
fi
mkdir -p "$directory"
if [ -L "$destination" ]; then
  printf 'error: refusing to replace symlink: %s\n' "$destination" >&2
  exit 1
fi
if [ -e "$destination" ]; then
  if [ -f "$destination" ] && cmp -s "$source" "$destination"; then
    printf 'already installed: %s\n' "$destination"
    exit 0
  fi
  printf 'error: refusing to overwrite differing skill: %s\n' "$destination" >&2
  exit 1
fi

# noclobber also refuses a file created between the check and the write.
if (set -C; cat "$source" > "$destination"); then
  printf 'installed: %s\n' "$destination"
else
  printf 'error: could not install skill: %s\n' "$destination" >&2
  exit 1
fi
