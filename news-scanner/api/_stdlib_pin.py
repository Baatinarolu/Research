"""Stdlib import guard (underscore = helper, never a Vercel endpoint).

This directory contains ``calendar.py`` — the Vercel ``/api/calendar``
function — which shadows the standard-library ``calendar`` module as soon as
this directory is inserted at the front of ``sys.path``. The stdlib
``email.utils`` (used by our RSS date parsing and by psycopg) imports
``calendar.timegm`` from it, so without a guard the endpoint file gets loaded
in place of the stdlib module and the import chain collapses.

Importing this module first loads the genuine stdlib ``calendar`` by its
absolute file path and caches it in ``sys.modules`` before anything can
resolve the shadowing filename.
"""
import importlib.util
import os
import sys

STDLIB_DIR = os.path.dirname(os.__file__)
STDLIB_CALENDAR = os.path.join(STDLIB_DIR, "calendar.py")


def ensure_stdlib_calendar():
    existing = sys.modules.get("calendar")
    if existing is not None and os.path.normcase(
            getattr(existing, "__file__", "") or "") == os.path.normcase(STDLIB_CALENDAR):
        return
    spec = importlib.util.spec_from_file_location("calendar", STDLIB_CALENDAR)
    module = importlib.util.module_from_spec(spec)
    sys.modules["calendar"] = module
    spec.loader.exec_module(module)


ensure_stdlib_calendar()
