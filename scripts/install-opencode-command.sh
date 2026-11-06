#!/bin/sh
# Install finish commands and their bundled implementation profiles. Explicit
# --upgrade backs up differing regular files; default installation never
# replaces a user's definition.
set -eu

upgrade=false
case ${1:-} in
  '') ;;
  --upgrade) upgrade=true; shift ;;
  *) printf 'usage: %s [--upgrade]\n' "$0" >&2; exit 1 ;;
esac
[ "$#" -eq 0 ] || { printf 'unexpected installer arguments\n' >&2; exit 1; }

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  config_dir=$XDG_CONFIG_HOME
elif [ -n "${HOME:-}" ]; then
  config_dir=$HOME/.config
else
  printf 'error: neither XDG_CONFIG_HOME nor HOME is set\n' >&2
  exit 1
fi

assets='commands/approve commands/ha-merge agents/aven-orchestrator agents/aven-babysitter'
resolve_asset() {
  directory=$config_dir/opencode/${asset%/*}
  destination=$config_dir/opencode/$asset.md
  case $asset in
    agents/aven-orchestrator) source=$root/agents/orchestrator.md ;;
    agents/aven-babysitter) source=$root/agents/babysitter.md ;;
    *) source=$root/$asset.md ;;
  esac
}
for asset in $assets; do
  resolve_asset
  if [ -L "$destination" ]; then
    printf 'error: refusing to replace symlink: %s\n' "$destination" >&2
    exit 1
  fi
  if [ -e "$destination" ] && ! cmp -s "$source" "$destination"; then
    if [ ! -f "$destination" ] || [ "$upgrade" != true ]; then
      printf 'error: refusing to overwrite differing OpenCode definition: %s (explicit --upgrade backs up regular files)\n' "$destination" >&2
      exit 1
    fi
  fi
done

for asset in $assets; do
  resolve_asset
  mkdir -p "$directory"
  if [ -f "$destination" ] && cmp -s "$source" "$destination"; then
    printf 'already installed: %s\n' "$destination"
    continue
  fi
  if [ -e "$destination" ]; then
    backup=$destination.bak.$$
    (set -C; cat "$destination" > "$backup")
    printf 'backed up: %s\n' "$backup"
    # An explicitly authorized upgrade preserves the old definition; refuse
    # symlinks again immediately before replacement.
    [ ! -L "$destination" ] || { printf 'error: refusing to replace symlink: %s\n' "$destination" >&2; exit 1; }
    cat "$source" > "$destination"
    printf 'updated: %s\n' "$destination"
  elif (set -C; cat "$source" > "$destination"); then
    printf 'installed: %s\n' "$destination"
  else
    printf 'error: could not install OpenCode command: %s\n' "$destination" >&2
    exit 1
  fi
done
