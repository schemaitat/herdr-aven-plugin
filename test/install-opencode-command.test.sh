#!/bin/sh
# Isolated global command installation and workflow safety contract.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mktemp -d /tmp/opencode/ha-merge-test.XXXXXXXX)
trap 'rm -rf "$work"' EXIT HUP INT TERM
export XDG_CONFIG_HOME=$work/xdg
export HOME=$work/home
installer=$PLUGIN_ROOT/scripts/install-opencode-command.sh
command_file=$XDG_CONFIG_HOME/opencode/commands/ha-merge.md

out=$(sh "$installer")
assert_contains "$out" "installed: $command_file"
cmp -s "$PLUGIN_ROOT/commands/ha-merge.md" "$command_file" || fail "installed command differs"
cmp -s "$PLUGIN_ROOT/commands/approve.md" "$XDG_CONFIG_HOME/opencode/commands/approve.md" || fail "approve command was not installed"
cmp -s "$PLUGIN_ROOT/agents/orchestrator.md" "$XDG_CONFIG_HOME/opencode/agents/aven-orchestrator.md" || fail "orchestrator profile was not installed"
out=$(sh "$installer")
assert_contains "$out" "already installed: $command_file"

# Never replace a foreign or locally edited command, including symlinks.
printf 'personal command\n' > "$command_file"
if sh "$installer" > "$work/out" 2>&1; then fail "overwrote a foreign command"; fi
assert_file_contains "$work/out" 'refusing to overwrite'
assert_eq "$(cat "$command_file")" 'personal command'
out=$(sh "$installer" --upgrade)
assert_contains "$out" "backed up: $command_file.bak."
cmp -s "$PLUGIN_ROOT/commands/ha-merge.md" "$command_file" || fail "explicit upgrade did not install new command"
assert_eq "$(cat "$command_file".bak.*)" 'personal command'
profile=$XDG_CONFIG_HOME/opencode/agents/aven-orchestrator.md
printf 'older profile\n' > "$profile"
if sh "$installer" > "$work/out" 2>&1; then fail "overwrote a differing agent without explicit upgrade"; fi
sh "$installer" --upgrade > "$work/out"
assert_eq "$(cat "$profile".bak.*)" 'older profile'
cmp -s "$PLUGIN_ROOT/agents/orchestrator.md" "$profile" || fail "explicit upgrade did not refresh the profile"
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
assert_file_contains "$prompt" 'human merge trigger'
assert_file_contains "$prompt" 'does not require a live builder/coordinator terminal'
assert_file_contains "$prompt" 'aven-dispatch merge <task-id> [<task-id> ...] --yes'
assert_file_contains "$prompt" 'exact approved'
assert_file_contains "$prompt" 'Automatically resolve and verify'
assert_file_contains "$prompt" 'Never blindly choose'
assert_file_contains "$prompt" 'at most'
assert_file_contains "$prompt" 'three repair rounds'
assert_file_contains "$prompt" '--review-commit <exact-combined-sha>'
assert_file_contains "$prompt" 'main moved during preparation'
assert_file_contains "$prompt" 'watcher'
assert_file_contains "$prompt" 'Never push main'
assert_file_contains "$prompt" 'delete a Git worktree'
assert_file_contains "$prompt" 'Finalize and optional space closure'
assert_file_contains "$prompt" 'merged; delivery recording pending'
assert_file_contains "$prompt" 'exact worktree folder'
assert_file_contains "$prompt" 'primary-checkout/main space'
assert_file_contains "$prompt" 'default **No**'
assert_file_contains "$prompt" 'herdr-app do space.close --id <space-id> --confirmed true'
assert_file_lacks "$prompt" 'Never push main, create a PR, close a Herdr space, or'
approve=$PLUGIN_ROOT/commands/approve.md
assert_file_contains "$approve" 'subagent: false'
assert_file_contains "$approve" 'Never blindly stage'
assert_file_contains "$approve" 'A nonzero result is not an approval'
assert_file_contains "$approve" 'aven-dispatch approve <task-ref>'
assert_file_contains "$approve" 'marks the root done'
assert_file_contains "$approve" 'does not authorize merging'
printf 'install-opencode-command ok\n'
