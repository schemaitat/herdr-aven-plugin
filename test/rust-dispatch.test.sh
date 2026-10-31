#!/bin/sh
# End-to-end process fixture for the herdr-core dispatcher.
#
# `hc` is the deterministic fixture in test/hc_fixture.py; its `exec` runs real
# Git. OpenCode and Aven are faked on PATH so prompt admission and Aven
# metadata are observable without touching a real user setup.
set -eu
. "$(dirname "$0")/helpers.sh"

work=$(mkworkdir)
fake=$work/bin
state=$work/hc-state
log=$work/calls
store=$work/dispatch.sqlite
repo=$work/repo
mkdir -p "$fake" "$state" "$repo"
export HC_SESSION=aven-dispatch-test-$$
export HC_FIXTURE_STATE=$state
export HC_FIXTURE_LOG=$log
export HC_FIXTURE_CORE_ID=fixture-core
export HC_FIXTURE_CORE_NAME=fixture
export HC_BIN=$PLUGIN_ROOT/test/hc_fixture.py
export HERDR_APP_BIN=$fake/herdr-app
export AVEN_WORKTREE_ROOT=$work/worktrees
export XDG_CONFIG_HOME=$work/config
mkdir -p "$work/config"
chmod +x "$PLUGIN_ROOT/test/hc_fixture.py"

# A real repository so hc exec / git worktree operations are exercised.
git -C "$repo" init -q
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
printf '%s\n' base > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -qm base

cat > "$fake/aven" <<'EOF'
#!/bin/sh
printf 'aven %s\n' "$*" >> "$AVEN_LOG"
case " $* " in
  *" context APP-1 --json "*) printf '%s\n' '{"task":{"id":"immutable-task","title":"quoted \"task\""},"project":{"key":"app"}}' ;;
  *" context APP-2 --json "*) printf '%s\n' '{"task":{"id":"epic-task","title":"cumulative epic"},"project":{"key":"app"},"metadata":{"sdd.plan-worked-out":"true","sdd.plan-kind":"multi-phase"},"epic_children":[{"id":"phase-two","ref":"APP-P2","title":"second phase"},{"id":"phase-one","ref":"APP-P1","title":"first phase"}]}' ;;
  *" context APP-P1 --json "*) printf '%s\n' '{"task":{"id":"phase-one","title":"first phase","status":"todo"},"project":{"key":"app"},"metadata":{"sdd.plan-root":"epic-task","sdd.plan-phase":"1"},"dependencies":{"depends_on":[],"depends_on_open":0}}' ;;
  *" context APP-P2 --json "*) printf '%s\n' '{"task":{"id":"phase-two","title":"second phase","status":"todo"},"project":{"key":"app"},"metadata":{"sdd.plan-root":"epic-task","sdd.plan-phase":"2"},"dependencies":{"depends_on":[{"task_id":"phase-one"}],"depends_on_open":1}}' ;;
  *" add Dispatch log: "*) printf '%s\n' 'created DL-LOG ref=LOG' ;;
  *) : ;;
esac
EOF
cat > "$fake/opencode" <<'EOF'
#!/bin/sh
printf 'opencode %s\n' "$*" >> "$OPENCODE_LOG"
case " $* " in
  *" POST /api/session/"*"/prompt "*) data=; while [ "$#" -gt 0 ]; do [ "$1" = --data ] && { data=$2; break; }; shift; done; id=$(printf '%s' "$data" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); printf '{"data":{"id":"%s"}}\n' "$id" ;;
  *" POST /api/session "*) case "$*" in *'"agent":"aven-babysitter"'*) printf '%s\n' '{"data":{"id":"ses_babysitter"}}' ;; *) n=$(wc -l < "$OPENCODE_LOG"); printf '{"data":{"id":"ses_%s"}}\n' "$n" ;; esac ;;
  *" GET /api/session/ses_"*) if [ -n "${OPENCODE_OUTCOME:-}" ]; then printf '{"data":{"outcome":"%s"}}\n' "$OPENCODE_OUTCOME"; else printf '%s\n' '{"data":{}}'; fi ;;
  *" GET /api/session?limit=1 "*) printf '%s\n' '{"data":[]}' ;;
  *" GET /api/experimental/session/"*) printf 'id: 42\nevent: update\ndata: {}\n\n' ;;
  *" GET /api/agent "*" x-opencode-directory:"*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-5.6-terra"},"mode":"primary","hidden":false},{"id":"aven-babysitter","name":"Aven babysitter","mode":"primary","hidden":true},{"id":"aven-orchestrator","name":"Aven orchestrator","mode":"primary","hidden":true}]}' ;;
  *" GET /api/agent "*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-5.6-terra"},"mode":"primary","hidden":false},{"id":"aven-babysitter","name":"Aven babysitter","mode":"primary","hidden":true},{"id":"aven-orchestrator","name":"Aven orchestrator","mode":"primary","hidden":true}]}' ;;
  *) printf '%s\n' '{"data":[]}' ;;
esac
EOF
cat > "$fake/herdr-app" <<'EOF'
#!/bin/sh
[ "${FAKE_APP:-}" = 1 ] || exit 1
case "${1:-}" in
  status) exit 0 ;;
  ls)
    if [ -f "$FAKE_APP_STATE" ]; then
      folder=$(cat "$FAKE_APP_STATE")
      printf '{"spaces":[{"id":"s1","name":"task","folder":"%s","tabs":[{"id":"tb1","active":true,"terminals":[{"terminal":"t-placeholder"}]}]}]}\n' "$folder"
    else
      printf '{"spaces":[]}\n'
    fi
    ;;
  do)
    printf 'app %s\n' "$*" >> "$FAKE_APP_LOG"
    case " $* " in
      *" space.new "*) folder=; while [ "$#" -gt 0 ]; do [ "$1" = --folder ] && { folder=$2; break; }; shift; done; printf '%s' "$folder" > "$FAKE_APP_STATE" ;;
    esac
    printf '{}\n'
    ;;
  *) exit 0 ;;
esac
EOF
export FAKE_APP_STATE=$work/app-space
export FAKE_APP_LOG=$work/app.log
chmod +x "$fake"/*

export AVEN_LOG=$work/aven.log
export OPENCODE_LOG=$work/opencode.log

context='{"version":1,"invocation":{"origin_cwd":"'"$repo"'"},"targeting":{"targets":[{"id":"immutable-task","ref":"APP-1"}]},"selection":{"primary":{"ref":"APP-1","task":{"id":"immutable-task","title":"quoted \"task\""},"project":{"key":"app"}}}}'

PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF >/dev/null
$context
EOF

# Worktrees are created only through hc exec/git; the checkout follows the
# shared ~/.herdr/worktrees convention.
worktree=$work/worktrees/repo/app-dispatch-immutable-task
[ -d "$worktree" ] || fail "dispatch did not create the expected worktree"
[ "$(git -C "$worktree" rev-parse --abbrev-ref HEAD)" = "app/dispatch-immutable-task" ] || fail "worktree branch"
assert_file_contains "$log" '"exec"' 'worktree operations use hc exec'
assert_file_contains "$log" '"worktree", "add"' 'hc exec runs git worktree add'
assert_file_contains "$log" '"run"' 'agent launch uses hc run'
assert_file_contains "$log" '--outlive-parent' 'dispatch terminals outlive the short-lived dispatcher'
assert_file_contains "$log" '--no-parent' 'dispatch terminals are not tied to a popup process'
assert_file_contains "$log" 'AVEN_DISPATCH_STORE=' 'terminal inherits the central store'
assert_file_contains "$log" 'aven.attempt' 'terminals carry attempt ownership labels'
assert_file_contains "$log" 'opencode' 'OpenCode starts in the dedicated terminal'
assert_file_contains "$work/opencode.log" 'POST /api/session/' 'session created before terminal launch'
assert_file_contains "$work/opencode.log" 'POST /api/session/' 'prompt admitted through the API'
assert_contains "$(sqlite_json "$store")" '"backend": "hc"' 'backend persisted'
assert_contains "$(sqlite_json "$store")" '"core_id": "fixture-core"' 'durable core identity persisted'
assert_contains "$(sqlite_json "$store")" '"address": "t1"' 'terminal address persisted before reuse'
[ ! -e "$work/.aven-dispatch" ] || fail 'no legacy JSON store'

before=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF > "$work/reopen"
$context
EOF
after=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
assert_eq "$after" "$before" 're-dispatch never admits a second prompt'
assert_file_contains "$work/reopen" 'reopened APP-1' 're-dispatch reopens the durable session'
runs=$(grep -c '"run"' "$log")
[ "$runs" -ge 1 ] || fail 'reopen should have a persisted terminal'

# Babysitting is opt-in: a second API session and a separate owned terminal.
babysitter_store=$work/babysitter.sqlite
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$babysitter_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --babysitter <<EOF >/dev/null
$context
EOF
assert_contains "$(sqlite_json "$babysitter_store")" '"babysitter": true' 'babysitter opt-in persisted'
assert_contains "$(sqlite_json "$babysitter_store")" '"role": "babysitter"' 'babysitter terminal ownership persisted'
assert_file_contains "$work/opencode.log" 'ses_babysitter' 'babysitter API session created and admitted'
assert_file_contains "$log" 'aven.role=babysitter' 'babysitter terminal carries its role label'

# A crash between durable prompt checkpoint and admission is recovered by
# rebuilding the deterministic prompt and admitting once.
pending_store=$work/pending.sqlite
cp "$store" "$pending_store"
python3 - "$pending_store" <<'PY2'
import json, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    task_id, workflow, payload = db.execute("SELECT task_id, workflow, payload FROM attempts").fetchone()
    attempt = json.loads(payload)
    attempt["state"] = "prompt-pending"
    attempt["pending_prompt"] = ""
    db.execute("UPDATE attempts SET payload = ? WHERE task_id = ? AND workflow = ?", (json.dumps(attempt), task_id, workflow))
    db.commit()
PY2
before=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$pending_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF > "$work/pending-retry"
$context
EOF
after=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
assert_eq "$after" "$((before + 1))" 'pending prompt recovery admits exactly once'
assert_file_contains "$work/pending-retry" 'reopened APP-1' 'pending recovery reopens the durable session'

# A crash after reserving the worktree but before any session/agent is safe:
# the clean owned reservation is discarded and a fresh attempt is admitted.
incomplete_store=$work/incomplete.sqlite
cp "$store" "$incomplete_store"
python3 - "$incomplete_store" <<'PY2'
import json, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    task_id, workflow, payload = db.execute("SELECT task_id, workflow, payload FROM attempts").fetchone()
    attempt = json.loads(payload)
    attempt["state"] = "workspace-pending"
    attempt["session_id"] = ""
    attempt["prompt_id"] = ""
    attempt["pending_prompt"] = ""
    attempt["terminal"] = {}
    attempt["terminals"] = {}
    db.execute("UPDATE attempts SET payload = ? WHERE task_id = ? AND workflow = ?", (json.dumps(attempt), task_id, workflow))
    db.commit()
PY2
before=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$incomplete_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF > "$work/incomplete-retry"
$context
EOF
after=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
assert_eq "$after" "$((before + 1))" 'incomplete reservation is discarded and admitted once'
assert_file_contains "$work/incomplete-retry" 'admitted APP-1' 'incomplete reservation starts a fresh dispatch'
[ -d "$work/worktrees/repo/app-dispatch-immutable-task" ] || fail 'fresh dispatch recreated the worktree'

# A legacy record is read-only evidence until an explicit relaunch.
legacy_store=$work/legacy.sqlite
cp "$store" "$legacy_store"
python3 - "$legacy_store" <<'PY'
import json, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    task_id, workflow, payload = db.execute("SELECT task_id, workflow, payload FROM attempts").fetchone()
    attempt = json.loads(payload)
    attempt["backend"] = "herdr"
    attempt.pop("terminal", None)
    attempt["pane"] = "w1:p1"
    db.execute("UPDATE attempts SET payload = ? WHERE task_id = ? AND workflow = ?", (json.dumps(attempt), task_id, workflow))
    db.commit()
PY
set +e
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$legacy_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF > "$work/legacy" 2>&1
$context
EOF
rc=$?
set -e
assert_eq "$rc" "1" 'legacy attempt requires explicit relaunch'
assert_file_contains "$work/legacy" 'retired herdr runtime' 'legacy refusal explains the migration'

# Cumulative worktrees: coordinator plus one worker checkout per ordered phase.
cumulative_store=$work/cumulative.sqlite
cumulative_context='{"version":1,"invocation":{"origin_cwd":"'"$repo"'"},"targeting":{"targets":[{"id":"epic-task","ref":"APP-2"}]},"selection":{"primary":{"ref":"APP-2","task":{"id":"epic-task","title":"cumulative epic"},"project":{"key":"app"}}}}'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$cumulative_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra --skill aven/sdd-implement --skills-dir "$PLUGIN_ROOT/skills" --mode worktrees <<EOF >/dev/null
$cumulative_context
EOF
for phase in phase-01 phase-02; do
  [ -d "$work/worktrees/repo/app-dispatch-epic-task-$phase" ] || fail "missing $phase worktree"
done
assert_file_contains "$log" 'app/dispatch-epic-task-phase-01' 'first phase branch created'
assert_file_contains "$log" 'app/dispatch-epic-task-phase-02' 'second phase branch created'
assert_contains "$(sqlite_json "$cumulative_store")" '"state": "provisioned"' 'blocked successor stays provisioned'
assert_contains "$(sqlite_json "$cumulative_store")" '"state": "running"' 'first phase is admitted'
assert_contains "$(sqlite_json "$cumulative_store")" '"role": "phase"' 'phase terminal ownership persisted'

# Bounded reconcile and watcher status are explicit, repeatable operations.
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- watch --once > "$work/watch-once"
assert_file_contains "$work/watch-once" 'reconciled' 'watch --once reconciles persisted attempts'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- watch --status > "$work/watch-status"
assert_file_contains "$work/watch-status" '"store"' 'watcher status reports its store'

# With herdr-app available, a dispatched worktree gets a sidebar space and the
# attempt terminal is labelled into that space's tab.
app_store=$work/app.sqlite
FAKE_APP=1 PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$app_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-5.6-terra <<EOF >/dev/null
$context
EOF
assert_file_contains "$work/app.log" 'space.new' 'dispatch creates a worktree space in herdr-app'
assert_file_contains "$log" 'herdr.space=s1' 'attempt terminal is labelled into the worktree space'
assert_file_contains "$log" 'herdr.tab=tb1' 'attempt terminal is labelled into the worktree tab'

# Reset invalidates execution while preserving Aven plan/status.
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- reset APP-1 --yes > "$work/reset"
assert_file_contains "$work/reset" 'reset complete for APP-1'
assert_eq "$(sqlite_count "$store")" 0 'reset removes the central attempt'
last_edit=$(grep 'aven edit APP-1' "$work/aven.log" | tail -n 1)
assert_not_contains "$last_edit" '--status' 'reset preserves task status'

printf 'rust dispatch ok\n'
