# PAIRWIRE v2 — News Intelligence Terminal

A wire-service / trading-terminal style web app that **automatically scans the news for any
instrument** — forex pairs (including unlisted crosses), stocks, indices, crypto, commodities
and macro gauges — then scores it, charts it, and watches it for breaking headlines.

Flat print/terminal design (light **WIRE** + dark **TERMINAL** themes). No gradients, no glass,
no generic "AI app" styling. **Zero dependencies and no API keys.**

## Run it 24/7 on Vercel (recommended)

This folder is a complete Vercel project — see **[DEPLOY.md](DEPLOY.md)** for the full guide.
The short version (needs Node.js for the CLI and your own free Vercel account):

```bash
cd news-scanner
npm install -g vercel
vercel login
vercel --prod      # → permanent https://…vercel.app URL, no server to keep running
```

Vercel serves `public/` from its CDN and runs each `/api/*.py` file as a Python Function
on demand. An optional daily cron (`/api/cron`) can scan a watch set in the background
and send webhook/Telegram alerts — details and env vars in DEPLOY.md / `.env.example`.

## Run locally

```bash
cd news-scanner
python3 local_server.py     # http://localhost:8080   (Windows: py local_server.py)
PORT=9000 python3 local_server.py   # custom port
```

Local and Vercel run the **same engine**: `local_server.py` and every Vercel Function
call one shared dispatcher (`api/_pairwire.py → handle_api`).

## What you can scan

| Input | Behaviour |
|---|---|
| `EUR/USD`, `GBP/JPY`, `USD/NGN`, `AUD/NZD`… | **Any** forex pair. Split into base + quote; 4 wire searches run (pair, pair forecast, base currency + its central bank, quote currency + its central bank), plus matching stories from the CNBC & MarketWatch wires. |
| `GBP`, `NGN`, `USD`, any currency code | Single-currency scan (currency + central bank news). |
| Pair builder | Pick any 2 of 34 currencies → scan that cross. ⇄ swaps direction. |
| `AAPL`, `NVDA`, any ticker (`SHOP`, `HOOD`, …) | Exact-ticker search + company news. 13F "holdings churn" fillers are automatically demoted. |
| `SPX500`, `NAS100`, `US30`, `UK100`, `GER40`, `JPN225`, `IN50`… | Indices (aliases `DAX`, `DOW`, `NASDAQ`, `SP500` work). |
| `DXY`, `US10Y`, `US30Y`, `VIX` | Macro gauges: dollar index, Treasury yields, volatility. |
| `BTCUSD`, `ETHUSD`, `AVAXUSD`… | Crypto pairs (any `COIN+USD/USDT`). |
| `GOLD`/`XAUUSD`, `WTI`, `BRENT`, `NATGAS`, `COPPER`… | Commodities. |
| Anything else, e.g. `nigerian naira` | Free-text news search. |

Press **Ctrl+K** for the fuzzy command palette (companies, currencies, tickers, recent scans).

## What each scan produces

- **Desk Brief** — auto-generated verdict: pair-aware bias score (−100…+100) with confidence,
  what is driving it, which side of the pair the pressure is on, key headline risks — plus a
  **plain-English summary** that separates direction pressure from trading-conditions risk.
- **News Conditions Risk** — a separate 0–100 gauge (LOW → EXTREME) for how disorderly the
  news window may be: imminent/recent calendar releases, fresh high-impact bursts, news heat,
  day move and two-way headline conflict. It lists every point awarded and includes a checklist
  on spreads, slippage, gaps/whipsaws, stop fills and broker/margin rules. It is **not** a
  direction forecast, win/loss probability or recommendation.
- **Bias Meter** — blends pair headline flow + **base-currency strength − quote-currency
  strength** (hawkish/dovish, beats/misses), weighted by impact, source tier and recency.
  Strong quote-currency news correctly counts *against* the pair.
- **Stories, not noise** — the same event from 6 outlets is clustered into one story
  ("+N more outlets" expands coverage). Every headline carries a transparent
  **Score** (relevance + impact + recency + coverage), an **Impact score 0–100**,
  source **Tier 1/2/3**, driver tag and a **“WHY THIS SCORE?”** box listing the matched
  terms, source/freshness points, pair-direction logic and the exact score blend.
- **Candlestick chart** (1D→5Y) with crosshair OHLC readout and ◆ markers for high-impact
  headlines — click a marker to jump to that story. Plus a 24h headline-flow strip.
- **Economic calendar** (ForexFactory) auto-filtered to your pair's currencies, with a
  plain-English explainer under recognised releases (CPI, jobs, GDP, PMI, rate decisions,
  speeches…) and a clear distinction between ForexFactory's event class and PairWire's own
  headline Impact score.
- **Market Radar** — scans 10 majors (or your **My List**) and ranks them by **news heat**.
- **Currency strength board**, session clock, clickable ticker tape, feed-health status.
- **Breaking alerts** while the page is open (banner + optional sound/browser notification),
  plus the server-side **cron monitor** for when it isn't (see DEPLOY.md).
- **My List** pinning, saved headlines, recent scans (stored in your browser). Your last
  scanned instrument, chart timeframe and watchlist tab are also restored on refresh. If the
  browser blocks local storage (private mode / embedded preview frame), an amber banner warns
  that changes only last for the session — nothing fails silently.
- **Reading guide + fictional DEMO mode** — “? HOW TO READ THIS” explains LOW/MEDIUM/HIGH,
  every score, pair direction and the risks of trading through news. **DEMO** loads an invented
  EUR/USD scan (headlines, price, chart and calendar) under a permanent banner, pauses live
  scan/tape/strength/radar loading, blocks saving/copying its fake links, and exits back to the
  previous live symbol. Demo data exists only in that mode.
- Filters: stories vs all headlines, ▲/▼ direction, high impact, 1H/6H/24H/7D, base/quote
  side, source tier, text, sort by time/score/impact/relevance, compact density.
- **Export** CSV or a text Desk Brief. Print view supported.
- Keyboard: `Ctrl K` search · `/` instrument box · `R` rescan · `1–4` direction filters.

## Data sources (all free, no keys)

- **News:** Google News RSS search aggregation + direct CNBC and MarketWatch RSS wires.
- **Prices/candles:** Yahoo Finance chart API (delayed). Day change uses Yahoo's own
  `regularMarketChangePercent`. Note: Yahoo returns HTTP 429 to full Chrome user-agent
  strings; the engine deliberately sends a bare `Mozilla/5.0`.
- **Calendar:** ForexFactory weekly JSON via `nfs.faireconomy.media`.

Caches are in-process (scans/prices 60 s, wires 300 s, calendar 15 min). On Vercel that
means *per serverless instance* — a cold instance simply fetches fresh data.

### Real vs calculated vs demo (important)

- **Default mode is live, not demo.** Headlines, timestamps, publishers and links come from the
  public feeds above; the header badge says **LIVE PUBLIC FEEDS** and `/api/scan` returns
  `dataMode: "LIVE"`.
- **Calculated by PairWire:** Impact, Relevance, Story Score, Bias, Confidence, Heat, clusters,
  Desk Brief and News Conditions Risk. These are transparent rule-based estimates from real
  inputs. They are not supplied by publishers, are not facts, and can be wrong.
- **Fictional only in DEMO mode:** the demo dataset is generated in the browser for teaching,
  is bannered/badged as fictional everywhere it appears, and never mixes with the default
  live scan. Prices in live mode are real but **delayed**, so use your broker for execution.

## API

```
GET /api/scan?symbol=EUR/USD         full scan (news + scoreReasons, stories, briefing, risk, dataMode, stats…)
GET /api/chart?symbol=EUR/USD&tf=1M  candles: 1D 5D 1M 6M 1Y 5Y
GET /api/calendar?currencies=EUR,USD this week's events (omit filter for all)
GET /api/radar?symbols=EURUSD,GBPJPY ranked by news heat (max 12)
GET /api/strength                    8 major currencies ranked by today's % vs USD
GET /api/tape                        ticker-tape quotes
GET /api/symbols                     watchlist groups + 34 currencies
GET /api/health                      runtime + per-process feed status
GET|POST /api/cron                   secured background monitor (see DEPLOY.md)
```

## Files

```
news-scanner/
├── public/                 static front end (the only web-served folder)
│   ├── index.html
│   └── static/  app.js, style.css   (WIRE + TERMINAL themes)
├── api/
│   ├── _pairwire.py        the engine: resolving, scoring, clustering, bias, radar…
│   ├── _http.py            shared HTTP handler ("_" helper, not an endpoint)
│   └── scan.py chart.py tape.py strength.py radar.py
│       calendar.py symbols.py health.py cron.py    (one Vercel Function each)
├── local_server.py         local dev server (same dispatcher as production)
├── vercel.json             functions (60s), daily cron, headers, outputDirectory
├── .python-version         3.12
├── requirements.txt        empty on purpose — standard library only
├── .env.example            optional cron/alert settings (website needs none)
├── DEPLOY.md               Vercel deployment + 24/7 guide
└── .github/workflows/pairwire-cron.yml.example   optional free 15-min scheduler
```

## Honest limitations

- Prices are **delayed** and for reference only — trade off your broker feed.
- Sentiment/bias/risk are transparent headline rule-scores, **not financial advice**. Wording
  rules can miss sarcasm, context, guidance buried in an article, or what was already priced in.
- Serverless has no shared memory: caches, feed-status and cron alert de-duplication are
  per-instance (best-effort). Add Vercel KV/a database if you ever need guarantees.
- Google News RSS is a personal-use aggregation feed. For licensed low-latency wire data,
  replace `fetch_google_news()` in `api/_pairwire.py` with a paid provider — the
  scoring/clustering/UI pipeline stays identical.
- "24/7" on Vercel means *always available on demand*, not a process scanning between
  requests; background scanning is what `/api/cron` + a scheduler is for.
- Session open/close times are standard UTC approximations (DST edges vary).
