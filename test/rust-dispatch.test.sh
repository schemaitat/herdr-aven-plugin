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
printf '%s\n' '{"result":{"worktree":{"path":"/worktree"},"root_pane":{"pane_id":"w1:p1"}}}'
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

printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- dispatch --agent build >/dev/null
assert_file_contains "$log" 'herdr worktree create --cwd /parent --branch app/dispatch-immutable-task --label APP-1 quoted "task"' 'stable worktree branch'
assert_file_contains "$log" '"agent":"build"' 'primary agent sent to OpenCode session creation'
assert_file_contains "$log" 'opencode api POST /api/session/ses_one/prompt' 'durable prompt admission'
assert_file_contains "$state" '"session_id": "ses_one"' 'session persisted before retry'
assert_file_contains "$state" '"agent": "build"' 'primary agent persisted'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- list --running > "$work/running"
assert_file_contains "$work/running" '"task_ref": "APP-1"' 'list reports running dispatch'
assert_file_contains "$work/running" '"state": "running"' 'list filters to running dispatches'
before=$(grep -c 'POST /api/session/ses_one/prompt' "$log")
printf '%s\n' "$context" | PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- dispatch > "$work/retry"
after=$(grep -c 'POST /api/session/ses_one/prompt' "$log")
assert_eq "$after" "$before" 're-dispatch does not admit a second prompt'
assert_file_contains "$work/retry" 'existing attempt' 're-dispatch points to recovery commands'

PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- reconcile APP-1 >/dev/null
assert_file_contains "$state" '"log_cursor": "42"' 'durable log cursor persisted'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- interrupt APP-1 >/dev/null
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$state" cargo run --quiet -- list --running > "$work/after-interrupt"
assert_not_contains "$(cat "$work/after-interrupt")" '"task_ref": "APP-1"' 'interrupted dispatch is excluded from running list'
printf 'rust dispatch ok\n'
