#!/usr/bin/env python3
"""Drive the real inline Aven pickers and assert their prompt counts."""
import errno
import fcntl
import os
import pty
import select
import subprocess
import sys
import termios
import time

context, output, mode, cancel, *command = sys.argv[1:]
master, slave = pty.openpty()
env = dict(os.environ, AVEN_COMMAND_CONTEXT=context, TERM="xterm")
def attach_terminal():
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, env=env,
                           close_fds=True, preexec_fn=attach_terminal)
os.close(slave)
data = b""
handled = {b"Select implementation mode:": 0, b"Select an OpenCode agent:": 0, b"Select an OpenCode model:": 0}
deadline = time.monotonic() + 60
try:
    while True:
        if time.monotonic() > deadline:
            raise RuntimeError(f"timed out waiting for dispatch: {data!r}")
        ready, _, _ = select.select([master], [], [], 0.1)
        chunk = b""
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            data += chunk
            for heading in handled:
                count = data.count(heading)
                while handled[heading] < count:
                    handled[heading] += 1
                    if heading == b"Select implementation mode:":
                        response = (mode + "\n").encode()
                    else:
                        is_cancel = (cancel == "agent" and heading == b"Select an OpenCode agent:") or (
                            cancel == "model" and heading == b"Select an OpenCode model:"
                        )
                        response = b"q" if is_cancel else b"\r"
                    os.write(master, response)
        if process.poll() is not None and not chunk:
            break
    open(output, "wb").write(data)
    expected = 1 if cancel in ("agent", "model") else 0
    if process.returncode != expected:
        raise RuntimeError(f"dispatch exit {process.returncode}, expected {expected}: {data!r}")
    expected_counts = {
        "none": [1, 1, 1], "agent": [1, 1, 0], "model": [1, 1, 1],
        "existing": [0, 0, 0], "dry-run": [1, 0, 0],
    }[cancel]
    if list(handled.values()) != expected_counts:
        raise RuntimeError(f"unexpected picker counts {handled}: {data!r}")
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
    os.close(master)
