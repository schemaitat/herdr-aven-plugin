#!/bin/sh
# aven custom command: implement the selected task with a coding agent.
#
# aven runs this as `sh <this file>` (wired up by `install-aven-command`) and
# writes its versioned command context to standard input. The dispatcher hands
# the task to Herdr:
#
#   1. create a Git worktree-backed workspace on a task branch, or open the
#      task's existing worktree when it is already there,
#   2. start the configured agent in that worktree's root pane (or reuse the
#      agent already in it),
#   3. prompt the agent to run the workflow,
#   4. mark the task active and leave a handoff note in aven.
#
# Task text reaches herdr and aven only as argv or standard input; it is never
# evaluated as shell.
#
# Overrides (set them in the aven command's `env` or in the plugin environment):
#   AVEN_DISPATCH_AGENT     agent to start (default: opencode)
#   AVEN_DISPATCH_KIND      herdr agent kind (default: the agent name)
#   AVEN_DISPATCH_BASE      base ref for the new branch (default: herdr's choice)
#   AVEN_DISPATCH_PROMPT    opening instruction for the agent; {ref} and {title}
#                           are replaced (default: "Implement {ref}: {title}").
#                           Use it to run a different agent workflow.
#   AVEN_DISPATCH_SKILL     name of a bundled SDD skill under skills/sdd (for
#                           example "specify"); its text is inserted into the
#                           prompt with $ARGUMENTS filled from the task. Takes
#                           precedence over AVEN_DISPATCH_PROMPT.
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

# skill_body <file>
# Print a bundled SDD skill without its YAML front matter and with the
# __SPECKIT_COMMAND_<NAME>__ placeholders rewritten to their /speckit-<name>
# form. Leading blank lines are dropped.
skill_body() {
  awk '
    NR == 1 && $0 == "---" { in_fm = 1; next }
    in_fm && $0 == "---" { in_fm = 0; next }
    in_fm { next }
    {
      if (!started && $0 ~ /^[[:space:]]*$/) next
      started = 1
      line = $0
      while (match(line, /__SPECKIT_COMMAND_[A-Z0-9_]+__/)) {
        name = tolower(substr(line, RSTART + 18, RLENGTH - 20))
        gsub(/_/, "-", name)
        line = substr(line, 1, RSTART - 1) "/speckit-" name substr(line, RSTART + RLENGTH)
      }
      print line
    }' "$1"
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
context=$tmp/context.json
out=$tmp/stdout
err=$tmp/stderr

# herdr_call <label> <command...>
# Runs a Herdr command with its stdout in $out. On failure, prints the label and
# Herdr's own JSON error (herdr writes errors to stderr) and returns nonzero.
herdr_call() {
  label=$1
  shift
  : > "$err"
  if "$@" > "$out" 2> "$err"; then
    return 0
  fi
  reason=$(tr '\n' ' ' < "$err")
  printf 'aven dispatch: %s failed: %s\n' "$label" "${reason:-no detail}" >&2
  return 1
}

# --- read the aven command context ------------------------------------------

if ! json_capable; then
  fail "reading the task needs jq or python3 on PATH (set AVEN_JSON_BACKEND to pick one)"
fi

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

# Herdr starts a new worktree from the repository's parent checkout, never from
# a linked worktree ("linked_worktree_source"). A pane inside a worktree has
# its own path, so resolve the parent checkout rather than the pane's toplevel.
repo=$(git -C "$origin" worktree list --porcelain 2>/dev/null |
  sed -n 's/^worktree //p' | head -n 1)
if [ -z "$repo" ]; then
  repo=$(git -C "$origin" rev-parse --show-toplevel 2>/dev/null) || repo=
fi
[ -n "$repo" ] ||
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
skill=${AVEN_DISPATCH_SKILL:-}

if [ -n "$skill" ]; then
  case "$skill" in
    *[!a-z0-9-]*) fail "invalid AVEN_DISPATCH_SKILL: $skill" ;;
  esac
  skill_file=$PLUGIN_ROOT/skills/sdd/$skill.md
  [ -f "$skill_file" ] ||
    fail "no bundled SDD skill '$skill' (looked for $PLUGIN_ROOT/skills/sdd/$skill.md)"
  skill_args=$title
  if [ -n "$description" ]; then
    skill_args="$title

$description"
  fi
  prompt=$(skill_body "$skill_file" |
    replace_all '$ARGUMENTS' "$skill_args" |
    replace_all '{ARGS}' "$skill_args")
else
  prompt_template=${AVEN_DISPATCH_PROMPT:-}
  [ -n "$prompt_template" ] || prompt_template='Implement {ref}: {title}'
  prompt=$(printf '%s' "$prompt_template" |
    replace_all '{ref}' "$ref" |
    replace_all '{title}' "$title")
  if [ -n "$description" ]; then
    prompt="$prompt

$description"
  fi
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

# --- create or reuse the worktree -------------------------------------------

# Re-dispatching a task, or running the next SDD phase, finds the branch's
# worktree already on disk; Herdr refuses to create it twice, so open the
# existing one instead of failing. The branch is deterministic per task, so this
# is the common case for a task that has been dispatched before.
existing_wt=$(git -C "$repo" worktree list --porcelain 2>/dev/null | awk -v b="refs/heads/$branch" '
  /^worktree / { wt = substr($0, 10); next }
  /^branch / { if ($2 == b) { print wt; exit } }
')

if [ -n "$existing_wt" ]; then
  set -- "$herdr" worktree open --cwd "$repo" --path "$existing_wt" --label "$ref $title"
  open_label="herdr worktree open"
else
  set -- "$herdr" worktree create --cwd "$repo" --branch "$branch" --label "$ref $title"
  if [ -n "$base" ]; then
    set -- "$@" --base "$base"
  fi
  open_label="herdr worktree create"
fi
if [ "$no_focus" != 1 ]; then
  set -- "$@" --focus
fi

herdr_call "$open_label" "$@" || exit 1
created=$(cat "$out")

pane=$(json_query "$created" result.root_pane.pane_id)
[ -n "$pane" ] || pane=$(json_query "$created" root_pane.pane_id)
[ -n "$pane" ] || pane=$(json_query "$created" result.pane.pane_id)
worktree=$(json_query "$created" result.worktree.path)
[ -n "$worktree" ] || worktree=$existing_wt
[ -n "$pane" ] || fail "herdr did not report the pane: $created"

# --- start and prompt the agent ---------------------------------------------

# A reused worktree may already have an agent in its pane; prompt that one
# rather than starting a second. A fresh worktree always needs one.
agent_status=$(json_query "$created" result.root_pane.agent_status)
if [ -n "$agent_status" ] && [ "$agent_status" != unknown ]; then
  :
elif [ -n "$existing_wt" ]; then
  herdr_call "herdr agent start" \
    "$herdr" agent start "$agent_name" --kind "$kind" --pane "$pane" ||
    warn "continuing with the agent already in $pane"
else
  herdr_call "herdr agent start" \
    "$herdr" agent start "$agent_name" --kind "$kind" --pane "$pane" ||
    fail "the worktree ${worktree:-was created} is left in place"
fi
herdr_call "herdr agent prompt" \
  "$herdr" agent prompt "$pane" "$prompt" ||
  fail "agent $agent_name is running in ${worktree:-the new worktree}"

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
