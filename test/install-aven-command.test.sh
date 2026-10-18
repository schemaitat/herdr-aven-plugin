#!/bin/sh
# scripts/install-aven-command.sh: writes the built-in dispatch command and the
# extra commands from aven-commands.yaml into aven's config.yaml, once, and
# rewrites the managed block when the commands change.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
export AVEN_CONFIG_DIR=$work/aven
fake=$work/bin
mkdir -p "$fake"
cat > "$fake/cargo" <<'EOF'
#!/bin/sh
printf 'cargo %s\n' "$*" >> "$CARGO_INSTALL_LOG"
EOF
cat > "$fake/aven-dispatch" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$fake/cargo" "$fake/aven-dispatch"
export CARGO_INSTALL_LOG=$work/cargo.log
export PATH="$fake:$PATH"

run_installer() {
  sh "$PLUGIN_ROOT/scripts/install-aven-command.sh"
}

config=$AVEN_CONFIG_DIR/config.yaml

# A fresh config directory gets the managed block.
out=$(run_installer)
assert_contains "$out" "config: $config" "config path"
assert_contains "$out" "installed: dispatch (keys: z d)" "installed line"
assert_file_contains "$config" "# Managed by herdr-aven-plugin"
assert_file_contains "$config" "# End of the herdr-aven-plugin managed block."
assert_file_contains "$config" "name: dispatch"
assert_file_contains "$config" "program: aven-dispatch"
assert_file_contains "$config" "args:"
assert_file_contains "$config" "- dispatch"
assert_file_contains "$config" "- build" "default build agent"
assert_file_contains "$config" "- github-copilot/gpt-5.6-terra" "default Terra model"
assert_file_contains "$config" "$PLUGIN_ROOT/.opencode" "plugin OpenCode config directory"
assert_file_contains "$CARGO_INSTALL_LOG" "cargo install --path $PLUGIN_ROOT --force"
assert_file_contains "$config" "keys: [z d]"
assert_file_contains "$config" "target: focused"
assert_file_contains "$config" "on_success: quit"

# The aven-native workflow example is installed next to dispatch by default.
assert_file_contains "$config" "name: sdd"
assert_file_contains "$config" "keys: [z s]"
assert_file_contains "$config" "--skill" "workflow skill option"
assert_file_contains "$config" "aven/sdd" "workflow skill name"
assert_file_contains "$config" "--skills-dir" "workflow skills directory"
assert_file_contains "$config" "$PLUGIN_ROOT/skills" "workflow skills directory path"
assert_contains "$out" "installed: sdd (extra)" "workflow command reported"

# aven can parse the result.
aven config get sync.enabled >/dev/null ||
  fail "aven cannot parse the config after install"

# Running again changes nothing and says so.
lines=$(wc -l < "$config")
out=$(run_installer)
assert_contains "$out" "already installed" "idempotent"
assert_eq "$(wc -l < "$config")" "$lines" "reinstall must not add a second block"

# Extra commands from AVEN_COMMANDS_FILE are written next to dispatch, with
# ${PLUGIN_ROOT} substituted and their keys and env intact.
extras=$work/extras.yaml
cat > "$extras" <<'EOF'
# Extra commands for the test.
- name: dispatch-claude
  aliases: [custom-dispatch-claude]
  description: Implement the selected task with Claude
  program: aven-dispatch
  args: [dispatch, --agent, claude, --opencode-config-dir, "${PLUGIN_ROOT}/.opencode"]
  keys: [z c]
  detail_keys: [z C]
  target: focused
  execution: wait
  on_success: quit


- name: dispatch-main
  description: Branch based on main
  program: aven-dispatch
  args: [dispatch, --model, provider/model, --opencode-config-dir, "${PLUGIN_ROOT}/.opencode"]
  keys: [z m]
  target: focused
  execution: wait
  on_success: quit

EOF
out=$(AVEN_COMMANDS_FILE=$extras run_installer)
assert_contains "$out" "updated: $config" "extras update reported"
assert_contains "$out" "installed: dispatch-claude (extra)" "extra name reported"
assert_contains "$out" "installed: dispatch-main (extra)" "second extra reported"
assert_file_contains "$config" "name: dispatch-claude"
assert_file_contains "$config" "name: dispatch-main"
assert_file_contains "$config" 'args: [dispatch, --agent, claude, --opencode-config-dir, "'"$PLUGIN_ROOT"'/.opencode"]' "direct dispatcher args in extras"
assert_file_contains "$config" "keys: [z c]"
assert_file_contains "$config" "--agent"
assert_file_contains "$config" "--model"
assert_file_lacks "$config" '${PLUGIN_ROOT}' "no placeholder survives"
aven config get sync.enabled >/dev/null ||
  fail "aven cannot parse the config with extra commands"

# A comment in the extras file is not written into the config.
assert_file_lacks "$config" "Extra commands for the test." "comment line not written"
before=$(wc -l < "$config")
out=$(AVEN_COMMANDS_FILE=$extras run_installer)
assert_contains "$out" "already installed" "extras reinstall idempotent"
assert_eq "$(wc -l < "$config")" "$before" "extras reinstall must not add lines"

# Going back to no extra commands removes them again. Point at a file with only
# comments to install just the built-in dispatch command.
empty=$work/empty.yaml
printf '# no extra commands\n' > "$empty"
out=$(AVEN_COMMANDS_FILE=$empty run_installer)
assert_contains "$out" "updated: $config" "removal update reported"
assert_file_lacks "$config" "dispatch-claude" "removed extra command"
assert_file_lacks "$config" "name: sdd" "removed workflow command"
aven config get sync.enabled >/dev/null || fail "config after removal does not parse"

# Anything after the managed block is left alone.
printf '\n# user comment\nproject:\n  overrides: []\n' >> "$config"
AVEN_COMMANDS_FILE=$extras run_installer >/dev/null
assert_file_contains "$config" "# user comment" "content after the block kept"
assert_file_contains "$config" "project:" "top-level key after the block kept"
aven config get sync.enabled >/dev/null || fail "config with trailing content does not parse"

# A block written by an older version (no end marker) is replaced, keeping what
# came before it.
legacy=$work/legacy
AVEN_CONFIG_DIR=$legacy
export AVEN_CONFIG_DIR
mkdir -p "$legacy"
cat > "$legacy/config.yaml" <<'EOF'
local:
  db_path: null

# Managed by herdr-aven-plugin (install-aven-command). Remove this block to uninstall.
tui:
  commands:
    - name: dispatch
      program: cargo
      args:
        - run
        - --quiet
        - --manifest-path
        - /old/Cargo.toml
        - "--"
        - dispatch
      keys: [z d]
EOF
out=$(run_installer)
assert_contains "$out" "updated: $legacy/config.yaml" "legacy block updated"
assert_file_contains "$legacy/config.yaml" "local:" "legacy prefix kept"
assert_file_contains "$legacy/config.yaml" "program: aven-dispatch" "legacy block replaced"
assert_file_contains "$legacy/config.yaml" "# End of the herdr-aven-plugin managed block."
aven config get sync.enabled >/dev/null || fail "migrated config does not parse"

# An existing config without a tui: section gets the block appended.
other=$work/other
AVEN_CONFIG_DIR=$other
export AVEN_CONFIG_DIR
mkdir -p "$other"
printf 'local:\n  db_path: null\n' > "$other/config.yaml"
out=$(run_installer)
assert_contains "$out" "installed: dispatch" "append to existing config"
assert_file_contains "$other/config.yaml" "local:" "original settings kept"
assert_file_contains "$other/config.yaml" "name: dispatch" "block appended"
aven config get sync.enabled >/dev/null || fail "appended config does not parse"

# A config that already has a top-level tui: section is never rewritten.
busy=$work/busy
AVEN_CONFIG_DIR=$busy
export AVEN_CONFIG_DIR
mkdir -p "$busy"
printf 'tui:\n  sidebar:\n    views: [queue]\n' > "$busy/config.yaml"
before=$(cat "$busy/config.yaml")
set +e
out=$(AVEN_COMMANDS_FILE=$extras run_installer 2>&1)
rc=$?
set -e
assert_eq "$rc" "1" "busy config exit code"
assert_contains "$out" "already has a top-level tui: section" "busy config warning"
assert_contains "$out" "name: dispatch" "busy config prints the snippet"
assert_contains "$out" "name: dispatch-claude" "busy snippet includes extras"
assert_eq "$(cat "$busy/config.yaml")" "$before" "busy config must be untouched"

# An invalid extra command (a duplicate name) is rejected by aven and the
# config is restored.
dup=$work/dup.yaml
cat > "$dup" <<'EOF'
- name: dispatch
  description: duplicate name
  program: aven-dispatch
  args: [dispatch]
  keys: [z q]
EOF
AVEN_CONFIG_DIR=$other
export AVEN_CONFIG_DIR
before=$(cat "$other/config.yaml")
set +e
out=$(AVEN_COMMANDS_FILE=$dup run_installer 2>&1)
rc=$?
set -e
assert_eq "$rc" "1" "invalid extras exit code"
assert_contains "$out" "could not parse the config after the change; it was restored" "restore warning"
assert_eq "$(cat "$other/config.yaml")" "$before" "invalid extras must restore the config"

printf 'install-aven-command ok\n'
