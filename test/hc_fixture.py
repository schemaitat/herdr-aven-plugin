#!/usr/bin/env python3
"""A deterministic herdr-core (`hc`) process fixture.

Not a fake of Git or OpenCode: `hc exec` runs the requested program for real,
so worktree tests exercise actual Git through the documented hc boundary.
Terminals are recorded facts; `hc events` streams a snapshot from
`$HC_FIXTURE_STATE/events.ndjson` for watcher tests.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

state = Path(os.environ.get("HC_FIXTURE_STATE", "/tmp/aven-hc-fixture"))
state.mkdir(parents=True, exist_ok=True)
terminals_path = state / "terminals.json"
counter_path = state / "counter"
status_path = state / "status.json"
events_path = Path(os.environ.get("HC_FIXTURE_EVENTS", state / "events.ndjson"))
log_path = os.environ.get("HC_FIXTURE_LOG")
follow = os.environ.get("HC_FIXTURE_FOLLOW") == "1"


def log(argv):
    if log_path:
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(argv) + "\n")


def load():
    if not terminals_path.exists():
        return {}
    try:
        return json.loads(terminals_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save(value):
    terminals_path.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")


def statuses():
    if not status_path.exists():
        return {}
    try:
        return json.loads(status_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def address():
    n = 0
    if counter_path.exists():
        try:
            n = int(counter_path.read_text().strip())
        except Exception:
            n = 0
    n += 1
    counter_path.write_text(str(n), encoding="utf-8")
    return f"t{n}"


def fact(record, seq=0):
    override = statuses().get(record["address"], {})
    status = override.get("status")
    value = {
        "address": record["address"],
        "argv": record.get("argv", []),
        "cols": 200,
        "created_ms": record.get("created_ms", int(time.time() * 1000)),
        "cwd": record.get("cwd", "/"),
        "die_with_parent": False,
        "labels": record.get("labels", {}),
        "name": record.get("name"),
        "notify": False,
        "parent": None,
        "reason": override.get("reason", record.get("reason")),
        "reported": status is not None,
        "rows": 120,
        "screen": "exact",
        "state": override.get("state", record.get("state", "live")),
        "status": {"state": status, "kind": override.get("kind", "")} if status else None,
        "status_ms": None,
        "turn": override.get("turn", record.get("turn", 0)),
        "keep": False,
        "rm": False,
        "signal": None,
        "exit_code": override.get("exit_code"),
        "finished_ms": None,
        "identity": "fixture",
        "foreground": {"name": record.get("program", "sh"), "argv": record.get("argv", []), "cwd": record.get("cwd", "/"), "pid": record.get("pid", 999)},
        "template": None,
        "title": "",
        "seq": seq,
    }
    if value["state"] == "finished":
        value["foreground"] = None
    return value


def minimal(record):
    override = statuses().get(record["address"], {})
    return {
        "address": record["address"],
        "agent": record.get("program", "sh"),
        "cwd": record.get("cwd", "/"),
        "name": record.get("name"),
        "state": override.get("state", record.get("state", "live")),
        "status": override.get("status"),
        "turn": override.get("turn", record.get("turn", 0)),
    }


def parse_options(argv):
    options = {"labels": {}, "argv": [], "cwd": "/", "name": None, "all": False}
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "--":
            options["argv"] = argv[index + 1:]
            break
        if item.startswith("--"):
            key = item[2:]
            if key in ("json", "bg", "no-parent", "outlive-parent", "all", "keep", "no-notify", "rm"):
                options[key.replace("-", "_")] = True
                index += 1
                continue
            value = argv[index + 1] if index + 1 < len(argv) else ""
            if key == "label":
                label, _, text = value.partition("=")
                options["labels"][label] = text
            elif key in ("name", "cwd", "terminal", "if", "timeout", "children", "output", "kind"):
                options[key] = value
            index += 2
            continue
        options["argv"] = argv[index:]
        break
    return options


def main():
    argv = sys.argv[1:]
    log(argv)
    if not argv:
        print(json.dumps({"error": {"kind": "needs_target"}}))
        return 7
    command = argv[0]
    rest = argv[1:]
    if command in ("--version", "-V"):
        print("hc 0.1.15")
        return 0
    if command == "schema":
        print(json.dumps({"methods": [{"name": "events.subscribe"}, {"name": "terminal.send"}, {"name": "terminal.get"}]}))
        return 0
    if command == "server":
        action = rest[0] if rest else "status"
        if action == "status":
            print(json.dumps({
                "core": {"id": os.environ.get("HC_FIXTURE_CORE_ID", "fixture-core"), "name": os.environ.get("HC_FIXTURE_CORE_NAME", "fixture")},
                "version": "0.1.15", "pid": 1, "uptime_ms": 1000, "holders": [], "live": 1, "finished": 0,
            }))
            return 0
        if action == "stop":
            print(json.dumps({"stopped": True}))
            return 0
        return 0
    if command == "exec":
        options = parse_options(rest)
        if "--cwd" in rest:
            index = rest.index("--cwd")
            cwd = rest[index + 1]
            program = rest[index + 2:]
        else:
            cwd = "/"
            program = rest
        if program and program[0] == "--":
            program = program[1:]
        result = subprocess.run(program, cwd=cwd, text=True, capture_output=True)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode
    if command == "run":
        options = parse_options(rest)
        program = options["argv"]
        label_argv = []
        if program and program[0] == "env":
            program = program[1:]
            while program and "=" in program[0] and not program[0].startswith("-"):
                program = program[1:]
        address_value = address()
        record = {
            "address": address_value,
            "name": options.get("name"),
            "cwd": options.get("cwd", os.getcwd()),
            "labels": options.get("labels", {}),
            "argv": label_argv or options["argv"],
            "program": program[0] if program else "sh",
            "state": "live",
            "turn": 0,
            "pid": int(time.time() * 1000) % 30000,
        }
        records = load()
        records[address_value] = record
        save(records)
        print(json.dumps({"address": address_value, "name": record["name"], "state": "live", "turn": 0}))
        return 0
    if command == "get":
        target = rest[0] if rest else ""
        records = load()
        if target not in records:
            print(json.dumps({"error": {"kind": "not_found", "message": f"no terminal {target}"}}), file=sys.stderr)
            return 3
        print(json.dumps(fact(records[target])))
        return 0
    if command == "ls":
        include_all = "--all" in rest
        records = load()
        values = [minimal(record) for record in records.values() if include_all or minimal(record)["state"] == "live"]
        print(json.dumps({"hidden_finished": 0, "terminals": values}))
        return 0
    if command == "kill":
        target = next((item for item in rest if not item.startswith("--")), "")
        records = load()
        if target not in records:
            return 3
        statuses_value = statuses()
        statuses_value[target] = {"state": "finished", "reason": "killed"}
        status_path.write_text(json.dumps(statuses_value), encoding="utf-8")
        print(json.dumps(fact(records[target])))
        return 0
    if command == "rm":
        target = next((item for item in rest if not item.startswith("--")), "")
        records = load()
        records.pop(target, None)
        save(records)
        print(json.dumps({"removed": target}))
        return 0
    if command == "label":
        target = rest[0] if rest else ""
        records = load()
        for item in rest[1:]:
            key, _, value = item.partition("=")
            if value:
                records[target].setdefault("labels", {})[key] = value
            else:
                records[target].get("labels", {}).pop(key, None)
        save(records)
        print(json.dumps(fact(records[target])))
        return 0
    if command == "send":
        print(json.dumps({"turn": 1, "wait": {"terminal": rest[0] if rest else "", "ended": True, "reason": "status", "turn": 1, "children": []}}))
        return 0
    if command == "keys":
        print(json.dumps({"keys": rest[1:]}))
        return 0
    if command == "wait":
        print(json.dumps({"terminal": rest[0] if rest else "", "ended": True, "reason": "status", "turn": 1, "children": []}))
        return 0
    if command == "events":
        options = parse_options(rest)
        wanted = options.get("labels", {})
        records = load()
        matching = [fact(record) for record in records.values() if all(record.get("labels", {}).get(key) == value for key, value in wanted.items())]
        print(json.dumps({"channel": None, "seq": 0, "terminals": matching}), flush=True)
        if not follow:
            return 0
        position = 0
        while True:
            if events_path.exists():
                lines = events_path.read_text(encoding="utf-8").splitlines()
                while position < len(lines):
                    print(lines[position], flush=True)
                    position += 1
            time.sleep(0.05)
    print(json.dumps({"error": {"kind": "invalid_params", "message": f"unsupported command {command}"}}), file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.exit(0)
