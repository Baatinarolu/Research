"""Vercel Function: GET /api/scan — see api/_pairwire.py handle_api()."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _http import PairwireHandler  # noqa: E402


class handler(PairwireHandler):
    pass
