#!/bin/sh
# Runs every test/*.test.sh concurrently and reports the result.
#
# Each suite already isolates its temp directories, stores, fixture state and
# sessions, so they can run at the same time. TEST_JOBS bounds the pool and
# defaults to the logical CPU count; TEST_JOBS=1 reproduces serial ordering.
set -eu

here=$(dirname "$0")
TEST_DIR=$(cd "$here" && pwd)
PLUGIN_ROOT=$(cd "$here/.." && pwd)
export PLUGIN_ROOT

jobs=${TEST_JOBS:-}
if [ -z "$jobs" ]; then
  jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)
  [ -n "$jobs" ] || jobs=$(getconf NPROCESSORS_ONLN 2>/dev/null || true)
  [ -n "$jobs" ] || jobs=4
fi
case $jobs in
  ''|*[!0-9]*|0) jobs=4 ;;
esac

logs=$(mktemp -d "${TMPDIR:-/tmp}/aven-tests.XXXXXX")
trap 'rm -rf "$logs"' EXIT HUP INT TERM
export LOGS_DIR="$logs"

set -- "$TEST_DIR"/*.test.sh
if [ ! -e "$1" ]; then
  printf '0 test file(s) passed\n'
  exit 0
fi

printf '%s\n' "$@" | xargs -P "$jobs" -n 1 sh -c '
  for test_file do
    name=$(basename "$test_file")
    if sh "$test_file" > "$LOGS_DIR/$name.out" 2>&1; then
      : > "$LOGS_DIR/$name.ok"
    else
      : > "$LOGS_DIR/$name.failed"
    fi
  done
' sh

failed=0
count=0
for test_file in "$@"; do
  [ -f "$test_file" ] || continue
  count=$((count + 1))
  name=$(basename "$test_file")
  printf '== %s\n' "$name"
  if [ -f "$logs/$name.out" ]; then
    cat "$logs/$name.out"
  fi
  if [ -f "$logs/$name.ok" ]; then
    printf '   ok\n'
  else
    printf '   FAILED\n'
    failed=$((failed + 1))
  fi
done

if [ "$failed" -eq 0 ]; then
  printf '\n%d test file(s) passed\n' "$count"
else
  printf '\n%d of %d test file(s) failed\n' "$failed" "$count"
fi
exit "$failed"
