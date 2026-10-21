#!/bin/sh
# End-to-end process fixture for the Rust dispatcher. Commands are faked on
# PATH, proving task text stays argv/stdin data and that persisted IDs prevent
# a second OpenCode admission after a retry.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
fake=$work/bin
mkdir -p "$fake"
log=$work/calls
state=$work/state.json
export RUST_DISPATCH_LOG=$log
export HERDR_SOCKET_PATH=$work/herdr.sock
export XDG_CONFIG_HOME=$work/config
python3 "$PLUGIN_ROOT/test/herdr-socket-fixture.py" &
socket_fixture=$!
trap 'kill "$socket_fixture" 2>/dev/null || true' EXIT HUP INT TERM
while [ ! -S "$HERDR_SOCKET_PATH" ]; do
  kill -0 "$socket_fixture" 2>/dev/null || fail 'Herdr socket fixture failed'
  sleep 0.05
done

cat > "$fake/aven" <<'EOF'
#!/bin/sh
case " $* " in
  *" context APP-1 --json "*) printf '%s\n' '{"task":{"id":"immutable-task","title":"quoted \"task\""},"project":{"key":"app"}}' ;;
  *" context APP-2 --json "*) printf '%s\n' '{"task":{"id":"epic-task","title":"cumulative epic"},"project":{"key":"app"},"metadata":{"sdd.plan-worked-out":"true","sdd.plan-kind":"multi-phase"},"epic_children":[{"id":"phase-two","ref":"APP-P2","title":"second phase"},{"id":"phase-one","ref":"APP-P1","title":"first phase"}]}' ;;
  *" context APP-P1 --json "*) printf '%s\n' '{"task":{"id":"phase-one","title":"first phase","status":"todo"},"project":{"key":"app"},"metadata":{"sdd.plan-root":"epic-task","sdd.plan-phase":"1"},"dependencies":{"depends_on":[],"depends_on_open":0}}' ;;
  *" context APP-P2 --json "*) printf '%s\n' '{"task":{"id":"phase-two","title":"second phase","status":"todo"},"project":{"key":"app"},"metadata":{"sdd.plan-root":"epic-task","sdd.plan-phase":"2"},"dependencies":{"depends_on":[{"task_id":"phase-one"}],"depends_on_open":1}}' ;;
  *" context APP-3 --json "*) printf '%s\n' '{"task":{"id":"single-epic","title":"single-phase epic"},"project":{"key":"app"},"metadata":{"sdd.plan-worked-out":"true","sdd.plan-kind":"multi-phase"},"epic_children":[{"id":"only-phase","ref":"APP-ONLY","title":"only phase"}]}' ;;
  *" context APP-ONLY --json "*) printf '%s\n' '{"task":{"id":"only-phase","title":"only phase","status":"todo"},"project":{"key":"app"},"metadata":{"sdd.plan-root":"single-epic","sdd.plan-phase":"1"},"dependencies":{"depends_on":[],"depends_on_open":0}}' ;;
  *" add Dispatch log: "*) printf '%s\n' 'created DL-LOG ref=LOG' ;;
  *) printf 'aven %s\n' "$*" >> "$RUST_DISPATCH_LOG" ;;
esac
EOF
cat > "$fake/git" <<'EOF'
#!/bin/sh
case " $* " in
  *" rev-parse --show-toplevel "*) printf '%s\n' "${RUST_REPO_ROOT:-/parent}" ;;
  *)
printf 'worktree /parent\nHEAD deadbeef\nbranch refs/heads/main\n\n'
  ;;
esac
EOF
cat > "$fake/herdr" <<'EOF'
#!/bin/sh
printf 'herdr %s\n' "$*" >> "$RUST_DISPATCH_LOG"
if [ "$1" = plugin ] && [ "$2" = pane ] && [ "$3" = open ]; then
  for argument in "$@"; do
    case "$argument" in
      AVEN_DISPATCH_PICKER_RESPONSE=*) response=${argument#AVEN_DISPATCH_PICKER_RESPONSE=} ;;
    esac
  done
  [ -n "${response:-}" ] && printf '%s\n' configured-build > "$response"
  printf '%s\n' '{}'
  exit 0
fi
if [ "$1" = pane ] && [ "$2" = run ]; then
  printf 'herdr-pane-run argc=%s command=%s\n' "$#" "$4" >> "$RUST_DISPATCH_LOG"
fi
if [ "$1" = pane ] && [ "$2" = process-info ]; then
  printf '%s\n' '{"result":{"process_info":{"shell_pid":42,"foreground_processes":[{"pid":42}]}}}'
  exit 0
fi
mkdir -p "$RUST_WORKTREE"
case " $* " in
  *" pane split "*) printf '%s\n' '{"result":{"pane":{"pane_id":"w1:p2"}}}' ;;
   *) printf '{"result":{"workspace_id":"w2","worktree":{"path":"%s"},"root_pane":{"pane_id":"w1:p1"}}}\n' "$RUST_WORKTREE" ;;
esac
EOF
cat > "$fake/opencode" <<'EOF'
#!/bin/sh
printf 'opencode %s\n' "$*" >> "$RUST_DISPATCH_LOG"
case " $* " in
  *" POST /api/session "*) printf '%s\n' '{"data":{"id":"ses_one"}}' ;;
  *" POST /api/session/ses_one/prompt "*) printf '%s\n' "$*" | grep -q 'msg_' || exit 1; printf '%s\n' '{"data":{"id":"msg_expected"}}' ;;
   *" GET /api/experimental/session/"*) printf 'id: 42\nevent: update\ndata: {}\n\n' ;;
   *" GET /api/agent "*" x-opencode-directory:"*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-5.6-terra"},"mode":"primary","hidden":false},{"id":"aven-babysitter","name":"Aven babysitter","mode":"primary","hidden":true},{"id":"aven-orchestrator","name":"Aven orchestrator","mode":"primary","hidden":true}]}' ;;
   *" GET /api/agent "*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-5.6-terra"},"mode":"primary","hidden":false}]}' ;;
  *) printf '%s\n' '{"data":[]}' ;;
esac
EOF
chmod +x "$fake"/*

# The fake prompt endpoint must echo the persisted caller ID. Replace the
# fixed response with one derived from --data without parsing task text.
sed -i 's/{"data":{"id":"msg_expected"}}/{"data":{"id":"msg_1a"}}/' "$fake/opencode"

context='{"version":1,"invocation":{"origin_cwd":"/repo/nested/directory"},"targeting":{"targets":[{"id":"immutable-task","ref":"APP-1"}]},"selection":{"primary":{"ref":"APP-1","task":{"id":"immutable-task","title":"quoted \"task\""},"project":{"key":"app"}}}}'

# Use an explicit deterministic pre-created ID expectation is impossible in a
# black-box process test, so admission intentionally returns the caller ID via
# a tiny JSON extraction tool available in the fixture shell.
cat > "$fake/opencode" <<'EOF'
#!/bin/sh
printf 'opencode %s\n' "$*" >> "$RUST_DISPATCH_LOG"
case " $* " in
   *" POST /api/session/"*"/prompt "*) data=; while [ "$#" -gt 0 ]; do [ "$1" = --data ] && { data=$2; break; }; shift; done; id=$(printf '%s' "$data" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); printf '{"data":{"id":"%s"}}\n' "$id" ;;
    *" POST /api/session "*) case "$*" in *'"agent":"aven-babysitter"'*) printf '%s\n' '{"data":{"id":"ses_babysitter"}}' ;; *) printf '%s\n' '{"data":{"id":"ses_one"}}' ;; esac ;;
    *" GET /api/session/ses_one "*) if [ -n "${RUST_DISPATCH_SESSION_OUTCOME:-}" ]; then printf '{"data":{"outcome":"%s"}}\n' "$RUST_DISPATCH_SESSION_OUTCOME"; else printf '%s\n' '{"data":{}}'; fi ;;
   *" GET /api/experimental/session/"*) printf 'id: 42\nevent: update\ndata: {}\n\n' ;;
   *" GET /api/agent "*" x-opencode-directory:"*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-5.6-terra"},"mode":"primary","hidden":false},{"id":"aven-babysitter","name":"Aven babysitter","mode":"primary","hidden":true},{"id":"aven-orchestrator","name":"Aven orchestrator","mode":"primary","hidden":true}]}' ;;
    *" GET /api/agent "*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-5.6-terra"},"mode":"primary","hidden":false},{"id":"aven-babysitter","name":"Aven babysitter","mode":"primary","hidden":true},{"id":"aven-orchestrator","name":"Aven orchestrator","mode":"primary","hidden":true}]}' ;;
   *) printf '%s\n' '{"data":[]}' ;;
esac
EOF
chmod +x "$fake/opencode"

printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" RUST_REPO_ROOT=/repo-checkout RUST_WORKTREE="$work/worktree" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" >/dev/null
assert_file_contains "$log" 'herdr worktree create --cwd /repo-checkout --branch app/dispatch-immutable-task --label APP-1 quoted "task" --no-focus' 'nested-CWD dispatch creates the workspace from its Git checkout root without moving focus'
assert_file_contains "$log" 'herdr-api pane.focus w1:p1' 'dispatch focuses the worktree pane after attaching the session'
assert_file_contains "$log" '"agent":"build"' 'primary agent sent to OpenCode session creation'
assert_file_contains "$log" '"model":{"id":"gpt-5.6-terra","providerID":"github-copilot"}' 'model sent to OpenCode session creation'
[ ! -e "$work/worktree/.opencode/opencode.jsonc" ] || fail 'ordinary dispatch must not add an OpenCode config'
assert_file_contains "$log" 'opencode api POST /api/session/ses_one/prompt' 'durable prompt admission'
assert_file_contains "$log" 'herdr pane run w1:p1 env AVEN_DISPATCH_STORE=' 'OpenCode inherits the dispatcher store in the worktree pane'
assert_file_contains "$log" 'herdr pane send-keys w1:p1 ctrl+c' 'dispatcher clears the target pane before starting OpenCode'
assert_file_contains "$log" 'herdr pane process-info --pane w1:p1' 'dispatcher verifies the target pane shell before starting OpenCode'
assert_file_contains "$log" 'opencode --session '\''ses_one'\''' 'OpenCode starts in the worktree pane with its durable session'
assert_file_contains "$log" 'herdr-pane-run argc=4 command=env AVEN_DISPATCH_STORE=' 'OpenCode command is one pane-run argument, not Herdr options'
agent_start_line=$(grep -n 'herdr pane run w1:p1 env AVEN_DISPATCH_STORE=' "$log" | head -n 1 | cut -d: -f1)
pane_clear_line=$(grep -n 'herdr pane send-keys w1:p1 ctrl+c' "$log" | head -n 1 | cut -d: -f1)
prompt_line=$(grep -n 'opencode api POST /api/session/ses_one/prompt' "$log" | head -n 1 | cut -d: -f1)
[ "$pane_clear_line" -lt "$agent_start_line" ] || fail 'pane is cleared before the OpenCode command is sent'
[ "$agent_start_line" -lt "$prompt_line" ] || fail 'OpenCode starts before prompt admission schedules execution'
assert_file_contains "$log" 'Plan then implement an Aven task' 'explicit skills directory is loaded'
assert_file_contains "$state" '"session_id": "ses_one"' 'session persisted before retry'
assert_file_contains "$state" '"agent": "build"' 'primary agent persisted'
assert_not_contains "$(cat "$log")" 'herdr pane split' 'ordinary dispatch does not create a babysitter pane'
assert_not_contains "$(cat "$log")" 'Pre-provisioned cumulative worktrees' 'single-session prompt does not receive worktree coordinator instructions'

# Babysitting is opt-in: both sessions are created and prompted through the
# OpenCode API, then the second API session is attached in the sibling pane.
babysitter_state=$work/babysitter-state.json
printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$babysitter_state" RUST_WORKTREE="$work/worktree-babysitter" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --babysitter >/dev/null
assert_file_contains "$log" 'herdr pane split w1:p1 --direction right --cwd ' 'babysitter splits next to build pane'
assert_file_contains "$log" 'opencode api GET /api/agent' 'babysitter discovery queries the global agent context'
assert_file_contains "$log" '"agent":"aven-babysitter"' 'global babysitter session created through OpenCode API'
assert_file_contains "$log" 'opencode api POST /api/session --data {"agent":"aven-babysitter"' 'babysitter session creation uses the global agent scope'
assert_file_contains "$log" '"model":{"id":"gpt-6-luna","providerID":"github-copilot"}' 'babysitter API session uses Luna'
assert_file_contains "$log" 'opencode api POST /api/session/ses_babysitter/prompt' 'babysitter prompt admitted through OpenCode API'
assert_file_contains "$log" 'herdr pane run w1:p2 env AVEN_DISPATCH_STORE=' 'babysitter inherits the dispatcher store when its API-owned session attaches'
assert_file_contains "$log" 'opencode --session '\''ses_babysitter'\''' 'babysitter pane attaches API-owned session'
assert_file_contains "$log" 'Supervise build OpenCode session ses_one in Herdr pane w1:p1' 'babysitter receives build identity'
assert_file_contains "$babysitter_state" '"babysitter": true' 'opt-in babysitter persisted'
assert_file_contains "$babysitter_state" '"babysitter_session_id": "ses_babysitter"' 'babysitter API session persisted'
assert_file_contains "$work/config/opencode/agents/aven-babysitter.md" 'You are the babysitter' 'babysitter is installed as a global aven-namespaced agent'
[ ! -e "$work/worktree-babysitter/.opencode/opencode.jsonc" ] || fail 'babysitter dispatch must not add an OpenCode config'

# `--agent select` always opens the Herdr popup picker, including when OpenCode
# reports only one visible primary agent. The selected ID returns through a
# private response file, so the Aven command's JSON stdin remains untouched.
selector_state=$work/selector-state.json
printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$selector_state" RUST_WORKTREE="$work/worktree-selector" cargo run --quiet -- dispatch --agent select --model github-copilot/gpt-5.6-terra >/dev/null
assert_file_contains "$selector_state" '"agent": "configured-build"' 'picker returns the selected OpenCode agent id'
assert_file_contains "$log" 'herdr plugin pane open --plugin aven.tasks --entrypoint agent-picker' 'selector opens the Herdr popup picker'
assert_file_contains "$log" 'opencode api GET /api/agent' 'selector lists agents through the OpenCode API'

# The actual installed Aven commands use execution: terminal. Their context
# arrives via a protected file and stdin/stdout belong to the existing popup.
PATH="$fake:$PATH" python3 "$PLUGIN_ROOT/test/terminal-picker.py" "$work" "$context"

PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- list --running > "$work/running"
assert_file_contains "$work/running" '"task_ref": "APP-1"' 'list reports running dispatch'
assert_file_contains "$work/running" '"state": "running"' 'list filters to running dispatches'
# `list --running` must not trust a stale persisted string after OpenCode
# reports a terminal outcome.
RUST_DISPATCH_SESSION_OUTCOME=succeeded PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- list --running > "$work/terminal-running"
assert_not_contains "$(cat "$work/terminal-running")" '"task_ref": "APP-1"' 'list excludes authoritative terminal sessions from running output'
before=$(grep -c 'POST /api/session/ses_one/prompt' "$log")
printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" > "$work/retry"
after=$(grep -c 'POST /api/session/ses_one/prompt' "$log")
assert_eq "$after" "$before" 're-dispatch does not admit a second prompt'
assert_file_contains "$work/retry" 'reopened APP-1 in OpenCode session ses_one' 're-dispatch reopens the persisted session'

# Legacy attempts could be checkpointed as prompt-pending before their prompt
# body was durable. Single-session recovery rebuilds the deterministic workflow
# prompt rather than leaving the selected task permanently stranded.
legacy_state=$work/legacy-pending.json
python3 - "$state" "$legacy_state" <<'PY'
import json
import sys

source, target = sys.argv[1:]
store = json.load(open(source))
attempt = next(iter(store["attempts"].values()))
attempt["state"] = "prompt-pending"
attempt["pending_prompt"] = ""
json.dump(store, open(target, "w"))
PY
before=$(grep -c 'POST /api/session/ses_one/prompt' "$log")
printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$legacy_state" RUST_WORKTREE="$work/worktree-legacy" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" > "$work/legacy-retry"
after=$(grep -c 'POST /api/session/ses_one/prompt' "$log")
assert_eq "$after" "$((before + 1))" 'legacy pending attempt regenerates and admits its durable prompt'
assert_file_contains "$work/legacy-retry" 'reopened APP-1 in OpenCode session ses_one' 'legacy pending attempt reopens its existing session'

PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- reconcile APP-1 >/dev/null
assert_file_contains "$state" '"log_cursor": "42"' 'durable log cursor persisted'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- interrupt APP-1 >/dev/null
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- list --running > "$work/after-interrupt"
assert_not_contains "$(cat "$work/after-interrupt")" '"task_ref": "APP-1"' 'interrupted dispatch is excluded from running list'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- log APP-1 --event manual-debug --detail 'operator diagnostic' > "$work/log-event"
assert_file_contains "$work/log-event" 'logged manual-debug for APP-1 in DL-LOG' 'dispatcher log command appends an operator event'
assert_file_contains "$log" 'aven related add DL-LOG APP-1' 'dispatcher log task references the source task'
assert_file_contains "$log" 'aven note DL-LOG --stdin' 'operator event is written to the linked log task'

# Reset invalidates shared-store and Aven dispatch attempts without touching the
# durable Aven plan or worktree. The fake active-session endpoint reports no sessions,
# so this also proves reset uses the V2 activity probe before mutation.
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- reset APP-1 --yes > "$work/reset"
assert_file_contains "$work/reset" 'reset complete for APP-1' 'confirmed reset completes'
assert_file_contains "$state" '"attempts": {}' 'reset removes the local attempt'
assert_file_contains "$log" 'opencode api GET /api/session/active' 'reset checks active sessions before cleanup'
assert_not_contains "$(cat "$log")" 'aven edit APP-1 --status todo' 'reset preserves the task status'
assert_not_contains "$(cat "$log")" '--remove-metadata sdd.plan-worked-out' 'reset preserves the completed-plan marker'
assert_not_contains "$(cat "$log")" '--remove-metadata sdd.plan-kind' 'reset preserves plan topology metadata'
assert_not_contains "$(cat "$log")" '--remove-metadata sdd.plan-schema' 'reset preserves plan schema metadata'
assert_file_contains "$log" 'phase_children' 'reset records phase inventory only for audit'
assert_file_contains "$work/reset" 'Aven plan was preserved' 'completion reports plan preservation'

# Cumulative worktrees are provisioned by the dispatcher, not left to the
# coordinator model. The root gets one coordinator worktree and every ordered
# phase gets its own worker worktree; only the first phase is admitted.
cumulative_state=$work/cumulative-state.json
cumulative_context='{"version":1,"invocation":{"origin_cwd":"/repo"},"targeting":{"targets":[{"id":"epic-task","ref":"APP-2"}]},"selection":{"primary":{"ref":"APP-2","task":{"id":"epic-task","title":"cumulative epic"},"project":{"key":"app"}}}}'
printf '%s\n' "$cumulative_context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$cumulative_state" RUST_WORKTREE="$work/worktree-cumulative" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-implement --skills-dir "$PLUGIN_ROOT/skills" --mode worktrees >/dev/null
epic_worktrees=$(grep -c 'branch app/dispatch-epic-task' "$log")
assert_eq "$epic_worktrees" 3 'cumulative dispatch creates coordinator plus two phase worktrees'
assert_file_contains "$log" 'branch app/dispatch-epic-task-phase-01 --base app/dispatch-epic-task' 'first phase starts from the coordinator branch'
assert_file_contains "$log" 'branch app/dispatch-epic-task-phase-02 --base app/dispatch-epic-task' 'second phase gets its dedicated cumulative branch'
phase_one_line=$(grep -n 'label APP-P1 first phase' "$log" | tail -n 1 | cut -d: -f1)
phase_two_line=$(grep -n 'label APP-P2 second phase' "$log" | tail -n 1 | cut -d: -f1)
[ "$phase_one_line" -lt "$phase_two_line" ] || fail 'reverse-ordered Aven children are provisioned in validated phase order'
assert_file_contains "$log" '"agent":"aven-orchestrator"' 'root session uses the fixed global orchestrator agent'
assert_file_contains "$work/config/opencode/agents/aven-orchestrator.md" 'You coordinate one approved Aven implementation epic' 'orchestrator is installed as a global aven-namespaced agent'
assert_file_contains "$cumulative_state" '"task_ref": "APP-P1"' 'first phase is persisted'
assert_file_contains "$cumulative_state" '"task_ref": "APP-P2"' 'second phase is persisted'
assert_file_contains "$cumulative_state" '"state": "provisioned"' 'blocked successor remains provisioned without a prompt'
assert_file_contains "$cumulative_state" '"state": "running"' 'first phase is admitted to its worker session'
assert_file_contains "$log" 'Pre-provisioned cumulative worktrees' 'worktree coordinator receives its topology instructions'

# A one-phase plan has the same epic root/child structure. Worktree mode must
# admit that single ordered child instead of requiring an arbitrary second one.
single_epic_state=$work/single-epic-state.json
single_epic_context='{"version":1,"invocation":{"origin_cwd":"/repo"},"targeting":{"targets":[{"id":"single-epic","ref":"APP-3"}]},"selection":{"primary":{"ref":"APP-3","task":{"id":"single-epic","title":"single-phase epic"},"project":{"key":"app"}}}}'
printf '%s\n' "$single_epic_context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$single_epic_state" RUST_WORKTREE="$work/worktree-single-epic" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-implement --skills-dir "$PLUGIN_ROOT/skills" --mode worktrees >/dev/null
assert_file_contains "$single_epic_state" '"task_ref": "APP-ONLY"' 'one-child epic phase is persisted'
assert_file_contains "$single_epic_state" '"state": "running"' 'one-child epic phase is admitted'

# A reset clears execution attempts but never changes the approved epic plan,
# root status, or phase subtasks. The root remains the durable ADR
# container and the phase relationship survives the reset.
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$cumulative_state" cargo run --quiet -- reset APP-2 --yes > "$work/epic-reset"
assert_file_contains "$work/epic-reset" 'reset complete for APP-2' 'epic reset completes'
epic_reset_edit=$(grep 'aven edit APP-2' "$log" | tail -n 1)
assert_not_contains "$epic_reset_edit" '--status' 'epic reset preserves root status'
assert_not_contains "$epic_reset_edit" '--epic' 'epic reset preserves the root epic type'
assert_not_contains "$(cat "$log")" 'aven epic remove APP-P1 APP-2' 'epic reset preserves phase containment'
printf 'rust dispatch ok\n'
