#!/usr/bin/env python3
"""Exercise Aven's terminal-context protocol with a real PTY, not stdin JSON."""

import errno
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import time


work = Path(sys.argv[1])
context = work / "terminal-context.json"
context.write_text(sys.argv[2])
log = Path(os.environ["RUST_DISPATCH_LOG"])


def exercise(name, choice, reopen=False):
    state = work / f"{name}.json"
    before = log.read_text()
    master, slave = pty.openpty()
    env = {
        **os.environ,
        "AVEN_COMMAND_CONTEXT": str(context),
        "AVEN_DISPATCH_STORE": str(state),
        "RUST_WORKTREE": str(work / name),
        "HERDR_PLUGIN_ENTRYPOINT_ID": "tui",
    }
    process = subprocess.Popen(
        ["cargo", "run", "--quiet", "--", "dispatch", "--agent", "select"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        start_new_session=True,
    )
    os.close(slave)
    output = b""

    def wait_for(text):
        nonlocal output
        deadline = time.monotonic() + 30
        while text not in output:
            assert time.monotonic() < deadline, output.decode(errors="replace")
            if select.select([master], [], [], 0.1)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                assert data, output.decode(errors="replace")
                output += data

    try:
        wait_for(b"Choice [1-1], or q to cancel:")
        # One available agent must still require input. No session, prompt, or
        # nested popup may be launched while this existing popup awaits a choice.
        calls = log.read_text()[len(before):]
        assert "POST /api/session" not in calls, calls
        assert "plugin pane open" not in calls, calls
        assert "pane.focus" not in calls, calls
        assert "--no-focus" in calls, calls
        assert state.exists() == reopen
        if reopen:
            assert b"reopen existing session" in output
        os.write(master, b"0\n")
        wait_for(b"Enter a number from 1 to 1, or q.")
        os.write(master, choice)
        result = process.wait(timeout=30)
        if choice == b"q\n":
            assert result != 0
            assert not state.exists()
            assert "POST /api/session" not in log.read_text()[len(before):]
            assert "pane.focus" not in log.read_text()[len(before):]
        else:
            assert result == 0, output.decode(errors="replace")
            attempt = next(iter(json.loads(state.read_text())["attempts"].values()))
            assert attempt["agent"] == "configured-build"
            assert attempt["state"] == "running"
            calls = log.read_text()[len(before):]
            assert "herdr-api pane.focus w1:p1" in calls
            if reopen:
                assert "POST /api/session" not in calls
            else:
                assert calls.index("POST /api/session/ses_one/prompt") < calls.index("herdr-api pane.focus")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        os.close(master)


exercise("terminal-selected", b"1\n")
exercise("terminal-cancelled", b"q\n")
exercise("terminal-selected", b"1\n", reopen=True)
print("terminal picker PTY checks passed")
