-- PAIRWIRE — Neon Postgres schema
--
-- Applied automatically on the first request that uses DATABASE_URL
-- (see api/_db.py → ensure_schema), or manually with:
--     psql "$DATABASE_URL" -f db/schema.sql
--
-- Model: anonymous clients. The browser generates a random UUID (pw_uid) and
-- sends it with every sync; there are no passwords or personal accounts.
-- Anyone who knows a client_id can read that dataset, so the UUID is the
-- secret — use 122 bits of randomness (crypto.randomUUID) and never share it.

CREATE TABLE IF NOT EXISTS users (
    client_id    TEXT PRIMARY KEY,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlist (
    client_id  TEXT NOT NULL REFERENCES users(client_id) ON DELETE CASCADE,
    symbol     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, symbol)
);

CREATE TABLE IF NOT EXISTS saved_headlines (
    client_id TEXT NOT NULL REFERENCES users(client_id) ON DELETE CASCADE,
    key       TEXT NOT NULL,
    title     TEXT NOT NULL,
    link      TEXT NOT NULL DEFAULT '',
    source    TEXT NOT NULL DEFAULT '',
    ts        BIGINT NOT NULL DEFAULT 0,
    symbol    TEXT NOT NULL DEFAULT '',
    saved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, key)
);

CREATE TABLE IF NOT EXISTS recent_scans (
    client_id       TEXT NOT NULL REFERENCES users(client_id) ON DELETE CASCADE,
    symbol          TEXT NOT NULL,
    last_scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, symbol)
);

CREATE TABLE IF NOT EXISTS settings (
    client_id  TEXT NOT NULL REFERENCES users(client_id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (client_id, key)
);

-- Reliable, cross-instance de-dupe for the /api/cron background monitor.
CREATE TABLE IF NOT EXISTS cron_alert_seen (
    key        TEXT PRIMARY KEY,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_client ON watchlist(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_saved_client     ON saved_headlines(client_id, saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_recent_client    ON recent_scans(client_id, last_scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_settings_client  ON settings(client_id);
CREATE INDEX IF NOT EXISTS idx_cron_seen_time   ON cron_alert_seen(first_seen);
