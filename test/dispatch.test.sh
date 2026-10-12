#!/bin/sh
# bin/dispatch.sh: the aven custom command that hands a task to an agent.
#
# The sandbox refuses chmod, so herdr and aven are run through /bin/sh: the
# first argv token names a small script that lives in the test's working
# directory (worktree, agent, edit, note), and sh runs it.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
repo=$work/repo
mkdir -p "$repo"
git -C "$repo" init -q

FAKE_LOG=$work/calls.log
: > "$FAKE_LOG"
export FAKE_LOG

# herdr stand-in: /bin/sh runs "worktree" or "agent" from the working directory.
cat > "$work/worktree" <<'SCRIPT'
printf 'worktree %s\n' "$*" >> "$FAKE_LOG"
printf '%s\n' '{"id":"cli:worktree:create","result":{"workspace":{"workspace_id":"w9"},"root_pane":{"pane_id":"w9:p1"},"worktree":{"path":"/tmp/wt/app"}}}'
SCRIPT
cat > "$work/agent" <<'SCRIPT'
printf 'agent %s\n' "$*" >> "$FAKE_LOG"
printf '%s\n' '{"id":"cli:agent","result":{"type":"ok"}}'
SCRIPT

# aven stand-in: /bin/sh runs "edit" or "note".
cat > "$work/edit" <<'SCRIPT'
printf 'edit %s\n' "$*" >> "$FAKE_LOG"
SCRIPT
cat > "$work/note" <<'SCRIPT'
printf 'note %s\n' "$*" >> "$FAKE_LOG"
cat >> "$FAKE_LOG"
SCRIPT

context=$(printf '{
  "version": 1,
  "command": {"name": "dispatch", "invoked_as": "custom-dispatch"},
  "invocation": {"cwd": "%s", "origin_cwd": "%s", "aven_exe": "/bin/sh", "db_path": null},
  "workspace": {"key": "default", "name": "default"},
  "targeting": {"policy": "focused", "resolved_from": "focused", "targets": [{"id": "7KQ9ABCDE1234567", "ref": "APP-7KQ9"}]},
  "selection": {"primary": {
    "ref": "APP-7KQ9",
    "task": {"id": "7KQ9ABCDE1234567", "title": "refactor \\"mitarbeiter\\" view.", "description": "Split the view.", "status": "todo"},
    "project": {"key": "app", "prefix": "APP"}
  }, "marked": []}
}' "$repo" "$repo")
printf '%s\n' "$context" > "$work/context.json"

run_dispatch() {
  sh "$PLUGIN_ROOT/bin/dispatch.sh" < "$work/context.json"
}

# Everything below runs from the directory holding the fake programs.
cd "$work"
HERDR_BIN_PATH=/bin/sh
export HERDR_BIN_PATH

expected_branch='app/7kq9-refactor-mitarbeiter-view'

# Dry run prints the plan and touches nothing.
out=$(AVEN_DISPATCH_DRY_RUN=1 run_dispatch)
assert_contains "$out" "dry run: APP-7KQ9" "dry run ref"
assert_contains "$out" "branch     $expected_branch" "dry run branch"
assert_contains "$out" "agent      opencode (opencode)" "dry run agent"
assert_eq "$(wc -l < "$FAKE_LOG")" "0" "dry run must not call herdr or aven"

# A real dispatch creates the worktree, starts the agent, prompts it, and
# records the handoff in aven.
out=$(run_dispatch)
assert_contains "$out" "Dispatched APP-7KQ9 to opencode" "dispatch summary"

assert_file_contains "$FAKE_LOG" "worktree create --cwd $repo --branch $expected_branch --label APP-7KQ9 refactor \"mitarbeiter\" view. --focus" "worktree argv"
assert_file_contains "$FAKE_LOG" "agent start app-7kq9 --kind opencode --pane w9:p1" "agent start argv"
assert_file_contains "$FAKE_LOG" "agent prompt w9:p1 Implement APP-7KQ9: refactor \"mitarbeiter\" view." "agent prompt carries the title with quotes"
assert_file_contains "$FAKE_LOG" "Split the view." "prompt carries the description"
assert_file_contains "$FAKE_LOG" "aven note APP-7KQ9 --stdin" "prompt tells the agent how to leave a note"
assert_file_contains "$FAKE_LOG" "edit APP-7KQ9 --status active" "task marked active"
assert_file_contains "$FAKE_LOG" "note APP-7KQ9 --stdin" "handoff note written"
assert_file_contains "$FAKE_LOG" "Dispatched to opencode in worktree /tmp/wt/app" "note body"

# The base ref and the agent are configurable.
: > "$FAKE_LOG"
AVEN_DISPATCH_BASE=main AVEN_DISPATCH_AGENT=claude run_dispatch >/dev/null
assert_file_contains "$FAKE_LOG" "--base main" "custom base"
assert_file_contains "$FAKE_LOG" "agent start app-7kq9 --kind claude --pane w9:p1" "custom agent"

# AVEN_DISPATCH_NO_FOCUS drops --focus.
: > "$FAKE_LOG"
AVEN_DISPATCH_NO_FOCUS=1 run_dispatch >/dev/null
assert_file_lacks "$FAKE_LOG" "--focus" "no-focus"

# No task selected is an error before anything is dispatched.
: > "$FAKE_LOG"
printf '{"version":1,"selection":{"primary":null},"invocation":{"origin_cwd":"%s"}}' "$repo" > "$work/empty.json"
set +e
out=$(sh "$PLUGIN_ROOT/bin/dispatch.sh" < "$work/empty.json" 2>&1)
rc=$?
set -e
assert_eq "$rc" "1" "no-selection exit code"
assert_contains "$out" "no task selected" "no-selection message"
assert_eq "$(wc -l < "$FAKE_LOG")" "0" "no-selection must not dispatch"

# A directory that is not a Git repository is rejected.
plain=$work/plain
mkdir -p "$plain"
printf '{"version":1,"selection":{"primary":{"ref":"APP-1","task":{"title":"x"},"project":{"key":"app"}}},"invocation":{"origin_cwd":"%s"}}' "$plain" > "$work/plain.json"
set +e
out=$(sh "$PLUGIN_ROOT/bin/dispatch.sh" < "$work/plain.json" 2>&1)
rc=$?
set -e
assert_eq "$rc" "1" "non-repo exit code"
assert_contains "$out" "not inside a Git repository" "non-repo message"

# Reading task text needs jq or python3; forcing awk fails clearly.
set +e
out=$(AVEN_JSON_BACKEND=awk run_dispatch 2>&1)
rc=$?
set -e
assert_eq "$rc" "1" "awk exit code"
assert_contains "$out" "needs jq or python3" "awk message"

printf 'dispatch ok\n'
