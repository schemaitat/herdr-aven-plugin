#!/bin/sh
# Isolated cascade-delete contract: a root epic is inventoried leaves-first,
# descendants are soft-deleted before the root, dispatcher attempt/effect rows
# are removed only after every Aven delete succeeds, and unrelated work is
# untouched. Aven is the stateful JSON fixture; no real database or store is
# used.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
fake=$work/bin
store=$work/dispatch.sqlite
state=$work/aven.json
mkdir -p "$fake"

export AVEN_FIXTURE_STATE=$state
export AVEN_FIXTURE_LOG=$work/aven.log
chmod +x "$PLUGIN_ROOT/test/aven_fixture.py"

cat > "$fake/aven" <<EOF
#!/bin/sh
exec python3 "$PLUGIN_ROOT/test/aven_fixture.py" "\$@"
EOF
chmod +x "$fake/aven"
export AVEN_BIN=$fake/aven

binary=$PLUGIN_ROOT/target/debug/aven-dispatch
[ -x "$binary" ] || fail "build target/debug/aven-dispatch first (just test-board-delete builds it)"

seed_state() {
  python3 - "$state" <<'PY'
import json, sys

def task(reference, title, is_epic=False, parent=None, status="todo"):
    return {
        "id": f"id-{reference}",
        "ref": reference,
        "title": title,
        "status": status,
        "priority": "none",
        "deleted": False,
        "is_epic": is_epic,
        "project": "app",
        "description": "",
        "metadata": {},
        "notes": [],
        "related": [],
        "depends_on": [],
        "epic_parent": parent,
        "updated_at": "2026-01-01T00:00:00Z",
    }

tasks = {
    "APP-ROOT": task("APP-ROOT", "Root epic", is_epic=True),
    "APP-CHILD": task("APP-CHILD", "Child phase", parent="APP-ROOT"),
    "APP-GRAND": task("APP-GRAND", "Grandchild task", parent="APP-CHILD"),
    "APP-OTHER": task("APP-OTHER", "Unrelated task"),
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump({"tasks": tasks, "next": 10, "projects": {}}, handle, indent=2, sort_keys=True)
PY
}

insert_attempt() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sqlite3, sys
store, task_id, task_ref = sys.argv[1:]
payload = {
    "task_id": task_id, "task_ref": task_ref, "workflow": "implementation",
    "attempt_id": "att_" + task_ref.lower(), "branch": "app/dispatch",
    "worktree": "", "session_id": "ses_fixture", "prompt_id": "msg_fixture",
    "state": "completed", "aven": {"aven_exe": "", "db_path": None, "workspace": None, "origin_cwd": ""},
    "created_at": 1,
}
with sqlite3.connect(store) as db:
    db.execute(
        "INSERT OR REPLACE INTO attempts (task_id, workflow, attempt_id, task_ref, state, generation, session_id, created_at, updated_at, payload) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (task_id, "implementation", payload["attempt_id"], task_ref, payload["state"], 0, payload["session_id"], 1, 1, json.dumps(payload)),
    )
    db.commit()
PY
}

insert_effect() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sqlite3, sys
store, task_id, task_ref = sys.argv[1:]
with sqlite3.connect(store) as db:
    db.execute(
        "INSERT OR REPLACE INTO effects (scope, task_id, task_ref, workflow, attempt_id, operation_id, kind, state, payload, generation, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ("default", task_id, task_ref, "implementation", "att_" + task_ref.lower(), "op-one", "aven_metadata", "pending", "{}", 0, 0, 1, 1),
    )
    db.commit()
PY
}

effect_count() {
  python3 - "$store" <<'PY'
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
try:
    print(connection.execute("SELECT count(*) FROM effects").fetchone()[0])
finally:
    connection.close()
PY
}

fixture_deleted() {
  python3 - "$state" "$1" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    state = json.load(handle)
print("true" if state["tasks"][sys.argv[2]].get("deleted", False) else "false")
PY
}

inventory_order() {
  python3 -c 'import json,sys; print(",".join(task["ref"] for task in json.load(sys.stdin)["tasks"]))'
}

seed_state
PATH="$fake:$PATH" "$binary" --store "$store" list >/dev/null
insert_attempt "$store" "id-APP-ROOT" "APP-ROOT"
insert_attempt "$store" "id-APP-CHILD" "APP-CHILD"
insert_attempt "$store" "id-APP-GRAND" "APP-GRAND"
insert_effect "$store" "id-APP-CHILD" "APP-CHILD"

# Default invocation is a read-only leaves-first inventory.
inventory=$(PATH="$fake:$PATH" "$binary" --store "$store" delete APP-ROOT --json)
assert_contains "$inventory" '"applied": false' "the default run is inventory-only"
assert_eq "$(printf '%s' "$inventory" | inventory_order)" "APP-GRAND,APP-CHILD,APP-ROOT" "descendants are inventoried before their parent"
assert_eq "$(sqlite_count "$store")" "3" "inventory leaves attempt rows alone"
assert_eq "$(effect_count)" "1" "inventory leaves effect rows alone"
for ref in APP-ROOT APP-CHILD APP-GRAND; do
  assert_eq "$(fixture_deleted "$ref")" "false" "inventory does not delete $ref"
done

# A mid-tree failure stops before the root and purges no dispatcher state.
set +e
AVEN_FIXTURE_FAIL_DELETE=APP-CHILD PATH="$fake:$PATH" \
  "$binary" --store "$store" delete APP-ROOT --apply --json > "$work/failed" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "a failed child delete exits nonzero"
assert_file_contains "$work/failed" "APP-CHILD" "the failure names the refused child"
assert_eq "$(fixture_deleted APP-GRAND)" "true" "already-visited descendants may be soft-deleted"
assert_eq "$(fixture_deleted APP-CHILD)" "false" "the failed child is not deleted"
assert_eq "$(fixture_deleted APP-ROOT)" "false" "the root is never deleted before every child succeeds"
assert_eq "$(sqlite_count "$store")" "3" "failed Aven deletion preserves attempt rows"

# Apply deletes leaves first, cleans attempts and effects, and keeps unrelated
# work and its state alone.
applied=$(PATH="$fake:$PATH" "$binary" --store "$store" delete APP-ROOT --apply --json)
assert_contains "$applied" '"applied": true'
assert_contains "$applied" '"attempts_removed": 3'
assert_eq "$(printf '%s' "$applied" | inventory_order)" "APP-GRAND,APP-CHILD,APP-ROOT" "apply preserves leaves-first order"
for ref in APP-ROOT APP-CHILD APP-GRAND; do
  assert_eq "$(fixture_deleted "$ref")" "true" "apply soft-deletes $ref"
done
assert_eq "$(fixture_deleted APP-OTHER)" "false" "an unrelated task is untouched"
assert_eq "$(sqlite_count "$store")" "0" "apply removes attempt rows for the whole tree"
assert_eq "$(effect_count)" "0" "apply removes effects even when their attempt is gone"
assert_eq "$(python3 - "$AVEN_FIXTURE_LOG" <<'PY'
import sys
print(",".join(line.split()[-1] for line in open(sys.argv[1], encoding="utf-8") if line.startswith("aven delete ")))
PY
)" "APP-GRAND,APP-CHILD,APP-GRAND,APP-CHILD,APP-ROOT" "Aven delete attempts follow the leaves-first cascade order"

# Retry is idempotent and reports that no dispatcher state remained.
again=$(PATH="$fake:$PATH" "$binary" --store "$store" delete APP-ROOT --apply --json)
assert_contains "$again" '"applied": true'
assert_contains "$again" '"attempts_removed": 0'
assert_eq "$(printf '%s' "$again" | inventory_order)" "APP-GRAND,APP-CHILD,APP-ROOT" "an already-deleted tree still inventories"

printf 'board delete ok\n'
