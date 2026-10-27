#!/usr/bin/env python3
"""
PAIRWIRE local development server.
Production runs on Vercel (see DEPLOY.md); this file only exists so you can
run the exact same code on your own machine:

    python3 local_server.py   ->  http://localhost:8080
"""
import os
import sys
import urllib.parse
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "public" / "static"
sys.path.insert(0, str(ROOT / "api"))
import _stdlib_pin  # noqa: E402,F401  (pins stdlib calendar ahead of api/calendar.py)
from _http import PairwireHandler  # noqa: E402

MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon"}


class LocalHandler(PairwireHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/") or parsed.path == "/health":
            return super().do_GET()
        if parsed.path in ("", "/", "/index.html"):
            target = ROOT / "public" / "index.html"
        elif parsed.path.startswith("/static/"):
            target = (ROOT / "public" / parsed.path.lstrip("/")).resolve()
            if not str(target).startswith(str(STATIC_DIR.resolve())):
                self.send_response(404); self.end_headers(); self.wfile.write(b"Not found"); return
        else:
            self.send_response(404); self.end_headers(); self.wfile.write(b"Not found"); return
        if not target.is_file():
            self.send_response(404); self.end_headers(); self.wfile.write(b"Not found"); return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"PAIRWIRE (local) running on http://0.0.0.0:{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), LocalHandler).serve_forever()
