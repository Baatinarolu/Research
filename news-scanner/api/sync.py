"""Vercel Function: GET|POST /api/sync — Neon-backed cross-device sync.

Routing and validation live in api/_db.py → handle_sync, dispatched via
api/_pairwire.py → handle_api, exactly like every other endpoint.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _http import PairwireHandler  # noqa: E402


class handler(PairwireHandler):
    pass
