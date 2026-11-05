#!/usr/bin/env python3
"""Minimal OpenCode CLI/API fixture for lifecycle tests."""
import json
import os
import sys

LOG = os.environ.get("OPENCODE_FIXTURE_LOG")
STATE = os.environ.get("OPENCODE_FIXTURE_STATE")
OUTCOME = os.environ.get("OPENCODE_FIXTURE_OUTCOME", "")


def log(argv):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as handle:
            handle.write("opencode " + " ".join(argv) + "\n")


def main(argv):
    log(argv)
    if not argv or argv[0] != "api":
        raise SystemExit("fixture supports only `opencode api`")
    method = argv[1]
    path = argv[2]
    data = None
    if "--data" in argv:
        data = json.loads(argv[argv.index("--data") + 1])
    if method == "POST" and path == "/api/session":
        sessions = 0
        if STATE and os.path.exists(STATE):
            with open(STATE, encoding="utf-8") as handle:
                sessions = json.load(handle).get("sessions", 0)
        sessions += 1
        if STATE:
            with open(STATE, "w", encoding="utf-8") as handle:
                json.dump({"sessions": sessions}, handle)
        print(json.dumps({"data": {"id": f"ses_fixture_{sessions}"}}))
        return
    if method == "POST" and path.endswith("/prompt"):
        print(json.dumps({"data": {"id": (data or {}).get("id", "msg_fixture")}}))
        return
    if method == "POST" and path.endswith("/interrupt"):
        print(json.dumps({"data": {}}))
        return
    if method == "GET" and path == "/api/session/active":
        print(json.dumps({"data": {}}))
        return
    if method == "GET" and path.startswith("/api/session?"):
        print(json.dumps({"data": []}))
        return
    if method == "GET" and path == "/api/agent":
        print(
            json.dumps(
                {
                    "data": [
                        {"id": "build", "name": "build", "mode": "primary", "hidden": False},
                        {
                            "id": "aven-babysitter",
                            "name": "Aven babysitter",
                            "mode": "primary",
                            "hidden": False,
                        },
                        {
                            "id": "aven-orchestrator",
                            "name": "Aven orchestrator",
                            "mode": "primary",
                            "hidden": False,
                        },
                    ]
                }
            )
        )
        return
    if method == "GET" and "/experimental/session/" in path:
        print("")
        return
    if method == "GET" and path.endswith(("/permission", "/form")):
        print(json.dumps({"data": []}))
        return
    if method == "GET" and path.startswith("/api/session/"):
        print(json.dumps({"data": {"outcome": OUTCOME} if OUTCOME else {}}))
        return
    print(json.dumps({"data": {}}))


if __name__ == "__main__":
    main(sys.argv[1:])
