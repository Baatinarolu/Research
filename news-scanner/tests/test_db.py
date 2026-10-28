"""Tests for the optional Neon layer. Runs without a database and without
psycopg installed — the default deployment must keep working on stdlib alone.

Run: python3 -m unittest discover -s tests -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "api"))

import _db  # noqa: E402

UUID = "12345678-1234-4123-8234-1234567890ab"


class DisabledStateTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop("DATABASE_URL", None)

    def tearDown(self):
        if self._saved is not None:
            os.environ["DATABASE_URL"] = self._saved

    def test_disabled_without_database_url(self):
        self.assertFalse(_db.db_enabled())
        status = _db.db_status()
        self.assertFalse(status["enabled"])
        self.assertFalse(status["configured"])

    def test_sync_route_reports_disabled(self):
        code, payload = _db.handle_sync("GET", {"uid": [UUID]}, b"")
        self.assertEqual(code, 200)
        self.assertFalse(payload["enabled"])

    def test_cron_helpers_are_noop_when_disabled(self):
        self.assertIsNone(_db.cron_filter_unseen(["a", "b"]))
        self.assertIsNone(_db.cron_mark_seen(["a", "b"]))  # must not raise


class ValidationTests(unittest.TestCase):
    def _valid(self):
        return {
            "watchlist": ["EUR/USD", "XAUUSD"],
            "saved": [{"key": "abc123", "title": "Headline", "link": "http://x",
                       "source": "CNBC", "ts": 1700000000, "symbol": "EUR/USD"}],
            "recent": [{"symbol": "EUR/USD", "ts": 1700000000}],
            "settings": {"pw_theme": "terminal", "pw_tf": "1M", "unknown_key": "x"},
        }

    def test_valid_payload_normalised(self):
        out = _db.validate_payload(self._valid())
        self.assertEqual(out["watchlist"], ["EUR/USD", "XAUUSD"])
        self.assertEqual(out["saved"][0]["key"], "abc123")
        self.assertNotIn("unknown_key", out["settings"])
        self.assertIn("pw_theme", out["settings"])

    def test_rejects_non_object(self):
        with self.assertRaises(ValueError):
            _db.validate_payload(["nope"])

    def test_rejects_duplicate_watchlist(self):
        bad = self._valid()
        bad["watchlist"] = ["EUR/USD", "EUR/USD"]
        with self.assertRaises(ValueError):
            _db.validate_payload(bad)

    def test_rejects_oversized_collections(self):
        bad = self._valid()
        bad["watchlist"] = ["S%d" % i for i in range(_db.WATCHLIST_MAX + 1)]
        with self.assertRaises(ValueError):
            _db.validate_payload(bad)

    def test_rejects_bad_saved_row(self):
        bad = self._valid()
        bad["saved"] = [{"title": "no key"}]
        with self.assertRaises(ValueError):
            _db.validate_payload(bad)

    def test_rejects_non_scalar_setting(self):
        bad = self._valid()
        bad["settings"] = {"pw_theme": {"nested": True}}
        with self.assertRaises(ValueError):
            _db.validate_payload(bad)

    def test_recent_deduped_and_bounded(self):
        out = _db.validate_payload({
            "watchlist": [], "saved": [],
            "recent": [{"symbol": "A"}, {"symbol": "A"}, {"symbol": "B"}],
            "settings": {},
        })
        self.assertEqual([r["symbol"] for r in out["recent"]], ["A", "B"])


class RouteTests(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop("DATABASE_URL", None)

    def tearDown(self):
        if self._saved is not None:
            os.environ["DATABASE_URL"] = self._saved

    def test_uid_pattern_accepts_v4_uuids_only(self):
        self.assertTrue(_db.UID_RE.match(UUID))
        self.assertFalse(_db.UID_RE.match("not-a-uuid"))
        self.assertFalse(_db.UID_RE.match(""))
        # v1 UUID (version digit 1) must not pass
        self.assertFalse(_db.UID_RE.match("12345678-1234-1123-8234-1234567890ab"))

    def test_disabled_short_circuit_answers_before_validation(self):
        # Default deployments (no DATABASE_URL) always get the helpful
        # disabled payload rather than a 400, whatever the query looks like.
        for qs in ({"uid": ["not-a-uuid"]}, {}, None):
            code, payload = _db.handle_sync("GET", qs, b"")
            self.assertEqual(code, 200)
            self.assertFalse(payload["enabled"])
            self.assertIn("DATABASE_URL", payload["note"])

    def test_get_shape_is_stable(self):
        code, payload = _db.handle_sync("GET", None, b"")
        self.assertEqual(code, 200)
        self.assertIn("enabled", payload)


class SchemaSplitTests(unittest.TestCase):
    def test_schema_file_splits_into_executable_statements(self):
        sql = _db.SCHEMA_PATH.read_text(encoding="utf-8")
        chunks = []
        for chunk in sql.split(";"):
            lines = [ln for ln in chunk.splitlines() if not ln.strip().startswith("--")]
            stmt = "\n".join(lines).strip()
            if stmt:
                chunks.append(stmt)
        self.assertTrue(chunks)
        # All 6 tables and 5 indexes from db/schema.sql
        joined = "\n".join(chunks)
        for table in ("users", "watchlist", "saved_headlines",
                      "recent_scans", "settings", "cron_alert_seen"):
            self.assertIn("CREATE TABLE IF NOT EXISTS %s" % table, joined)
        self.assertEqual(joined.count("CREATE INDEX IF NOT EXISTS"), 5)
        # No statement accidentally carries a comment header
        self.assertFalse(any(s.startswith("--") for s in chunks))


class SchemaFallbackTests(unittest.TestCase):
    def setUp(self):
        self._orig_path = _db.SCHEMA_PATH
        self._orig_ready = _db._schema_ready
        _db._schema_ready = False

    def tearDown(self):
        _db.SCHEMA_PATH = self._orig_path
        _db._schema_ready = self._orig_ready

    def test_inline_fallback_when_file_missing(self):
        from pathlib import Path
        _db.SCHEMA_PATH = Path("/nonexistent/pairwire/schema.sql")
        executed = []

        class Cur:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def execute(self, sql, params=None): executed.append(sql)

        class Conn:
            def cursor(self): return Cur()
            def commit(self): pass

        _db.ensure_schema(Conn())
        joined = "\n".join(executed)
        for table in ("users", "watchlist", "saved_headlines",
                      "recent_scans", "settings", "cron_alert_seen"):
            self.assertIn("CREATE TABLE IF NOT EXISTS %s" % table, joined)
        self.assertEqual(joined.count("CREATE INDEX IF NOT EXISTS"), 5)
        self.assertTrue(_db._schema_ready)

    def test_inline_schema_matches_file_object_set(self):
        file_stmts = _db._split_sql(_db.SCHEMA_PATH.read_text(encoding="utf-8"))
        inline_stmts = _db._split_sql(_db.SCHEMA_SQL)
        self.assertEqual(len(file_stmts), len(inline_stmts))

        def signature(stmts):
            return [" ".join(s.split()[:5]).upper() for s in stmts]

        self.assertEqual(signature(file_stmts), signature(inline_stmts))

    def test_split_sql_drops_comments(self):
        stmts = _db._split_sql("-- hello\nCREATE TABLE a(x int);\n-- c\nCREATE INDEX i ON a(x);")
        self.assertEqual(len(stmts), 2)
        self.assertFalse(any(s.startswith("--") for s in stmts))

    def test_semicolon_inside_comment_creates_no_phantom_statement(self):
        sql = "-- every sync; there are no passwords here.\nCREATE TABLE a(x int);"
        stmts = _db._split_sql(sql)
        self.assertEqual(len(stmts), 1)
        self.assertTrue(stmts[0].startswith("CREATE TABLE"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
