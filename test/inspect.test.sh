#!/bin/sh
# Read-only inspector snapshot: scoped Aven/store/Herdr/API merge, read
# allowlist, non-mutation, sanitization and missing-source degradation.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
fake=$work/bin
mkdir -p "$fake" "$work/state"
log=$work/calls
store=$work/dispatch.sqlite
repo=$work/app
mkdir -p "$repo/wt"
export RUST_INSPECT_WORK=$work
export RUST_INSPECT_LOG=$log
export RUST_INSPECT_REPO=$repo
export XDG_STATE_HOME=$work/state
export AVEN_DISPATCH_STORE=$store
unset HC_SESSION AVEN_DISPATCH_OPENCODE_URL AVEN_DISPATCH_OPENCODE_AUTHORIZATION
unset AVEN_DISPATCH_OPENCODE_TOKEN AVEN_DISPATCH_OPENCODE_PASSWORD
export HC_BIN=$fake/hc

cat > "$work/tasks.json" <<'JSON'
[
  {"ref":"APP-1","id":"task-one","title":"Task \u001b[31mOne\u001b[0m","project":"app","status":"todo","is_epic":false},
  {"ref":"APP-2","id":"task-two","title":"Task two","project":"app","status":"todo","is_epic":false},
  {"ref":"ZZZ-1","id":"foreign","title":"foreign project task","project":"other","status":"todo","is_epic":false}
]
JSON
printf '[]\n' > "$work/upcoming.json"
cat > "$work/context-one.json" <<'JSON'
{
  "task":{"id":"task-one","display_ref":"APP-1","title":"Task \u001b[31mOne\u001b[0m","status":"active","is_epic":false},
  "project":{"key":"app"},
  "workspace":{"key":"default"},
  "metadata":{
    "dispatch.reset-generation":"2",
    "dispatch.reset-state":"completed",
    "sdd.plan-root":"APP-9",
    "sdd.plan-worked-out":"true",
    "dispatch.attempt.implementation":"{\"task_id\":\"task-one\",\"task_ref\":\"APP-1\",\"workflow\":\"implementation\",\"attempt_id\":\"stale-recovery\",\"generation\":2,\"session_id\":\"ses_one\",\"pane\":\"w1:p1\",\"terminal\":{\"core_id\":\"core\",\"address\":\"t1\",\"role\":\"builder\",\"created_by_attempt\":true},\"state\":\"running\",\"created_at\":5,\"pending_prompt\":\"SECRET_PROMPT\"}",
    "dispatch.attempt.planning":"{\"task_id\":\"task-one\",\"task_ref\":\"APP-1\",\"workflow\":\"planning\",\"attempt_id\":\"plan-recovery\",\"generation\":2,\"session_id\":\"ses_three\",\"pane\":\"w1:p3\",\"terminal\":{\"core_id\":\"core\",\"address\":\"t3\",\"role\":\"builder\",\"created_by_attempt\":false},\"state\":\"running\",\"created_at\":10,\"prompt_id\":\"SECRET_PROMPT\"}"
  },
  "dependencies":{"depends_on":[{"id":"dep-one","display_ref":"APP-DEP","title":"dependency","status":"todo"}],"blocks":[]},
  "related":[{"task_id":"rel-one","display_ref":"APP-REL"}],
  "epic_children":[]
}
JSON
cat > "$work/context-two.json" <<'JSON'
{
  "task":{"id":"task-two","display_ref":"APP-2","title":"Task two","status":"active","is_epic":false},
  "project":{"key":"app"},
  "workspace":{"key":"default"},
  "metadata":{
    "dispatch.reset-generation":"1",
    "dispatch.reset-state":"in_progress",
    "dispatch.attempt.implementation":"{\"task_id\":\"task-two\",\"task_ref\":\"APP-2\",\"workflow\":\"implementation\",\"attempt_id\":\"reset-attempt\",\"generation\":1,\"session_id\":\"ses_two\",\"pane\":\"w1:p2\",\"state\":\"running\",\"created_at\":7}"
  },
  "dependencies":{"depends_on":[],"blocks":[]},
  "epic_children":[]
}
JSON
cat > "$work/terminals.json" <<JSON
{"hidden_finished":0,"terminals":[
  {"address":"t1","cwd":"$repo/wt","name":"aven-dispatch-task-one","state":"live","status":"idle","agent":"opencode","turn":4,"where":"app / 1"},
  {"address":"t3","cwd":"$repo/wt","name":"aven-dispatch-plan","state":"live","status":"working","agent":"opencode","turn":1,"where":"app / 1"},
  {"address":"t9","cwd":"/other","name":"unrelated","state":"live","status":"idle","agent":"zsh","turn":0,"where":"other / 1"}
]}
JSON

cat > "$fake/aven" <<'EOF'
#!/bin/sh
printf 'aven %s\n' "$*" >> "$RUST_INSPECT_LOG"
case " $* " in
  *" project list "*) printf '%s\n' '[{"key":"app","name":"app","prefix":"APP"}]' ;;
  *" list "*" --upcoming "*)
    printf 'start %s\n' "$(date +%s%N)" >> "$RUST_INSPECT_WORK/list-upcoming.times"
    sleep 0.2
    cat "$RUST_INSPECT_WORK/upcoming.json"
    printf 'end %s\n' "$(date +%s%N)" >> "$RUST_INSPECT_WORK/list-upcoming.times"
    ;;
  *" list "*)
    printf 'start %s\n' "$(date +%s%N)" >> "$RUST_INSPECT_WORK/list-available.times"
    sleep 0.2
    cat "$RUST_INSPECT_WORK/tasks.json"
    printf 'end %s\n' "$(date +%s%N)" >> "$RUST_INSPECT_WORK/list-available.times"
    ;;
  *" context APP-1 "*) cat "$RUST_INSPECT_WORK/context-one.json" ;;
  *" context APP-2 "*) cat "$RUST_INSPECT_WORK/context-two.json" ;;
  *) printf '%s\n' '{}' ;;
esac
EOF
cat > "$fake/git" <<'EOF'
#!/bin/sh
printf 'git %s\n' "$*" >> "$RUST_INSPECT_LOG"
if [ "${3:-}" = rev-parse ]; then printf '%s\n' "$RUST_INSPECT_REPO"; exit 0; fi
exit 1
EOF
cat > "$fake/hc" <<'EOF'
#!/bin/sh
printf 'hc %s\n' "$*" >> "$RUST_INSPECT_LOG"
if [ "$1 $2" = "ls --json" ]; then cat "$RUST_INSPECT_WORK/terminals.json"; exit 0; fi
exit 1
EOF
cat > "$fake/opencode" <<'EOF'
#!/bin/sh
printf 'opencode %s\n' "$*" >> "$RUST_INSPECT_LOG"
exit 1
EOF
chmod +x "$fake"/*

python3 - "$store" <<'PY'
import json, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute("""CREATE TABLE attempts (
  task_id TEXT NOT NULL, workflow TEXT NOT NULL, attempt_id TEXT NOT NULL,
  task_ref TEXT NOT NULL, state TEXT NOT NULL, generation INTEGER NOT NULL,
  session_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (task_id, workflow))""")
connection.execute("PRAGMA user_version = 1")
rows = [
  ("task-one", "implementation", "central-a", "APP-1", "needs-review", 2, "ses_one", 20,
   {"task_id":"task-one","task_ref":"APP-1","workflow":"implementation","attempt_id":"central-a",
    "generation":2,"session_id":"ses_one","pane":"w1:p1","state":"needs-review","created_at":20,
    "backend":"hc","core_id":"core","terminal":{"core_id":"core","address":"t1","role":"builder","created_by_attempt":True},
    "pending_prompt":"SECRET_PROMPT","prompt_id":"SECRET_PROMPT"}),
  ("task-two", "implementation", "reset-central", "APP-2", "running", 1, "ses_two", 30,
   {"task_id":"task-two","task_ref":"APP-2","workflow":"implementation","attempt_id":"reset-central",
    "generation":1,"session_id":"ses_two","pane":"w1:p2","state":"running","created_at":30,
    "terminal":{"core_id":"core","address":"t2","role":"builder","created_by_attempt":True}}),
  ("foreign", "implementation", "foreign-a", "ZZZ-1", "running", 0, "ses_foreign", 40,
   {"task_id":"foreign","task_ref":"ZZZ-1","workflow":"implementation","attempt_id":"foreign-a",
    "generation":0,"session_id":"ses_foreign","pane":"w9:p1","state":"running","created_at":40}),
]
for row in rows:
    task_id, workflow, attempt_id, ref, state, generation, session_id, created, payload = row
    connection.execute("INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?,?)",
      (task_id, workflow, attempt_id, ref, state, generation, session_id, created, created, json.dumps(payload)))
connection.execute("INSERT INTO attempts VALUES ('bad','default','bad','BAD-1','running',0,'',1,1,'not-json')")
connection.commit()
connection.close()
PY
store_hash_before=$(sha256sum "$store" | cut -d' ' -f1)

python3 "$PLUGIN_ROOT/test/inspect-api-fixture.py" "$work/api.log" "$work/port" &
api_fixture=$!
trap 'kill "$api_fixture" 2>/dev/null || true' EXIT HUP INT TERM
while [ ! -s "$work/port" ]; do
  kill -0 "$api_fixture" 2>/dev/null || fail 'OpenCode fixture failed'
  sleep 0.05
done
port=$(cat "$work/port")
printf '{"url":"http://127.0.0.1:%s","password":"test-password"}\n' "$port" > "$work/state/opencode-service.json"
mkdir -p "$work/state/opencode"
mv "$work/state/opencode-service.json" "$work/state/opencode/service.json"

cargo build --quiet --bin aven-dispatch
binary=$PLUGIN_ROOT/target/debug/aven-dispatch

PATH="$fake:$PATH" "$binary" inspect --project app --cwd "$repo" --json > "$work/out.json"

python3 - "$work/out.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
refs = {task["ref"] for task in snapshot["tasks"]}
assert refs == {"APP-1", "APP-2"}, refs
assert snapshot["scope"]["project"] == "app"
assert snapshot["scope"]["workspace"] == "default"
assert snapshot["scope"]["project_source"] == "explicit"
assert snapshot["scope"]["repository"].endswith("/app")
task = next(task for task in snapshot["tasks"] if task["ref"] == "APP-1")
assert task["title"] == "Task One", task["title"]
assert task["status"] == "active"
assert task["hydrated"] is True
assert task["plan"]["plan_root"] == "APP-9"
assert task["plan"]["plan_worked_out"] is True
assert task["plan"]["reset_generation"] == 2
assert [dep["ref"] for dep in task["dependencies"]] == ["APP-DEP"]
assert task["dependencies"][0]["hydrated"] is False
attempts = {(attempt["ref"], attempt["workflow"]): attempt for attempt in snapshot["attempts"]}
assert ("APP-2", "implementation") not in attempts, "reset-in-progress snapshot must be rejected"
assert ("ZZZ-1", "implementation") not in attempts, "foreign project task must stay out of scope"
implementation = attempts[("APP-1", "implementation")]
assert implementation["attempt_id"] == "central-a"
assert implementation["origin"] == "central_store"
assert implementation["state"] == "needs-review"
planning = attempts[("APP-1", "planning")]
assert planning["attempt_id"] == "plan-recovery"
assert planning["origin"] == "aven_recovery"
sessions = {session["session_id"]: session for session in snapshot["sessions"]}
assert sessions["ses_one"]["api"]["state"] == "working"
assert sessions["ses_one"]["api"]["approval_waiting"] == "yes"
assert sessions["ses_one"]["api"]["input_waiting"] == "no"
assert sessions["ses_three"]["api"]["state"] == "missing"
candidates = {(candidate["pane_id"], candidate["role"]): candidate for candidate in snapshot["candidates"]}
assert candidates[("t1", "primary")]["topology_present"] is True
assert candidates[("t1", "primary")]["workspace_id"] == "app / 1"
assert candidates[("t3", "primary")]["topology_present"] is True
assert all(pane["pane_id"] != "t9" for pane in snapshot["panes"]), "unscoped terminal leaked"
health = {source["source"]: source for source in snapshot["sources"]}
assert health["aven"]["status"] == "ok", health["aven"]
assert health["dispatcher"]["status"] == "incomplete", health["dispatcher"]  # malformed row + reset rejection
assert health["core"]["status"] == "ok", health["core"]
assert health["opencode"]["status"] == "ok", health["opencode"]
serialized = json.dumps(snapshot)
assert "SECRET_PROMPT" not in serialized
assert "prompt_id" not in serialized
assert "pending_prompt" not in serialized
assert "\u001b" not in serialized
PY

# The available and upcoming list reads must overlap in time.
python3 - "$work" <<'PY'
import sys
work = sys.argv[1]

def interval(name):
    stamps = [line.split() for line in open(f"{work}/{name}.times")]
    start = min(int(value) for kind, value in stamps if kind == "start")
    end = max(int(value) for kind, value in stamps if kind == "end")
    return start, end

available = interval("list-available")
upcoming = interval("list-upcoming")
assert available[0] < upcoming[1] and upcoming[0] < available[1], (
    f"list reads did not overlap: available={available} upcoming={upcoming}")
PY

# Scope is inferred from the repository basename, not widened to every project.
PATH="$fake:$PATH" "$binary" inspect --cwd "$repo" --json > "$work/inferred.json"
python3 - "$work/inferred.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
assert snapshot["scope"]["project"] == "app"
assert snapshot["scope"]["project_source"] == "inferred"
PY

# A missing store is not created, and Aven recovery alone keeps inspection usable.
missing_store=$work/missing.sqlite
PATH="$fake:$PATH" "$binary" --store "$missing_store" inspect --project app --cwd "$repo" --json > "$work/missing.json"
[ ! -e "$missing_store" ] || fail 'inspection must not create a missing dispatcher store'
python3 - "$work/missing.json" <<'PY'
import json, sys
snapshot = json.load(open(sys.argv[1]))
assert snapshot["attempts"], "recovery snapshots must remain usable without a store"
assert all(attempt["origin"] == "aven_recovery" for attempt in snapshot["attempts"])
health = {source["source"]: source for source in snapshot["sources"]}
assert health["dispatcher"]["status"] == "unavailable"
PY

# The store hash is unchanged after every read.
store_hash_after=$(sha256sum "$store" | cut -d' ' -f1)
assert_eq "$store_hash_after" "$store_hash_before" 'inspection must not mutate the central store'

# Read allowlist and no lifecycle/network shortcuts or focus requests.
assert_not_contains "$(cat "$log")" 'pane.focus' 'inspection must not focus panes'
assert_not_contains "$(cat "$log")" 'opencode api' 'inspection must not invoke the CLI API'
assert_contains "$(cat "$log")" 'hc ls --json' 'terminal topology uses the read-only hc list'
assert_not_contains "$(cat "$work/out.json")" 'test-password' 'service credentials must not leak into JSON'
assert_not_contains "$(cat "$log")" 'aven edit' 'inspection must not edit Aven'
assert_not_contains "$(cat "$log")" 'aven note' 'inspection must not write notes'
assert_not_contains "$(cat "$log")" 'aven status' 'inspection must not use the writable status path'
assert_not_contains "$(cat "$log")" 'reconcile' 'inspection must not reconcile'
api_calls=$(cat "$work/api.log")
assert_contains "$api_calls" 'GET /openapi.json'
assert_contains "$api_calls" 'GET /api/session/active'
assert_contains "$api_calls" 'GET /api/session/ses_one'
assert_contains "$api_calls" 'GET /api/session/ses_one/permission'
assert_contains "$api_calls" 'GET /api/session/ses_one/form'
assert_not_contains "$api_calls" 'POST ' 'API reads must be GET-only'
assert_not_contains "$api_calls" '/api/session?' 'inspection must not list all sessions'
assert_not_contains "$api_calls" '/message' 'inspection must not read transcripts'

# An explicit unknown project fails visibly instead of widening scope.
if PATH="$fake:$PATH" "$binary" inspect --project absent --cwd "$repo" --json > "$work/absent.out" 2> "$work/absent.err"; then
  fail 'unknown project must fail'
fi
assert_file_contains "$work/absent.err" 'was not found'
assert_file_contains "$work/absent.err" 'absent'
