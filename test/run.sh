#!/bin/sh
# Runs every test/*.test.sh and reports the result.
set -eu

here=$(dirname "$0")
TEST_DIR=$(cd "$here" && pwd)
PLUGIN_ROOT=$(cd "$here/.." && pwd)
export PLUGIN_ROOT

failed=0
count=0
for test_file in "$TEST_DIR"/*.test.sh; do
  [ -f "$test_file" ] || continue
  count=$((count + 1))
  name=$(basename "$test_file")
  printf '== %s\n' "$name"
  if sh "$test_file"; then
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
