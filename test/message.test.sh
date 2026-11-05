#!/bin/sh
# Message identity fences and bounded, prompt-free summary reads.
set -eu
. "$(dirname "$0")/helpers.sh"

mkdir -p /tmp/opencode
work=$(mktemp -d /tmp/opencode/aven-message-test.XXXXXX)
fake=$work/bin
store=$work/dispatch.sqlite
binary=$PLUGIN_ROOT/target/debug/aven-dispatch
[ -x "$binary" ] || fail 'build target/debug/aven-dispatch first'
mkdir -p "$fake"
export AVEN_DISPATCH_STORE=$store
export HC_CALL_LOG=$work/hc-calls.log
cat > "$fake/hc" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$HC_CALL_LOG"
printf '{}\n'
EOF
chmod +x "$fake/hc"
export PATH="$fake:$PATH"

# Create an isolated store, then model a re-dispatched attempt that differs from
# the attempt a board rendered before the click.
"$binary" list >/dev/null
python3 - "$store" <<'PY'
import json, sqlite3, sys
payload = {
    "task_id": "task-one", "task_ref": "APP-ONE", "workflow": "implementation",
    "attempt_id": "att-new", "generation": 1, "branch": "app/new", "worktree": "/repo/new",
    "prompt_id": "", "state": "needs-review", "session_id": "ses_new", "core_id": "fixture-core",
    "terminal": {"core_id": "fixture-core", "address": "t-new", "name": "new", "role": "builder", "created_by_attempt": True},
    "pending_prompt": "SECRET PROMPT", "created_at": 100,
    "aven": {"aven_exe": "", "db_path": None, "workspace": None, "origin_cwd": "/private/checkout"},
}
connection = sqlite3.connect(sys.argv[1])
connection.execute(
    "INSERT INTO attempts (task_id, workflow, attempt_id, task_ref, state, generation, session_id, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ("task-one", "implementation", "att-new", "APP-ONE", "needs-review", 1, "ses_new", 100, 100, json.dumps(payload)),
)
connection.commit()
connection.close()
PY

refuse() {
  expected=$1
  shift
  if "$binary" message task-one --workflow implementation --role builder --text '/ha-merge merge into local main' "$@" >"$work/message.out" 2>"$work/message.err"; then
    fail 'replacement attempt was messaged'
  fi
  assert_file_contains "$work/message.err" "$expected" 'identity mismatch is explained'
  [ ! -e "$HC_CALL_LOG" ] || fail 'identity mismatch must happen before any hc/message call'
}
refuse 'attempt ID changed' --attempt-id att-old --generation 1 --terminal t-new
refuse 'reset generation changed' --attempt-id att-new --generation 0 --terminal t-new
refuse 'terminal changed' --attempt-id att-new --generation 1 --terminal t-old

summary=$("$binary" list --summary --limit 1)
assert_contains "$summary" 'att-new' 'summary includes the attempt'
assert_not_contains "$summary" 'SECRET PROMPT' 'summary omits prompts'
assert_not_contains "$summary" '/private/checkout' 'summary omits Aven invocation details'

python3 - "$store" <<'PY'
import json, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
payload = json.loads(connection.execute("SELECT payload FROM attempts WHERE task_id = 'task-one'").fetchone()[0])
payload.update(task_id="task-two", task_ref="APP-TWO", attempt_id="att-two", created_at=200)
connection.execute(
    "INSERT INTO attempts (task_id, workflow, attempt_id, task_ref, state, generation, session_id, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ("task-two", "implementation", "att-two", "APP-TWO", "needs-review", 1, "ses_two", 200, 200, json.dumps(payload)),
)
connection.commit()
connection.close()
PY
if "$binary" list --summary --limit 1 >"$work/cap.out" 2>"$work/cap.err"; then
  fail 'summary silently truncated an over-cap store'
fi
assert_file_contains "$work/cap.err" 'exceeds the 1-attempt limit' 'cap overflow is explicit'
[ ! -e "$HC_CALL_LOG" ] || fail 'read-only summary/mismatch paths must not call hc'
printf 'message identity and summary limits ok\n'
