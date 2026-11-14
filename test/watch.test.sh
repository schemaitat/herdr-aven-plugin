#!/bin/sh
# Event-driven watcher lifecycle: one owner per store, durable state, snapshot
# correlation, and a status event that updates terminal observation without
# changing Aven acceptance.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
binary=$(dispatch_bin)
fake=$work/bin
state=$work/hc-state
repo=$work/repo
store=$work/dispatch.sqlite
mkdir -p "$fake" "$state" "$repo"
export HC_SESSION=aven-dispatch-test-$$
export HC_FIXTURE_STATE=$state
export HC_FIXTURE_LOG=$work/calls
export HC_FIXTURE_CORE_ID=fixture-core
export HC_FIXTURE_CORE_NAME=fixture
export HC_FIXTURE_FOLLOW=1
export HC_FIXTURE_EVENTS=$state/events.ndjson
export HC_BIN=$PLUGIN_ROOT/test/hc_fixture.py
export HERDR_APP_BIN=$fake/herdr-app
export AVEN_WORKTREE_ROOT=$work/worktrees
export XDG_CONFIG_HOME=$work/config
mkdir -p "$work/config"
chmod +x "$PLUGIN_ROOT/test/hc_fixture.py"

git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
printf '%s\n' base > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -qm base

cat > "$fake/aven" <<EOF
#!/bin/sh
exec python3 "$PLUGIN_ROOT/test/aven_fixture.py" "\$@"
EOF
export AVEN_FIXTURE_STATE=$work/aven-state.json
export AVEN_FIXTURE_LOG=$work/aven.log
export AVEN_FIXTURE_PREFIX=APP
python3 - "$AVEN_FIXTURE_STATE" <<'PY'
import json, sys
state = {"next": 1, "projects": {"app": "app"}, "tasks": {
    "APP-1": {"id": "immutable-task", "ref": "APP-1", "title": "watched task",
              "status": "todo", "priority": "none", "deleted": False, "is_epic": False,
              "project": "app", "description": "", "metadata": {}, "notes": [],
              "related": [], "depends_on": []},
}}
json.dump(state, open(sys.argv[1], "w"), indent=2, sort_keys=True)
PY
cat > "$fake/opencode" <<'EOF'
#!/bin/sh
case " $* " in
  *" POST /api/session/"*"/prompt "*) data=; while [ "$#" -gt 0 ]; do [ "$1" = --data ] && { data=$2; break; }; shift; done; id=$(printf '%s' "$data" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); printf '{"data":{"id":"%s"}}\n' "$id" ;;
  *" POST /api/session "*) printf '%s\n' '{"data":{"id":"ses_watch"}}' ;;
  *" GET /api/session/ses_watch "*) printf '%s\n' '{"data":{}}' ;;
  *" GET /api/session?limit=1 "*) printf '%s\n' '{"data":[]}' ;;
  *) printf '%s\n' '{"data":[]}' ;;
esac
EOF
cat > "$fake/herdr-app" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$fake"/*

context='{"version":1,"invocation":{"origin_cwd":"'"$repo"'"},"targeting":{"targets":[{"id":"immutable-task","ref":"APP-1"}]},"selection":{"primary":{"ref":"APP-1","task":{"id":"immutable-task","title":"watched task"},"project":{"key":"app"}}}}'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" "$binary" dispatch --agent build --model github-copilot/gpt-6.1-terra <<EOF >/dev/null
$context
EOF

PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" "$binary" watch > "$work/watch.log" 2>&1 &
watcher=$!
trap 'kill "$watcher" 2>/dev/null || true' EXIT HUP INT TERM
for _ in $(seq 1 200); do
  [ -f "$work/watch.json" ] && grep -q '"running": true' "$work/watch.json" && break
  sleep 0.05
done
grep -q '"running": true' "$work/watch.json" || fail 'watcher did not publish durable running state'

PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" "$binary" watch --status > "$work/status.json"
assert_file_contains "$work/status.json" '"lock"' 'status reports the owning lock'
for _ in $(seq 1 100); do grep -q 'fixture-core' "$work/watch.json" && break; sleep 0.05; done
assert_file_contains "$work/watch.json" 'fixture-core' 'state records the durable core identity'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" "$binary" watch --status > "$work/status.json"

set +e
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" "$binary" watch > "$work/duplicate" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" 'a second watcher is refused'
assert_file_contains "$work/duplicate" 'already owns' 'duplicate watcher explains ownership'

# A status event is a trigger to inspect core facts, not an acceptance verdict.
python3 - "$state" <<'PY'
import json, sys
from pathlib import Path
state = Path(sys.argv[1])
(state / "status.json").write_text(json.dumps({"t1": {"status": "working", "turn": 3}}), encoding="utf-8")
line = {"jsonrpc": "2.0", "method": "event", "params": {"data": {"state": "working", "status": "working"}, "seq": 1, "terminal": "t1", "type": "status"}}
with open(state / "events.ndjson", "a", encoding="utf-8") as handle:
    handle.write(json.dumps(line) + "\n")
PY

seen=no
for _ in $(seq 1 200); do
  if sqlite_json "$store" | grep -q '"status": "working"'; then seen=yes; break; fi
  sleep 0.05
done
assert_eq "$seen" "yes" 'status event updated the terminal observation'
assert_contains "$(sqlite_json "$store")" '"state": "running"' 'core status alone does not change persisted execution state'

PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" "$binary" watch --stop > "$work/stop"
assert_file_contains "$work/stop" 'stopped dispatcher watcher' 'watch --stop signals the owner'
for _ in $(seq 1 100); do [ ! -e "$work/watch.lock" ] && break; sleep 0.05; done
[ ! -e "$work/watch.lock" ] || fail 'watcher lock was not released'
wait "$watcher" 2>/dev/null || true
trap - EXIT HUP INT TERM

printf 'watch ok\n'
