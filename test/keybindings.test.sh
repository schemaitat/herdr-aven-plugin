#!/bin/sh
# scripts/install-keybindings.sh: appends the bindings once, never takes a
# chord Herdr uses itself, and restores the config when Herdr rejects it.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
cfg=$work/config.toml
: > "$cfg"

HERDR_CONFIG_PATH=$cfg
HERDR_BIN_PATH=/bin/echo
PLUGIN_ROOT=$PLUGIN_ROOT
export HERDR_CONFIG_PATH HERDR_BIN_PATH PLUGIN_ROOT

install() {
  sh "$PLUGIN_ROOT/scripts/install-keybindings.sh"
}

# Fresh config gets both bindings.
out=$(install)
assert_contains "$out" "config: $cfg"
assert_contains "$out" "bound prefix+a -> aven.tasks.open"
assert_contains "$out" "bound prefix+shift+c -> aven.tasks.compose"
assert_contains "$out" "reloaded"
assert_file_contains "$cfg" 'key = "prefix+a"'
assert_file_contains "$cfg" 'command = "aven.tasks.open"'
assert_file_contains "$cfg" 'key = "prefix+shift+c"'
assert_file_contains "$cfg" 'command = "aven.tasks.compose"'

# Never claims a default Herdr chord.
assert_file_lacks "$cfg" 'key = "prefix+c"'
assert_file_lacks "$cfg" 'key = "prefix+shift+t"'

# Running again adds nothing.
lines_before=$(wc -l < "$cfg")
out=$(install)
assert_contains "$out" "already bound: aven.tasks.open (prefix+a)"
assert_contains "$out" "already bound: aven.tasks.compose (prefix+shift+c)"
assert_eq "$(wc -l < "$cfg")" "$lines_before" "reinstall must not duplicate blocks"

# A chord already taken by another plugin is reported, not stolen.
taken=$work/taken.toml
cat > "$taken" <<'EOF'
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "other.plugin.thing"
description = "someone else"
EOF
HERDR_CONFIG_PATH=$taken
out=$(install)
assert_contains "$out" "warning: prefix+a is already bound to other.plugin.thing"
assert_file_contains "$taken" 'command = "aven.tasks.compose"'
assert_file_lacks "$taken" 'command = "aven.tasks.open"'

# An action that sits on a default chord is reported, not changed.
default=$work/default.toml
cat > "$default" <<'EOF'
[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "aven.tasks.open"
description = "resize mode, but bound to aven"
EOF
HERDR_CONFIG_PATH=$default
out=$(install)
assert_contains "$out" "which Herdr uses itself"
assert_file_contains "$default" 'key = "prefix+r"'

# herdr rejects the config: the previous content is restored.
reject=$work/reject.toml
printf 'onboarding = false\n' > "$reject"
HERDR_CONFIG_PATH=$reject
HERDR_BIN_PATH=/bin/false
set +e
out=$(install 2>&1)
rc=$?
set -e
assert_eq "$rc" "1" "rejected config exit code"
assert_contains "$out" "config check rejected"
assert_file_lacks "$reject" 'aven.tasks.open'
assert_file_contains "$reject" 'onboarding = false'

# herdr is not on PATH: bindings are written, reload is left to the user.
nobin=$work/nobin.toml
: > "$nobin"
HERDR_CONFIG_PATH=$nobin
HERDR_BIN_PATH=/nonexistent/herdr
out=$(install)
assert_contains "$out" "is not available"
assert_file_contains "$nobin" 'command = "aven.tasks.open"'

printf 'keybindings ok\n'
