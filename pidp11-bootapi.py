#!/usr/bin/env python3
"""PiDP-11 boot-API -- send_keys/read_screen bridge for the PiDP-11 Hacker
Replicant (see ../README.md for the full picture). A small stdlib-only HTTP
server that exposes exactly two actions on an existing `screen` session:

  GET  /api/pidp11/screen   -> {"text": "..."} hardcopy of the 'pidp11' screen session
  POST /api/pidp11/keys     body {"text": "..."} -> types into that same session
  GET  /api/pidp11/status   -> {"os": "211bsd+", "running": true}

Deliberately limited to reading and typing in the already-visible operator
console (the same session your web console attaches to): no shell, no
filesystem access. Runs as whichever user owns the `screen` session (on the
official PiDP-11 image: user `pi`). Listens on :8093, CORS open -- this is
meant to be reachable from the chat backend only; don't expose it to the
public internet without adding your own auth layer.
"""
import json, os, re, subprocess, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

SESSION = "pidp11"
HARDCOPY = "/tmp/pidp11-bootapi-hardcopy.txt"
SIMH_CMD = "/dev/shm/pidp11/tmpsimhcommand.txt"
PORT = 8093


def send_keys(text):
    literal = text.replace("\\r", "\r").replace("\\n", "\r")
    subprocess.run(["screen", "-S", SESSION, "-X", "stuff", literal],
                   capture_output=True, timeout=10, check=True)


def read_screen():
    try:
        os.remove(HARDCOPY)
    except OSError:
        pass
    subprocess.run(["screen", "-S", SESSION, "-X", "hardcopy", HARDCOPY],
                   capture_output=True, timeout=10, check=True)
    for _ in range(10):
        if os.path.exists(HARDCOPY):
            break
        time.sleep(0.1)
    try:
        with open(HARDCOPY, errors="replace") as f:
            return f.read().rstrip() + "\n"
    except OSError:
        return "(kon hardcopy niet lezen)"


def status():
    running = subprocess.run(["screen", "-ls"], capture_output=True, text=True).stdout.find("." + SESSION) >= 0
    osname = None
    try:
        m = re.search(r"cd\s+\S*/systems/(\S+)", open(SIMH_CMD).read())
        osname = m.group(1) if m else None
    except OSError:
        pass
    return {"os": osname, "running": running}


class Handler(BaseHTTPRequestHandler):
    def _respond(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")
        try:
            if path == "/api/pidp11/screen":
                self._respond(200, {"text": read_screen()})
            elif path == "/api/pidp11/status":
                self._respond(200, status())
            else:
                self._respond(404, {"error": "not found"})
        except Exception as e:
            self._respond(500, {"error": str(e)})

    def do_POST(self):
        if urlparse(self.path).path.rstrip("/") != "/api/pidp11/keys":
            return self._respond(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads((self.rfile.read(length) if length else b"{}") or b"{}")
        except json.JSONDecodeError:
            return self._respond(400, {"error": "ongeldige JSON"})
        text = payload.get("text", "")
        if not isinstance(text, str) or not text:
            return self._respond(400, {"error": "'text' (string) verplicht"})
        try:
            send_keys(text)
            self._respond(200, {"ok": True})
        except Exception as e:
            self._respond(500, {"error": str(e)})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
