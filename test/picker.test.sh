#!/bin/sh
# aven-dispatch pick renders choices in its own terminal and returns the exact
# selected id through a private response file. A /query prefix fuzzy-filters.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
binary=$(dispatch_bin)
response=$work/response
export AVEN_DISPATCH_PICKER_RESPONSE=$response
export AVEN_DISPATCH_PICKER_NAMES='Build
Plan
Review'
export AVEN_DISPATCH_PICKER_IDS='build
plan
review'

printf '2\n' | "$binary" pick --kind agent >/dev/null
assert_eq "$(cat "$response")" "plan" 'selected id is returned exactly'

rm -f "$response"
printf '/rev\n1\n' | "$binary" pick --kind agent >/dev/null
assert_eq "$(cat "$response")" "review" 'fuzzy search selects from the filtered list'

rm -f "$response"
printf '/zzz\n2\n' | "$binary" pick --kind agent >/dev/null
assert_eq "$(cat "$response")" "cancelled" 'out-of-range selection after no matches cancels'

rm -f "$response"
printf 'q\n' | "$binary" pick --kind model >/dev/null
assert_eq "$(cat "$response")" "cancelled" 'cancel is explicit'

rm -f "$response"
printf '9\n' | "$binary" pick --kind agent >/dev/null
assert_eq "$(cat "$response")" "cancelled" 'out-of-range selection cancels'

printf 'picker ok\n'
