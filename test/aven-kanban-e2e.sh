#!/bin/sh
# Optional native herdr-app E2E. Every mutable surface is isolated; the two
# screenshots and sanitized logs are retained for visual inspection.
set -eu
. "$(dirname "$0")/helpers.sh"

command -v herdr-app >/dev/null 2>&1 || fail 'herdr-app is required for the native Kanban E2E'
command -v hc >/dev/null 2>&1 || fail 'herdr-core (hc) is required for the native Kanban E2E'
command -v aven >/dev/null 2>&1 || fail 'aven is required for the native Kanban E2E'
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  fail 'the native Kanban E2E needs a display; use an isolated herdr-app display when headless'
fi

mkdir -p /tmp/opencode
root=$(mktemp -d /tmp/opencode/aven-kanban-e2e.XXXXXX)
app_home=$root/app
session=aven-kanban-e2e-$$
app_pid=
core_started=no
mkdir -p "$app_home" "$root/bin"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$app_pid" ]; then
    HERDR_APP_HOME="$app_home" HC_SESSION="$session" herdr-app do window.close >/dev/null 2>&1 || true
    count=0
    while kill -0 "$app_pid" 2>/dev/null && [ "$count" -lt 50 ]; do
      sleep 0.1
      count=$((count + 1))
    done
    if kill -0 "$app_pid" 2>/dev/null; then kill "$app_pid" 2>/dev/null || true; fi
    wait "$app_pid" 2>/dev/null || true
  fi
  if [ "$core_started" = yes ]; then
    HC_SESSION="$session" hc server stop >/dev/null 2>&1 || true
  fi
  printf 'artifacts: %s\n' "$root"
  exit "$status"
}
trap cleanup EXIT INT TERM

export HERDR_APP_HOME="$app_home"
export HC_SESSION="$session"
export AVEN_DB="$root/aven.sqlite"
export AVEN_DISPATCH_STORE="$root/dispatch.sqlite"
export AVEN_KANBAN_E2E="$root"
export PATH="$root/bin:$PATH"

# This dispatcher double is intentionally narrow: reads return one owned review
# attempt and messages are captured for assertion. It never dispatches real work.
cat > "$root/bin/aven-dispatch" <<'EOF'
#!/bin/sh
set -eu
case "${1:-}" in
  list)
    cat "$AVEN_KANBAN_E2E/attempt.json"
    ;;
  message)
    printf '%s\n' "$@" >> "$AVEN_KANBAN_E2E/unexpected-message.log"
    exit 2
    ;;
  *)
    printf 'unsupported aven-dispatch fixture command: %s\n' "${1:-}" >&2
    exit 2
    ;;
esac
EOF
chmod +x "$root/bin/aven-dispatch"

# Keep the merge tab's program harmless. The isolated app may not have a real
# agent installed, so the tab falls back to a shell; the test reads the typed
# prompt from that terminal rather than running a real merge.

# Keep board Git evidence inside this isolated test root. The sandbox may not
# expose the personal local-main checkout to a spawned app even when the real
# desktop app can read it.
repo=$root/repo
mkdir -p "$repo"
git -C "$repo" init -q -b main
git -C "$repo" config user.email kanban-e2e@example.invalid
git -C "$repo" config user.name "Kanban E2E"
printf 'baseline\n' > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -q -m "test: baseline"
git -C "$repo" switch -q -c review-result
printf 'review result\n' >> "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -q -m "test: review result"
git -C "$repo" switch -q main
aven project create "Kanban E2E" --prefix E2E --path "$repo" >/dev/null
add_epic() {
  title=$1
  status=$2
  shift 2
  output=$(aven add "$title" --project kanban-e2e --status "$status" --epic "$@")
  set -- $output
  printf '%s\n' "$2"
}
backlog_ref=$(add_epic "Dummy backlog epic" backlog)
planned_ref=$(add_epic "Dummy planned epic" todo --metadata sdd.plan-worked-out=true --metadata sdd.plan-kind=multi-phase)
progress_ref=$(add_epic "Dummy in-progress epic" active --metadata sdd.plan-worked-out=true)
review_ref=$(add_epic "Dummy approved review epic" done --metadata sdd.plan-worked-out=true --metadata approval.state=approved --metadata delivery.state=committed)
done_ref=$(add_epic "Dummy delivered epic" done --metadata delivery.state=merged --metadata delivery.target=main)
main_done_ref=$(add_epic "Dummy main-delivered epic" done)
review_id=$(aven show "$review_ref" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id))')
main_done_id=$(aven show "$main_done_ref" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).id))')
printf 'dummy epics: %s %s %s %s %s %s\n' "$backlog_ref" "$planned_ref" "$progress_ref" "$review_ref" "$done_ref" "$main_done_ref"

# Start an owned terminal in the unique core session. The merge action may peek
# this terminal, but no genuine agent, Git worktree, or OpenCode session exists.
core_started=yes
terminal_json=$(hc run --bg --json --no-parent --outlive-parent --name kanban-review-$$ --cwd "$PLUGIN_ROOT" -- sleep 300)
terminal=$(printf '%s' "$terminal_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).address))')
node - "$root/attempt.json" "$review_id" "$review_ref" "$repo" "$terminal" "$main_done_id" "$main_done_ref" "$PLUGIN_ROOT" <<'NODE'
const fs = require("node:fs");
const [output, taskId, taskRef, worktree, address, mainDoneId, mainDoneRef, pluginRoot] = process.argv.slice(2);
fs.writeFileSync(output, JSON.stringify([
  {
    task_id: taskId, task_ref: taskRef, workflow: "implementation", attempt_id: "att_kanban_e2e",
    generation: 0, created_at: 100, state: "needs-review", execution_mode: "single-session",
    worktree: "", branch: "review-result", lifecycle: { contradiction: "" },
    terminal: { address, core_id: "isolated-e2e", name: "kanban-review" },
    coordinator_terminal: { address: "", core_id: "", name: "" },
    pending_prompt: "fixture prompt must never be rendered",
  },
  {
    task_id: mainDoneId, task_ref: mainDoneRef, workflow: "implementation", attempt_id: "att_kanban_main_done",
    generation: 0, created_at: 90, state: "needs-review", execution_mode: "single-session",
    worktree: pluginRoot, branch: "main", lifecycle: { contradiction: "" },
    terminal: { address: "", core_id: "", name: "" },
    coordinator_terminal: { address: "", core_id: "", name: "" },
  },
], null, 2));
NODE

HERDR_APP_HOME="$app_home" sh "$PLUGIN_ROOT/scripts/install-app-mod.sh" > "$root/install.log"
(
  cd "$PLUGIN_ROOT"
  exec herdr-app > "$root/app.log" 2>&1
) &
app_pid=$!

ready=no
count=0
while [ "$count" -lt 100 ]; do
  if herdr-app status > "$root/status.json" 2> "$root/status-error.log"; then ready=yes; break; fi
  sleep 0.1
  count=$((count + 1))
done
[ "$ready" = yes ] || fail "isolated herdr-app did not become ready: $(cat "$root/status-error.log")"

# Give the board an explicit repository folder so its read-only local-main
# evidence check has deterministic scope in the isolated app.
herdr-app do space.new --name "kanban e2e" --folder "$repo" > "$root/space.json"
herdr-app do mod.open --name aven-kanban > "$root/open.json"
# The local fixture normally hydrates in milliseconds. Allow the first native
# frame and the bounded four-worker metadata reads to settle before keyboard input.
sleep 3
herdr-app shot "$root/kanban-board.png" >/dev/null
[ -s "$root/kanban-board.png" ] || fail 'board screenshot was not written'

# Initial selection is the first Backlog card. Three next commands select the
# sole Review card across the five one-card columns.
herdr-app do aven-kanban.next >/dev/null
herdr-app do aven-kanban.next >/dev/null
herdr-app do aven-kanban.next >/dev/null
herdr-app do aven-kanban.merge >/dev/null
space_id=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).space)' "$root/space.json")
address=
count=0
while [ -z "$address" ] && [ "$count" -lt 200 ]; do
  if herdr-app ls > "$root/ls.json" 2>/dev/null; then
    address=$(node -e 'const fs = require("node:fs"); const [file, spaceId, name] = process.argv.slice(1); const data = JSON.parse(fs.readFileSync(file, "utf8")); const space = (data.spaces || []).find((entry) => entry.id === spaceId); const tab = (space?.tabs || []).find((entry) => entry.name === name); const terminal = tab?.terminals?.[0]?.terminal; if (terminal) process.stdout.write(terminal);' "$root/ls.json" "$space_id" "merge $review_ref")
  fi
  [ -n "$address" ] && break
  sleep 0.1
  count=$((count + 1))
done
if [ -z "$address" ]; then
  herdr-app status > "$root/failure-status.json" || true
  herdr-app shot "$root/kanban-failure.png" >/dev/null || true
  fail 'Merge into main did not open the main-space merge tab'
fi
count=0
prompt_seen=no
while [ "$prompt_seen" = no ] && [ "$count" -lt 100 ]; do
  if hc read "$address" 2>/dev/null | grep -Fq -- "/ha-merge $review_id"; then
    prompt_seen=yes
    break
  fi
  sleep 0.1
  count=$((count + 1))
done
[ "$prompt_seen" = yes ] || fail 'merge tab did not receive the /ha-merge prompt'
[ ! -e "$root/unexpected-message.log" ] || fail 'merge must not message a builder or coordinator terminal'
sleep 1
herdr-app shot "$root/kanban-handoff.png" >/dev/null
[ -s "$root/kanban-handoff.png" ] || fail 'handoff screenshot was not written'
herdr-app status > "$root/final-status.json"
printf 'native Kanban E2E ok\nboard: %s\nhandoff: %s\n' "$root/kanban-board.png" "$root/kanban-handoff.png"
