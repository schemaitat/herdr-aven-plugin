#!/bin/sh
# Isolated global command installation and workflow safety contract.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mktemp -d "${TMPDIR:-/tmp}/ha-merge-test.XXXXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
export XDG_CONFIG_HOME=$work/xdg
export HOME=$work/home
installer=$PLUGIN_ROOT/scripts/install-opencode-command.sh
command_file=$XDG_CONFIG_HOME/opencode/commands/ha-merge.md

out=$(sh "$installer")
assert_contains "$out" "installed: $command_file"
cmp -s "$PLUGIN_ROOT/commands/ha-merge.md" "$command_file" || fail "installed command differs"
out=$(sh "$installer")
assert_contains "$out" "already installed: $command_file"

# Never replace a foreign or locally edited command, including symlinks.
printf 'personal command\n' > "$command_file"
if sh "$installer" > "$work/out" 2>&1; then fail "overwrote a foreign command"; fi
assert_file_contains "$work/out" 'refusing to overwrite'
assert_eq "$(cat "$command_file")" 'personal command'
rm "$command_file"
printf 'target\n' > "$work/target"
ln -s "$work/target" "$command_file"
if sh "$installer" > "$work/out" 2>&1; then fail "accepted a symlink"; fi
assert_file_contains "$work/out" 'refusing to replace symlink'
assert_eq "$(cat "$work/target")" 'target'
rm "$command_file"
ln -s "$work/missing" "$command_file"
if sh "$installer" > "$work/out" 2>&1; then fail "accepted a dangling symlink"; fi

# HOME fallback, and refusal when neither location is available.
out=$(env -u XDG_CONFIG_HOME HOME="$work/fallback" sh "$installer")
assert_contains "$out" "$work/fallback/.config/opencode/commands/ha-merge.md"
if env -u XDG_CONFIG_HOME -u HOME sh "$installer" > "$work/out" 2>&1; then
  fail "accepted missing config home"
fi
assert_file_contains "$work/out" 'neither XDG_CONFIG_HOME nor HOME'

# The contract is a prompt, not execution-level enforcement. These assertions
# prevent accidental removal of its essential gates; they do not simulate an LLM.
prompt=$PLUGIN_ROOT/commands/ha-merge.md
assert_file_contains "$prompt" 'subagent: false'
assert_file_contains "$prompt" '**merge into local main**, **create a pull request**'
assert_file_contains "$prompt" 'Cancel or no answer means no commit'
assert_file_contains "$prompt" 'Never blindly stage all files'
assert_file_contains "$prompt" 'do not bypass the root'
assert_file_contains "$prompt" 'cannot include unrelated staged'
assert_file_contains "$prompt" 'Require it to be clean'
assert_file_contains "$prompt" 'Verify the source commit is an ancestor'
assert_file_contains "$prompt" 'An open PR is not a successful merge'
assert_file_contains "$prompt" 'aven context <ref> --full'
assert_file_contains "$prompt" 'aven-dispatch reconcile <ref> --workflow <workflow>'
assert_file_contains "$prompt" 'pending Aven update or failed'
assert_file_contains "$prompt" 'never proceed to integration or teardown'
assert_file_contains "$prompt" 'never mark unverified work done'
assert_file_contains "$prompt" 'Only after a verified successful merge and successful reconciliation'
assert_file_contains "$prompt" 'Never use the currently focused'
assert_file_contains "$prompt" 'The default is No'
assert_file_contains "$prompt" 'revalidate the exact association immediately beforehand'
assert_file_contains "$prompt" 'Never delete a Git worktree or branch'
printf 'install-opencode-command ok\n'
