#!/bin/sh
# Test helpers. Sourced by the *.test.sh files under test/.
set -eu

here=$(dirname "$0")
TEST_DIR=$(cd "$here" && pwd)
PLUGIN_ROOT=${PLUGIN_ROOT:-$(cd "$here/.." && pwd)}
export PLUGIN_ROOT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected [$2], got [$1] (${3:-})"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "[$1] does not contain [$2] (${3:-})" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "[$1] unexpectedly contains [$2] (${3:-})" ;;
    *) ;;
  esac
}

assert_file_contains() {
  assert_contains "$(cat "$1")" "$2" "${3:-$1}"
}

assert_file_lacks() {
  assert_not_contains "$(cat "$1")" "$2" "${3:-$1}"
}

# sqlite_json DB: render the central store's attempt payloads as JSON.
sqlite_json() {
  python3 - "$1" <<'PY'
import json, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
try:
    rows = [json.loads(row[0]) for row in connection.execute(
        "SELECT payload FROM attempts ORDER BY created_at, task_id, workflow")]
finally:
    connection.close()
print(json.dumps({"attempts": {
    f"{attempt['task_id']}:{attempt.get('workflow', 'default')}": attempt
    for attempt in rows
}}, indent=2))
PY
}

# sqlite_count DB: number of attempt rows in the central store.
sqlite_count() {
  python3 - "$1" <<'PY'
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
try:
    print(connection.execute("SELECT count(*) FROM attempts").fetchone()[0])
finally:
    connection.close()
PY
}

# mkworkdir: a fresh scratch directory that the test owns.
mkworkdir() {
  dir=${TMPDIR:-/tmp}/aven.tasks.test.$$
  mkdir -p "$dir"
  printf '%s' "$dir"
}
