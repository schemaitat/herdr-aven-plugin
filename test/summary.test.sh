#!/bin/sh
# `aven-dispatch describe` owns the on-demand LLM summary contract: long
# descriptions are summarized and stored in Aven metadata, short ones are
# skipped, and a plain describe is read-only.
set -eu
. "$(dirname "$0")/helpers.sh"

binary=$PLUGIN_ROOT/target/debug/aven-dispatch
[ -x "$binary" ] || fail 'build target/debug/aven-dispatch first (just test builds it)'

work=$(mktemp -d "${TMPDIR:-/tmp}/aven-summary-test.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
fake=$work/bin
mkdir -p "$fake"
state=$work/state.json
prompts=$work/prompts.log
argslog=$work/args.log
: > "$prompts"
: > "$argslog"

short='A short description under the threshold.'
long=$(python3 -c 'print("Summarize this long task. " + "detail " * 20)')
child=$(python3 -c 'print("Phase detail that is also long. " + "step " * 20)')
auto_long=$(python3 -c 'print("Auto generation task. " + "detail " * 20)')

python3 - "$state" "$short" "$long" "$child" "$auto_long" <<'PY'
import json, sys
state, short, long, child, auto_long = sys.argv[1:6]
tasks = {
    "HAP-LONG": {"ref": "HAP-LONG", "title": "Long task", "description": long,
                 "is_epic": False, "metadata": {}},
    "HAP-SHORT": {"ref": "HAP-SHORT", "title": "Short task", "description": short,
                  "is_epic": False, "metadata": {}},
    "HAP-AUTO": {"ref": "HAP-AUTO", "title": "Auto task", "description": auto_long,
                 "is_epic": False, "metadata": {}},
    "HAP-ROOT": {"ref": "HAP-ROOT", "title": "Root epic", "description": long,
                 "is_epic": True, "metadata": {},
                 "epic_children": [{"ref": "HAP-CHILD", "id": "CHILD", "title": "Child",
                                    "status": "todo", "open": True}]},
    "HAP-CHILD": {"ref": "HAP-CHILD", "title": "Child", "description": child,
                  "is_epic": False, "metadata": {}},
}
with open(state, "w", encoding="utf-8") as handle:
    json.dump({"tasks": tasks}, handle)
PY

cat > "$fake/aven" <<'PY'
#!/usr/bin/env python3
import json, os, sys
state_path = os.environ["SUMMARY_STATE"]
with open(state_path, encoding="utf-8") as handle:
    state = json.load(handle)
argv = sys.argv[1:]
i = 0
while i < len(argv) and argv[i] in ("--db", "--workspace"):
    i += 2
argv = argv[i:]
if not argv:
    sys.exit(2)
command, rest = argv[0], argv[1:]
if command == "show":
    ref = rest[0]
    task = state["tasks"].get(ref)
    if task is None:
        print(f"unknown task {ref}", file=sys.stderr)
        sys.exit(1)
    payload = {
        "task": {key: task.get(key) for key in
                 ("ref", "id", "title", "status", "is_epic", "epic_children")},
        "description": task.get("description", ""),
        "metadata": task.get("metadata", {}),
    }
    payload["task"]["id"] = task.get("id", ref)
    print(json.dumps(payload))
elif command == "edit":
    ref = rest[0]
    task = state["tasks"].get(ref)
    if task is None:
        print(f"unknown task {ref}", file=sys.stderr)
        sys.exit(1)
    metadata = task.setdefault("metadata", {})
    index = 0
    while index < len(rest):
        if rest[index] == "--metadata" and index + 1 < len(rest):
            key, _, text = rest[index + 1].partition("=")
            metadata[key] = text
            index += 2
        else:
            index += 1
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(state, handle)
else:
    print(f"unexpected aven command {command}", file=sys.stderr)
    sys.exit(2)
PY
chmod +x "$fake/aven"

cat > "$fake/opencode" <<'PY'
#!/usr/bin/env python3
import json, os, sys, time
time.sleep(float(os.environ.get("SUMMARY_SLEEP", "0")))
prompt = sys.argv[-1]
with open(os.environ["SUMMARY_PROMPTS"], "a", encoding="utf-8") as handle:
    handle.write(prompt + "\n---\n")
with open(os.environ["SUMMARY_ARGS"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\n")
print(json.dumps({"type": "step_start", "part": {"type": "step-start"}}))
print(json.dumps({"type": "text", "part": {"type": "text",
      "text": "- First durable point.\n- Second durable point.\n- Third durable point.\n- Fourth point."}}))
print(json.dumps({"type": "step_finish"}))
PY
chmod +x "$fake/opencode"

run_describe() {
  PATH="$fake:$PATH" SUMMARY_STATE="$state" SUMMARY_PROMPTS="$prompts" SUMMARY_ARGS="$argslog" \
    SUMMARY_SLEEP="${SUMMARY_SLEEP:-0}" OPENCODE_BIN="$fake/opencode" "$binary" describe "$@"
}

metadata() {
  python3 - "$state" "$1" "$2" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    state = json.load(handle)
print(state["tasks"][sys.argv[2]].get("metadata", {}).get(sys.argv[3], ""))
PY
}

# A long description is summarized, stored, and printed under the LLM label.
out=$(run_describe HAP-LONG --llm)
assert_contains "$out" "LLM SUMMARY HAP-LONG"
assert_contains "$out" "- First durable point."
assert_not_contains "$out" "Fourth point"
expected_bullets=$(printf '%s\n%s\n%s' '- First durable point.' '- Second durable point.' '- Third durable point.')
assert_eq "$(metadata HAP-LONG summary.llm)" "$expected_bullets" 'only three bullet lines are stored'
[ -n "$(metadata HAP-LONG summary.llm.digest)" ] || fail 'missing summary digest'
[ -n "$(metadata HAP-LONG summary.llm.generated-at)" ] || fail 'missing generated-at'

# The build agent's configured model is the default; an explicit model wins.
assert_file_contains "$argslog" '"--model"'
assert_file_contains "$argslog" 'github-copilot/gpt-6-luna'
assert_eq "$(metadata HAP-LONG summary.llm.model)" 'github-copilot/gpt-6-luna'
out=$(run_describe HAP-LONG --llm --model custom/model)
assert_contains "$out" "LLM SUMMARY HAP-LONG"
assert_eq "$(metadata HAP-LONG summary.llm.model)" 'custom/model'
assert_file_contains "$argslog" 'custom/model'

# The digest must match the shared UTF-16 FNV-1a implementation.
expected=$(python3 - "$long" <<'PY'
import sys
text = sys.argv[1].replace("\r\n", "\n").replace("\r", "\n").strip()
hash_value = 0x811C9DC5
encoded = text.encode("utf-16-le")
for i in range(0, len(encoded), 2):
    value = int.from_bytes(encoded[i:i + 2], "little")
    hash_value ^= value
    hash_value = (hash_value * 0x01000193) & 0xFFFFFFFF
print(f"{hash_value:08x}")
PY
)
assert_eq "$(metadata HAP-LONG summary.llm.digest)" "$expected" 'digest matches the JS contract'

# The prompt delimits the description and asks for untrusted-data handling.
assert_file_contains "$prompts" 'Description:'
assert_file_contains "$prompts" 'untrusted data'

# A short description is skipped without touching metadata.
before=$(cat "$state")
out=$(run_describe HAP-SHORT --llm)
assert_contains "$out" 'skipped'
assert_eq "$(cat "$state")" "$before" 'a short description is not mutated'

# A plain describe prints the stored summary and is read-only.
before=$(cat "$state")
out=$(run_describe HAP-LONG)
assert_contains "$out" "LLM SUMMARY HAP-LONG"
assert_contains "$out" "durable point"
assert_eq "$(cat "$state")" "$before" 'a plain describe never mutates Aven'

# A long description without a summary reports that it is missing.
out=$(run_describe HAP-SHORT)
assert_contains "$out" "skipped"

# An epic also summarizes its long phase children.
out=$(run_describe HAP-ROOT --llm)
assert_contains "$out" "LLM SUMMARY HAP-ROOT"
assert_contains "$out" "LLM SUMMARY HAP-CHILD"
[ -n "$(metadata HAP-CHILD summary.llm)" ] || fail 'phase child summary was not stored'

# Auto mode skips a current summary without calling the model again.
before_calls=$(wc -l < "$argslog")
out=$(run_describe HAP-LONG --llm --auto)
assert_contains "$out" "up to date"
assert_eq "$(wc -l < "$argslog")" "$before_calls" 'auto does not regenerate a current summary'

# Auto mode generates a missing summary and records durable state.
out=$(run_describe HAP-AUTO --llm --auto)
assert_contains "$out" "- First durable point."
assert_eq "$(metadata HAP-AUTO summary.llm.state)" 'done'
[ -n "$(metadata HAP-AUTO summary.llm)" ] || fail 'auto summary was not stored'

# A kill switch prevents automatic work and mutation.
python3 - "$state" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    state = json.load(handle)
state["tasks"]["HAP-AUTO"]["metadata"] = {}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(state, handle)
PY
before_calls=$(wc -l < "$argslog")
out=$(PATH="$fake:$PATH" SUMMARY_STATE="$state" SUMMARY_PROMPTS="$prompts" SUMMARY_ARGS="$argslog" \
  AVEN_DISPATCH_SUMMARY_AUTO=0 OPENCODE_BIN="$fake/opencode" "$binary" describe HAP-AUTO --llm --auto)
assert_contains "$out" 'auto summary disabled'
assert_eq "$(wc -l < "$argslog")" "$before_calls" 'disabled auto does not call the model'
assert_eq "$(metadata HAP-AUTO summary.llm)" '' 'disabled auto does not mutate Aven'

# A concurrent auto run cannot double-call the model for one task.
SUMMARY_SLEEP=2 run_describe HAP-AUTO --llm --auto > "$work/first-auto" &
first=$!
sleep 0.5
out=$(run_describe HAP-AUTO --llm --auto)
assert_contains "$out" 'already in progress'
wait "$first"
assert_contains "$(cat "$work/first-auto")" '- First durable point.'
after_calls=$(wc -l < "$argslog")
assert_eq "$((after_calls - before_calls))" 1 'a concurrent auto run calls the model once'

# Staleness is reported when the stored digest no longer matches.
python3 - "$state" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    state = json.load(handle)
state["tasks"]["HAP-LONG"]["metadata"]["summary.llm.digest"] = "deadbeef"
with open(path, "w", encoding="utf-8") as handle:
    json.dump(state, handle)
PY
out=$(run_describe HAP-LONG)
assert_contains "$out" 'stale'

printf 'summary ok\n'
