#!/bin/sh
# scripts/doctor.sh reports Aven, herdr-core, and optional app readiness.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
binary=$(dispatch_bin)
fake=$work/bin
mkdir -p "$fake"
cat > "$fake/aven" <<'SCRIPT'
#!/bin/sh
case " $* " in
  *" --version "*) printf 'aven 0.9.0\n' ;;
  *" prime --json "*) printf '{"project":"app"}\n' ;;
  *) : ;;
esac
SCRIPT
cat > "$fake/hc" <<'SCRIPT'
#!/bin/sh
case " $* " in
  *" --version "*) printf 'hc 0.1.15\n' ;;
  *" server status --json "*) printf '{"core":{"id":"core-1","name":"local"},"version":"0.1.15"}\n' ;;
  *) : ;;
esac
SCRIPT
cat > "$fake/herdr-app" <<'SCRIPT'
#!/bin/sh
exit 1
SCRIPT
chmod +x "$fake"/*
PATH="$fake:$PATH" AVEN_BIN=$fake/aven out=$(sh "$PLUGIN_ROOT/scripts/doctor.sh")
assert_contains "$out" "aven tasks" "header"
assert_contains "$out" "hc 0.1.15" "herdr-core version"
assert_contains "$out" "local" "core name"
assert_contains "$out" "core-1" "core id"
assert_contains "$out" "app" "inferred project"
assert_contains "$out" "unavailable" "missing app is reported"
assert_contains "$out" "headless dispatch remains supported" "headless remains supported"

# Missing Aven or herdr-core is a hard failure.
set +e
PATH="$fake:$PATH" AVEN_BIN=/nonexistent/aven sh "$PLUGIN_ROOT/scripts/doctor.sh" >/dev/null 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "missing aven exit code"
set +e
PATH=/usr/bin:/bin AVEN_BIN=$fake/aven sh "$PLUGIN_ROOT/scripts/doctor.sh" >/dev/null 2>&1
rc=$?
set -e
assert_eq "$rc" "1" "missing herdr-core exit code"

# The Rust doctor negotiates required core capabilities and the OpenCode API.
cat > "$fake/opencode" <<'SCRIPT'
#!/bin/sh
case " $* " in
  *" GET /api/session?limit=1 "*) printf '{"data":[]}\n' ;;
  *) printf '{"data":[]}\n' ;;
esac
SCRIPT
cat > "$fake/hc" <<'SCRIPT'
#!/bin/sh
case " $* " in
  *" --version "*) printf 'hc 0.1.15\n' ;;
  *" server status --json "*) printf '{"core":{"id":"core-1","name":"local"},"version":"0.1.15"}\n' ;;
  *" schema "*) printf '{"methods":[{"name":"terminal.send"}]}\n' ;;
  *) : ;;
esac
SCRIPT
chmod +x "$fake"/*
set +e
HC_BIN=$fake/hc PATH="$fake:$PATH" "$binary" doctor > "$work/rust-doctor" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" 'doctor rejects missing event capability'
assert_file_contains "$work/rust-doctor" 'events.subscribe' 'missing capability is named'

cat > "$fake/hc" <<'SCRIPT'
#!/bin/sh
case " $* " in
  *" --version "*) printf 'hc 0.1.15\n' ;;
  *" server status --json "*) printf '{"core":{"id":"core-1","name":"local"},"version":"0.1.15"}\n' ;;
  *" schema "*) printf '{"methods":[{"name":"events.subscribe"},{"name":"terminal.send"}]}\n' ;;
  *) : ;;
esac
SCRIPT
chmod +x "$fake/hc"
HC_BIN=$fake/hc PATH="$fake:$PATH" "$binary" doctor > "$work/rust-doctor" 2>&1
assert_file_contains "$work/rust-doctor" 'ready:' 'doctor reports ready with tested capabilities'
assert_file_contains "$work/rust-doctor" 'headless dispatch remains supported' 'missing app remains supported'

printf 'doctor ok\n'
