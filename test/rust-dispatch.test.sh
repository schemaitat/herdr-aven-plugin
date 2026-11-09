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

cat > "$fake/aven" <<EOF
#!/bin/sh
exec python3 "$PLUGIN_ROOT/test/aven_fixture.py" "\$@"
EOF
export AVEN_FIXTURE_STATE=$work/aven-state.json
export AVEN_FIXTURE_LOG=$work/aven.log
export AVEN_FIXTURE_PREFIX=APP
seed_aven() {
python3 - "$AVEN_FIXTURE_STATE" <<'PY'
import json, sys

def task(ref, task_id, title, status="todo", epic=False, metadata=None, parent=None):
    return {
        "id": task_id, "ref": ref, "title": title, "status": status,
        "priority": "none", "deleted": False, "is_epic": epic, "project": "app",
        "description": "", "metadata": metadata or {}, "notes": [], "related": [],
        "depends_on": [], "epic_parent": parent,
    }

state = {"next": 1, "projects": {"app": "app"}, "tasks": {}}
for item in [
    task("APP-1", "immutable-task", 'quoted "task"'),
    task("APP-3", "bulk-task", "second selected task"),
    task("APP-4", "wrong-task", "stale target"),
    task("APP-2", "epic-task", "cumulative epic", epic=True,
         metadata={"sdd.plan-worked-out": "true", "sdd.plan-kind": "multi-phase"}),
    task("APP-P1", "phase-one", "first phase", parent="APP-2",
         metadata={"sdd.plan-root": "epic-task", "sdd.plan-phase": "1"}),
    task("APP-P2", "phase-two", "second phase", parent="APP-2",
         metadata={"sdd.plan-root": "epic-task", "sdd.plan-phase": "2"}),
]:
    state["tasks"][item["ref"]] = item
state["tasks"]["APP-P2"]["depends_on"] = ["APP-P1"]
json.dump(state, open(sys.argv[1], "w"), indent=2, sort_keys=True)
PY
}
seed_aven
cat > "$fake/opencode" <<'EOF'
#!/bin/sh
printf 'opencode %s\n' "$*" >> "$OPENCODE_LOG"
case " $* " in
  *" POST /api/session/"*"/prompt "*) data=; while [ "$#" -gt 0 ]; do [ "$1" = --data ] && { data=$2; break; }; shift; done; id=$(printf '%s' "$data" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); printf '{"data":{"id":"%s"}}\n' "$id" ;;
  *" POST /api/session "*) case "$*" in *'"agent":"aven-babysitter"'*) printf '%s\n' '{"data":{"id":"ses_babysitter"}}' ;; *) n=$(wc -l < "$OPENCODE_LOG"); printf '{"data":{"id":"ses_%s"}}\n' "$n" ;; esac ;;
  *" GET /api/session/ses_"*) if [ -n "${OPENCODE_OUTCOME:-}" ]; then printf '{"data":{"outcome":"%s"}}\n' "$OPENCODE_OUTCOME"; else printf '%s\n' '{"data":{}}'; fi ;;
  *" GET /api/session?limit=1 "*) printf '%s\n' '{"data":[]}' ;;
  *" GET /api/experimental/session/"*) printf 'id: 42\nevent: update\ndata: {}\n\n' ;;
  *" GET /api/agent "*" x-opencode-directory:"*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-6.1-terra"},"mode":"primary","hidden":false},{"id":"aven-babysitter","name":"Aven babysitter","mode":"primary","hidden":false},{"id":"aven-orchestrator","name":"Aven orchestrator","mode":"primary","hidden":false}]}' ;;
  *" GET /api/agent "*) printf '%s\n' '{"data":[{"id":"configured-build","name":"Configured build","model":{"providerID":"github-copilot","id":"gpt-6.1-terra"},"mode":"primary","hidden":false},{"id":"aven-babysitter","name":"Aven babysitter","mode":"primary","hidden":false},{"id":"aven-orchestrator","name":"Aven orchestrator","mode":"primary","hidden":false}]}' ;;
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
      addr=$(python3 -c 'import json,sys
lines=open(sys.argv[1]).read().splitlines()
labels=[json.loads(line) for line in lines if line.startswith("[\"label\"")]
print(labels[-1][1] if labels else "t1")' "$HC_FIXTURE_LOG" 2>/dev/null || printf 't1')
      printf '{"spaces":[{"id":"s1","name":"task","folder":"%s","tabs":[{"id":"tb1","active":true,"terminals":[{"terminal":"t-shell","pane":"p-shell"},{"terminal":"%s","pane":"p-agent"}]}]}]}\n' "$folder" "$addr"
    else
      printf '{"spaces":[]}\n'
    fi
    ;;
  do)
    printf 'app %s\n' "$*" >> "$FAKE_APP_LOG"
    case " $* " in
      *" space.new "*) folder=; while [ "$#" -gt 0 ]; do [ "$1" = --folder ] && { folder=$2; break; }; shift; done; printf '%s' "$folder" > "$FAKE_APP_STATE"; printf '{"space":"s1","tab":"tb1","terminal":"t-shell"}\n' ;;
      *) printf '{}\n' ;;
    esac
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
bulk_context='{"version":1,"invocation":{"origin_cwd":"'"$repo"'"},"targeting":{"targets":[{"id":"immutable-task","ref":"APP-1"},{"id":"bulk-task","ref":"APP-3"}]},"selection":{"primary":{"ref":"APP-1","task":{"id":"immutable-task","title":"quoted \"task\""},"project":{"key":"app"}}}}'

PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF >/dev/null
$context
EOF

# Worktrees are created only through hc exec/git; the checkout follows the
# shared ~/.herdr/worktrees convention.
worktree=$work/worktrees/repo/feat-app-1-quoted-task-dispatch-immutable-task
[ -d "$worktree" ] || fail "dispatch did not create the expected worktree"
[ "$(git -C "$worktree" rev-parse --abbrev-ref HEAD)" = "feat/app-1-quoted-task-dispatch-immutable-task" ] || fail "worktree branch"
assert_file_contains "$log" '"exec"' 'worktree operations use hc exec'
assert_file_contains "$log" '"worktree", "add"' 'hc exec runs git worktree add'
assert_file_contains "$log" '"run"' 'agent launch uses hc run'
assert_file_contains "$log" "$fake/opencode" 'terminal launch uses the resolved OpenCode executable'
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

# A selected-task batch preserves target order and admits one independent
# worktree/session/prompt per target.
seed_aven
bulk_store=$work/bulk.sqlite
before=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$bulk_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF >/dev/null
$bulk_context
EOF
after=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
assert_eq "$after" "$((before + 2))" 'bulk dispatch admits every selected target independently'
[ -d "$work/worktrees/repo/feat-app-1-quoted-task-dispatch-immutable-task" ] || fail 'bulk dispatch creates first selected worktree'
[ -d "$work/worktrees/repo/feat-app-3-second-selected-task-dispatch-bulk-task" ] || fail 'bulk dispatch creates second selected worktree'
sqlite_json "$bulk_store" > "$work/explicit-bulk.json"
python3 - "$work/explicit-bulk.json" <<'PY'
import json, sys
attempts = json.load(open(sys.argv[1]))['attempts']
assert len(attempts) == 2, attempts
for attempt in attempts.values():
    assert (attempt['workflow'], attempt['execution_mode'], attempt['agent'], attempt['model']) == (
        'implementation', 'single-session', 'build', 'github-copilot/gpt-6.1-terra'), attempt
PY

# Exercise actual inline mode/agent/model pickers in a pseudo-terminal. The
# second new attempt must reuse all choices rather than prompting again.
seed_aven
printf '%s\n' "$bulk_context" > "$work/bulk-context.json"
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$work/interactive-bulk.sqlite" python3 "$PLUGIN_ROOT/test/bulk-dispatch-pty.py" "$work/bulk-context.json" "$work/interactive-bulk.out" 2 none "$PLUGIN_ROOT/target/debug/aven-dispatch" dispatch --agent select --preferred-agent configured-build --preferred-model github-copilot/gpt-6.1-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills"
sqlite_json "$work/interactive-bulk.sqlite" > "$work/interactive-bulk.json"
python3 - "$work/interactive-bulk.json" <<'PY'
import json, sys
attempts = json.load(open(sys.argv[1]))['attempts']
assert len(attempts) == 2, attempts
for attempt in attempts.values():
    assert (attempt['workflow'], attempt['execution_mode'], attempt['agent'], attempt['model']) == (
        'implementation', 'subsessions', 'configured-build', 'github-copilot/gpt-6.1-terra'), attempt
PY
# Reopening an entirely existing batch asks for no new configuration.
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$work/interactive-bulk.sqlite" python3 "$PLUGIN_ROOT/test/bulk-dispatch-pty.py" "$work/bulk-context.json" "$work/existing-bulk.out" 2 existing "$PLUGIN_ROOT/target/debug/aven-dispatch" dispatch --agent select --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills"

# A dry run still selects the implementation mode only once, without starting
# agent/model pickers or sessions.
seed_aven
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$work/dry-bulk.sqlite" python3 "$PLUGIN_ROOT/test/bulk-dispatch-pty.py" "$work/bulk-context.json" "$work/dry-bulk.out" 2 dry-run "$PLUGIN_ROOT/target/debug/aven-dispatch" dispatch --dry-run --agent select --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills"

# Reopening a saved single-session attempt does not prompt or seed settings for
# the new subsession attempt; the explicit mode of the saved attempt survives.
seed_aven
mixed_store=$work/mixed-bulk.sqlite
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$mixed_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-sol --mode single-session --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF >/dev/null
$context
EOF
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$mixed_store" python3 "$PLUGIN_ROOT/test/bulk-dispatch-pty.py" "$work/bulk-context.json" "$work/mixed-bulk.out" 2 none "$PLUGIN_ROOT/target/debug/aven-dispatch" dispatch --agent select --preferred-agent configured-build --preferred-model github-copilot/gpt-6.1-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills"
sqlite_json "$mixed_store" > "$work/mixed-bulk.json"
python3 - "$work/mixed-bulk.json" <<'PY'
import json, sys
attempts = json.load(open(sys.argv[1]))['attempts']
old = attempts['immutable-task:implementation']
new = attempts['bulk-task:implementation']
assert (old['execution_mode'], old['agent'], old['model']) == ('single-session', 'build', 'github-copilot/gpt-6.1-sol'), old
assert (new['execution_mode'], new['agent'], new['model']) == ('subsessions', 'configured-build', 'github-copilot/gpt-6.1-terra'), new
PY

# Canceling the shared agent choice cannot admit either task.
seed_aven
before=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$work/canceled-bulk.sqlite" python3 "$PLUGIN_ROOT/test/bulk-dispatch-pty.py" "$work/bulk-context.json" "$work/canceled-bulk.out" 1 agent "$PLUGIN_ROOT/target/debug/aven-dispatch" dispatch --agent select --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills"
after=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
assert_eq "$after" "$before" 'canceling shared configuration admits no task'
assert_eq "$(sqlite_count "$work/canceled-bulk.sqlite")" 0 'canceled selection removes its reservation'
seed_aven
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$work/canceled-model-bulk.sqlite" python3 "$PLUGIN_ROOT/test/bulk-dispatch-pty.py" "$work/bulk-context.json" "$work/canceled-model-bulk.out" 1 model "$PLUGIN_ROOT/target/debug/aven-dispatch" dispatch --agent select --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills"
after=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
assert_eq "$after" "$before" 'canceling shared model admits no task'
assert_eq "$(sqlite_count "$work/canceled-model-bulk.sqlite")" 0 'canceled model removes its reservation'

# A marked batch is dispatched identically when focus sits on a task that is
# not marked; the focused selection never takes part in the batch.
seed_aven
detached_context='{"version":1,"invocation":{"origin_cwd":"'"$repo"'"},"targeting":{"targets":[{"id":"immutable-task","ref":"APP-1"},{"id":"bulk-task","ref":"APP-3"}]},"selection":{"primary":{"ref":"APP-9","task":{"id":"focused-elsewhere","title":"focused elsewhere"},"project":{"key":"app"}}}}'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$work/detached-bulk.sqlite" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF > "$work/detached"
$detached_context
EOF
assert_file_lacks "$work/opencode.log" 'focused-elsewhere' 'focused task outside the marks never joins the batch'
assert_file_contains "$work/detached" 'APP-3' 'marked batch still includes the selected target'

# Malformed batches are rejected during preflight before a worktree or session
# can be created for any selected task.
before=$(wc -l < "$work/opencode.log")
set +e
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$work/invalid-bulk.sqlite" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra <<EOF >/dev/null 2>&1
{"version":1,"invocation":{"origin_cwd":"$repo"},"targeting":{"targets":[{"id":"duplicate","ref":"APP-1"},{"id":"duplicate","ref":"APP-3"}]}}
EOF
rc=$?
set -e
assert_eq "$rc" "1" 'duplicate selected targets fail preflight'
assert_eq "$(wc -l < "$work/opencode.log")" "$before" 'invalid batch has no OpenCode side effects'

# Every target is re-read before the first target is admitted, so a stale ID in
# a later selection is also rejected without partially dispatching the batch.
before=$(wc -l < "$work/opencode.log")
set +e
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$work/stale-bulk.sqlite" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra <<EOF >/dev/null 2>&1
{"version":1,"invocation":{"origin_cwd":"$repo"},"targeting":{"targets":[{"id":"immutable-task","ref":"APP-1"},{"id":"expected-task","ref":"APP-4"}]}}
EOF
rc=$?
set -e
assert_eq "$rc" "1" 'stale selected target fails preflight'
assert_eq "$(wc -l < "$work/opencode.log")" "$before" 'stale batch has no partial dispatch'

before=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF > "$work/reopen"
$context
EOF
after=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
assert_eq "$after" "$before" 're-dispatch never admits a second prompt'
assert_file_contains "$work/reopen" 'reopened APP-1' 're-dispatch reopens the durable session'
runs=$(grep -c '"run"' "$log")
[ "$runs" -ge 1 ] || fail 'reopen should have a persisted terminal'

# The Kanban Enter action reopens a closed worktree non-interactively. Killing
# the saved terminal simulates a closed space; reopen must relaunch the same
# durable OpenCode session and report the new terminal instead of prompting.
sqlite_json "$store" > "$work/before-explicit-reopen.json"
old_terminal=$(python3 - "$work/before-explicit-reopen.json" <<'PY'
import json, sys
attempt = json.load(open(sys.argv[1]))['attempts']['immutable-task:implementation']
print(attempt['terminal']['address'])
PY
)
[ -n "$old_terminal" ] || fail 'the saved attempt has a terminal to close'
"$HC_BIN" kill "$old_terminal" >/dev/null
sessions_before=$(grep -c -- '--session' "$log" || true)
runs_before=$(grep -c '"run"' "$log" || true)
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- reopen APP-1 --json > "$work/reopen-json"
python3 - "$work/reopen-json" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
assert payload['task_ref'] == 'APP-1', payload
assert payload['workflow'] == 'implementation', payload
assert payload['session_id'].startswith('ses_'), payload
assert payload['worktree'].endswith('app-quoted-task-dispatch-immutable-task'), payload
assert payload['terminal'], payload
PY
assert_eq "$(grep -c -- '--session' "$log" || true)" "$((sessions_before + 1))" 'reopen relaunches the saved OpenCode session'
assert_eq "$(grep -c '"run"' "$log" || true)" "$((runs_before + 1))" 'reopen launches exactly one replacement terminal'
new_terminal=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["terminal"])' "$work/reopen-json")
[ "$new_terminal" != "$old_terminal" ] || fail 'reopen reports the replacement terminal, not the closed one'
grep -F -- '"--session"' "$log" >/dev/null || fail 'reopen passes the durable session id to OpenCode'
# Accepted or canceled tasks are inert: reopen must never restart their agent.
python3 - "$AVEN_FIXTURE_STATE" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
state['tasks']['APP-1']['status'] = 'done'
json.dump(state, open(sys.argv[1], 'w'), indent=2, sort_keys=True)
PY
before_failed=$(grep -c '"run"' "$log")
set +e
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- reopen APP-1 --json > "$work/reopen-terminal.out" 2>&1
rc=$?
set -e
assert_eq "$rc" "1" 'reopen refuses a terminal task'
assert_file_contains "$work/reopen-terminal.out" 'terminal tasks are inert' 'terminal reopen explains the refusal'
assert_eq "$(grep -c '"run"' "$log")" "$before_failed" 'refused reopen launches no terminal'

# Babysitting is opt-in: a second API session and a separate owned terminal.
seed_aven
babysitter_store=$work/babysitter.sqlite
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$babysitter_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --babysitter <<EOF >/dev/null
$context
EOF
assert_contains "$(sqlite_json "$babysitter_store")" '"babysitter": true' 'babysitter opt-in persisted'
assert_contains "$(sqlite_json "$babysitter_store")" '"babysitter_model": "github-copilot/gpt-6-luna"' 'default babysitter model persisted'
assert_contains "$(sqlite_json "$babysitter_store")" '"role": "babysitter"' 'babysitter terminal ownership persisted'
assert_file_contains "$work/opencode.log" 'ses_babysitter' 'babysitter API session created and admitted'
assert_file_contains "$log" 'aven.role=babysitter' 'babysitter terminal carries its role label'
grep -F '"agent":"aven-babysitter","location"' "$work/opencode.log" | grep -F '"model":{"id":"gpt-6-luna","providerID":"github-copilot"}' >/dev/null \
  || fail 'default babysitter session uses Luna'
grep -F '"agent":"build","location"' "$work/opencode.log" | grep -F '"model":{"id":"gpt-6.1-terra","providerID":"github-copilot"}' >/dev/null \
  || fail 'builder keeps its selected model'

# An explicit babysitter override changes only the babysitter payload and is
# persisted for later recovery.
seed_aven
override_store=$work/babysitter-override.sqlite
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$override_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --babysitter --babysitter-model github-copilot/gpt-5.5 <<EOF >/dev/null
$context
EOF
assert_contains "$(sqlite_json "$override_store")" '"babysitter_model": "github-copilot/gpt-5.5"' 'babysitter override persisted'
grep -F '"agent":"aven-babysitter","location"' "$work/opencode.log" | tail -n 1 | grep -F '"model":{"id":"gpt-5.5","providerID":"github-copilot"}' >/dev/null \
  || fail 'configured babysitter session uses its override'
grep -F '"agent":"build","location"' "$work/opencode.log" | tail -n 1 | grep -F '"model":{"id":"gpt-6.1-terra","providerID":"github-copilot"}' >/dev/null \
  || fail 'babysitter override leaves the builder model unchanged'

# The environment variable is an equivalent configuration surface.
seed_aven
env_store=$work/babysitter-env.sqlite
AVEN_DISPATCH_BABYSITTER_MODEL=github-copilot/gpt-6-astra PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$env_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --babysitter <<EOF >/dev/null
$context
EOF
assert_contains "$(sqlite_json "$env_store")" '"babysitter_model": "github-copilot/gpt-6-astra"' 'babysitter model environment variable persisted'
grep -F '"agent":"aven-babysitter","location"' "$work/opencode.log" | tail -n 1 | grep -F '"model":{"id":"gpt-6-astra","providerID":"github-copilot"}' >/dev/null \
  || fail 'babysitter model environment variable selects the session model'

# Reopening after a failed sidecar launch reuses the saved model rather than a
# newly supplied override.
python3 - "$override_store" <<'PY2'
import json, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    task_id, workflow, payload = db.execute("SELECT task_id, workflow, payload FROM attempts").fetchone()
    attempt = json.loads(payload)
    attempt["babysitter_session_id"] = ""
    attempt["babysitter_terminal"] = {}
    attempt["terminals"].pop("babysitter", None)
    attempt["state"] = "running"
    db.execute("UPDATE attempts SET payload = ? WHERE task_id = ? AND workflow = ?", (json.dumps(attempt), task_id, workflow))
    db.commit()
PY2
babysitter_sessions=$(grep -c '"agent":"aven-babysitter"' "$work/opencode.log")
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$override_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --babysitter --babysitter-model github-copilot/gpt-6.1-sol <<EOF > "$work/babysitter-reopen"
$context
EOF
assert_eq "$(grep -c '"agent":"aven-babysitter"' "$work/opencode.log")" "$((babysitter_sessions + 1))" 'missing babysitter sidecar is recreated on reopen'
grep -F '"agent":"aven-babysitter","location"' "$work/opencode.log" | tail -n 1 | grep -F '"model":{"id":"gpt-5.5","providerID":"github-copilot"}' >/dev/null \
  || fail 'missing-sidecar retry reuses the saved babysitter model'

# Invalid model syntax fails through the existing model_ref validation path.
seed_aven
invalid_store=$work/babysitter-invalid.sqlite
set +e
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$invalid_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --babysitter --babysitter-model not-a-model <<EOF > "$work/babysitter-invalid" 2>&1
$context
EOF
rc=$?
set -e
assert_eq "$rc" "1" 'invalid babysitter model fails session creation'
assert_file_contains "$work/babysitter-invalid" 'must use provider/model form' 'invalid babysitter model uses the model_ref validation path'

addresses=$(python3 - "$babysitter_store" <<'PY'
import json, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    payload = json.loads(db.execute("SELECT payload FROM attempts LIMIT 1").fetchone()[0])
print(payload["terminal"]["address"], payload["babysitter_terminal"]["address"])
PY
)
builder_address=${addresses% *}
babysitter_address=${addresses#* }
assert_file_contains "$work/opencode.log" "herdr-core terminal $builder_address for task" 'babysitter prompt names the builder terminal'
assert_file_lacks "$work/opencode.log" "herdr-core terminal $babysitter_address for task" 'babysitter prompt never names its own terminal'

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
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$pending_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF > "$work/pending-retry"
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
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$incomplete_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF > "$work/incomplete-retry"
$context
EOF
after=$(grep -c 'POST /api/session/.*/prompt' "$work/opencode.log")
assert_eq "$after" "$((before + 1))" 'incomplete reservation is discarded and admitted once'
assert_file_contains "$work/incomplete-retry" 'admitted APP-1' 'incomplete reservation starts a fresh dispatch'
[ -d "$work/worktrees/repo/feat-app-1-quoted-task-dispatch-immutable-task" ] || fail 'fresh dispatch recreated the worktree'

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
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$legacy_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-plan-implement --skills-dir "$PLUGIN_ROOT/skills" <<EOF > "$work/legacy" 2>&1
$context
EOF
rc=$?
set -e
assert_eq "$rc" "1" 'legacy attempt requires explicit relaunch'
assert_file_contains "$work/legacy" 'retired herdr runtime' 'legacy refusal explains the migration'

# Cumulative worktrees: coordinator plus one worker checkout per ordered phase.
assert_file_lacks "$work/opencode.log" '"agent":"aven-orchestrator"' 'non-worktree dispatch does not create an orchestrator'
seed_aven
cumulative_store=$work/cumulative.sqlite
cumulative_context='{"version":1,"invocation":{"origin_cwd":"'"$repo"'"},"targeting":{"targets":[{"id":"epic-task","ref":"APP-2"}]},"selection":{"primary":{"ref":"APP-2","task":{"id":"epic-task","title":"cumulative epic"},"project":{"key":"app"}}}}'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$cumulative_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-implement --skills-dir "$PLUGIN_ROOT/skills" --mode worktrees <<EOF >/dev/null
$cumulative_context
EOF
for phase in phase-01 phase-02; do
  [ -d "$work/worktrees/repo/feat-app-2-cumulative-epic-dispatch-epic-task-$phase" ] || fail "missing $phase worktree"
done
assert_file_contains "$log" 'feat/app-2-cumulative-epic-dispatch-epic-task-phase-01' 'first phase branch created'
assert_file_contains "$log" 'feat/app-2-cumulative-epic-dispatch-epic-task-phase-02' 'second phase branch created'
assert_contains "$(sqlite_json "$cumulative_store")" '"state": "provisioned"' 'blocked successor stays provisioned'
assert_contains "$(sqlite_json "$cumulative_store")" '"state": "running"' 'first phase is admitted'
assert_contains "$(sqlite_json "$cumulative_store")" '"role": "phase"' 'phase terminal ownership persisted'

# The worktree coordinator defaults to Luna while each phase worker keeps the
# selected worker model.
grep -F '"agent":"aven-orchestrator","location"' "$work/opencode.log" | tail -n 1 | grep -F '"model":{"id":"gpt-6-luna","providerID":"github-copilot"}' >/dev/null \
  || fail 'worktree coordinator defaults to Luna'
assert_contains "$(sqlite_json "$cumulative_store")" '"coordinator_model": "github-copilot/gpt-6-luna"' 'default coordinator model persisted'
for phase in phase-01 phase-02; do
  grep -F '"agent":"build","location"' "$work/opencode.log" | grep -F "feat-app-2-cumulative-epic-dispatch-epic-task-$phase" | tail -n 1 | grep -F '"model":{"id":"gpt-6.1-terra","providerID":"github-copilot"}' >/dev/null \
    || fail "phase worker $phase keeps the selected worker model"
done

# An orchestrator override changes only the coordinator payload and persists
# through coordinator_model.
seed_aven
orchestrator_store=$work/orchestrator-override.sqlite
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$orchestrator_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-implement --skills-dir "$PLUGIN_ROOT/skills" --mode worktrees --orchestrator-model github-copilot/gpt-5.5 <<EOF >/dev/null
$cumulative_context
EOF
assert_contains "$(sqlite_json "$orchestrator_store")" '"coordinator_model": "github-copilot/gpt-5.5"' 'coordinator override persisted'
grep -F '"agent":"aven-orchestrator","location"' "$work/opencode.log" | tail -n 1 | grep -F '"model":{"id":"gpt-5.5","providerID":"github-copilot"}' >/dev/null \
  || fail 'configured coordinator session uses its override'
for phase in phase-01 phase-02; do
  grep -F '"agent":"build","location"' "$work/opencode.log" | grep -F "feat-app-2-cumulative-epic-dispatch-epic-task-$phase" | tail -n 1 | grep -F '"model":{"id":"gpt-6.1-terra","providerID":"github-copilot"}' >/dev/null \
    || fail "coordinator override leaves phase worker $phase on the worker model"
done

# Invalid coordinator syntax fails through the shared model_ref validation path.
seed_aven
invalid_orchestrator_store=$work/orchestrator-invalid.sqlite
set +e
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$invalid_orchestrator_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-implement --skills-dir "$PLUGIN_ROOT/skills" --mode worktrees --orchestrator-model not-a-model <<EOF > "$work/orchestrator-invalid" 2>&1
$cumulative_context
EOF
rc=$?
set -e
assert_eq "$rc" "1" 'invalid orchestrator model fails session creation'
assert_file_contains "$work/orchestrator-invalid" 'must use provider/model form' 'invalid orchestrator model uses the model_ref validation path'

# Bounded reconcile and watcher status are explicit, repeatable operations.
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- watch --once > "$work/watch-once"
assert_file_contains "$work/watch-once" 'reconciled' 'watch --once reconciles persisted attempts'
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- watch --status > "$work/watch-status"
assert_file_contains "$work/watch-status" '"store"' 'watcher status reports its store'

# With herdr-app available, a dispatched worktree gets a sidebar space and the
# attempt terminal is labelled into that space's tab.
seed_aven
app_store=$work/app.sqlite
FAKE_APP=1 PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$app_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --babysitter <<EOF >/dev/null
$context
EOF
assert_file_contains "$work/app.log" 'space.new' 'dispatch creates a worktree space in herdr-app'
assert_file_lacks "$work/app.log" 'pane.split' 'dispatch no longer splits an Aven worktree pane'
assert_file_lacks "$work/app.log" 'aven-worktree' 'dispatch no longer opens the retired panel mod'
assert_file_contains "$log" '"kill"' 'the placeholder shell is removed after labelling'
assert_file_contains "$log" '"t-shell"' 'the removed terminal is the space.new placeholder'
assert_file_contains "$log" 'herdr.space=s1' 'attempt terminal is labelled into the worktree space'
assert_file_contains "$log" 'herdr.tab=tb1' 'attempt terminal is labelled into the worktree tab'

# The worker establishes the task layout; its babysitter joins that existing
# worktree tab without creating another companion pane or placeholder space.
# The sidecar is deliberately started after the worker is admitted.
assert_eq "$(grep -c 'space.new' "$work/app.log")" 1 'babysitter reuses the worker worktree space'
assert_file_lacks "$work/app.log" 'pane.split' 'babysitter never creates a panel pane'
assert_file_contains "$work/app.log" 'pane.focus --terminal t' 'sidecar layout restores focus to the worker or sidecar terminal'

# Cumulative dispatch keeps the coordinator and every phase worker in their
# own worktree space and never splits a panel into any of them.
seed_aven
app_worktree_store=$work/app-worktree.sqlite
FAKE_APP=1 PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$app_worktree_store" cargo run --quiet -- dispatch --agent build --model github-copilot/gpt-6.1-terra --skill aven/sdd-implement --skills-dir "$PLUGIN_ROOT/skills" --mode worktrees <<EOF >/dev/null
$cumulative_context
EOF
assert_file_lacks "$work/app.log" 'pane.split' 'coordinator and phase workers receive no panel pane'
assert_file_contains "$work/app.log" 'feat-app-2-cumulative-epic-dispatch-epic-task-phase-01' 'first phase gets a separate worktree space'
assert_file_contains "$work/app.log" 'feat-app-2-cumulative-epic-dispatch-epic-task-phase-02' 'second phase gets a separate worktree space'
assert_file_contains "$work/app.log" 'feat-app-2-cumulative-epic-dispatch-epic-task' 'coordinator gets its root worktree space'

# Reset invalidates execution while preserving Aven plan/status.
PATH="$fake:$PATH" AVEN_DISPATCH_STORE="$store" cargo run --quiet -- reset APP-1 --yes > "$work/reset"
assert_file_contains "$work/reset" 'reset complete for APP-1'
assert_eq "$(sqlite_count "$store")" 0 'reset removes the central attempt'
last_edit=$(grep 'aven edit APP-1' "$work/aven.log" | tail -n 1)
assert_not_contains "$last_edit" '--status' 'reset preserves task status'

printf 'rust dispatch ok\n'
