#!/usr/bin/env python3
"""PTY checks for the dispatcher inspector terminal lifecycle.

The fixture snapshot avoids live Aven/OpenCode/Herdr reads, so the test only
exercises the real terminal runtime, key handling and restoration paths.
"""
import fcntl
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import time

binary, fixture = sys.argv[1], sys.argv[2]
env = dict(os.environ)
env["AVEN_DISPATCH_TUI_FIXTURE"] = fixture
env.pop("AVEN_DISPATCH_STORE", None)
ALT_ENTER = b"\x1b[?1049h"
ALT_LEAVE = b"\x1b[?1049l"
HIDE = b"\x1b[?25l"
SHOW = b"\x1b[?25h"


def spawn(environment=None, args=None):
    child_env = environment or env
    argv = [binary, *(args or ["tui"])]
    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(binary, argv, child_env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    return pid, fd


def read_until(fd, needles, deadline):
    output = b""
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        if any(needle in output for needle in needles):
            return output, True
    return output, False


def wait_exit(pid, deadline):
    status = None
    while time.time() < deadline:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            return status
        time.sleep(0.02)
    try:
        os.kill(pid, 9)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    raise AssertionError("inspector did not exit before the deadline")


def run_keys(steps, timeout=5.0, environment=None, initial=b"APP-1", args=None):
    pid, fd = spawn(environment, args)
    deadline = time.time() + timeout
    output = b""
    try:
        chunk, ok = read_until(fd, [initial], deadline)
        output += chunk
        assert ok, f"initial frame missing APP-1: {output[-500:]!r}"
        for key, marker in steps:
            os.write(fd, key)
            if marker:
                chunk, ok = read_until(fd, [marker], deadline)
                output += chunk
                assert ok, f"marker {marker!r} missing after {key!r}: {output[-500:]!r}"
        status = wait_exit(pid, deadline)
        drain_until = time.time() + 0.5
        while time.time() < drain_until:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if not ready:
                break
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    return status, output


start = time.time()
status, output = run_keys(
    [
        (b"?", b"Dispatcher"),
        (b"?", None),
        (b"q", None),
    ]
)
elapsed = time.time() - start
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, f"quit exit {status}"
for sequence, name in [
    (ALT_ENTER, "alternate screen enter"),
    (ALT_LEAVE, "alternate screen leave"),
    (HIDE, "cursor hide"),
    (SHOW, "cursor show"),
]:
    assert sequence in output, f"missing {name}: {output[-800:]!r}"
assert elapsed < 3.0, f"help/quit took {elapsed:.2f}s"
print(f"tui help/quit ok in {elapsed:.3f}s")

status, output = run_keys([(b"\x03", None)])
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, f"ctrl-c exit {status}"
assert ALT_ENTER in output and ALT_LEAVE in output and SHOW in output
print("tui ctrl-c restoration ok")

# A startup failure after raw mode/alternate-screen initialization must restore
# the terminal and exit non-zero.
bad_env = dict(env)
bad_env["AVEN_DISPATCH_TUI_FIXTURE"] = fixture + ".missing"
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(binary, [binary, "tui"], bad_env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
output, _ = read_until(fd, [], time.time() + 3)
status = wait_exit(pid, time.time() + 3)
os.close(fd)
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) != 0, f"missing fixture exit {status}"
assert ALT_LEAVE in output and SHOW in output, f"startup error did not restore: {output[-800:]!r}"
print("tui startup-error restoration ok")

# Non-TTY use fails with an actionable diagnostic instead of emitting control
# sequences into a pipe.
result = subprocess.run(
    [binary, "tui"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env,
    timeout=5,
)
assert result.returncode != 0
assert b"interactive terminal" in result.stderr, result.stderr
assert ALT_ENTER not in result.stdout
help_result = subprocess.run(
    [binary, "tui", "--help"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env,
    timeout=5,
)
assert help_result.returncode == 0, help_result.stderr
assert b"dispatcher inspector" in help_result.stdout
for flag in (b"--project", b"--workspace", b"--cwd"):
    assert flag in help_result.stdout, f"missing {flag!r} in tui help"
print("tui non-TTY and help checks ok")


# Exact Enter navigation in an isolated inherited-session fixture. The fake
# Herdr CLI provides fresh topology; the existing Unix-socket fixture logs
# pane.focus and never contacts a real Herdr session.
import json
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
work = tempfile.mkdtemp(prefix="aven-tui-focus.")
fake_bin = os.path.join(work, "bin")
os.makedirs(fake_bin)
snapshot_path = os.path.join(work, "snapshot.json")
socket_path = os.path.join(work, "herdr.sock")
focus_log = os.path.join(work, "focus.log")


def write_snapshot(panes):
    with open(snapshot_path, "w", encoding="utf-8") as handle:
        json.dump({"result": {"snapshot": {"panes": panes}}}, handle)


def pane(pane_id, session, workspace="w1", tab="w1:t1"):
    return {
        "address": pane_id,
        "workspace_id": workspace,
        "tab_id": tab,
        "cwd": "/repo/wt",
        "agent_session": {"kind": "id", "value": session},
    }


with open(os.path.join(fake_bin, "hc"), "w", encoding="utf-8") as handle:
    handle.write(
        "#!/bin/sh\n"
        'printf "hc %s\\n" "$*" >> "$TUI_FOCUS_LOG"\n'
        'if [ "$1 $2 $3" = "server status --json" ]; then printf \'%s\\n\' \'{"core":{"id":"core","name":"core"}}\'; exit 0; fi\n'
        'if [ "$1" = "get" ]; then\n'
        '  case "$2" in\n'
        '    t1) attempt=a1 ;;\n'
        '    t2) attempt=a2 ;;\n'
        '    *) exit 1 ;;\n'
        '  esac\n'
        '  task=task-one\n'
        '  [ "${TUI_HC_MISMATCH:-}" = 1 ] && task=other\n'
        '  printf \'%s\\n\' "{\\\"address\\\":\\\"$2\\\",\\\"name\\\":\\\"terminal\\\",\\\"state\\\":\\\"live\\\",\\\"status\\\":\\\"idle\\\",\\\"labels\\\":{\\\"aven.task_id\\\":\\\"$task\\\",\\\"aven.attempt_id\\\":\\\"$attempt\\\"}}"\n'
        '  exit 0\n'
        'fi\n'
        "exit 1\n"
    )
os.chmod(os.path.join(fake_bin, "hc"), 0o755)
with open(os.path.join(fake_bin, "herdr-app"), "w", encoding="utf-8") as handle:
    handle.write(
        "#!/bin/sh\n"
        'printf "app %s\\n" "$*" >> "$TUI_FOCUS_LOG"\n'
        "exit 0\n"
    )
os.chmod(os.path.join(fake_bin, "herdr-app"), 0o755)


def focus_env(fixture_path, extra=None):
    result = dict(env)
    result.update(
        {
            "AVEN_DISPATCH_TUI_FIXTURE": fixture_path,
            "HC_BIN": os.path.join(fake_bin, "hc"),
            "PATH": fake_bin + os.pathsep + result["PATH"],
            "TUI_FOCUS_LOG": focus_log,
        }
    )
    if extra:
        result.update(extra)
    return result


def focus_lines(path):
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as handle:
        return [line.strip() for line in handle if line.strip()]


def app_focus_lines(path):
    return [line for line in focus_lines(path) if line.startswith("app do pane.focus")]


status, output = run_keys(
    [(b"\r", b"request"), (b"q", None)],
    environment=focus_env(fixture),
)
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
lines = focus_lines(focus_log)
assert "app do pane.focus --terminal t1" in lines, lines
assert "app do terminal.peek --terminal t1" not in lines, lines
assert b"pane.focus" not in output
print("tui explicit Enter focused exactly one terminal")

# Inspection, movement, search, refresh, help and quit cause no reveal/focus.
before = len(focus_lines(focus_log))
status, _ = run_keys(
    [
        (b"j", None),
        (b"k", None),
        (b"/APP", None),
        (b"\r", None),
        (b"r", None),
        (b"?", b"Dispatcher"),
        (b"?", None),
        (b"q", None),
    ],
    environment=focus_env(fixture),
)
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
assert len(focus_lines(focus_log)) == before, focus_lines(focus_log)
print("tui non-Enter actions performed no focus call")

# Multiple candidates open a chooser; cancellation performs no focus.
with open(fixture, "r", encoding="utf-8") as handle:
    multi = json.load(handle)
second = dict(multi["candidates"][0])
second.update(
    {
        "pane_id": "t2",
        "workspace_id": "app / 1",
        "workflow": "planning",
        "attempt_id": "a2",
        "role": "coordinator",
        "labels": [["aven.task_id", "task-one"], ["aven.attempt_id", "a2"]],
    }
)
multi["candidates"] = [multi["candidates"][0], second]
multi_path = os.path.join(work, "multi.json")
with open(multi_path, "w", encoding="utf-8") as handle:
    json.dump(multi, handle)
before = len(focus_lines(focus_log))
status, _ = run_keys(
    [(b"\r", None), (b"q", None), (b"q", None)],
    environment=focus_env(multi_path),
)
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
assert len(focus_lines(focus_log)) == before, focus_lines(focus_log)
print("tui chooser cancellation performed no focus call")

before = len(focus_lines(focus_log))
status, _ = run_keys(
    [(b"\r", b"candidate"), (b"j", None), (b"\r", b"request"), (b"q", None)],
    environment=focus_env(multi_path),
)
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
assert "app do pane.focus --terminal t2" in focus_lines(focus_log)[before:], (
    focus_lines(focus_log)[before:]
)
print("tui chooser focused the explicit second terminal")

# A removed target fails closed with no reveal/focus and stays usable.
stale_path = os.path.join(work, "stale.json")
with open(fixture, "r", encoding="utf-8") as handle:
    stale = json.load(handle)
stale["candidates"][0]["pane_id"] = "gone"
with open(stale_path, "w", encoding="utf-8") as handle:
    json.dump(stale, handle)
before = len(app_focus_lines(focus_log))
status, output = run_keys(
    [(b"\r", b"failed"), (b"q", None)],
    environment=focus_env(stale_path),
)
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
assert len(app_focus_lines(focus_log)) == before, focus_lines(focus_log)
assert b"revalidate" in output or b"failed" in output
print("tui removed terminal failed closed without a focus call")

# A terminal whose ownership labels no longer match fails closed.
before = len(app_focus_lines(focus_log))
status, output = run_keys(
    [(b"\r", b"failed"), (b"q", None)],
    environment=focus_env(fixture, {"TUI_HC_MISMATCH": "1"}),
)
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
assert len(app_focus_lines(focus_log)) == before, focus_lines(focus_log)
assert b"failed" in output, output[-1200:]
print("tui changed ownership failed closed without a focus call")


# A four-second stalled source must not delay help or quit past 200 ms.
stall = tempfile.mkdtemp(prefix="aven-tui-stall.")
stall_bin = os.path.join(stall, "bin")
stall_repo = os.path.join(stall, "repo")
os.makedirs(stall_bin)
os.makedirs(stall_repo)
with open(os.path.join(stall_bin, "aven"), "w", encoding="utf-8") as handle:
    handle.write("#!/bin/sh\nsleep 4\n")
with open(os.path.join(stall_bin, "git"), "w", encoding="utf-8") as handle:
    handle.write('#!/bin/sh\nprintf "%s\\n" "$STALL_REPO"\n')
with open(os.path.join(stall_bin, "hc"), "w", encoding="utf-8") as handle:
    handle.write("#!/bin/sh\nexit 1\n")
for name in ("aven", "git", "hc"):
    os.chmod(os.path.join(stall_bin, name), 0o755)
stall_env = dict(env)
stall_env.pop("AVEN_DISPATCH_TUI_FIXTURE", None)
stall_env.pop("HC_BIN", None)
stall_env.update(
    {
        "PATH": stall_bin + os.pathsep + stall_env["PATH"],
        "HC_BIN": os.path.join(stall_bin, "hc"),
        "AVEN_DISPATCH_STORE": os.path.join(stall, "missing.sqlite"),
        "STALL_REPO": stall_repo,
    }
)
pid, fd = spawn(stall_env, ["tui", "--project", "app", "--cwd", stall_repo])
try:
    output, ok = read_until(fd, [b"overview"], time.time() + 5)
    assert ok, f"stalled inspector did not render: {output[-800:]!r}"
    started = time.time()
    os.write(fd, b"?")
    _, ok = read_until(fd, [b"Dispatcher"], started + 2)
    help_ms = (time.time() - started) * 1000
    assert ok, "help unavailable during stalled source"
    os.write(fd, b"?")
    started = time.time()
    os.write(fd, b"q")
    status = wait_exit(pid, started + 3)
    quit_ms = (time.time() - started) * 1000
    assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
    assert help_ms <= 200, f"help took {help_ms:.1f} ms during a stalled source"
    assert quit_ms <= 200, f"quit took {quit_ms:.1f} ms during a stalled source"
    print(f"tui stalled-source help={help_ms:.1f}ms quit={quit_ms:.1f}ms")
finally:
    try:
        os.close(fd)
    except OSError:
        pass
