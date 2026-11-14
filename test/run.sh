#!/bin/sh
# Scoped test runner driven by test/suites.txt.
#
# Selectors:
#   unit          fast unit/contract tier (the default)
#   extended      slower functional contracts, opt-in
#   integration   heavy process/Git fixtures, opt-in
#   all           unit suites, then extended suites, then integration suites
#   module:<name> every suite whose modules column lists <name>
#   <suite>...    named suites from the manifest, dependencies first
#
# Options:
#   --list        show suites by tier, modules, dependencies and files
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
RUST_MODULES=$TEST_DIR/rust-modules.txt
SELF=$TEST_DIR/$(basename "$0")

selected=
ordered=
execution=
logs=

cleanup() {
  [ -z "$logs" ] || rm -rf "$logs"
  [ -z "$selected" ] || rm -f "$selected"
  [ -z "$ordered" ] || rm -f "$ordered"
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
  extended      slower functional contracts, opt-in
  integration   heavy approval, dispatch and lifecycle fixtures
  all           every unit suite, then extended, then integration
  module:<name> every suite whose modules column lists <name>
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
  awk -F'|' -v n="$1" '!/^[[:space:]]*#/ && !/^[[:space:]]*$/ && $1 == n {print; exit}' "$MANIFEST"
}

suite_exists() {
  [ -n "$(row_for "$1")" ]
}

suite_field() {
  awk -F'|' -v n="$1" -v f="$2" '!/^[[:space:]]*#/ && !/^[[:space:]]*$/ && $1 == n {print $f; exit}' "$MANIFEST"
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

add_module() {
  _module=$1
  _matched=0
  for _suite in $(manifest_rows | awk -F'|' -v m="$_module" '
    {
      n = split($5, modules, ",")
      for (i = 1; i <= n; i++) if (modules[i] == m) { print $1; next }
    }'); do
    _matched=1
    add_unique "$_suite"
  done
  if [ "$_matched" -eq 0 ]; then
    # Rust-only modules have no shell suite but are still valid selectors.
    [ -f "$RUST_MODULES" ] && grep -qxF "$_module" "$RUST_MODULES" || \
      die "unknown module: $_module (try --list)"
  fi
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
  for _tier in unit extended integration; do
    printf '%s:\n' "$_tier"
    manifest_rows | awk -F'|' -v t="$_tier" '$2 == t {
      deps = ($3 == "" ? "-" : $3)
      files = ($4 == "" ? "(group)" : $4)
      printf "  %-26s deps=%-52s modules=%-20s %s\n", $1, deps, $5, $6
    }'
  done
  printf '\nselectors: all, unit, extended, integration, module:<name>, or any suite name\n'
}

prepare_selection() {
  : > "$selected"
  for _sel in $selector_args; do
    case $_sel in
      all)
        add_tier unit
        add_tier extended
        add_tier integration
        ;;
      unit|extended|integration)
        add_tier "$_sel"
        ;;
      module:*)
        add_module "${_sel#module:}"
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
  # Resolve the dependency order in one awk pass. Selection order is
  # authoritative (unit before extended before integration); dependencies are
  # emitted before their dependents.
  awk -F'|' '
    FILENAME == ARGV[1] {
      order[++count] = $0
      next
    }
    !/^[[:space:]]*#/ && !/^[[:space:]]*$/ {
      deps[$1] = $3
    }
    END {
      emitted = 0
      while (emitted < count) {
        progressed = 0
        for (i = 1; i <= count; i++) {
          name = order[i]
          if (name in done) continue
          ready = 1
          n = split(deps[name], parts, ",")
          for (j = 1; j <= n; j++) {
            dep = parts[j]
            if (dep == "") continue
            if (!(dep in done)) { ready = 0; break }
          }
          if (ready) {
            print name
            done[name] = 1
            emitted++
            progressed = 1
          }
        }
        if (!progressed) {
          print "dependency cycle among selected suites" > "/dev/stderr"
          exit 2
        }
      }
    }
  ' "$selected" "$MANIFEST" > "$ordered"
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

# `all` is a tier barrier, not just a concatenated selection: run each tier to
# completion so heavy integration fixtures cannot contend with the fast tier.
if [ "$selector_args" = " all" ]; then
  overall=0
  for _tier in unit extended integration; do
    sh "$SELF" "$_tier" || overall=$?
  done
  exit "$overall"
fi

# The unit suites run the prebuilt dispatcher directly instead of paying
# `cargo run` startup for every command. Build it once when it is missing.
if [ ! -x "$PLUGIN_ROOT/target/debug/aven-dispatch" ]; then
  (cd "$PLUGIN_ROOT" && cargo build --quiet --bin aven-dispatch)
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
