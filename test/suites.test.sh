#!/bin/sh
# Test manifest coverage and dependency resolution. This suite keeps every
# test/*.test.sh classified exactly once, validates the DAG, and pins the
# default selector to the fast unit tier.
set -eu
. "$(dirname "$0")/helpers.sh"

manifest=$PLUGIN_ROOT/test/suites.txt
runner=$PLUGIN_ROOT/test/run.sh
work=$(mkworkdir)

[ -f "$manifest" ] || fail 'missing test/suites.txt'
[ -x "$runner" ] || fail 'test/run.sh is not executable'

# Every shell suite is classified exactly once.
for file in "$PLUGIN_ROOT"/test/*.test.sh; do
  base=$(basename "$file")
  count=$(awk -F'|' -v file="$base" '
    !/^[[:space:]]*#/ && !/^[[:space:]]*$/ {
      n = split($4, files, ",")
      for (i = 1; i <= n; i++) if (files[i] == file) count++
    }
    END { print count + 0 }
  ' "$manifest")
  assert_eq "$count" "1" "suite manifest classification for $base"
done

# Every referenced file exists, every suite name is unique, and every tier and
# dependency is valid.
awk -F'|' '!/^[[:space:]]*#/ && !/^[[:space:]]*$/ {print}' "$manifest" > "$work/rows"
[ -s "$work/rows" ] || fail 'suite manifest has no suites'

cut -d'|' -f1 "$work/rows" > "$work/names"
dups=$(sort "$work/names" | uniq -d)
[ -z "$dups" ] || fail "duplicate suite names: $dups"

while IFS='|' read -r name tier deps files description; do
  [ -n "$name" ] || fail 'suite with an empty name'
  case $tier in
    unit|integration) ;;
    *) fail "suite $name has invalid tier: $tier" ;;
  esac
  [ -n "$description" ] || fail "suite $name has no description"
  if [ -n "$files" ]; then
    printf '%s\n' "$files" | tr ',' '\n' > "$work/files"
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      [ -f "$PLUGIN_ROOT/test/$file" ] || fail "suite $name references missing file: $file"
    done < "$work/files"
  fi
  if [ -n "$deps" ]; then
    printf '%s\n' "$deps" | tr ',' '\n' > "$work/deps"
    while IFS= read -r dep; do
      [ -n "$dep" ] || continue
      grep -qxF "$dep" "$work/names" || fail "suite $name depends on unknown suite: $dep"
    done < "$work/deps"
  fi
done < "$work/rows"

# Resolving everything proves the DAG is acyclic.
sh "$runner" --dry-run all > "$work/all"
[ -s "$work/all" ] || fail 'all selector resolved no suites'
for name in $(cat "$work/names"); do
  awk -F'|' -v n="$name" '$1 == n && $4 != "" {found=1} END {exit !found}' "$work/rows" || continue
  grep -qxF "$name" "$work/all" || fail "all selector omitted suite: $name"
done

# The default selector is the unit tier.
sh "$runner" --dry-run > "$work/default"
sh "$runner" --dry-run unit > "$work/unit"
cmp -s "$work/default" "$work/unit" || fail 'default selector is not the unit tier'

# all runs every unit suite before the first integration suite.
awk -F'|' '$2 == "unit" && $4 != "" {print $1}' "$work/rows" > "$work/unit-names"
awk -F'|' '$2 == "integration" && $4 != "" {print $1}' "$work/rows" > "$work/integration-names"
seen_integration=0
while IFS= read -r name; do
  if grep -qxF "$name" "$work/integration-names"; then
    seen_integration=1
  elif grep -qxF "$name" "$work/unit-names"; then
    [ "$seen_integration" -eq 0 ] || fail "unit suite ran after integration: $name"
  else
    fail "all selector returned unknown suite: $name"
  fi
done < "$work/all"

# Aggregate groups expand to their dependencies and have no executable body.
sh "$runner" --dry-run install > "$work/install"
for dep in install-app-mod install-aven-command install-opencode-command install-skill; do
  grep -qxF "$dep" "$work/install" || fail "install selector omitted $dep"
done
if grep -qxF install "$work/install"; then
  fail 'aggregate install suite must not have an executable body'
fi

# Unknown suites fail instead of silently running nothing.
if sh "$runner" no-such-suite >/dev/null 2>&1; then
  fail 'unknown suite was accepted'
fi

# Discovery lists every suite name.
sh "$runner" --list > "$work/list"
for name in $(cat "$work/names"); do
  grep -q "^  $name " "$work/list" || fail "test-list omitted suite: $name"
done

printf 'test suites ok\n'
