#!/bin/sh
# Opt-in Aven custom-command entrypoint for the Rust dispatcher. It preserves
# stdin verbatim, so Aven's versioned context reaches the binary unchanged.
set -eu

here=$(dirname "$0")
root=$(cd "$here/.." && pwd)

if [ -n "${AVEN_DISPATCH_BIN:-}" ]; then
  exec "$AVEN_DISPATCH_BIN" dispatch "$@"
fi

if [ -x "$root/target/release/aven-dispatch" ]; then
  exec "$root/target/release/aven-dispatch" dispatch "$@"
fi

exec cargo run --quiet --manifest-path "$root/Cargo.toml" -- dispatch "$@"
