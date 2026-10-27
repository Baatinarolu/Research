# Deploy PAIRWIRE to Vercel (24/7)

PAIRWIRE is now a standard Vercel project. There is **no always-running server to keep alive**:
Vercel serves the front end from its CDN and runs each API call as a short-lived Python
Function, on demand, day and night. Your computer does not need to be on.

```
news-scanner/                 ← this folder IS the Vercel project root
├── public/                   ← the ONLY folder served as static files
│   ├── index.html
│   └── static/app.js, style.css
├── api/
│   ├── scan.py  chart.py  tape.py  strength.py  radar.py
│   ├── calendar.py  symbols.py  health.py  cron.py   ← one Vercel Function each
│   ├── _http.py              ← shared handler ("_" = helper, not an endpoint)
│   └── _pairwire.py          ← the whole scanning engine (stdlib only)
├── vercel.json               ← functions (60s), cron, headers, output dir
├── .python-version           ← 3.12
├── requirements.txt          ← intentionally empty: zero dependencies
└── local_server.py           ← local dev only; Vercel ignores it
```

No API keys are required for the website itself. The only thing a deployment needs is
**your own Vercel account** — nobody (including an AI assistant) can log into Vercel for you.

The reading guide, “WHY THIS SCORE?” explanations, News Conditions Risk panel and fictional
**DEMO** mode need no extra Vercel configuration: explanations/risk are returned by the same
`/api/scan` function, while demo data is generated locally in the browser and is never a
server endpoint or the default mode.

---

## Option A — Vercel CLI (fastest, ~2 minutes)

You need Node.js installed for the CLI.

```bash
cd news-scanner
npm install -g vercel     # or: npx vercel
vercel login              # opens your browser
vercel                    # preview deploy; accept the defaults
vercel --prod             # production deploy → your permanent https://…vercel.app URL
```

When asked: set up in the current directory, no code/framework overrides needed —
`vercel.json` already declares everything (`framework: null`, `outputDirectory: public`,
functions, cron).

## Option B — GitHub import (auto-deploys on every push)

1. Push **the contents of this folder** to a GitHub repository.
   (If your repo root is one level above this folder, set Vercel's
   **Root Directory** to `news-scanner`.)
2. In Vercel: **Add New… → Project → Import** the repo.
3. Framework Preset: **Other**. Build Command: leave empty. Output Directory: `public`
   (both already in `vercel.json`).
4. **Deploy.** Every later `git push` redeploys automatically.

## Verify the deployment

```bash
curl https://YOUR-APP.vercel.app/api/health
curl "https://YOUR-APP.vercel.app/api/scan?symbol=EUR/USD" | head -c 500
```

In that scan JSON, confirm `dataMode` is `LIVE`, a `risk` object is present, and headlines
carry `scoreReasons`. Then open `https://YOUR-APP.vercel.app`, scan something, open
**? HOW TO READ THIS**, and hard-refresh once (so no cached copy of the old local version is
shown). If you test **DEMO**, you should see the permanent fictional-data banner; use
**EXIT DEMO** to return to live public feeds.

---

## "Run 24/7" — what that means here

| Thing | Behaviour on Vercel |
|---|---|
| The website + API | **Always available.** No process to babysit; functions spin up per request (first cold call may take a second or two). |
| Auto-rescan in the app | Runs while the page is open in a browser (same as locally). |
| Background monitoring while no browser is open | Needs the **cron endpoint** below. A serverless site does not scan by itself between requests. |

### Background monitor (`/api/cron`)

`vercel.json` already schedules `GET /api/cron` **daily at 06:00 UTC** — deliberately,
because free **Hobby accounts may only run cron jobs once per day**, and a more frequent
expression makes the *deployment fail*. Each run scans a small watch set, finds fresh
high-impact headlines and (optionally) sends them to you.

To get alerts, set these in **Vercel → Project → Settings → Environment Variables**
(then redeploy). Nothing here is required for the website itself:

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | **Recommended.** Random string, 16+ chars. Vercel Cron automatically sends it as `Authorization: Bearer …`; the endpoint rejects everything else. |
| `CRON_SYMBOLS` | Watch set, e.g. `EURUSD,USDJPY,XAUUSD,BTCUSD` (default: 6 majors). Max 8. |
| `CRON_WINDOW_MINUTES` | "Fresh" window for alerts (default `120`). |
| `CRON_MIN_IMPACT` | Alert threshold, impact score 1–100 (default `70`). |
| `CRON_ALWAYS_NOTIFY` | `true` = send a summary even when there are no alerts. |
| `ALERT_WEBHOOK_URL` | Slack or Discord incoming-webhook URL (both payload keys are sent). |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Telegram alerts via your own bot (create one with @BotFather). |

Test it anytime after deploying:

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://YOUR-APP.vercel.app/api/cron
```

### Want background checks every 15 minutes?

Two honest routes:

1. **Vercel Pro** — change the schedule in `vercel.json` to `"*/15 * * * *"` and redeploy.
   (On Hobby this exact change fails the deployment — by Vercel's design, not a bug.)
2. **Free external scheduler** — any cron service (GitHub Actions, cron-job.org, UptimeRobot…)
   can call the same secured URL every 15 minutes. A ready-made GitHub Actions example is in
   `.github/workflows/pairwire-cron.yml.example` — rename it to `.yml`, add the two repo
   secrets it names, done. Note GitHub's scheduler can be delayed several minutes.

Alert de-duplication is best-effort in serverless memory: if Vercel starts a fresh
instance, an alert can repeat. For guaranteed once-only alerts you'd add a small store
(Vercel KV/Upstash, a database) — deliberately not bundled so the default deploy stays
account- and key-free.

### Cross-device storage with Neon Postgres (optional)

By default all personal data (My List, saved headlines, recents, theme and
other settings) lives in the browser's `localStorage`, so it does not follow
you between devices. Setting one environment variable, `DATABASE_URL`, turns
on **Neon serverless Postgres** sync with no other code changes:

- The browser keeps an anonymous random ID (`pw_uid`, a UUID v4 — no login,
  no passwords, no personal data) and pushes its state to `/api/sync`.
- On a new browser/device, the same ID restores everything after you copy it
  across (see *Moving to another device* below); different IDs are separate
  datasets. Treat the UUID as a secret — anyone holding it can read that
  dataset.
- The same database gives `/api/cron` **guaranteed alert de-duplication**
  across serverless cold starts (the in-memory de-dupe remains as fallback).
- Without `DATABASE_URL`, nothing changes: the app stays 100% browser-local
  and `requirements.txt`'s one package is simply never imported.

#### Setup (~5 minutes, free tier)

1. Create a free project at <https://neon.tech> (GitHub login works). Pick the
   region closest to your Vercel deployment.
2. On the project **Dashboard → Connection Details**, choose **Pooled
   connection string** (the host contains `-pooler`). Copy it — it looks like
   `postgresql://USER:PASSWORD@ep-…-pooler.…neon.tech/neondb?sslmode=require`.
3. In Vercel: **Project → Settings → Environment Variables**, add
   `DATABASE_URL` = that string (all environments), then **Redeploy**.
4. That's it. The tables in [`db/schema.sql`](db/schema.sql) are created
   automatically on the first sync request (idempotent `CREATE TABLE IF NOT
   EXISTS`). Verify:

   ```bash
   curl "https://YOUR-APP.vercel.app/api/health"            # database.enabled = true
   curl "https://YOUR-APP.vercel.app/api/sync?uid=12345678-1234-4123-8234-1234567890ab"
   # → {"enabled": true, "watchlist": [], "saved": [], ...}
   ```

   In the app, the top-bar indicator reads **SYNC: ON** (green). If the
   database is ever unreachable it shows **SYNC: ERROR · LOCAL ONLY** —
   local data keeps working and retries automatically.

#### Optional: apply the schema manually

```bash
pip install "psycopg[binary]>=3.1,<4"
psql "$DATABASE_URL" -f db/schema.sql     # or paste the file into Neon's SQL editor
```

#### Local development with the database

```bash
export DATABASE_URL="postgresql://…-pooler.…neon.tech/neondb?sslmode=require"
pip install -r requirements.txt
python3 local_server.py
```

#### Moving to another device

The anonymous ID is the only credential. In the old browser, run
`localStorage.getItem("pw_uid")` in the developer console; in the new browser
on the same site, run `localStorage.setItem("pw_uid", "that-uuid")` and
reload. Your data pulls down from Neon.

#### What is stored

| Table | Contents |
|---|---|
| `users` | Anonymous client UUID + first-seen / last-seen timestamps |
| `watchlist` | My List symbols, per client |
| `saved_headlines` | Saved headline key, title, link, source, timestamp, symbol |
| `recent_scans` | Recently scanned symbols with last-scanned time |
| `settings` | Theme, interval, sound, compact, notifications, timeframe, tab, last symbol |
| `cron_alert_seen` | Alert de-dupe keys (7-day rolling window) |

Payloads are validated and capped server-side (200 watchlist rows, 500 saved
headlines, 20 recents, scalar settings only; max 60 KB per request).

### Usage/cost note

Every open browser tab auto-rescans on the interval chosen in the app, and each scan
calls the upstream news/price feeds. For a public deployment, prefer the 5/15-minute
interval, and remember the free upstream feeds can rate-limit bursts (the radar scans
10 instruments). Heavy public/commercial traffic belongs on Vercel Pro with licensed
data feeds — see "Honest limitations" in `README.md`.

---

## Custom domain (optional)

Vercel → Project → **Settings → Domains** → add your domain and create the DNS records
Vercel shows you. HTTPS certificates are automatic.

## Local development (unchanged engine)

```bash
python3 local_server.py     # http://localhost:8080  (Windows: py local_server.py)
```

`local_server.py` and the Vercel Functions call the *same* dispatcher
(`api/_pairwire.py → handle_api`), so local and production behaviour match.
If you have the Vercel CLI linked to the project, `vercel dev` also works.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Deployment serves a directory listing / 404 at `/` | Root Directory is wrong. It must be the folder containing `vercel.json` + `public/`. |
| Deploy fails: *"Hobby accounts are limited to daily cron jobs"* | Your `crons` schedule runs more than once a day on a Hobby account. Use `0 6 * * *`, upgrade to Pro, or use an external scheduler (above). |
| `/api/cron` returns 401 from Vercel Cron | `CRON_SECRET` in the project doesn't match, or env vars were added without redeploying. Redeploy after changing env vars. |
| `FUNCTION_INVOCATION_TIMEOUT` | An upstream feed hung. Functions allow 60s (`maxDuration` in `vercel.json`); check Vercel → Logs, then simply retry — scans normally take ~1s. |
| Header says "Feeds: Vercel serverless · verified by each scan" | Normal. Each serverless instance has its own memory, so the health function can't see the scan function's feed log; the scan results themselves are the live check. |
| Old design still showing | Hard-refresh (Ctrl/Cmd+Shift+R). Static files are CDN-cached for an hour per `vercel.json`. |
| Page says DEMO / fictional data | Demo mode was opened deliberately from **DEMO** or the guide. This is browser-side teaching data, not the deployment's live feed. Click **EXIT DEMO**; the badge should return to **LIVE PUBLIC FEEDS**. |
| I added Flask/FastAPI and `/api/*.py` stopped working | Expected: a detected Python framework preset takes over *all* routing and file-based functions stop being created. This project is intentionally framework-free. |
