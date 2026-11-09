#!/bin/sh
# Scoped test runner driven by test/suites.txt.
#
# Selectors:
#   unit          fast unit/contract tier (the default)
#   integration   heavy process/Git fixtures
#   all           unit suites, then integration suites
#   <suite>...    named suites from the manifest, dependencies first
#
# Options:
#   --list        show suites by tier, dependencies and files
#   --dry-run     print the resolved execution order without running anything
#   --help        show this help
#
# TEST_JOBS bounds the parallel pool (default: logical CPU count).
# TEST_BUDGET_SECONDS fails the run when suite execution exceeds the budget.
# The budget covers suite execution after binaries are built, not compilation.
set -eu

here=$(dirname "$0")
TEST_DIR=$(cd "$here" && pwd)
PLUGIN_ROOT=$(cd "$here/.." && pwd)
export PLUGIN_ROOT
MANIFEST=$TEST_DIR/suites.txt
SELF=$TEST_DIR/$(basename "$0")

selected=
ordered=
pending=
next=
execution=
logs=

cleanup() {
  [ -z "$logs" ] || rm -rf "$logs"
  [ -z "$selected" ] || rm -f "$selected"
  [ -z "$ordered" ] || rm -f "$ordered"
  [ -z "$pending" ] || rm -f "$pending"
  [ -z "$next" ] || rm -f "$next"
  [ -z "$execution" ] || rm -f "$execution"
}
trap cleanup EXIT HUP INT TERM

die() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 2
}

usage() {
  cat <<'EOF'
Usage: test/run.sh [--list|--dry-run|--help] [selector...]

Selectors:
  unit          fast unit/contract tier (default)
  integration   heavy approval, dispatch and lifecycle fixtures
  all           every unit suite, then every integration suite
  <suite>...    named suites from test/suites.txt, dependencies first

Options:
  --list        list suites, tiers, dependencies and files
  --dry-run     print the resolved execution order without running
  --help        show this help

Environment:
  TEST_JOBS            parallel suite limit (default: logical CPU count)
  TEST_BUDGET_SECONDS  fail when suite execution exceeds this many seconds
EOF
}

if [ ! -f "$MANIFEST" ]; then
  die "missing suite manifest: $MANIFEST"
fi

manifest_rows() {
  awk -F'|' '!/^[[:space:]]*#/ && !/^[[:space:]]*$/ {print}' "$MANIFEST"
}

row_for() {
  manifest_rows | awk -F'|' -v n="$1" '$1 == n {print; exit}'
}

suite_exists() {
  [ -n "$(row_for "$1")" ]
}

suite_field() {
  _row=$(row_for "$1")
  [ -n "$_row" ] || return 1
  printf '%s\n' "$_row" | awk -F'|' -v f="$2" '{print $f}'
}

add_unique() {
  _name=$1
  if ! grep -qxF "$_name" "$selected"; then
    printf '%s\n' "$_name" >> "$selected"
  fi
}

add_tier() {
  _tier=$1
  for _suite in $(manifest_rows | awk -F'|' -v t="$_tier" '$2 == t {print $1}'); do
    add_unique "$_suite"
  done
}

run_one() {
  _suite=$1
  suite_exists "$_suite" || die "unknown suite: $_suite"
  _files=$(suite_field "$_suite" 4)
  [ -n "$_files" ] || return 0
  _old_ifs=$IFS
  IFS=','
  for _file in $_files; do
    IFS=$_old_ifs
    [ -n "$_file" ] || { IFS=','; continue; }
    [ -f "$TEST_DIR/$_file" ] || die "missing test file: $TEST_DIR/$_file"
    if ! sh "$TEST_DIR/$_file"; then
      IFS=$_old_ifs
      return 1
    fi
    IFS=','
  done
  IFS=$_old_ifs
}

list_suites() {
  for _tier in unit integration; do
    printf '%s:\n' "$_tier"
    manifest_rows | awk -F'|' -v t="$_tier" '$2 == t {
      deps = ($3 == "" ? "-" : $3)
      files = ($4 == "" ? "(group)" : $4)
      printf "  %-26s deps=%-52s %s\n", $1, deps, files
    }'
  done
  printf '\nselectors: all, unit, integration, or any suite name\n'
}

prepare_selection() {
  : > "$selected"
  for _sel in $selector_args; do
    case $_sel in
      all)
        add_tier unit
        add_tier integration
        ;;
      unit|integration)
        add_tier "$_sel"
        ;;
      *)
        suite_exists "$_sel" || die "unknown suite: $_sel (try --list)"
        add_unique "$_sel"
        ;;
    esac
  done

  # Expand dependencies until every referenced suite is selected.
  _changed=1
  while [ "$_changed" -eq 1 ]; do
    _changed=0
    while IFS= read -r _name; do
      _deps=$(suite_field "$_name" 3) || _deps=
      [ -n "$_deps" ] || continue
      _old_ifs=$IFS
      IFS=','
      for _dep in $_deps; do
        IFS=$_old_ifs
        [ -n "$_dep" ] || { IFS=','; continue; }
        suite_exists "$_dep" || die "suite $_name depends on unknown suite: $_dep"
        if ! grep -qxF "$_dep" "$selected"; then
          printf '%s\n' "$_dep" >> "$selected"
          _changed=1
        fi
        IFS=','
      done
      IFS=$_old_ifs
    done < "$selected"
  done
}

order_selection() {
  : > "$ordered"
  cp "$selected" "$pending"
  while [ -s "$pending" ]; do
    : > "$next"
    _before=$(wc -l < "$ordered" | tr -d ' ')
    while IFS= read -r _name; do
      _deps=$(suite_field "$_name" 3) || _deps=
      _ready=1
      if [ -n "$_deps" ]; then
        _old_ifs=$IFS
        IFS=','
        for _dep in $_deps; do
          IFS=$_old_ifs
          [ -n "$_dep" ] || { IFS=','; continue; }
          if ! grep -qxF "$_dep" "$ordered"; then
            _ready=0
          fi
          IFS=','
        done
        IFS=$_old_ifs
      fi
      if [ "$_ready" -eq 1 ]; then
        printf '%s\n' "$_name" >> "$ordered"
      else
        printf '%s\n' "$_name" >> "$next"
      fi
    done < "$pending"
    mv "$next" "$pending"
    _after=$(wc -l < "$ordered" | tr -d ' ')
    if [ "$_after" -eq "$_before" ]; then
      die "dependency cycle among: $(tr '\n' ' ' < "$pending")"
    fi
  done
}

# Internal mode used by the parallel workers; do not select it directly.
if [ "${1:-}" = "--run-one" ]; then
  [ $# -eq 2 ] || die "usage: $0 --run-one <suite>"
  run_one "$2"
  exit 0
fi

mode=run
selector_args=
for _arg in "$@"; do
  case $_arg in
    --list) mode=list ;;
    --dry-run) mode=dry-run ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $_arg" ;;
    *) selector_args="$selector_args $_arg" ;;
  esac
done

if [ "$mode" = list ]; then
  list_suites
  exit 0
fi

[ -n "$selector_args" ] || selector_args=unit

selected=$(mktemp "${TMPDIR:-/tmp}/aven-suite-selected.XXXXXX")
ordered=$(mktemp "${TMPDIR:-/tmp}/aven-suite-order.XXXXXX")
pending=$(mktemp "${TMPDIR:-/tmp}/aven-suite-pending.XXXXXX")
next=$(mktemp "${TMPDIR:-/tmp}/aven-suite-next.XXXXXX")
execution=$(mktemp "${TMPDIR:-/tmp}/aven-suite-exec.XXXXXX")
logs=$(mktemp -d "${TMPDIR:-/tmp}/aven-tests.XXXXXX")
export LOGS_DIR="$logs" TEST_RUNNER="$SELF"

prepare_selection
order_selection

: > "$execution"
while IFS= read -r _name; do
  _files=$(suite_field "$_name" 4) || _files=
  [ -n "$_files" ] || continue
  printf '%s\n' "$_name" >> "$execution"
done < "$ordered"

count=$(wc -l < "$execution" | tr -d ' ')
if [ "$count" -eq 0 ]; then
  printf '0 suite(s) selected\n'
  exit 0
fi

if [ "$mode" = dry-run ]; then
  cat "$execution"
  exit 0
fi

jobs=${TEST_JOBS:-}
if [ -z "$jobs" ]; then
  jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || true)
  [ -n "$jobs" ] || jobs=$(getconf NPROCESSORS_ONLN 2>/dev/null || true)
  [ -n "$jobs" ] || jobs=4
fi
case $jobs in
  ''|*[!0-9]*|0) jobs=4 ;;
esac

started=$(date +%s)
xargs -P "$jobs" -n 1 sh -c '
  suite=$1
  start=$(date +%s)
  if sh "$TEST_RUNNER" --run-one "$suite" > "$LOGS_DIR/$suite.out" 2>&1; then
    status=ok
  else
    status=failed
  fi
  end=$(date +%s)
  printf "%s %s %s\n" "$suite" "$status" "$((end - start))" > "$LOGS_DIR/$suite.meta"
' sh < "$execution"
total=$(( $(date +%s) - started ))

failed=0
while IFS= read -r _name; do
  _meta="$logs/$_name.meta"
  _status=missing
  _secs=0
  if [ -f "$_meta" ]; then
    read -r _ignored _status _secs < "$_meta"
  fi
  printf '== %s (%ss)\n' "$_name" "$_secs"
  if [ -f "$logs/$_name.out" ]; then
    cat "$logs/$_name.out"
  fi
  if [ "$_status" = ok ]; then
    printf '   ok\n'
  else
    printf '   FAILED\n'
    failed=$((failed + 1))
  fi
done < "$execution"

budget=${TEST_BUDGET_SECONDS:-}
if [ -n "$budget" ]; then
  case $budget in
    *[!0-9]*) die "TEST_BUDGET_SECONDS must be a whole number, got: $budget" ;;
  esac
  if [ "$total" -gt "$budget" ]; then
    printf '\nFAIL: suite execution took %ss, over the %ss budget\n' "$total" "$budget" >&2
    failed=$((failed + 1))
  fi
fi

if [ "$failed" -eq 0 ]; then
  if [ -n "$budget" ]; then
    printf '\n%d suite(s) passed in %ss (budget %ss)\n' "$count" "$total" "$budget"
  else
    printf '\n%d suite(s) passed in %ss\n' "$count" "$total"
  fi
else
  printf '\n%d of %d suite(s) failed in %ss\n' "$failed" "$count" "$total"
fi
exit "$failed"
