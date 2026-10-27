"""Shared HTTP handler for PAIRWIRE Vercel Functions (underscore = not an endpoint)."""
import json
import os
import sys
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _stdlib_pin  # noqa: E402,F401  (pins stdlib calendar before api/calendar.py can shadow it)
from _pairwire import handle_api  # noqa: E402


class PairwireHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {self.address_string()} {fmt % args}", flush=True)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _dispatch(self):
        parsed = urllib.parse.urlparse(self.path)
        if self.command == "POST" and parsed.path.rstrip("/") not in ("/api/cron", "/api/sync"):
            return self.send_json({"error": "Method not allowed"}, 405)
        body = b""
        if self.command == "POST":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length > 65536:
                return self.send_json({"error": "Payload too large"}, 413)
            body = self.rfile.read(length) if length else b""
        try:
            status, payload = handle_api(
                parsed.path,
                urllib.parse.parse_qs(parsed.query),
                self.headers, body, self.command)
            return self.send_json(payload, status)
        except Exception as e:
            print(f"API error on {parsed.path}: {e!r}", flush=True)
            return self.send_json({"error": str(e)}, 500)

    def do_GET(self):
        return self._dispatch()

    def do_POST(self):
        return self._dispatch()
