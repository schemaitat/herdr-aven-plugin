#!/usr/bin/env python3
"""Real Herdr + Aven popup test; only OpenCode and cargo installation are stubbed.

Run with `just test-e2e` inside Herdr. No third-party Python packages required.
Owns its Git repo, Aven DB/config, Herdr registry/session, worktrees, and PTY.
"""

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time


def normalized(data):
    # Herdr emits screen diffs: cursor moves can replace spaces between words.
    data = re.sub(rb"\x1b\].*?(?:\x07|\x1b\\)", b"", data, flags=re.S)
    data = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", data)
    return re.sub(rb"\s+", b"", data)


def main():
    if os.environ.get("HERDR_ENV") != "1":
        raise SystemExit("Run just test-e2e inside a Herdr-managed pane.")
    for program in ("herdr", "aven", "cargo", "git"):
        if shutil.which(program) is None:
            raise SystemExit(f"Required program not found: {program}")

    plugin = Path(__file__).resolve().parent.parent
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"], cwd=plugin
    ))
    dispatcher = Path(metadata["target_directory"]) / "debug" / "aven-dispatch"
    assert dispatcher.exists(), "Run cargo build first (or use just test-e2e)."
    scratch = "/tmp/opencode" if Path("/tmp/opencode").is_dir() else None
    root = Path(tempfile.mkdtemp(prefix="aven-popup-e2e-", dir=scratch))
    print(f"E2E artifacts (retained on failure): {root}", flush=True)
    repo, fake, config = root / "repo", root / "bin", root / "aven"
    for directory in (repo, fake, config):
        directory.mkdir()
    store = repo / ".aven-dispatch" / "state.json"
    calls, agents = root / "calls.jsonl", root / "agents.json"
    session = f"aven-popup-e2e-{os.getpid()}"
    env = {
        key: value for key, value in os.environ.items()
        if not key.startswith(("HERDR_", "AVEN_", "OPENCODE_", "GIT_"))
    }
    env.update({
        "TERM": "xterm-256color",
        "PATH": f"{fake}{os.pathsep}{os.environ['PATH']}",
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_DATA_HOME": str(root / "data"),
        "XDG_STATE_HOME": str(root / "state"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "HERDR_CONFIG_PATH": str(root / "herdr.toml"),
        "AVEN_CONFIG_DIR": str(config),
        "E2E_CALLS": str(calls),
        "E2E_AGENTS": str(agents),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
    })
    (root / "herdr.toml").write_text(
        'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n'
        f'[worktrees]\ndirectory = {json.dumps(str(root / "worktrees"))}\n'
        '[update]\nversion_check = false\nmanifest_check = false\n'
    )
    (config / "config.yaml").write_text(
        f'local:\n  db_path: {json.dumps(str(root / "db.sqlite"))}\n'
        'update:\n  automatic_checks: false\n'
    )
    agents.write_text(json.dumps([
        {"id": "build", "name": "Build", "model": {"providerID": "github-copilot", "id": "gpt-5.6-terra"}, "mode": "primary", "hidden": False}
    ]))
    (fake / "opencode").write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
record = {"argv": args[:3]}
if args[:2] == ["api", "POST"]:
    data = json.loads(args[args.index("--data") + 1])
        record.update({key: data[key] for key in ("agent", "id", "model") if key in data})
with open(os.environ["E2E_CALLS"], "a") as log:
    log.write(json.dumps(record) + "\\n")
if args[:3] == ["api", "GET", "/api/agent"]:
    with open(os.environ["E2E_AGENTS"]) as source:
        print(json.dumps({"data": json.load(source)}))
elif args[:3] == ["api", "POST", "/api/session"]:
    with open(os.environ["E2E_CALLS"]) as log:
        count = sum(json.loads(line)["argv"] == ["api", "POST", "/api/session"] for line in log)
    print(json.dumps({"data": {"id": "ses_popup_e2e_" + str(count)}}))
elif args[:2] == ["api", "POST"] and args[2].endswith("/prompt"):
    print(json.dumps({"data": {"id": data["id"]}}))
elif len(args) == 2 and args[0] == "--session" and args[1].startswith("ses_popup_e2e_"):
    print("E2E stub OpenCode terminal attached")
else:
    sys.exit("Unexpected OpenCode invocation: " + repr(args))
''')
    # Exercise the real command installer without installing into the user's
    # Cargo bin directory. Its resolved dispatcher is our already-built binary.
    (fake / "cargo").write_text('#!/bin/sh\n[ "$1" = install ]\n')
    (fake / "aven-dispatch").symlink_to(dispatcher)
    for program in ("opencode", "cargo"):
        (fake / program).chmod(0o755)

    def run(args, cwd=repo):
        return subprocess.run(
            args, env=env, cwd=cwd, text=True, capture_output=True,
            check=True, timeout=30,
        ).stdout

    run(["sh", str(plugin / "scripts/install-aven-command.sh")])
    assert "execution: terminal" in (config / "config.yaml").read_text()
    run(["herdr", "plugin", "link", str(plugin)])
    run(["git", "init", "-q", "-b", "development"])
    (repo / "README.md").write_text("Popup E2E fixture\n")
    run(["git", "add", "README.md"])
    run(["git", "-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid",
         "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"])
    run(["aven", "project", "create", "Popup E2E", "--path", str(repo)])
    created = run(["aven", "add", "POPUP_PICKER_E2E", "--project", "popup-e2e"])
    task_ref = created.split()[1]

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 164, 0, 0))
    client = subprocess.Popen(
        ["herdr", "--session", session], env=env, cwd=repo,
        stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
    )
    os.close(slave)
    output = b""
    passed = False

    def pump(seconds=0.1):
        nonlocal output
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not select.select([master], [], [], max(0, deadline - time.monotonic()))[0]:
                break
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            output += data
            # Answer ordinary terminal capability probes from the Herdr client.
            for query, reply in ((b"\x1b[6n", b"\x1b[1;1R"),
                                 (b"\x1b[c", b"\x1b[?1;2c"),
                                 (b"\x1b[?u", b"\x1b[?0u")):
                if query in data:
                    os.write(master, reply)

    def wait_until(predicate, description):
        deadline = time.monotonic() + 30
        while not predicate():
            assert time.monotonic() < deadline, f"Timeout: {description}; artifacts: {root}"
            assert client.poll() is None, f"Herdr client exited; artifacts: {root}"
            pump()

    def wait_text(text, start):
        wait_until(lambda: normalized(text) in normalized(output[start:]), repr(text))

    def snapshot():
        return json.loads(run(["herdr", "--session", session, "api", "snapshot"]))["result"]["snapshot"]

    def records():
        return [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    def posts():
        return [call for call in records() if call["argv"][:2] == ["api", "POST"]]

    def attempt(reference=task_ref):
        if store.exists():
            return next((attempt for attempt in json.loads(store.read_text())["attempts"].values()
                         if attempt["task_ref"] == reference), None)

    def open_aven(title=b"POPUP_PICKER_E2E"):
        start = len(output)
        deadline = time.monotonic() + 30
        # Admission/focus precedes the old Aven process exiting. Only retry an
        # explicitly rejected ui_busy request; never open overlapping popups.
        while True:
            try:
                run(["herdr", "--session", session, "plugin", "pane", "open",
                     "--plugin", "aven.tasks", "--entrypoint", "tui"])
                break
            except subprocess.CalledProcessError as error:
                assert json.loads(error.stderr)["error"]["code"] == "ui_busy", error.stderr
                assert time.monotonic() < deadline, "Previous Aven popup did not exit"
                pump()
        wait_text(title, start)
        pump(0.2)

    def invoke_picker():
        start = len(output)
        os.write(master, b"zd")
        wait_text(b"q to cancel:", start)
        assert snapshot()["focused_pane_id"] == origin_pane, "Focus moved before selection"
        return start

    try:
        wait_until(lambda: len(output) > 1000, "Herdr client startup")
        origin = snapshot()
        origin_pane, origin_workspace = origin["focused_pane_id"], origin["focused_workspace_id"]
        initial_worktrees = run(["git", "worktree", "list", "--porcelain"]).count("worktree ")
        open_aven()
        start = invoke_picker()
        wait_text(b"Choice [1-1]", start)
        assert not posts() and not store.exists(), "Single agent was auto-selected"
        invalid_start = len(output)
        os.write(master, b"0\n")
        wait_text(b"Enter a number from 1 to 1, or q.", invalid_start)
        assert snapshot()["focused_pane_id"] == origin_pane
        cancel_start = len(output)
        os.write(master, b"q\n")
        wait_text(b"POPUP_PICKER_E2E", cancel_start)
        assert not posts() and not store.exists(), "Cancellation admitted a session"
        assert run(["git", "worktree", "list", "--porcelain"]).count("worktree ") == initial_worktrees, \
            "Cancellation did not remove the newly created Herdr worktree"
        assert snapshot()["focused_pane_id"] == origin_pane
        assert json.loads(run(["aven", "context", task_ref, "--json"]))["task"]["status"] == "inbox"
        print("PASS: single-agent picker, invalid input, cancel, and original focus", flush=True)

        agents.write_text(json.dumps([
            {"id": "build", "name": "Build", "model": {"providerID": "github-copilot", "id": "gpt-5.6-terra"}, "mode": "primary"},
            {"id": "review", "name": "Review", "model": {"providerID": "github-copilot", "id": "gpt-5.6-terra"}, "mode": "primary"},
            {"id": "hidden", "mode": "primary", "hidden": True},
            {"id": "explore", "mode": "subagent"},
        ]))
        start = invoke_picker()
        wait_text(b"Choice [1-2]", start)
        assert not posts(), "Session was created before agent selection"
        os.write(master, b"2\n")
        wait_text(b"Select an OpenCode model", start)
        wait_text(b"Choice [1-8]", start)
        assert not posts(), "Session was created before model selection"
        os.write(master, b"2\n")
        wait_until(lambda: attempt() is not None and attempt()["state"] == "running"
                   and not attempt()["aven_update_pending"], "dispatch admission")
        selected = attempt()
        wait_until(lambda: snapshot()["focused_pane_id"] == selected["pane"], "worktree pane focus")
        assert selected["agent"] == "review"
        assert len(posts()) == 2 and posts()[0]["agent"] == "review", posts()
        assert posts()[0]["model"] == {"providerID": "github-copilot", "id": "gpt-5.5"}, posts()
        context = json.loads(run(["aven", "context", task_ref, "--json"]))
        assert context["task"]["status"] == "active" and context["notes"]
        print("PASS: chosen agent admitted once, Aven handoff saved, then worktree focused", flush=True)

        # Reopening an existing task must still ask, but must not admit again.
        run(["herdr", "--session", session, "workspace", "focus", origin_workspace])
        open_aven()
        start = invoke_picker()
        wait_text(b"reopen existing session", start)
        wait_text(b"Choice [1-1]", start)
        os.write(master, b"1\n")
        wait_text(b"Select an OpenCode model", start)
        os.write(master, b"1\n")
        wait_until(lambda: snapshot()["focused_pane_id"] == selected["pane"], "reopened pane focus")
        assert len(posts()) == 2, "Re-dispatch admitted a duplicate session/prompt"
        assert attempt()["session_id"] == selected["session_id"]
        print("PASS: reopen confirmation preserves the session and avoids duplicate prompts", flush=True)

        # The same task opened from a linked checkout must find the original
        # attempt, even without AVEN_DISPATCH_STORE in the server environment.
        origin_pane = selected["pane"]
        open_aven()
        start = invoke_picker()
        wait_text(b"reopen existing session", start)
        wait_text(b"Choice [1-1]", start)
        os.write(master, b"1\n")
        wait_text(b"Select an OpenCode model", start)
        os.write(master, b"1\n")
        wait_text(f"reopened {task_ref}".encode(), start)
        assert len(posts()) == 2, "Dispatch from a worktree created a duplicate attempt"
        assert attempt()["session_id"] == selected["session_id"]
        print("PASS: dispatch from a linked worktree reuses the repository's original attempt", flush=True)

        # Dispatch a different task while staying on the linked worktree's
        # branch. No checkout/switch to main should be necessary.
        run(["aven", "edit", task_ref, "--status", "done"])
        source = Path(selected["worktree"])
        main_branch = run(["git", "symbolic-ref", "HEAD"]).strip()
        source_branch = run(["git", "symbolic-ref", "HEAD"], cwd=source).strip()
        created = run(["aven", "add", "WORKTREE_PICKER_E2E", "--project", "popup-e2e"], cwd=source)
        worktree_ref = created.split()[1]
        open_aven(b"WORKTREE_PICKER_E2E")
        start = invoke_picker()
        wait_text(b"Choice [1-2]", start)
        assert len(posts()) == 2, "New worktree dispatch admitted before selection"
        os.write(master, b"1\n")
        wait_text(b"Select an OpenCode model", start)
        os.write(master, b"1\n")
        wait_until(lambda: attempt(worktree_ref) is not None and attempt(worktree_ref)["state"] == "running"
                   and not attempt(worktree_ref)["aven_update_pending"], "dispatch from linked worktree")
        child = attempt(worktree_ref)
        wait_until(lambda: snapshot()["focused_pane_id"] == child["pane"], "new worktree focus")
        assert child["aven"]["origin_cwd"] == str(source), child
        assert child["agent"] == "build" and len(posts()) == 4
        assert run(["git", "symbolic-ref", "HEAD"]).strip() == main_branch
        assert run(["git", "symbolic-ref", "HEAD"], cwd=source).strip() == source_branch
        assert not (source / ".aven-dispatch" / "state.json").exists(), "Worktree used a separate default store"
        listing = json.loads(run([str(dispatcher), "list"], cwd=source))
        assert {item["task_ref"] for item in listing} == {task_ref, worktree_ref}
        print("PASS: new task dispatch from a linked worktree; focus deferred and branches unchanged", flush=True)
        passed = True
    finally:
        (root / "client.ansi").write_bytes(output)
        # Never stop the caller's/default session, and never touch user configs.
        try:
            run(["herdr", "session", "stop", session, "--json"])
        finally:
            if client.poll() is None:
                client.terminate()
            client.wait(timeout=10)
            os.close(master)
        if passed:
            shutil.rmtree(root)


if __name__ == "__main__":
    main()
