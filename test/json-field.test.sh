#!/bin/sh
# lib/plugin.sh has no multiplexer calls; its JSON helper stays backend-neutral.
set -eu
. "$(dirname "$0")/helpers.sh"

# shellcheck source=../lib/plugin.sh
. "$PLUGIN_ROOT/lib/plugin.sh"

json='{"project":"app","num":3,"null":null,"nested":{"project":"wrong"}}'
for backend in jq python3 awk; do
  command -v "$backend" >/dev/null 2>&1 || continue
  AVEN_JSON_BACKEND=$backend
  export AVEN_JSON_BACKEND
  assert_eq "$(json_field "$json" project)" "app" "$backend top-level key"
  assert_eq "$(json_field "$json" missing)" "" "$backend missing key"
  assert_eq "$(json_field "$json" null)" "" "$backend null value"
  assert_eq "$(json_field '' project)" "" "$backend empty json"
  assert_eq "$(json_field "$json" num)" "3" "$backend numeric value"
done
unset AVEN_JSON_BACKEND

assert_eq "$(printf 'a${X}b' | replace_all '${X}' '/root')" 'a/rootb' 'literal replacement'
assert_eq "$(printf 'a&b' | replace_all '&' '\&')" 'a\&b' 'ampersand replacement'

printf 'json field ok\n'
