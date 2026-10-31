#!/bin/sh
# aven-dispatch pick renders choices in its own terminal and returns the exact
# selected id through a private response file.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
response=$work/response
export AVEN_DISPATCH_PICKER_RESPONSE=$response
export AVEN_DISPATCH_PICKER_CHOICES='  1. Build (build)
  2. Plan (plan)'
export AVEN_DISPATCH_PICKER_IDS='build
plan'

printf '2\n' | cargo run --quiet -- pick --kind agent >/dev/null
assert_eq "$(cat "$response")" "plan" 'selected id is returned exactly'

rm -f "$response"
printf 'q\n' | cargo run --quiet -- pick --kind model >/dev/null
assert_eq "$(cat "$response")" "cancelled" 'cancel is explicit'

rm -f "$response"
printf '9\n' | cargo run --quiet -- pick --kind agent >/dev/null
assert_eq "$(cat "$response")" "cancelled" 'out-of-range selection cancels'

printf 'picker ok\n'
