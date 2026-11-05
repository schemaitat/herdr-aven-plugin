#!/bin/sh
# Isolated lifecycle contracts: terminal admission guards, stable reduction,
# delivery closeout, reviewed disposition, board proposals and read-only audit.
#
# Aven is a stateful disposable JSON fixture, OpenCode a deterministic API
# fixture, and hc the existing fixture whose `exec` runs real Git. No live
# incident task or store is used as a fixture.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
fake=$work/bin
store=$work/dispatch.sqlite
repo=$work/repo
state=$work/aven.json
mkdir -p "$fake" "$repo"

export HC_SESSION=aven-lifecycle-test-$$
export HC_FIXTURE_STATE=$work/hc-state
export HC_FIXTURE_LOG=$work/hc.log
export HC_FIXTURE_CORE_ID=fixture-core
export HC_FIXTURE_CORE_NAME=fixture
export HC_BIN=$PLUGIN_ROOT/test/hc_fixture.py
export HERDR_APP_BIN=$fake/herdr-app
export AVEN_WORKTREE_ROOT=$work/worktrees
export AVEN_FIXTURE_STATE=$state
export AVEN_FIXTURE_LOG=$work/aven.log
export OPENCODE_FIXTURE_LOG=$work/opencode.log
export OPENCODE_FIXTURE_STATE=$work/opencode.json
mkdir -p "$HC_FIXTURE_STATE"
chmod +x "$PLUGIN_ROOT/test/hc_fixture.py" "$PLUGIN_ROOT/test/aven_fixture.py" "$PLUGIN_ROOT/test/opencode_fixture.py"

cat > "$fake/aven" <<EOF
#!/bin/sh
exec python3 "$PLUGIN_ROOT/test/aven_fixture.py" "\$@"
EOF
cat > "$fake/opencode" <<EOF
#!/bin/sh
exec python3 "$PLUGIN_ROOT/test/opencode_fixture.py" "\$@"
EOF
cat > "$fake/herdr-app" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$fake"/*
export AVEN_BIN=$fake/aven
export OPENCODE_BIN=$fake/opencode

binary=$PLUGIN_ROOT/target/debug/aven-dispatch
[ -x "$binary" ] || fail "build target/debug/aven-dispatch first (just test-lifecycle builds it)"

git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
printf '%s\n' base > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -qm base
git -C "$repo" branch -M main

seed_state() {
  python3 - "$state" <<'PY'
import json, sys
tasks = {
    "APP-OPEN": ("OPEN", "open task", "todo", False, False, "app"),
    "APP-DONE": ("DONE", "done task", "done", False, False, "app"),
    "APP-CANCEL": ("CANCEL", "canceled task", "canceled", False, False, "app"),
    "APP-DELETED": ("DELETED", "deleted task", "todo", False, True, "app"),
    "APP-WEIRD": ("WEIRD", "unknown status task", "mystery", False, False, "app"),
    "APP-CODE": ("CODE", "accepted code result", "done", False, False, "app"),
    "APP-EPIC-CODE": ("EPICCODE", "accepted childless epic code result", "done", True, False, "app"),
    "APP-EPIC-RETAINED": ("EPICRETAINED", "accepted childless epic with retained result", "done", True, False, "app"),
    "APP-EPIC-PLANNING": ("EPICPLAN", "accepted childless planning epic", "done", True, False, "app"),
    "APP-AGGREGATE": ("AGGREGATE", "accepted aggregate root", "done", True, False, "app"),
    "APP-AGG-CHILD": ("AGGCHILD", "accepted delivered child", "done", False, False, "app"),
    "APP-AGG-OBLIGATION": ("AGGOBLIGATION", "open child delivery obligation", "todo", False, False, "app"),
    "APP-CANCELME": ("CANCELME", "active cancellation", "active", False, False, "app"),
    "APP-CANCEL-SUCCESSOR": ("CANCELSUCCESSOR", "canceled task needing a successor record", "canceled", False, False, "app"),
    "APP-EPIC": ("EPIC", "childless idea", "todo", True, False, "app"),
    "APP-OBLIGATION": ("OBLIG", "delivery obligation", "todo", False, False, "app"),
}
state = {"next": 100, "projects": {}, "tasks": {}}
for ref, (suffix, title, status, epic, deleted, project) in tasks.items():
    state["tasks"][ref] = {
        "id": f"id-{ref}", "ref": ref, "title": title, "status": status,
        "priority": "none", "deleted": deleted, "is_epic": epic,
        "project": project, "description": "", "metadata": {}, "notes": [],
        "related": [], "depends_on": [],
    }
state["tasks"]["APP-CODE"]["metadata"] = {"delivery.state": "pending"}
state["tasks"]["APP-OBLIGATION"]["metadata"] = {"delivery.obligation-for": "APP-CANCELME"}
state["tasks"]["APP-CANCELME"]["related"] = ["APP-OBLIGATION"]
state["tasks"]["APP-OBLIGATION"]["related"] = ["APP-CANCELME"]
state["tasks"]["APP-CANCEL"]["metadata"] = {
    "disposition.artifacts": json.dumps([{
        "kind": "phase-worktree", "path": "/preserved/phase-02",
        "branch": "app/phase-02", "commit": "deadbeef", "dirty": False,
    }])
}
state["tasks"]["APP-AGG-CHILD"]["epic_parent"] = "APP-AGGREGATE"
state["tasks"]["APP-AGG-CHILD"]["metadata"] = {"delivery.state": "merged"}
state["tasks"]["APP-AGG-OBLIGATION"]["metadata"] = {
    "delivery.obligation-for": "APP-AGG-CHILD", "delivery.state": "pending"
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2, sort_keys=True)
PY
}
seed_state

context() {
  printf '{"version":1,"invocation":{"origin_cwd":"%s"},"targeting":{"targets":[%s]},"selection":{"primary":{"ref":"%s","task":{"id":"%s","title":"t"},"project":{"key":"app"}}}}' \
    "$repo" "$1" "$2" "$3"
}

run_dispatch() {
  PATH="$fake:$PATH" "$binary" --store "$store" dispatch --agent build --model github-copilot/gpt-6.1-terra
}

# ---------------------------------------------------------------------------
# Phase 1 — terminal/deleted/unknown targets reject the whole batch with zero
# admission side effects, in both orders.
# ---------------------------------------------------------------------------
for order in "APP-OPEN,APP-DONE" "APP-DONE,APP-OPEN"; do
  before=$( [ -f "$work/opencode.log" ] && wc -l < "$work/opencode.log" || printf 0)
  targets=$(python3 - "$order" <<'PY'
import json, sys
refs = sys.argv[1].split(",")
print(",".join(json.dumps({"id": f"id-{ref}", "ref": ref}) for ref in refs))
PY
)
  set +e
  run_dispatch <<EOF > "$work/reject-order" 2>&1
$(context "$targets" "${order%%,*}" "id-${order%%,*}")
EOF
  rc=$?
  set -e
  assert_eq "$rc" "1" "terminal target rejects mixed batch ($order)"
  after=$( [ -f "$work/opencode.log" ] && wc -l < "$work/opencode.log" || printf 0)
  assert_eq "$after" "$before" "invalid mixed batch has no OpenCode side effects ($order)"
done
[ ! -e "$store" ] || fail "invalid mixed batches must not create the dispatcher store"
[ ! -e "$work/worktrees/repo/app-dispatch-open" ] || fail "invalid mixed batches must not create a worktree"

for ref in APP-DELETED APP-WEIRD; do
  set +e
  run_dispatch <<EOF > "$work/reject-target" 2>&1
$(context "{\"id\":\"id-$ref\",\"ref\":\"$ref\"}" "$ref" "id-$ref")
EOF
  rc=$?
  set -e
  assert_eq "$rc" "1" "invalid target $ref is rejected"
  assert_file_contains "$work/reject-target" "task id-$ref" "invalid target $ref explains the refusal"
done

# ---------------------------------------------------------------------------
# Phase 2 — repeated reconciliation is stable and terminal contradictions are
# explicit.
# ---------------------------------------------------------------------------
init_store() {
  PATH="$fake:$PATH" "$binary" --store "$1" list >/dev/null
}
insert_attempt() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import json, sqlite3, sys
store, task_id, task_ref, state = sys.argv[1:]
payload = {
    "task_id": task_id, "task_ref": task_ref, "workflow": "implementation",
    "attempt_id": "att_" + task_ref.lower(), "branch": "app/dispatch",
    "worktree": "", "session_id": "ses_fixture", "prompt_id": "msg_fixture",
    "state": state, "aven": {"aven_exe": "", "db_path": None, "workspace": None, "origin_cwd": ""},
    "created_at": 1,
}
with sqlite3.connect(store) as db:
    db.execute(
        "INSERT OR REPLACE INTO attempts (task_id, workflow, attempt_id, task_ref, state, generation, session_id, created_at, updated_at, payload) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (task_id, "implementation", payload["attempt_id"], task_ref, state, 0, payload["session_id"], 1, 1, json.dumps(payload)),
    )
    db.commit()
PY
}
reduce_store=$work/reduce.sqlite
init_store "$reduce_store"
insert_attempt "$reduce_store" "id-APP-DONE" "APP-DONE" "running"
PATH="$fake:$PATH" OPENCODE_FIXTURE_OUTCOME=succeeded "$binary" --store "$reduce_store" watch --once > "$work/reduce-1"
assert_contains "$(python3 - "$reduce_store" <<'PY'
import json, sqlite3, sys
print(json.loads(sqlite3.connect(sys.argv[1]).execute("SELECT payload FROM attempts").fetchone()[0])["state"])
PY
)" "completed" "accepted stopped execution converges to completed"
revision=$(python3 - "$reduce_store" <<'PY'
import json, sqlite3, sys
print(json.loads(sqlite3.connect(sys.argv[1]).execute("SELECT payload FROM attempts").fetchone()[0])["lifecycle"]["revision"])
PY
)
PATH="$fake:$PATH" OPENCODE_FIXTURE_OUTCOME=succeeded "$binary" --store "$reduce_store" watch --once > /dev/null
revision2=$(python3 - "$reduce_store" <<'PY'
import json, sqlite3, sys
print(json.loads(sqlite3.connect(sys.argv[1]).execute("SELECT payload FROM attempts").fetchone()[0])["lifecycle"]["revision"])
PY
)
assert_eq "$revision2" "$revision" "unchanged repeated reconcile keeps completed stable"

contradiction_store=$work/contradiction.sqlite
init_store "$contradiction_store"
insert_attempt "$contradiction_store" "id-APP-CANCEL" "APP-CANCEL" "running"
PATH="$fake:$PATH" "$binary" --store "$contradiction_store" watch --once > /dev/null
assert_contains "$(python3 - "$contradiction_store" <<'PY'
import json, sqlite3, sys
attempt = json.loads(sqlite3.connect(sys.argv[1]).execute("SELECT payload FROM attempts").fetchone()[0])
print(attempt["lifecycle"]["contradiction"])
PY
)" "terminal_unknown_execution" "terminal task with missing API evidence is a contradiction"

# ---------------------------------------------------------------------------
# Phase 3 — accepted-but-unmerged work gets one obligation; a human merge and
# closeout resolve it with exact local ancestry evidence.
# ---------------------------------------------------------------------------
closeout_store=$work/closeout.sqlite
init_store "$closeout_store"
worktree=$work/worktrees/repo/app-dispatch-code
git -C "$repo" worktree add -q -b app/dispatch-code "$worktree"
printf '%s\n' change > "$worktree/change.txt"
git -C "$worktree" add change.txt
git -C "$worktree" commit -qm change
code_commit=$(git -C "$worktree" rev-parse HEAD)
insert_attempt "$closeout_store" "id-APP-CODE" "APP-CODE" "completed"
insert_attempt "$closeout_store" "id-APP-DONE" "APP-DONE" "completed"
python3 - "$closeout_store" "$worktree" <<'PY'
import json, sqlite3, sys
store, worktree = sys.argv[1:]
with sqlite3.connect(store) as db:
    payload = json.loads(db.execute("SELECT payload FROM attempts").fetchone()[0])
    payload["worktree"] = worktree
    payload["branch"] = "app/dispatch-code"
    db.execute("UPDATE attempts SET payload = ? WHERE task_id = ?", (json.dumps(payload), "id-APP-CODE"))
    db.commit()
PY

set +e
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-CODE --project app --target main --json > "$work/closeout-dry" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "unmerged accepted work is non-success"
assert_file_contains "$work/closeout-dry" '"state": "committed"' "dry-run reports a committed but undelivered result"
assert_eq "$(python3 - "$state" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["tasks"]["APP-CODE"]["metadata"]["delivery.state"])
PY
)" "pending" "dry-run does not write delivery metadata"

set +e
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-CODE --project app --target main --apply > "$work/closeout-apply" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "apply without a merge remains non-success"
python3 - "$state" "$code_commit" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
task = state["tasks"]["APP-CODE"]
assert task["metadata"]["delivery.state"] == "committed", task["metadata"]
assert task["metadata"]["delivery.commit"] == sys.argv[2], task["metadata"]
obligations = [t for t in state["tasks"].values() if t["metadata"].get("delivery.obligation-for") == "APP-CODE"]
assert len(obligations) == 1, obligations
assert obligations[0]["status"] == "todo"
PY

# One logical obligation survives a repeated apply.
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-CODE --project app --target main --apply > /dev/null 2>&1 || true
assert_eq "$(python3 - "$state" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
print(len([t for t in state["tasks"].values() if t["metadata"].get("delivery.obligation-for") == "APP-CODE"]))
PY
)" "1" "repeated closeout keeps exactly one delivery obligation"

# Human-triggered integration into local main, then verified closeout.
git -C "$repo" merge --ff-only -q app/dispatch-code
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-CODE --project app --target main --apply --json > "$work/closeout-merged"
python3 - "$state" "$code_commit" <<'PY'
import json, subprocess, sys
state = json.load(open(sys.argv[1]))
task = state["tasks"]["APP-CODE"]
assert task["metadata"]["delivery.state"] == "merged", task["metadata"]
assert task["metadata"]["delivery.merged"] == sys.argv[2], task["metadata"]
obligations = [t for t in state["tasks"].values() if t["metadata"].get("delivery.obligation-for") == "APP-CODE"]
assert len(obligations) == 1 and obligations[0]["status"] == "done", obligations
PY
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-CODE --project app --target main --apply --json > "$work/closeout-merged-retry"
python3 - "$state" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
obligation = next(t for t in state["tasks"].values() if t["metadata"].get("delivery.obligation-for") == "APP-CODE")
assert obligation["status"] == "done", obligation
assert len([n for n in obligation["notes"] if "delivery-resolved:" in n["body"]]) == 1, obligation["notes"]
PY

# A merged child facet does not let a closed epic bypass its still-open mapped
# delivery follow-up.
set +e
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-AGGREGATE --project app --target main --json > "$work/aggregate-open-obligation" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "aggregate closeout rejects a still-open child obligation"
assert_file_contains "$work/aggregate-open-obligation" 'APP-AGG-CHILD delivery obligation APP-AGG-OBLIGATION is todo' "aggregate reports the exact open delivery obligation"

# An unrelated merge/PR claim cannot satisfy delivery.
assert_contains "$(PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-CODE --project app --target main --pr 42 --json)" '"target": "main"' "PR identity can be recorded without pretending merged delivery"

# A childless epic can still have its own bound code result. Do not infer
# no-code from `is_epic=true` plus an empty child list.
planning_dry=$work/epic-planning-dry
set +e
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-EPIC-PLANNING --project app --target main --json > "$planning_dry" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "childless planning epic needs an explicit no-code disposition"
assert_file_contains "$planning_dry" '"state": "pending"' "empty epic is not inferred not-applicable"
assert_file_contains "$planning_dry" 'explicit --not-applicable' "empty epic explains the required human decision"

epic_worktree=$work/worktrees/repo/app-dispatch-epic-code
git -C "$repo" worktree add -q -b app/dispatch-epic-code "$epic_worktree"
printf '%s\n' epic-change > "$epic_worktree/epic-change.txt"
git -C "$epic_worktree" add epic-change.txt
git -C "$epic_worktree" commit -qm epic-change
epic_code_commit=$(git -C "$epic_worktree" rev-parse HEAD)
insert_attempt "$closeout_store" "id-APP-EPIC-CODE" "APP-EPIC-CODE" "completed"
python3 - "$closeout_store" "$epic_worktree" <<'PY'
import json, sqlite3, sys
store, worktree = sys.argv[1:]
with sqlite3.connect(store) as db:
    payload = json.loads(db.execute("SELECT payload FROM attempts WHERE task_id = ?", ("id-APP-EPIC-CODE",)).fetchone()[0])
    payload["worktree"] = worktree
    payload["branch"] = "app/dispatch-epic-code"
    db.execute("UPDATE attempts SET payload = ? WHERE task_id = ?", (json.dumps(payload), "id-APP-EPIC-CODE"))
    db.commit()
PY

set +e
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-EPIC-CODE --project app --target main --json > "$work/epic-code-dry" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "unmerged childless epic code result remains pending"
assert_file_contains "$work/epic-code-dry" '"state": "committed"' "childless epic's bound result is verified as code"

set +e
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-EPIC-CODE --project app --target main --apply > "$work/epic-code-apply" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "childless epic code result creates a pending delivery obligation"
python3 - "$state" "$epic_code_commit" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
task = state["tasks"]["APP-EPIC-CODE"]
assert task["is_epic"] and task["status"] == "done", task
assert task["metadata"]["delivery.state"] == "committed", task["metadata"]
assert task["metadata"]["delivery.commit"] == sys.argv[2], task["metadata"]
obligations = [t for t in state["tasks"].values() if t["metadata"].get("delivery.obligation-for") == "APP-EPIC-CODE"]
assert len(obligations) == 1 and obligations[0]["status"] == "todo", obligations
PY

git -C "$repo" merge --ff-only -q app/dispatch-epic-code
PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-EPIC-CODE --project app --target main --apply --json > "$work/epic-code-merged"
python3 - "$state" "$epic_code_commit" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
task = state["tasks"]["APP-EPIC-CODE"]
assert task["metadata"]["delivery.state"] == "merged", task["metadata"]
assert task["metadata"]["delivery.commit"] == sys.argv[2], task["metadata"]
obligations = [t for t in state["tasks"].values() if t["metadata"].get("delivery.obligation-for") == "APP-EPIC-CODE"]
assert len(obligations) == 1 and obligations[0]["status"] == "done", obligations
PY

# A retained attempt may outlive its worktree. An explicit exact SHA can still
# be verified against a clean local target checkout without fabricating a
# source worktree or treating the code-bearing epic as no-code.
insert_attempt "$closeout_store" "id-APP-EPIC-RETAINED" "APP-EPIC-RETAINED" "needs-review"
python3 - "$closeout_store" "$work/missing-epic-worktree" <<'PY'
import json, sqlite3, sys
store, missing = sys.argv[1:]
with sqlite3.connect(store) as db:
    payload = json.loads(db.execute("SELECT payload FROM attempts WHERE task_id = ?", ("id-APP-EPIC-RETAINED",)).fetchone()[0])
    payload["worktree"] = missing
    payload["branch"] = "app/dispatch-retained-epic"
    db.execute("UPDATE attempts SET payload = ? WHERE task_id = ?", (json.dumps(payload), "id-APP-EPIC-RETAINED"))
    db.commit()
PY
(cd "$repo" && PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-EPIC-RETAINED --project app --target main --commit "$epic_code_commit" --json) > "$work/epic-retained-dry"
assert_file_contains "$work/epic-retained-dry" '"state": "merged"' "exact retained result is checked against the clean target"
assert_file_contains "$work/epic-retained-dry" "$epic_code_commit" "retained result evidence preserves the exact source SHA"
(cd "$repo" && PATH="$fake:$PATH" "$binary" --store "$closeout_store" closeout APP-EPIC-RETAINED --project app --target main --commit "$epic_code_commit" --apply --json) > "$work/epic-retained-apply"
python3 - "$state" "$epic_code_commit" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
task = state["tasks"]["APP-EPIC-RETAINED"]
assert task["is_epic"] and task["status"] == "done", task
assert task["metadata"]["delivery.state"] == "merged", task["metadata"]
assert task["metadata"]["delivery.commit"] == sys.argv[2], task["metadata"]
assert task["metadata"]["delivery.provenance"] == "local-main-ancestry", task["metadata"]
assert not [t for t in state["tasks"].values() if t["metadata"].get("delivery.obligation-for") == "APP-EPIC-RETAINED"]
PY

# ---------------------------------------------------------------------------
# Phase 4 — reviewed cancellation preserves artifacts and transfers an open
# obligation; recovery retirement is non-destructive and approval-gated.
# ---------------------------------------------------------------------------
set +e
PATH="$fake:$PATH" "$binary" --store "$closeout_store" disposition APP-CANCELME --json > "$work/disposition-dry" 2>&1
rc=$?
set -e
assert_eq "$rc" "0" "disposition dry-run is read-only and successful"
assert_eq "$(python3 - "$state" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["tasks"]["APP-CANCELME"]["status"])
PY
)" "active" "disposition dry-run does not change status"

PATH="$fake:$PATH" "$binary" --store "$closeout_store" disposition APP-CANCELME --apply --reason "superseded by follow-up" --successor APP-OPEN --json > "$work/disposition-apply"
python3 - "$state" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
task = state["tasks"]["APP-CANCELME"]
assert task["status"] == "canceled", task["status"]
assert task["metadata"]["disposition.reason"] == "superseded by follow-up", task["metadata"]
assert task["metadata"]["disposition.successor"] == "APP-OPEN", task["metadata"]
obligation = state["tasks"]["APP-OBLIGATION"]
assert obligation["metadata"]["delivery.obligation-for"] == "APP-OPEN", obligation["metadata"]
assert obligation["metadata"]["delivery.transferred-from"] == "APP-CANCELME", obligation["metadata"]
assert any("Disposition: canceled" in note["body"] for note in task["notes"])
PY

# Already-canceled tasks still need a durable reason and successor/no-successor
# record. Applying the same decision again must not duplicate its note, and a
# conflicting retry must fail closed.
PATH="$fake:$PATH" "$binary" --store "$closeout_store" disposition APP-CANCEL --reason "retained historical cancellation" --no-successor --json > "$work/canceled-no-successor-dry"
assert_file_contains "$work/canceled-no-successor-dry" 'missing disposition record' "already-canceled dry-run proposes recording the missing decision"
PATH="$fake:$PATH" "$binary" --store "$closeout_store" disposition APP-CANCEL --apply --reason "retained historical cancellation" --no-successor --json > "$work/canceled-no-successor-apply"
PATH="$fake:$PATH" "$binary" --store "$closeout_store" disposition APP-CANCEL --apply --reason "retained historical cancellation" --no-successor --json > "$work/canceled-no-successor-retry"
python3 - "$state" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
task = state["tasks"]["APP-CANCEL"]
assert task["status"] == "canceled", task
assert task["metadata"]["disposition.reason"] == "retained historical cancellation", task["metadata"]
assert task["metadata"]["disposition.no-successor"] == "true", task["metadata"]
artifacts = json.loads(task["metadata"]["disposition.artifacts"])
assert artifacts[0]["path"] == "/preserved/phase-02", artifacts
assert len([note for note in task["notes"] if "Disposition: canceled" in note["body"]]) == 1, task["notes"]
PY

PATH="$fake:$PATH" "$binary" --store "$closeout_store" disposition APP-CANCEL-SUCCESSOR --apply --reason "superseded by current work" --successor APP-OPEN --json > "$work/canceled-successor-apply"
python3 - "$state" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
task = state["tasks"]["APP-CANCEL-SUCCESSOR"]
assert task["status"] == "canceled", task
assert task["metadata"]["disposition.reason"] == "superseded by current work", task["metadata"]
assert task["metadata"]["disposition.successor"] == "APP-OPEN", task["metadata"]
assert "APP-OPEN" in task["related"], task["related"]
PY

set +e
PATH="$fake:$PATH" "$binary" --store "$closeout_store" disposition APP-CANCEL --apply --reason "conflicting replacement" --no-successor --json > "$work/canceled-conflict" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "conflicting retry on an already-recorded cancellation is rejected"
assert_file_contains "$work/canceled-conflict" 'different disposition reason' "conflicting cancellation retry explains the refusal"

recovery_state=$work/recovery.json
python3 - "$recovery_state" <<'PY'
import json, sys
state = {"next": 1, "projects": {}, "tasks": {
    "DR-ORPHAN": {"id": "id-DR-ORPHAN", "ref": "DR-ORPHAN", "title": "orphan",
                  "status": "inbox", "project": "dispatcher-recovery", "metadata": {"dispatch.attempt-id": "att_missing"},
                  "notes": [], "related": [], "depends_on": [], "is_epic": False, "deleted": False, "description": ""},
    "DR-UNKNOWN": {"id": "id-DR-UNKNOWN", "ref": "DR-UNKNOWN", "title": "unknown",
                   "status": "inbox", "project": "dispatcher-recovery", "metadata": {},
                   "notes": [], "related": [], "depends_on": [], "is_epic": False, "deleted": False, "description": ""},
}}
json.dump(state, open(sys.argv[1], "w"), indent=2, sort_keys=True)
PY
AVEN_FIXTURE_STATE=$recovery_state PATH="$fake:$PATH" "$binary" --store "$closeout_store" recovery --json > "$work/recovery-inventory"
assert_file_contains "$work/recovery-inventory" '"classification": "orphan-candidate"' "recovery inventory classifies an absent attempt as a candidate"
assert_file_contains "$work/recovery-inventory" '"classification": "unknown"' "recovery inventory keeps missing identity unknown"
AVEN_FIXTURE_STATE=$recovery_state PATH="$fake:$PATH" "$binary" --store "$closeout_store" recovery --apply --task DR-ORPHAN --reason "owner absent after reviewed reset" > /dev/null
assert_eq "$(python3 - "$recovery_state" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["tasks"]["DR-ORPHAN"]["status"])
PY
)" "canceled" "recovery retirement is a preserved canceled disposition"

# ---------------------------------------------------------------------------
# Phase 5 — board proposals expose childless ideas without removing history.
# ---------------------------------------------------------------------------
PATH="$fake:$PATH" "$binary" --store "$closeout_store" board --project app --json > "$work/board"
assert_file_contains "$work/board" '"reference": "APP-EPIC"' "board proposes the childless open epic"
PATH="$fake:$PATH" "$binary" --store "$closeout_store" board --project app --apply --task APP-EPIC > /dev/null
assert_eq "$(python3 - "$state" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["tasks"]["APP-EPIC"]["is_epic"])
PY
)" "False" "board apply returns the idea to non-epic without deleting it"

# ---------------------------------------------------------------------------
# Phase 6 — audit is read-only, distinguishes violations and incomplete
# sources, and never reports a missing store as clean.
# ---------------------------------------------------------------------------
sha_before=$(sha256sum "$state" | cut -d' ' -f1)
set +e
PATH="$fake:$PATH" "$binary" --store "$closeout_store" audit --project app --repository "$repo" --json > "$work/audit-violation" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "audit exits 1 for policy violations"
assert_file_contains "$work/audit-violation" '"code": "delivery_missing"' "audit finds accepted work without delivery"
assert_file_contains "$work/audit-violation" '"code": "root_closed_with_obligations"' "audit finds a closed root with an open child obligation"
assert_file_contains "$work/audit-violation" 'retains open delivery obligation' "audit distinguishes a merged child facet from its open follow-up"
sha_after=$(sha256sum "$state" | cut -d' ' -f1)
assert_eq "$sha_after" "$sha_before" "audit leaves the Aven fixture unchanged"

clean_state=$work/clean.json
python3 - "$clean_state" <<'PY'
import json, sys
state = {"next": 1, "projects": {}, "tasks": {
    "APP-CLEAN": {"id": "id-APP-CLEAN", "ref": "APP-CLEAN", "title": "clean",
                  "status": "done", "project": "app", "metadata": {"delivery.state": "merged"},
                  "notes": [], "related": [], "depends_on": [], "is_epic": False, "deleted": False, "description": ""},
}}
json.dump(state, open(sys.argv[1], "w"), indent=2, sort_keys=True)
PY
clean_store=$work/clean.sqlite
init_store "$clean_store"
AVEN_FIXTURE_STATE=$clean_state PATH="$fake:$PATH" "$binary" --store "$clean_store" audit --project app --repository "$repo" --json > "$work/audit-clean" 2>&1
assert_file_contains "$work/audit-clean" '"complete": true' "audit reports complete coverage"

set +e
AVEN_FIXTURE_STATE=$clean_state PATH="$fake:$PATH" "$binary" --store "$work/missing.sqlite" audit --project app --repository "$repo" --json > "$work/audit-missing" 2>&1
rc=$?
set -e
assert_eq "$rc" "2" "audit exits 2 when a required source is missing"
assert_file_contains "$work/audit-missing" '"complete": false' "missing source is never reported clean"

printf 'lifecycle tests passed\n'
