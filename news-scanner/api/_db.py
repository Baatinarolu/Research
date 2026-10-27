"""
PAIRWIRE Neon Postgres layer (optional).

The whole app still runs on the Python standard library alone. This module is
only imported when a request actually needs persistence AND DATABASE_URL is set:

  - /api/sync        cross-device My List, saved headlines, recents, settings
  - /api/cron        reliable alert de-duplication across serverless instances
  - /api/health      reports whether the database is configured

psycopg (v3) is imported lazily so a missing package or missing DATABASE_URL
never breaks the default keyless deployment — callers get None / disabled
payloads and the browser keeps using localStorage.
"""
import json
import os
import re
import time
from pathlib import Path

try:
    import _stdlib_pin  # noqa: F401  (psycopg's email.utils chain needs the real stdlib calendar)
except ImportError:
    pass

try:
    import psycopg
    from psycopg.types.json import Json
except Exception:  # pragma: no cover - package simply not installed
    psycopg = None
    Json = None

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "db" / "schema.sql"

# Payload limits — the sync endpoint faces the public internet and the client
# is anonymous, so cap everything to keep rows small and queries bounded.
UID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-"
                    r"[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
WATCHLIST_MAX = 200
SAVED_MAX = 500
RECENT_MAX = 20
SETTINGS_MAX = 20
SYMBOL_MAX = 40
TEXT_MAX = 1000
LINK_MAX = 2000
MAX_BODY_BYTES = 60000
SETTING_KEYS = {"pw_theme", "pw_interval", "pw_sound", "pw_compact",
                "pw_notify", "pw_tf", "pw_tab", "pw_last_symbol"}

_schema_ready = False
_last_error = {"detail": "", "ts": 0}


def _database_url():
    # Read live so tests (and rotated env vars) don't have to reimport.
    return os.environ.get("DATABASE_URL", "").strip()


def db_enabled():
    """True only when a connection string exists and the driver imported."""
    return bool(_database_url()) and psycopg is not None


def db_status():
    return {
        "configured": bool(_database_url()),
        "driver": "psycopg3" if psycopg is not None else "not-installed",
        "enabled": db_enabled(),
        "lastError": _last_error["detail"],
    }


def _conninfo():
    # Neon requires SSL; make sure the pooler URL asks for it even if the
    # copied connection string omitted the parameter.
    url = _database_url()
    if "sslmode" in url.lower():
        return url
    sep = "&" if "?" in url else "?"
    return url + sep + "sslmode=require"


def _connect():
    """Short-lived connection per call — the safe pattern on serverless."""
    return psycopg.connect(_conninfo(), connect_timeout=8, autocommit=False)


def ensure_schema(conn):
    """Idempotent DDL, once per serverless instance."""
    global _schema_ready
    if _schema_ready:
        return
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    statements = []
    for chunk in sql.split(";"):
        lines = [ln for ln in chunk.splitlines() if not ln.strip().startswith("--")]
        stmt = "\n".join(lines).strip()
        if stmt:
            statements.append(stmt)
    with conn.cursor() as cur:
        for stmt in statements:
            cur.execute(stmt)
    conn.commit()
    _schema_ready = True


# ---------------------------------------------------------------- validation
def _clean_str(value, limit, field):
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    value = value.strip()
    if not value or len(value) > limit:
        raise ValueError(f"{field} is empty or too long (max {limit})")
    return value


def validate_payload(payload):
    """Raises ValueError on anything malformed; returns a normalised payload."""
    if not isinstance(payload, dict):
        raise ValueError("Body must be a JSON object")

    watchlist = payload.get("watchlist", [])
    if not isinstance(watchlist, list) or len(watchlist) > WATCHLIST_MAX:
        raise ValueError(f"watchlist must be a list of up to {WATCHLIST_MAX}")
    watchlist = [_clean_str(s, SYMBOL_MAX, "watchlist symbol") for s in watchlist]
    if len(set(watchlist)) != len(watchlist):
        raise ValueError("watchlist contains duplicates")

    saved = payload.get("saved", [])
    if not isinstance(saved, list) or len(saved) > SAVED_MAX:
        raise ValueError(f"saved must be a list of up to {SAVED_MAX}")
    clean_saved, seen_keys = [], set()
    for row in saved:
        if not isinstance(row, dict):
            raise ValueError("saved entries must be objects")
        key = _clean_str(row.get("key", ""), 80, "saved key")
        if key in seen_keys:
            raise ValueError("saved contains duplicate keys")
        seen_keys.add(key)
        clean_saved.append({
            "key": key,
            "title": _clean_str(row.get("title", ""), TEXT_MAX, "saved title"),
            "link": _clean_str(row.get("link", ""), LINK_MAX, "saved link")
                    if row.get("link") else "",
            "source": str(row.get("source", ""))[:120],
            "ts": int(row.get("ts", 0) or 0),
            "symbol": str(row.get("symbol", ""))[:SYMBOL_MAX],
        })

    recent = payload.get("recent", [])
    if not isinstance(recent, list) or len(recent) > RECENT_MAX:
        raise ValueError(f"recent must be a list of up to {RECENT_MAX}")
    clean_recent, recent_syms = [], set()
    now = int(time.time())
    for row in recent:
        if not isinstance(row, dict) or "symbol" not in row:
            raise ValueError("recent entries must be objects with a symbol")
        sym = _clean_str(row["symbol"], SYMBOL_MAX, "recent symbol")
        if sym in recent_syms:
            continue
        recent_syms.add(sym)
        try:
            ts = int(row.get("ts", now))
        except (TypeError, ValueError):
            ts = now
        clean_recent.append({"symbol": sym, "ts": max(0, min(ts, now + 60))})

    settings = payload.get("settings", {})
    if not isinstance(settings, dict) or len(settings) > SETTINGS_MAX:
        raise ValueError(f"settings must be an object of up to {SETTINGS_MAX} keys")
    clean_settings = {}
    for key, value in settings.items():
        if key not in SETTING_KEYS:
            continue  # unknown keys are ignored, not fatal
        if value is None:
            continue
        if not isinstance(value, (str, bool, int, float)):
            raise ValueError(f"setting {key} must be a scalar")
        clean_settings[key] = value
    return {"watchlist": watchlist, "saved": clean_saved,
            "recent": clean_recent, "settings": clean_settings}


# ---------------------------------------------------------------- read / write
def pull(client_id):
    """All cloud-held state for one anonymous client."""
    with _connect() as conn:
        ensure_schema(conn)
        with conn.cursor() as cur:
            cur.execute("SELECT symbol FROM watchlist WHERE client_id=%s "
                        "ORDER BY created_at", (client_id,))
            watchlist = [r[0] for r in cur.fetchall()]

            cur.execute("SELECT key, title, link, source, ts, symbol, "
                        "EXTRACT(EPOCH FROM saved_at)::BIGINT FROM saved_headlines "
                        "WHERE client_id=%s ORDER BY saved_at DESC", (client_id,))
            saved = [{"key": r[0], "title": r[1], "link": r[2], "source": r[3],
                      "ts": r[4], "symbol": r[5], "savedAt": r[6]}
                     for r in cur.fetchall()]

            cur.execute("SELECT symbol, EXTRACT(EPOCH FROM last_scanned_at)::BIGINT "
                        "FROM recent_scans WHERE client_id=%s "
                        "ORDER BY last_scanned_at DESC LIMIT %s",
                        (client_id, RECENT_MAX))
            recent = [{"symbol": r[0], "ts": r[1]} for r in cur.fetchall()]

            cur.execute("SELECT key, value FROM settings WHERE client_id=%s",
                        (client_id,))
            settings = {r[0]: r[1] for r in cur.fetchall()}
    return {"watchlist": watchlist, "saved": saved,
            "recent": recent, "settings": settings}


def push(client_id, payload):
    """Full-state replacement per collection, inside one transaction."""
    with _connect() as conn:
        ensure_schema(conn)
        try:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO users(client_id) VALUES(%s) "
                            "ON CONFLICT(client_id) DO UPDATE "
                            "SET last_seen_at=now()", (client_id,))

                symbols = payload["watchlist"]
                cur.executemany("INSERT INTO watchlist(client_id, symbol) "
                                "VALUES(%s,%s) ON CONFLICT DO NOTHING",
                                [(client_id, s) for s in symbols])
                cur.execute("DELETE FROM watchlist WHERE client_id=%s "
                            "AND symbol <> ALL(%s)", (client_id, symbols))

                cur.executemany(
                    "INSERT INTO saved_headlines"
                    "(client_id, key, title, link, source, ts, symbol) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT(client_id, key) DO UPDATE SET "
                    "title=EXCLUDED.title, link=EXCLUDED.link, source=EXCLUDED.source, "
                    "ts=EXCLUDED.ts, symbol=EXCLUDED.symbol, saved_at=now()",
                    [(client_id, r["key"], r["title"], r["link"], r["source"],
                      r["ts"], r["symbol"]) for r in payload["saved"]])
                cur.execute("DELETE FROM saved_headlines WHERE client_id=%s "
                            "AND key <> ALL(%s)",
                            (client_id, [r["key"] for r in payload["saved"]]))

                cur.executemany(
                    "INSERT INTO recent_scans(client_id, symbol, last_scanned_at) "
                    "VALUES(%s,%s,to_timestamp(%s)) "
                    "ON CONFLICT(client_id, symbol) DO UPDATE SET "
                    "last_scanned_at=GREATEST(recent_scans.last_scanned_at, "
                    "EXCLUDED.last_scanned_at)",
                    [(client_id, r["symbol"], r["ts"]) for r in payload["recent"]])

                for key, value in payload["settings"].items():
                    cur.execute("INSERT INTO settings(client_id, key, value) "
                                "VALUES(%s,%s,%s) "
                                "ON CONFLICT(client_id, key) DO UPDATE SET "
                                "value=EXCLUDED.value, updated_at=now()",
                                (client_id, key, Json(value)))
            conn.commit()
        except Exception:
            conn.rollback()
            raise


# ---------------------------------------------------------------- cron de-dupe
def cron_filter_unseen(keys):
    """Return the subset of alert keys not already stored. None if disabled."""
    if not db_enabled() or not keys:
        return None
    try:
        with _connect() as conn:
            ensure_schema(conn)
            with conn.cursor() as cur:
                cur.execute("SELECT key FROM cron_alert_seen WHERE key = ANY(%s)",
                            (list(keys),))
                seen = {r[0] for r in cur.fetchall()}
        return [k for k in keys if k not in seen]
    except Exception as e:
        _record_error(e)
        return None


def cron_mark_seen(keys):
    if not db_enabled() or not keys:
        return
    try:
        with _connect() as conn:
            ensure_schema(conn)
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO cron_alert_seen(key) VALUES(%s) "
                                "ON CONFLICT DO NOTHING", [(k,) for k in keys])
                cur.execute("DELETE FROM cron_alert_seen "
                            "WHERE first_seen < now() - INTERVAL '7 days'")
            conn.commit()
    except Exception as e:
        _record_error(e)


def _record_error(e):
    _last_error["detail"] = f"{type(e).__name__}: {str(e)[:100]}"
    _last_error["ts"] = int(time.time())


# ---------------------------------------------------------------- HTTP route
def handle_sync(method, qs, body):
    """Returns (http_status, payload). Called from _pairwire.handle_api."""
    if not db_enabled():
        return 200, {"enabled": False,
                     "note": "DATABASE_URL is not configured on this deployment — "
                             "data stays in this browser only."}
    qs = qs or {}
    uid = str((qs.get("uid") or [""])[0]).strip()
    if not UID_RE.match(uid):
        return 400, {"error": "Missing or invalid uid (expect a UUID v4)."}
    try:
        if method == "GET":
            return 200, {"enabled": True, "uid": uid, **pull(uid)}
        if method != "POST":
            return 405, {"error": "Method not allowed"}
        if body is None:
            body = b""
        if isinstance(body, str):
            body = body.encode("utf-8")
        if len(body) > MAX_BODY_BYTES:
            return 413, {"error": "Sync payload too large."}
        try:
            payload = validate_payload(json.loads(body.decode("utf-8") or "{}"))
        except ValueError as e:
            return 400, {"error": str(e)}
        push(uid, payload)
        return 200, {"enabled": True, "uid": uid, **pull(uid)}
    except Exception as e:
        _record_error(e)
        print(f"Neon sync error: {e!r}", flush=True)
        return 502, {"error": "Database temporarily unavailable — local data is safe."}
