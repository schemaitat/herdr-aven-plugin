#!/usr/bin/env python3
"""Minimal authenticated OpenCode V2 service fixture for inspector tests.

The fixture serves only the GET endpoints the inspector is allowed to read and
records every request so the test can assert the read boundary. It never
starts a real OpenCode process.
"""
import base64
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

log_path, port_path = sys.argv[1], sys.argv[2]
expected = "Basic " + base64.b64encode(b"opencode:test-password").decode()
paths = {
    "/openapi.json": {
        "paths": {
            "/api/session/active": {"get": {}},
            "/api/session/{sessionID}": {"get": {}},
            "/api/session/{sessionID}/permission": {"get": {}},
            "/api/session/{sessionID}/form": {"get": {}},
        }
    },
    "/api/session/active": {"data": {"ses_one": {"type": "running"}}},
    "/api/session/ses_one": {"data": {"id": "ses_one", "parentID": "ses_parent"}},
    "/api/session/ses_one/permission": {"data": [{"sessionID": "ses_one"}]},
    "/api/session/ses_one/form": {"data": []},
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(f"GET {self.path}\n")
        if self.headers.get("Authorization") != expected:
            self.reply(401, {"_tag": "UnauthorizedError"})
            return
        body = paths.get(self.path)
        if body is None:
            self.reply(404, {"_tag": "NotFound"})
            return
        self.reply(200, body)

    def do_POST(self):
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(f"POST {self.path}\n")
        self.reply(405, {"_tag": "MethodNotAllowed"})

    def reply(self, status, body):
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionResetError, BrokenPipeError):
            pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(port_path, "w", encoding="utf-8") as handle:
    handle.write(str(server.server_address[1]))
server.serve_forever()
