"""Integration-shape tests for _db with a scripted in-memory connection.

Runs against the REAL psycopg driver (Json adaptation, module wiring) but a
fake network boundary, so no Postgres server is needed. Skip silently if
psycopg isn't installed in the current interpreter:

    python3 -m unittest tests.test_db_fake -v
"""
import os
import sys
import unittest

API_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api")
sys.path.insert(0, API_DIR)

import _stdlib_pin  # noqa: E402,F401  (must precede psycopg: keeps stdlib calendar resolvable)

try:
    import psycopg  # noqa: F401
    from psycopg.types.json import Json
except Exception:
    psycopg = None
    Json = None

os.environ["DATABASE_URL"] = "postgresql://u:p@ep-pooler.neon.tech/neondb?sslmode=require"
import _db  # noqa: E402


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.calls.append((sql, params))
        s = sql.strip().upper()
        if s.startswith("SELECT SYMBOL FROM WATCHLIST"):
            self._rows = [("EUR/USD",), ("XAUUSD",)]
        elif s.startswith("SELECT KEY, TITLE, LINK"):
            self._rows = [("k1", "Headline", "http://x", "CNBC", 1700000000,
                           "EUR/USD", 1700000100)]
        elif "RECENT_SCANS" in s and s.startswith("SELECT"):
            self._rows = [("EUR/USD", 1700000000)]
        elif s.startswith("SELECT KEY, VALUE FROM SETTINGS"):
            self._rows = [("pw_theme", "terminal")]
        elif "CRON_ALERT_SEEN" in s and s.startswith("SELECT"):
            self._rows = [("seen-key",)]
        else:
            self._rows = []

    def executemany(self, sql, seq):
        for params in seq:
            self.execute(sql, params)

    def fetchall(self):
        return self._rows


class FakeConn:
    def __init__(self):
        self.calls = []
        self.committed = False

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.committed = True

    def rollback(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@unittest.skipUnless(psycopg is not None, "psycopg not installed in this interpreter")
class DbFlowTests(unittest.TestCase):
    def setUp(self):
        _db._schema_ready = False
        self.conn = FakeConn()
        self._orig_connect = _db._connect
        _db._connect = lambda: self.conn

    def tearDown(self):
        _db._connect = self._orig_connect
        _db._schema_ready = False

    def test_enabled_and_ssl_enforced(self):
        self.assertTrue(_db.db_enabled())
        self.assertIn("sslmode=require", _db._conninfo())

    def test_conninfo_adds_sslmode_when_missing(self):
        old = _db._database_url
        try:
            _db._database_url = lambda: "postgresql://u:p@host/db"
            self.assertIn("?sslmode=require", _db._conninfo())
        finally:
            _db._database_url = old

    def test_pull_round_trip(self):
        data = _db.pull("12345678-1234-4123-8234-1234567890ab")
        self.assertEqual(data["watchlist"], ["EUR/USD", "XAUUSD"])
        self.assertEqual(data["saved"][0]["title"], "Headline")
        self.assertEqual(data["recent"][0], {"symbol": "EUR/USD", "ts": 1700000000})
        self.assertEqual(data["settings"], {"pw_theme": "terminal"})
        # schema DDL ran once
        ddl = [sql for sql, _ in self.conn.calls if sql.strip().upper().startswith("CREATE")]
        self.assertTrue(ddl)
        self.assertTrue(self.conn.committed)

    def test_push_full_state_and_json_adaptation(self):
        payload = _db.validate_payload({
            "watchlist": ["EUR/USD"],
            "saved": [{"key": "k1", "title": "T", "link": "http://x",
                       "source": "CNBC", "ts": 1, "symbol": "EUR/USD"}],
            "recent": [{"symbol": "EUR/USD", "ts": 1700000000}],
            "settings": {"pw_theme": "terminal", "pw_tf": "1M"},
        })
        _db.push("12345678-1234-4123-8234-1234567890ab", payload)
        sqls = [sql for sql, _ in self.conn.calls]
        # every collection is reconciled: upserts + deletions of missing rows
        self.assertTrue(any("INSERT INTO users" in s for s in sqls))
        self.assertTrue(any("INSERT INTO watchlist" in s for s in sqls))
        self.assertTrue(any("DELETE FROM watchlist" in s for s in sqls))
        self.assertTrue(any("INSERT INTO saved_headlines" in s for s in sqls))
        self.assertTrue(any("DELETE FROM saved_headlines" in s for s in sqls))
        self.assertTrue(any("INSERT INTO recent_scans" in s for s in sqls))
        self.assertTrue(any("INSERT INTO settings" in s for s in sqls))
        # settings values go through psycopg's JSONB wrapper
        json_params = [p for _, p in self.conn.calls if p for p in (p or []) if isinstance(p, Json)]
        self.assertTrue(json_params)
        self.assertTrue(self.conn.committed)

    def test_cron_dedupe_flow(self):
        fresh = _db.cron_filter_unseen(["seen-key", "new-key"])
        self.assertEqual(fresh, ["new-key"])
        _db.cron_mark_seen(["new-key"])
        sqls = [sql for sql, _ in self.conn.calls]
        self.assertTrue(any("INSERT INTO cron_alert_seen" in s for s in sqls))
        self.assertTrue(any("DELETE FROM cron_alert_seen" in s for s in sqls))

    def test_handle_sync_post_returns_pull_shape(self):
        code, payload = _db.handle_sync(
            "POST", {"uid": ["12345678-1234-4123-8234-1234567890ab"]},
            b'{"watchlist":["EUR/USD"],"saved":[],"recent":[],"settings":{}}')
        self.assertEqual(code, 200)
        self.assertTrue(payload["enabled"])
        self.assertIn("watchlist", payload)

    def test_handle_sync_rejects_oversized_body(self):
        code, payload = _db.handle_sync(
            "POST", {"uid": ["12345678-1234-4123-8234-1234567890ab"]},
            b"x" * (_db.MAX_BODY_BYTES + 1))
        self.assertEqual(code, 413)


if __name__ == "__main__":
    unittest.main(verbosity=2)
