#!/bin/sh
# aven custom command: implement the selected task with a coding agent.
#
# aven runs this as `sh <this file>` (wired up by `install-aven-command`) and
# writes its versioned command context to standard input. The dispatcher hands
# the task to Herdr:
#
#   1. create a Git worktree-backed workspace on a task branch,
#   2. start the configured agent in that worktree's root pane,
#   3. prompt the agent to implement the task,
#   4. mark the task active and leave a handoff note in aven.
#
# Task text reaches herdr and aven only as argv or standard input; it is never
# evaluated as shell.
#
# Overrides (set them in the aven command's `env` or in the plugin environment):
#   AVEN_DISPATCH_AGENT     agent to start (default: opencode)
#   AVEN_DISPATCH_KIND      herdr agent kind (default: the agent name)
#   AVEN_DISPATCH_BASE      base ref for the new branch (default: herdr's choice)
#   AVEN_DISPATCH_NO_FOCUS  set to 1 to leave focus where it is
#   AVEN_DISPATCH_DRY_RUN   set to 1 to print the plan and change nothing
set -eu

here=$(dirname "$0")
PLUGIN_ROOT=$(cd "$here/.." && pwd)
# shellcheck source=../lib/plugin.sh
. "$PLUGIN_ROOT/lib/plugin.sh"

fail() {
  printf 'aven dispatch: %s\n' "$1" >&2
  exit 1
}

warn() {
  printf 'aven dispatch: %s\n' "$1" >&2
}

# --- read the aven command context ------------------------------------------

if ! json_capable; then
  fail "reading the task needs jq or python3 on PATH (set AVEN_JSON_BACKEND to pick one)"
fi

context=$(mktemp)
trap 'rm -f "$context"' EXIT
cat > "$context"
body=$(cat "$context")

q() {
  json_query "$body" "$1"
}

ref=$(q selection.primary.ref)
title=$(q selection.primary.task.title)
[ -n "$ref" ] || fail "no task selected (run dispatch from the task list or detail)"
[ -n "$title" ] || title="$ref"
description=$(q selection.primary.task.description)
project_key=$(q selection.primary.project.key)
origin=$(q invocation.origin_cwd)
aven_exe=$(q invocation.aven_exe)
db_path=$(q invocation.db_path)

herdr=$(herdr_bin)
command -v "$herdr" >/dev/null 2>&1 ||
  fail "herdr not found at '$herdr'; dispatch needs to run inside Herdr"
[ -n "$origin" ] || origin=$(pwd)
[ -d "$origin" ] || fail "aven reported a directory that no longer exists: $origin"

# --- plan -------------------------------------------------------------------

repo=$(git -C "$origin" rev-parse --show-toplevel 2>/dev/null) ||
  fail "$origin is not inside a Git repository; a worktree needs one"

slug=$(printf '%s' "$title" |
  tr '[:upper:]' '[:lower:]' |
  tr -c 'a-z0-9' '-' |
  sed -e 's/-\{1,\}/-/g' -e 's/^-*//' -e 's/-*$//' |
  cut -c1-40)
slug=$(printf '%s' "$slug" | sed -e 's/-*$//')
[ -n "$slug" ] || slug=task

refkey=$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-')
refsuffix=$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]' | sed 's/.*-//')
prefix=$(printf '%s' "${project_key:-task}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-')

branch="${prefix}/${refsuffix}-${slug}"
agent_name=$(printf '%s' "$refkey" | cut -c1-32)
[ -n "$agent_name" ] || agent_name=aven-task

agent=${AVEN_DISPATCH_AGENT:-opencode}
kind=${AVEN_DISPATCH_KIND:-$agent}
base=${AVEN_DISPATCH_BASE:-}
no_focus=${AVEN_DISPATCH_NO_FOCUS:-0}

prompt="Implement $ref: $title"
if [ -n "$description" ]; then
  prompt="$prompt

$description"
fi
prompt="$prompt

Aven is the source of truth for this task. Read the full context with:
  aven context $ref
Leave a handoff note as you go with:
  aven note $ref --stdin
Mark it done when the work is complete:
  aven edit $ref --status done
Keep the task ref out of commit messages and pull request descriptions."

if [ "${AVEN_DISPATCH_DRY_RUN:-0}" = 1 ]; then
  printf 'dry run: %s\n' "$ref"
  printf '  repository %s\n' "$repo"
  printf '  branch     %s\n' "$branch"
  printf '  agent      %s (%s)\n' "$agent" "$kind"
  printf '  prompt     %s\n' "$(printf '%s' "$prompt" | head -n 1)"
  exit 0
fi

# --- create the worktree ----------------------------------------------------

set -- "$herdr" worktree create --cwd "$repo" --branch "$branch" --label "$ref $title"
if [ -n "$base" ]; then
  set -- "$@" --base "$base"
fi
if [ "$no_focus" != 1 ]; then
  set -- "$@" --focus
fi

if ! created=$("$@"); then
  fail "herdr worktree create failed for branch $branch"
fi
pane=$(json_query "$created" result.root_pane.pane_id)
[ -n "$pane" ] || pane=$(json_query "$created" root_pane.pane_id)
[ -n "$pane" ] || pane=$(json_query "$created" result.pane.pane_id)
worktree=$(json_query "$created" result.worktree.path)
[ -n "$pane" ] || fail "herdr did not report the new pane: $created"

# --- start and prompt the agent ---------------------------------------------

"$herdr" agent start "$agent_name" --kind "$kind" --pane "$pane" ||
  fail "herdr agent start failed (worktree ${worktree:-created} left in place)"
"$herdr" agent prompt "$pane" "$prompt" ||
  fail "herdr agent prompt failed (agent $agent_name is running in ${worktree:-the new worktree})"

# --- record the handoff in aven ---------------------------------------------

if [ -z "$aven_exe" ]; then
  aven_exe=$(find_aven || true)
  db_path=
fi

if [ -n "$aven_exe" ]; then
  run_aven() {
    if [ -n "$db_path" ]; then
      "$aven_exe" --db "$db_path" "$@"
    else
      "$aven_exe" "$@"
    fi
  }
  run_aven edit "$ref" --status active >/dev/null 2>&1 ||
    warn "could not set $ref to active"
  if [ -n "$worktree" ]; then
    handoff="Dispatched to $agent in worktree $worktree (branch $branch, pane $pane)."
  else
    handoff="Dispatched to $agent (branch $branch, pane $pane)."
  fi
  printf '%s\n' "$handoff" | run_aven note "$ref" --stdin >/dev/null 2>&1 ||
    warn "could not add a handoff note to $ref"
else
  warn "could not find aven; set $ref to active and note the handoff by hand"
fi

printf 'Dispatched %s to %s\n' "$ref" "$agent"
if [ -n "$worktree" ]; then
  printf '  worktree %s\n' "$worktree"
fi
printf '  branch   %s\n' "$branch"
printf '  pane     %s\n' "$pane"
