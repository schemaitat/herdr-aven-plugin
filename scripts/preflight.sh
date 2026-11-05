#!/bin/sh
# Report tool/executable provenance and isolated per-run paths without
# modifying a global installation. Missing required prerequisites are failures;
# optional UI/browser tools are reported separately.
set -eu

root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
status=0
run_dir=$(mktemp -d "${TMPDIR:-/tmp}/opencode/aven-preflight.XXXXXX" 2>/dev/null || mktemp -d)

report() {
  printf '%-22s %s\n' "$1" "$2"
}

require() {
  if command -v "$1" >/dev/null 2>&1; then
    report "$1" "$(command -v "$1") ($("$1" "${2:---version}" 2>/dev/null | head -n 1 || true))"
  else
    report "$1" "MISSING (required)"
    status=1
  fi
}

optional() {
  if command -v "$1" >/dev/null 2>&1; then
    report "$1" "$(command -v "$1") ($("$1" "${2:---version}" 2>/dev/null | head -n 1 || true))"
  else
    report "$1" "unavailable (optional; only relevant when its checks run)"
  fi
}

report "source" "$root"
report "source-revision" "$(git -C "$root" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
report "run-directory" "$run_dir"
report "store-path" "${AVEN_DISPATCH_STORE:-$run_dir/dispatch.sqlite}"
report "aven-workspace" "${AVEN_WORKSPACE:-default}"
report "host" "$(uname -srm 2>/dev/null || printf unknown)"
report "time" "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf unknown)"

require aven
require git
require cargo
require rustc

if command -v aven-dispatch >/dev/null 2>&1; then
  installed=$(command -v aven-dispatch)
  report "installed-dispatch" "$installed"
  if [ -f "$root/src/main.rs" ] && [ "$installed" -ot "$root/src/main.rs" ]; then
    report "installed-provenance" "STALE: installed binary predates reviewed source; run just install before live verification"
  else
    report "installed-provenance" "newer than or independent of reviewed source"
  fi
else
  report "installed-dispatch" "not installed (cargo-run verification only)"
fi

optional hc
optional opencode --version
optional node --version
optional npm --version

if command -v hc >/dev/null 2>&1; then
  hc server status 2>/dev/null | head -n 1 >/dev/null || report "hc-server" "unavailable (dispatch/tests require a running core)"
fi

# Per-run isolated ports are suggestions only; callers must pass them to the
# system under test rather than assuming a fixed port is free.
port=$(python3 - <<'PY' 2>/dev/null || printf 0
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)
report "suggested-port" "$port"

exit "$status"
