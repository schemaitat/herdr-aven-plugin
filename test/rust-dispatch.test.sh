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
if [ "$1" = pane ] && [ "$2" = run ]; then
  printf 'herdr-pane-run argc=%s command=%s\n' "$#" "$4" >> "$RUST_DISPATCH_LOG"
fi
mkdir -p "$RUST_WORKTREE"
printf '{"result":{"worktree":{"path":"%s"},"root_pane":{"pane_id":"w1:p1"}}}\n' "$RUST_WORKTREE"
EOF
cat > "$fake/opencode" <<'EOF'
#!/bin/sh
printf 'opencode %s\n' "$*" >> "$RUST_DISPATCH_LOG"
case " $* " in
  *" POST /api/session "*) printf '%s\n' '{"data":{"id":"ses_one"}}' ;;
  *" POST /api/session/ses_one/prompt "*) printf '%s\n' "$*" | grep -q 'msg_' || exit 1; printf '%s\n' '{"data":{"id":"msg_expected"}}' ;;
  *" GET /api/experimental/session/"*) printf 'id: 42\nevent: update\ndata: {}\n\n' ;;
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
  *" POST /api/session "*) printf '%s\n' '{"data":{"id":"ses_one"}}' ;;
  *" POST /api/session/ses_one/prompt "*) data=; while [ "$#" -gt 0 ]; do [ "$1" = --data ] && { data=$2; break; }; shift; done; id=$(printf '%s' "$data" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); printf '{"data":{"id":"%s"}}\n' "$id" ;;
  *" GET /api/experimental/session/"*) printf 'id: 42\nevent: update\ndata: {}\n\n' ;;
  *) printf '%s\n' '{"data":[]}' ;;
esac
EOF
chmod +x "$fake/opencode"

printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" RUST_WORKTREE="$work/worktree" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd --skills-dir "$PLUGIN_ROOT/skills" --opencode-config-dir "$PLUGIN_ROOT/.opencode" >/dev/null
assert_file_contains "$log" 'herdr worktree create --cwd /parent --branch app/dispatch-immutable-task --label APP-1 quoted "task" --focus' 'stable worktree branch'
assert_file_contains "$log" '"agent":"build"' 'primary agent sent to OpenCode session creation'
assert_file_contains "$log" '"model":{"id":"gpt-5.6-terra","providerID":"github-copilot"}' 'model sent to OpenCode session creation'
assert_file_contains "$work/worktree/.opencode/opencode.jsonc" '"$schema"' 'plugin OpenCode config copied to worktree'
assert_file_contains "$log" 'opencode api POST /api/session/ses_one/prompt' 'durable prompt admission'
assert_file_contains "$log" 'herdr pane run w1:p1 opencode --session ses_one' 'OpenCode starts in the worktree pane with its durable session'
assert_file_contains "$log" 'herdr-pane-run argc=4 command=opencode --session ses_one' 'OpenCode command is one pane-run argument, not Herdr options'
agent_start_line=$(grep -n 'herdr pane run w1:p1 opencode --session ses_one' "$log" | head -n 1 | cut -d: -f1)
prompt_line=$(grep -n 'opencode api POST /api/session/ses_one/prompt' "$log" | head -n 1 | cut -d: -f1)
[ "$agent_start_line" -lt "$prompt_line" ] || fail 'OpenCode starts before prompt admission schedules execution'
assert_file_contains "$log" 'Take an aven task from request to shipped' 'explicit skills directory is loaded'
assert_file_contains "$state" '"session_id": "ses_one"' 'session persisted before retry'
assert_file_contains "$state" '"agent": "build"' 'primary agent persisted'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- list --running > "$work/running"
assert_file_contains "$work/running" '"task_ref": "APP-1"' 'list reports running dispatch'
assert_file_contains "$work/running" '"state": "running"' 'list filters to running dispatches'
before=$(grep -c 'POST /api/session/ses_one/prompt' "$log")
printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- dispatch > "$work/retry"
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
