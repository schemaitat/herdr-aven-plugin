#!/usr/bin/env python3
"""Intercept exact-pane focus so process tests never contact a user's Herdr."""

import json
import os
import socket

with socket.socket(socket.AF_UNIX) as server:
    server.bind(os.environ["HERDR_SOCKET_PATH"])
    server.listen()
    while True:
        connection, _ = server.accept()
        with connection, connection.makefile("rwb") as stream:
            request = json.loads(stream.readline())
            assert request["method"] == "pane.focus", request
            pane = request["params"]["pane_id"]
            with open(os.environ["RUST_DISPATCH_LOG"], "a") as log:
                log.write(f"herdr-api pane.focus {pane}\n")
            response = {"id": request["id"], "result": {"type": "ok"}}
            stream.write(json.dumps(response).encode() + b"\n")
            stream.flush()
