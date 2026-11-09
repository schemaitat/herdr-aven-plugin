#!/bin/sh
# Isolated work-queue contract: ship/dispatch/plan/review/stage filtering,
# deterministic grouping, bounded truncation and a strictly read-only run.
#
# Aven is the disposable JSON fixture; no real task database, dispatcher store,
# herdr-core session or agent is read or written.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
fake=$work/bin
store=$work/dispatch.sqlite
state=$work/aven.json
repo=$work/app
mkdir -p "$fake" "$repo"

export AVEN_FIXTURE_STATE=$state
export AVEN_BIN=$fake/aven
chmod +x "$PLUGIN_ROOT/test/aven_fixture.py"

cat > "$fake/aven" <<EOF
#!/bin/sh
exec python3 "$PLUGIN_ROOT/test/aven_fixture.py" "\$@"
EOF
chmod +x "$fake/aven"

binary=$PLUGIN_ROOT/target/debug/aven-dispatch
[ -x "$binary" ] || fail "build target/debug/aven-dispatch first (just test-work builds it)"

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
    # ref: (title, status, epic, metadata, depends_on, epic_parent)
    "APP-SHIP": ("approved but undelivered", "done", False, {
        "approval.state": "approved", "approval.id": "approval-1",
        "approval.commit": "5e170dc424d1f7f791d2cf82a336b67eaefa8d2a",
        "approval.workflow": "implementation",
    }, [], None),
    "APP-DELIVERED": ("delivered result", "done", False, {
        "approval.state": "approved", "approval.id": "approval-2",
        "approval.commit": "193a9f51ed5cde7ca5582e85f586aa12f9e73269",
        "delivery.state": "merged",
    }, [], None),
    "APP-CANCEL": ("canceled idea", "canceled", False, {}, [], None),
    "APP-READY": ("ready to dispatch", "todo", False, {}, [], None),
    "APP-READY2": ("second ready task", "todo", False, {}, [], None),
    "APP-BLOCKED": ("blocked by a dependency", "todo", False, {}, ["APP-READY"], None),
    "APP-ACTIVE": ("already active", "active", False, {}, [], None),
    "APP-PLAN": ("epic without a plan", "todo", True, {}, [], None),
    "APP-UNPLANNED": ("child of an unplanned epic", "todo", False, {}, [], "APP-PLAN"),
    "APP-PLANNED": ("worked-out epic", "todo", True, {
        "sdd.plan-worked-out": "true", "sdd.plan-kind": "multi-phase",
        "sdd.plan-schema": "v1",
    }, [], None),
    "APP-PLANCHILD": ("implementable phase", "todo", False, {}, [], "APP-PLANNED"),
}
state = {"next": 100, "projects": {}, "tasks": {}}
for ref, (title, status, epic, metadata, depends_on, parent) in tasks.items():
    state["tasks"][ref] = {
        "id": f"id-{ref}", "ref": ref, "title": title, "status": status,
        "priority": "none", "deleted": False, "is_epic": epic, "project": "app",
        "description": "", "metadata": metadata, "notes": [], "related": [],
        "depends_on": depends_on,
    }
    if parent:
        state["tasks"][ref]["epic_parent"] = parent
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(state, handle, indent=2, sort_keys=True)
PY
}
seed_state

run_work() {
  PATH="$fake:$PATH" "$binary" --store "$store" work --project app "$@"
}

state_sha() {
  sha256sum "$state" | cut -d' ' -f1
}

before=$(state_sha)

# ---------------------------------------------------------------------------
# Phase 1 — the full report classifies every lifecycle stage deterministically.
# ---------------------------------------------------------------------------
run_work --json > "$work/report.json"
python3 - "$work/report.json" <<'PY'
import json, sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
assert report["schema"] == "aven-dispatch-work/v1", report["schema"]
assert report["scope"]["project"] == "app", report["scope"]
assert report["truncated"] is False, report["truncated"]
counts = report["counts"]
expected = {
    "land": 1, "dispatch": 3, "plan": 1, "waiting": 1, "blocked": 2,
    "done": 2, "working": 1, "review": 0, "unknown": 0,
}
assert counts == expected, (counts, expected)
assert [group["id"] for group in report["stages"]] == [
    "land", "review", "dispatch", "plan", "working", "waiting", "blocked", "unknown", "done",
], [group["id"] for group in report["stages"]]
cards = {card["ref"]: card for group in report["stages"] for card in group["cards"]}
assert cards["APP-SHIP"]["stage"] == "land"
assert cards["APP-SHIP"]["action"] == "merge"
assert cards["APP-SHIP"]["reason"] == "approved_not_delivered"
assert cards["APP-SHIP"]["column"] == "ready"
assert cards["APP-SHIP"]["approval"]["commit"].startswith("5e170dc4")
assert cards["APP-DELIVERED"]["stage"] == "done"
assert cards["APP-DELIVERED"]["reason"] == "delivery_settled"
assert cards["APP-CANCEL"]["stage"] == "done"
assert cards["APP-CANCEL"]["reason"] == "canceled"
assert cards["APP-READY"]["stage"] == "dispatch"
assert cards["APP-READY"]["action"] == "dispatch"
assert cards["APP-READY"]["column"] == "backlog"
assert cards["APP-PLANCHILD"]["stage"] == "dispatch"
assert cards["APP-BLOCKED"]["stage"] == "blocked"
assert cards["APP-BLOCKED"]["reason"] == "dependency_open"
assert cards["APP-UNPLANNED"]["stage"] == "blocked"
assert cards["APP-UNPLANNED"]["reason"] == "plan_not_worked_out"
assert cards["APP-PLAN"]["stage"] == "plan"
assert cards["APP-PLAN"]["action"] == "plan"
assert cards["APP-PLANNED"]["stage"] == "waiting"
assert cards["APP-PLANNED"]["reason"] == "awaiting_phases"
assert cards["APP-ACTIVE"]["stage"] == "working"
assert cards["APP-ACTIVE"]["reason"] == "aven_active"
PY

# ---------------------------------------------------------------------------
# Phase 2 — stage selection is repeatable and keeps empty selected groups.
# ---------------------------------------------------------------------------
run_work --stage land --json > "$work/land.json"
python3 - "$work/land.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert [group["id"] for group in report["stages"]] == ["land"]
assert report["counts"] == {"land": 1}, report["counts"]
assert report["stages"][0]["cards"][0]["ref"] == "APP-SHIP"
PY

run_work --stage dispatch --stage plan --json > "$work/multi.json"
python3 - "$work/multi.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert [group["id"] for group in report["stages"]] == ["dispatch", "plan"]
assert report["counts"] == {"dispatch": 3, "plan": 1}, report["counts"]
PY

run_work --stage review --json > "$work/review.json"
python3 - "$work/review.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert [group["id"] for group in report["stages"]] == ["review"]
assert report["counts"] == {"review": 0}, report["counts"]
assert report["stages"][0]["cards"] == []
PY

# ---------------------------------------------------------------------------
# Phase 3 — truncation is explicit and per-stage counts stay truthful.
# ---------------------------------------------------------------------------
run_work --stage dispatch --limit 1 --json > "$work/limited.json"
python3 - "$work/limited.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert report["truncated"] is True
assert report["card_limit"] == 1
assert report["counts"] == {"dispatch": 3}, report["counts"]
assert len(report["stages"][0]["cards"]) == 1
assert any("3 dispatch cards" in warning for warning in report["warnings"]), report["warnings"]
PY

# ---------------------------------------------------------------------------
# Phase 4 — human output and scope inference use the same report.
# ---------------------------------------------------------------------------
run_work > "$work/human.txt"
assert_file_contains "$work/human.txt" "land (ready) 1" "human output names the ship stage"
assert_file_contains "$work/human.txt" "APP-SHIP [merge] approved_not_delivered" "human output names the next action"
assert_file_contains "$work/human.txt" "dispatch (backlog) 3" "human output counts dispatch work"

PATH="$fake:$PATH" "$binary" --store "$store" work --cwd "$repo" --stage land --json > "$work/inferred.json"
python3 - "$work/inferred.json" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
assert report["scope"]["project"] == "app", report["scope"]["project"]
assert report["scope"]["project_source"] == "inferred", report["scope"]["project_source"]
assert report["counts"] == {"land": 1}, report["counts"]
PY

# ---------------------------------------------------------------------------
# Phase 5 — invalid limits fail closed and every run leaves Aven untouched.
# ---------------------------------------------------------------------------
if PATH="$fake:$PATH" "$binary" --store "$store" work --project app --limit 0 > "$work/invalid.out" 2>&1; then
  fail "work --limit 0 should fail"
fi
assert_file_contains "$work/invalid.out" "between 1 and 500" "invalid limit is explained"

after=$(state_sha)
assert_eq "$after" "$before" "work must not mutate Aven"

printf 'work-queue contract passed\n'
