#!/bin/sh
# Test manifest coverage and dependency resolution. This suite keeps every
# test/*.test.sh classified exactly once, assigns a module, validates the DAG
# and tiers, and pins the default selector to the fast unit tier.
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

while IFS='|' read -r name tier deps files modules description; do
  [ -n "$name" ] || fail 'suite with an empty name'
  case $tier in
    unit|extended|integration) ;;
    *) fail "suite $name has invalid tier: $tier" ;;
  esac
  [ -n "$description" ] || fail "suite $name has no description"
  [ -n "$modules" ] || fail "suite $name has no modules"
  printf '%s\n' "$modules" | tr ',' '\n' > "$work/modules"
  while IFS= read -r module_name; do
    [ -n "$module_name" ] || fail "suite $name has an empty module"
    case $module_name in
      *[!a-z0-9-]*) fail "suite $name has invalid module: $module_name" ;;
    esac
  done < "$work/modules"
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

# all runs every unit suite before extended suites, and extended before
# integration.
awk -F'|' '$2 == "unit" && $4 != "" {print $1}' "$work/rows" > "$work/unit-names"
awk -F'|' '$2 == "extended" && $4 != "" {print $1}' "$work/rows" > "$work/extended-names"
awk -F'|' '$2 == "integration" && $4 != "" {print $1}' "$work/rows" > "$work/integration-names"
seen_extended=0
seen_integration=0
while IFS= read -r name; do
  if grep -qxF "$name" "$work/integration-names"; then
    seen_integration=1
  elif grep -qxF "$name" "$work/extended-names"; then
    [ "$seen_integration" -eq 0 ] || fail "extended suite ran after integration: $name"
    seen_extended=1
  elif grep -qxF "$name" "$work/unit-names"; then
    [ "$seen_extended" -eq 0 ] || fail "unit suite ran after extended: $name"
  else
    fail "all selector returned unknown suite: $name"
  fi
done < "$work/all"

# The default tier stays fast: no extended or integration suite is selected.
for name in $(cat "$work/extended-names" "$work/integration-names"); do
  ! grep -qxF "$name" "$work/default" || fail "default tier included slow suite: $name"
done

# Module selectors expand to every suite that lists the module, across tiers.
sh "$runner" --dry-run module:install > "$work/module-install"
for name in install-app-mod install-aven-command install-opencode-command install-skill; do
  grep -qxF "$name" "$work/module-install" || fail "module:install omitted $name"
done
sh "$runner" --dry-run module:dispatch > "$work/module-dispatch"
for name in approval board-delete dispatch lifecycle message summary work; do
  grep -qxF "$name" "$work/module-dispatch" || fail "module:dispatch omitted $name"
done
if sh "$runner" --dry-run module:no-such-module >/dev/null 2>&1; then
  fail 'unknown module was accepted'
fi

# Rust-only modules are valid selectors even without a shell suite.
rust_modules=$PLUGIN_ROOT/test/rust-modules.txt
[ -f "$rust_modules" ] || fail 'missing test/rust-modules.txt'
for module_name in $(grep -v '^[[:space:]]*#' "$rust_modules" | sed '/^[[:space:]]*$/d'); do
  case $module_name in
    *[!a-z0-9-]*) fail "rust module has invalid name: $module_name" ;;
  esac
done
sh "$runner" --dry-run module:store > "$work/rust-module"
grep -q '0 suite(s) selected' "$work/rust-module" || \
  fail 'rust-only module store resolved shell suites'

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
