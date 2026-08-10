#!/usr/bin/env python3
"""Error-discovery review server (stdlib only)."""
import json, os, sys
from http.server import HTTPServer, BaseHTTPRequestHandler

BASE = os.path.dirname(os.path.abspath(__file__))
# Serve the raw local dataset only when it is complete (all generated files
# present), else the committed anonymized one. Guards against an interrupted
# extraction leaving a partial error_discovery_data/ that would 404 the app.
def _complete(d):
    return all(os.path.exists(os.path.join(d, f))
               for f in ("index.json", "samples.json", "graph.json"))
DATA = os.path.join(BASE, "error_discovery_data")
if not _complete(DATA):
    DATA = os.path.join(BASE, "sample-data")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8811

FILES = {"samples": "samples.json", "annotations": "annotations.json",
         "patterns": "patterns.json", "suggestions": "suggestions.json",
         "graph": "graph.json", "index": "index.json"}

def load(name):
    with open(os.path.join(DATA, FILES[name])) as f:
        return json.load(f)

def save(name, obj):
    tmp = os.path.join(DATA, FILES[name] + ".tmp")
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, os.path.join(DATA, FILES[name]))

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/":
            with open(os.path.join(BASE, "app.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if path == "/api/record":
            params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
            rid = params.get("id", "")
            if not rid or "/" in rid or ".." in rid:
                return self._send(400, {"error": "bad id"})
            p = os.path.join(DATA, "records", rid + ".json")
            if not os.path.exists(p):
                return self._send(404, {"error": "not found"})
            with open(p, "rb") as f:
                return self._send(200, f.read())
        name = path.removeprefix("/api/")
        if name in FILES:
            return self._send(200, load(name))
        self._send(404, {"error": "unknown"})

    def do_POST(self):
        name = self.path.removeprefix("/api/")
        if name not in ("samples", "annotations", "patterns", "suggestions"):
            return self._send(404, {"error": "unknown"})
        n = int(self.headers.get("Content-Length", 0))
        try:
            obj = json.loads(self.rfile.read(n))
        except Exception:
            return self._send(400, {"error": "bad json"})
        save(name, obj)
        self._send(200, {"ok": True})

if __name__ == "__main__":
    print(f"serving on http://127.0.0.1:{PORT}")
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()
