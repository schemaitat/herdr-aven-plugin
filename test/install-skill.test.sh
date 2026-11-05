#!/bin/sh
# Isolated OpenCode skill installation and content contract.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mktemp -d "${TMPDIR:-/tmp}/ha-skill-test.XXXXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
export XDG_CONFIG_HOME=$work/xdg
export HOME=$work/home
installer=$PLUGIN_ROOT/scripts/install-skill.sh
source_file=$PLUGIN_ROOT/opencode-skills/herdr-aven-tasks/SKILL.md
skill=$XDG_CONFIG_HOME/opencode/skills/herdr-aven-tasks/SKILL.md

out=$(sh "$installer")
assert_contains "$out" "installed: $skill"
cmp -s "$source_file" "$skill" || fail "installed skill differs"
out=$(sh "$installer")
assert_contains "$out" "already installed: $skill"

# Never replace a foreign or locally edited skill, including symlinks.
printf 'personal skill\n' > "$skill"
if sh "$installer" > "$work/out" 2>&1; then fail "overwrote a foreign skill"; fi
assert_file_contains "$work/out" 'refusing to overwrite differing skill'
assert_eq "$(cat "$skill")" 'personal skill'
rm "$skill"
printf 'target\n' > "$work/target"
ln -s "$work/target" "$skill"
if sh "$installer" > "$work/out" 2>&1; then fail "accepted a symlink"; fi
assert_file_contains "$work/out" 'refusing to replace symlink'
assert_eq "$(cat "$work/target")" 'target'
rm "$skill"
ln -s "$work/missing" "$skill"
if sh "$installer" > "$work/out" 2>&1; then fail "accepted a dangling symlink"; fi
rm -f "$skill"

# HOME fallback, and refusal when neither location is available.
out=$(env -u XDG_CONFIG_HOME HOME="$work/fallback" sh "$installer")
assert_contains "$out" "$work/fallback/.config/opencode/skills/herdr-aven-tasks/SKILL.md"
if env -u XDG_CONFIG_HOME -u HOME sh "$installer" > "$work/out" 2>&1; then
  fail "accepted missing config home"
fi
assert_file_contains "$work/out" 'neither XDG_CONFIG_HOME nor HOME'

# The skill must stay runnable: keep its frontmatter name and the commands that
# make the triage correct, including the full-ref and multi-workflow gotchas.
assert_file_contains "$source_file" 'name: herdr-aven-tasks'
assert_file_contains "$source_file" 'aven list --epics'
assert_file_contains "$source_file" 'aven-dispatch list --running'
assert_file_contains "$source_file" 'aven-dispatch status HAP-XXXX'
assert_file_contains "$source_file" '--workflow'
assert_file_contains "$source_file" 'hc ls'
assert_file_contains "$source_file" 'aven-dispatch watch --status'
assert_file_contains "$source_file" 'Stale / zombie'
assert_file_contains "$source_file" 'time.updated'
printf 'install-skill ok\n'
