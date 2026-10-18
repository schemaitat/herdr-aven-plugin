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
  *" add Dispatch log: "*) printf '%s\n' 'created DL-LOG ref=LOG' ;;
  *) printf 'aven %s\n' "$*" >> "$RUST_DISPATCH_LOG" ;;
esac
EOF
cat > "$fake/git" <<'EOF'
#!/bin/sh
printf 'worktree /parent\nHEAD deadbeef\nbranch refs/heads/main\n\n'
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
   *" GET /api/agent "*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-5.6-terra"},"mode":"primary","hidden":false}]}' ;;
  *) printf '%s\n' '{"data":[]}' ;;
esac
EOF
chmod +x "$fake"/*

# The fake prompt endpoint must echo the persisted caller ID. Replace the
# fixed response with one derived from --data without parsing task text.
sed -i 's/{"data":{"id":"msg_expected"}}/{"data":{"id":"msg_1a"}}/' "$fake/opencode"

context='{"version":1,"invocation":{"origin_cwd":"/repo"},"targeting":{"targets":[{"id":"immutable-task","ref":"APP-1"}]},"selection":{"primary":{"ref":"APP-1","task":{"id":"immutable-task","title":"quoted \"task\""},"project":{"key":"app"}}}}'

# Use an explicit deterministic pre-created ID expectation is impossible in a
# black-box process test, so admission intentionally returns the caller ID via
# a tiny JSON extraction tool available in the fixture shell.
cat > "$fake/opencode" <<'EOF'
#!/bin/sh
printf 'opencode %s\n' "$*" >> "$RUST_DISPATCH_LOG"
case " $* " in
   *" POST /api/session/"*"/prompt "*) data=; while [ "$#" -gt 0 ]; do [ "$1" = --data ] && { data=$2; break; }; shift; done; id=$(printf '%s' "$data" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); printf '{"data":{"id":"%s"}}\n' "$id" ;;
   *" POST /api/session "*) case "$*" in *'"agent":"babysitter"'*) printf '%s\n' '{"data":{"id":"ses_babysitter"}}' ;; *) printf '%s\n' '{"data":{"id":"ses_one"}}' ;; esac ;;
   *" GET /api/experimental/session/"*) printf 'id: 42\nevent: update\ndata: {}\n\n' ;;
   *" GET /api/agent "*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-5.6-terra"},"mode":"primary","hidden":false}]}' ;;
   *) printf '%s\n' '{"data":[]}' ;;
esac
EOF
chmod +x "$fake/opencode"

printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" RUST_WORKTREE="$work/worktree" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" >/dev/null
assert_file_contains "$log" 'herdr worktree create --cwd /parent --branch app/dispatch-immutable-task --label APP-1 quoted "task" --no-focus' 'worktree is created without moving focus away from the picker'
assert_file_contains "$log" 'herdr-api pane.focus w1:p1' 'dispatch focuses the worktree pane after attaching the session'
assert_file_contains "$log" '"agent":"build"' 'primary agent sent to OpenCode session creation'
assert_file_contains "$log" '"model":{"id":"gpt-5.6-terra","providerID":"github-copilot"}' 'model sent to OpenCode session creation'
[ ! -e "$work/worktree/.opencode/opencode.jsonc" ] || fail 'ordinary dispatch must not add an OpenCode config'
assert_file_contains "$log" 'opencode api POST /api/session/ses_one/prompt' 'durable prompt admission'
assert_file_contains "$log" 'herdr pane run w1:p1 env AVEN_DISPATCH_STORE=' 'OpenCode inherits the dispatcher store in the worktree pane'
assert_file_contains "$log" 'opencode --session '\''ses_one'\''' 'OpenCode starts in the worktree pane with its durable session'
assert_file_contains "$log" 'herdr-pane-run argc=4 command=env AVEN_DISPATCH_STORE=' 'OpenCode command is one pane-run argument, not Herdr options'
agent_start_line=$(grep -n 'herdr pane run w1:p1 env AVEN_DISPATCH_STORE=' "$log" | head -n 1 | cut -d: -f1)
prompt_line=$(grep -n 'opencode api POST /api/session/ses_one/prompt' "$log" | head -n 1 | cut -d: -f1)
[ "$agent_start_line" -lt "$prompt_line" ] || fail 'OpenCode starts before prompt admission schedules execution'
assert_file_contains "$log" 'Plan then implement an Aven task' 'explicit skills directory is loaded'
assert_file_contains "$state" '"session_id": "ses_one"' 'session persisted before retry'
assert_file_contains "$state" '"agent": "build"' 'primary agent persisted'
assert_not_contains "$(cat "$log")" 'herdr pane split' 'ordinary dispatch does not create a babysitter pane'

# Babysitting is opt-in: both sessions are created and prompted through the
# OpenCode API, then the second API session is attached in the sibling pane.
babysitter_state=$work/babysitter-state.json
printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$babysitter_state" RUST_WORKTREE="$work/worktree-babysitter" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --babysitter >/dev/null
assert_file_contains "$log" 'herdr pane split w1:p1 --direction right --cwd ' 'babysitter splits next to build pane'
assert_file_contains "$log" '"agent":"babysitter"' 'babysitter session created through OpenCode API'
assert_file_contains "$log" '"model":{"id":"gpt-6-luna","providerID":"github-copilot"}' 'babysitter API session uses Luna'
assert_file_contains "$log" 'opencode api POST /api/session/ses_babysitter/prompt' 'babysitter prompt admitted through OpenCode API'
assert_file_contains "$log" 'herdr pane run w1:p2 env AVEN_DISPATCH_STORE=' 'babysitter inherits the dispatcher store when its API-owned session attaches'
assert_file_contains "$log" 'opencode --session '\''ses_babysitter'\''' 'babysitter pane attaches API-owned session'
assert_file_contains "$log" 'Supervise build OpenCode session ses_one in Herdr pane w1:p1' 'babysitter receives build identity'
assert_file_contains "$babysitter_state" '"babysitter": true' 'opt-in babysitter persisted'
assert_file_contains "$babysitter_state" '"babysitter_session_id": "ses_babysitter"' 'babysitter API session persisted'
assert_file_contains "$work/worktree-babysitter/.opencode/agents/babysitter.md" 'You are the babysitter' 'only the babysitter agent is injected'
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
before=$(grep -c 'POST /api/session/ses_one/prompt' "$log")
printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" > "$work/retry"
after=$(grep -c 'POST /api/session/ses_one/prompt' "$log")
assert_eq "$after" "$before" 're-dispatch does not admit a second prompt'
assert_file_contains "$work/retry" 'reopened APP-1 in OpenCode session ses_one' 're-dispatch reopens the persisted session'

PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- reconcile APP-1 >/dev/null
assert_file_contains "$state" '"log_cursor": "42"' 'durable log cursor persisted'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- interrupt APP-1 >/dev/null
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- list --running > "$work/after-interrupt"
assert_not_contains "$(cat "$work/after-interrupt")" '"task_ref": "APP-1"' 'interrupted dispatch is excluded from running list'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- log APP-1 --event manual-debug --detail 'operator diagnostic' > "$work/log-event"
assert_file_contains "$work/log-event" 'logged manual-debug for APP-1 in DL-LOG' 'dispatcher log command appends an operator event'
assert_file_contains "$log" 'aven related add DL-LOG APP-1' 'dispatcher log task references the source task'
assert_file_contains "$log" 'aven note DL-LOG --stdin' 'operator event is written to the linked log task'
printf 'rust dispatch ok\n'
