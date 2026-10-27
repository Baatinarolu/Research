#!/usr/bin/env python3
"""
PAIRWIRE shared engine — used unchanged by:
  - Vercel Functions in /api        (production, always-on serverless)
  - local_server.py                 (local development)

Stdlib only. No API key required.
Data:
  - News      : Google News RSS search + direct CNBC / MarketWatch wires
  - Prices    : Yahoo Finance chart endpoint (delayed), incl. OHLC candles
  - Calendar  : ForexFactory weekly feed via faireconomy.media
"""
import hmac
import json
import math
import os
import re
import time
import html as ihtml
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from threading import Lock

# NOTE: keep this plain — Yahoo's chart endpoint returns HTTP 429 for full Chrome UA strings
# but accepts a bare "Mozilla/5.0" (verified live). Google News / RSS feeds accept it too.
UA = {"User-Agent": "Mozilla/5.0"}

_cache = {}
_cache_lock = Lock()
_status = {}
_status_lock = Lock()

def cache_get(key, ttl):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and (time.time() - hit[0]) < ttl:
            return hit[1]
    return None

def cache_set(key, value):
    with _cache_lock:
        _cache[key] = (time.time(), value)

def set_status(feed, ok, detail=""):
    with _status_lock:
        _status[feed] = {"ok": bool(ok), "detail": str(detail)[:120], "ts": int(time.time())}

# ---------------------------------------------------------------- currencies
CURRENCIES = {
    "USD": ("US Dollar", "Federal Reserve"),
    "EUR": ("Euro", "European Central Bank ECB"),
    "GBP": ("British Pound", "Bank of England"),
    "JPY": ("Japanese Yen", "Bank of Japan"),
    "CHF": ("Swiss Franc", "Swiss National Bank"),
    "AUD": ("Australian Dollar", "Reserve Bank of Australia"),
    "NZD": ("New Zealand Dollar", "Reserve Bank of New Zealand"),
    "CAD": ("Canadian Dollar", "Bank of Canada"),
    "CNY": ("Chinese Yuan", "People's Bank of China"),
    "HKD": ("Hong Kong Dollar", "Hong Kong Monetary Authority"),
    "SGD": ("Singapore Dollar", "Monetary Authority of Singapore"),
    "MXN": ("Mexican Peso", "Banco de Mexico Banxico"),
    "BRL": ("Brazilian Real", "Banco Central do Brasil"),
    "ZAR": ("South African Rand", "South African Reserve Bank"),
    "TRY": ("Turkish Lira", "Central Bank of Turkey"),
    "INR": ("Indian Rupee", "Reserve Bank of India"),
    "KRW": ("South Korean Won", "Bank of Korea"),
    "SEK": ("Swedish Krona", "Riksbank Sweden"),
    "NOK": ("Norwegian Krone", "Norges Bank"),
    "DKK": ("Danish Krone", "Danmarks Nationalbank"),
    "PLN": ("Polish Zloty", "National Bank of Poland"),
    "HUF": ("Hungarian Forint", "Hungarian National Bank"),
    "CZK": ("Czech Koruna", "Czech National Bank"),
    "ILS": ("Israeli Shekel", "Bank of Israel"),
    "AED": ("UAE Dirham", "Central Bank of UAE"),
    "SAR": ("Saudi Riyal", "Saudi Central Bank"),
    "THB": ("Thai Baht", "Bank of Thailand"),
    "IDR": ("Indonesian Rupiah", "Bank Indonesia"),
    "PHP": ("Philippine Peso", "Bangko Sentral ng Pilipinas"),
    "RUB": ("Russian Ruble", "Bank of Russia"),
    "NGN": ("Nigerian Naira", "Central Bank of Nigeria"),
    "KES": ("Kenyan Shilling", "Central Bank of Kenya"),
    "GHS": ("Ghanaian Cedi", "Bank of Ghana"),
    "EGP": ("Egyptian Pound", "Central Bank of Egypt"),
}

def forex_instrument(base, quote):
    bname, bbank = CURRENCIES.get(base, (base, base))
    qname, qbank = CURRENCIES.get(quote, (quote, quote))
    return {
        "symbol": f"{base}{quote}",
        "display": f"{base}/{quote}",
        "name": f"{bname} / {qname}",
        "type": "FOREX",
        "yahoo": f"{base}{quote}=X",
        "base": base, "quote": quote,
        "baseName": bname, "quoteName": qname,
        "queries": [
            (f"{base}/{quote} forex", "PAIR"),
            (f"{base} {quote} exchange rate forecast", "PAIR"),
            (f"{bname} currency {bbank}", "BASE"),
            (f"{qname} currency {qbank}", "QUOTE"),
        ],
    }

def currency_instrument(code):
    name, bank = CURRENCIES[code]
    if code == "USD":
        yahoo = "DX-Y.NYB"
    elif code in ("EUR", "GBP", "AUD", "NZD"):
        yahoo = f"{code}USD=X"
    else:
        yahoo = f"USD{code}=X"
    return {
        "symbol": code, "display": code, "name": f"{name} — single currency scan",
        "type": "CURRENCY", "yahoo": yahoo,
        "base": code, "quote": "USD" if code != "USD" else None,
        "baseName": name, "quoteName": "US Dollar" if code != "USD" else None,
        "queries": [
            (f"{name} currency news", "BASE"),
            (f"{bank} {name}", "BASE"),
            (f"{code} exchange rate", "PAIR"),
        ],
    }

# ---------------------------------------------------------------- presets
PRESETS = {}

def _add(symbol, display, name, typ, yahoo, queries, aliases=()):
    PRESETS[symbol] = {
        "symbol": symbol, "display": display, "name": name, "type": typ,
        "yahoo": yahoo, "queries": [(q, b) for q, b in queries],
    }
    for a in aliases:
        PRESETS[a] = PRESETS[symbol]

# Macro / risk gauges
_add("DXY", "DXY", "US Dollar Index", "MACRO", "DX-Y.NYB",
     [("US dollar index DXY", "MACRO"), ("US dollar Federal Reserve", "MACRO")], aliases=("USDX", "DOLLARINDEX"))
_add("US10Y", "US10Y", "US 10-Year Treasury Yield", "MACRO", "^TNX",
     [("10-year Treasury yield", "MACRO"), ("US Treasury yields Federal Reserve", "MACRO")], aliases=("TNX", "US10YR"))
_add("US30Y", "US30Y", "US 30-Year Treasury Yield", "MACRO", "^TYX",
     [("30-year Treasury yield", "MACRO")], aliases=("TYX",))
_add("VIX", "VIX", "CBOE Volatility Index", "MACRO", "^VIX",
     [("VIX volatility index stocks", "MACRO"), ("market volatility fear index", "MACRO")], aliases=("FEARINDEX",))

# Indices
_add("SPX500", "SPX500", "S&P 500", "INDEX", "^GSPC",
     [("S&P 500 index today", "INDEX"), ("S&P 500 stocks market", "INDEX"), ("Wall Street stocks Federal Reserve", "MARKET")],
     aliases=("SP500", "US500", "SPX", "S&P500", "SANDP500"))
_add("NAS100", "NAS100", "Nasdaq 100", "INDEX", "^NDX",
     [("Nasdaq 100 index today", "INDEX"), ("Nasdaq tech stocks", "INDEX")],
     aliases=("NASDAQ", "NASDAQ100", "US100", "NDX", "USTEC"))
_add("US30", "US30", "Dow Jones Industrial Average", "INDEX", "^DJI",
     [("Dow Jones Industrial Average today", "INDEX"), ("Dow Jones stocks market", "INDEX")],
     aliases=("DOW", "DOWJONES", "DJIA"))
_add("US2000", "US2000", "Russell 2000", "INDEX", "^RUT",
     [("Russell 2000 index small caps", "INDEX")], aliases=("RUT", "RUSSELL2000"))
_add("UK100", "UK100", "FTSE 100", "INDEX", "^FTSE",
     [("FTSE 100 index today", "INDEX"), ("FTSE 100 London stocks", "INDEX")], aliases=("FTSE", "FTSE100"))
_add("GER40", "GER40", "DAX 40 (Germany)", "INDEX", "^GDAXI",
     [("DAX index Germany today", "INDEX"), ("DAX 40 stocks Frankfurt", "INDEX")], aliases=("DAX", "GER30", "DAX40", "DE40"))
_add("FRA40", "FRA40", "CAC 40 (France)", "INDEX", "^FCHI",
     [("CAC 40 index Paris today", "INDEX")], aliases=("CAC40", "CAC", "FR40"))
_add("JPN225", "JPN225", "Nikkei 225 (Japan)", "INDEX", "^N225",
     [("Nikkei 225 index today", "INDEX"), ("Nikkei Japan stocks", "INDEX")], aliases=("NIKKEI", "NIKKEI225", "JP225"))
_add("AUS200", "AUS200", "S&P/ASX 200 (Australia)", "INDEX", "^AXJO",
     [("ASX 200 index today Australia", "INDEX")], aliases=("ASX200", "AU200"))
_add("HK50", "HK50", "Hang Seng (Hong Kong)", "INDEX", "^HSI",
     [("Hang Seng index today", "INDEX"), ("Hong Kong stocks Hang Seng", "INDEX")], aliases=("HANGSENG", "HSI"))
_add("EUSTX50", "EUSTX50", "Euro Stoxx 50", "INDEX", "^STOXX50E",
     [("Euro Stoxx 50 index today", "INDEX")], aliases=("STOXX50", "EU50"))
_add("IN50", "IN50", "Nifty 50 (India)", "INDEX", "^NSEI",
     [("Nifty 50 index today", "INDEX"), ("Sensex Nifty India stocks", "INDEX")], aliases=("NIFTY", "NIFTY50"))
_add("CHN50", "CHN50", "FTSE China A50 proxy (FXI)", "INDEX", "FXI",
     [("China stocks market today Shanghai", "INDEX")], aliases=("CHINA50", "CN50"))

# Commodities
_add("XAUUSD", "XAU/USD", "Gold / US Dollar", "COMMODITY", "GC=F",
     [("gold price today", "COMMODITY"), ("gold market Federal Reserve dollar", "COMMODITY")], aliases=("GOLD", "XAU"))
_add("XAUEUR", "XAU/EUR", "Gold / Euro", "COMMODITY", "GCEUR=X" ,
     [("gold price in euros", "COMMODITY"), ("gold price today", "COMMODITY")], aliases=("GOLDEUR",))
_add("XAGUSD", "XAG/USD", "Silver / US Dollar", "COMMODITY", "SI=F",
     [("silver price today", "COMMODITY"), ("silver market news", "COMMODITY")], aliases=("SILVER", "XAG"))
_add("WTI", "WTI", "WTI Crude Oil", "COMMODITY", "CL=F",
     [("WTI crude oil price today", "COMMODITY"), ("oil prices OPEC inventories", "COMMODITY")],
     aliases=("USOIL", "OIL", "CRUDE", "CRUDEOIL", "WTIUSD", "USOILUSD"))
_add("BRENT", "BRENT", "Brent Crude Oil", "COMMODITY", "BZ=F",
     [("Brent crude oil price today", "COMMODITY"), ("oil prices OPEC", "COMMODITY")], aliases=("UKOIL", "BRENTUSD"))
_add("NATGAS", "NATGAS", "Natural Gas", "COMMODITY", "NG=F",
     [("natural gas price today", "COMMODITY"), ("natural gas inventories weather", "COMMODITY")], aliases=("NG", "NATURALGAS", "NATGASUSD"))
_add("COPPER", "COPPER", "Copper", "COMMODITY", "HG=F",
     [("copper price today", "COMMODITY"), ("copper market China demand", "COMMODITY")], aliases=("XCUUSD",))
_add("PLATINUM", "PLATINUM", "Platinum", "COMMODITY", "PL=F",
     [("platinum price today", "COMMODITY")], aliases=("XPTUSD",))
_add("COFFEE", "COFFEE", "Coffee", "COMMODITY", "KC=F",
     [("coffee prices futures market", "COMMODITY")], aliases=("COFFEEUSD",))
_add("WHEAT", "WHEAT", "Wheat", "COMMODITY", "ZW=F",
     [("wheat prices futures market", "COMMODITY")], aliases=("WHEATUSD",))

# Crypto
for sym, name, yh, al in [
    ("BTCUSD", "Bitcoin / US Dollar", "BTC-USD", ("BITCOIN", "BTC")),
    ("ETHUSD", "Ethereum / US Dollar", "ETH-USD", ("ETHEREUM", "ETH")),
    ("SOLUSD", "Solana / US Dollar", "SOL-USD", ("SOLANA", "SOL")),
    ("XRPUSD", "XRP / US Dollar", "XRP-USD", ("XRP", "RIPPLE")),
    ("DOGEUSD", "Dogecoin / US Dollar", "DOGE-USD", ("DOGECOIN", "DOGE")),
    ("ADAUSD", "Cardano / US Dollar", "ADA-USD", ("CARDANO", "ADA")),
    ("LTCUSD", "Litecoin / US Dollar", "LTC-USD", ("LITECOIN", "LTC")),
    ("LINKUSD", "Chainlink / US Dollar", "LINK-USD", ("CHAINLINK", "LINK")),
    ("AVAXUSD", "Avalanche / US Dollar", "AVAX-USD", ("AVALANCHE", "AVAX")),
    ("BNBUSD", "BNB / US Dollar", "BNB-USD", ("BNB", "BINANCECOIN")),
]:
    coin = name.split(" /")[0]
    _add(sym, sym[:-3] + "/USD", name, "CRYPTO", yh,
         [(f"{coin} price today", "CRYPTO"), (f"{coin} crypto news", "CRYPTO")], aliases=al)

# Blue-chip stocks (any other ticker typed is resolved dynamically)
STOCKS = {
    "AAPL": "Apple Inc.", "MSFT": "Microsoft", "NVDA": "NVIDIA", "AMZN": "Amazon",
    "GOOGL": "Alphabet (Google)", "GOOG": "Alphabet (Google)", "META": "Meta Platforms",
    "TSLA": "Tesla", "NFLX": "Netflix", "AMD": "Advanced Micro Devices", "INTC": "Intel",
    "JPM": "JPMorgan Chase", "BAC": "Bank of America", "GS": "Goldman Sachs", "WMT": "Walmart",
    "XOM": "Exxon Mobil", "CVX": "Chevron", "V": "Visa", "MA": "Mastercard",
    "HD": "Home Depot", "DIS": "Walt Disney", "BA": "Boeing", "COIN": "Coinbase",
    "PLTR": "Palantir", "AVGO": "Broadcom", "COST": "Costco", "LLY": "Eli Lilly",
    "SHOP": "Shopify", "UBER": "Uber", "ABNB": "Airbnb", "CRM": "Salesforce",
    "ORCL": "Oracle", "ADBE": "Adobe", "PYPL": "PayPal", "NKE": "Nike", "MCD": "McDonald's",
    "UNH": "UnitedHealth", "BRK-B": "Berkshire Hathaway", "ARM": "Arm Holdings",
    "SMCI": "Super Micro Computer", "MSTR": "MicroStrategy", "HOOD": "Robinhood",
}
for tkr, comp in STOCKS.items():
    _add(tkr, tkr, comp, "STOCK", tkr,
         [(f'"{tkr}" stock', "COMPANY"), (f"{comp} shares earnings", "COMPANY")],
         aliases=(comp.upper().replace(" ", "").replace(".", "").replace(",", "").replace("'", ""),))

FOREX_WATCH = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "NZDUSD", "USDCAD",
               "EURGBP", "EURJPY", "GBPJPY", "AUDJPY", "EURCHF", "GBPCHF", "AUDNZD",
               "USDZAR", "USDTRY", "USDMXN", "USDCNH", "USDINR", "USDNGN"]
for p in FOREX_WATCH:
    b, q = p[:3], p[3:]
    if b in CURRENCIES and q in CURRENCIES:
        PRESETS[p] = forex_instrument(b, q)
# USDCNH: offshore yuan trades as CNH in most terminals; Yahoo uses USDCNH=X, news via CNY terms
PRESETS["USDCNH"] = forex_instrument("USD", "CNY")
PRESETS["USDCNH"].update({"symbol": "USDCNH", "display": "USD/CNH", "yahoo": "USDCNH=X"})

PEERS = {
    "tech": ["AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMZN", "AVGO", "AMD"],
    "banks": ["JPM", "BAC", "GS", "V", "MA", "PYPL"],
    "energy": ["XOM", "CVX"],
}
TICKER_PEERGROUP = {}
for g, members in PEERS.items():
    for m in members:
        TICKER_PEERGROUP[m] = g

def resolve(raw):
    """Turn anything the user types into an instrument definition."""
    s = (raw or "").strip().upper()
    s_clean = re.sub(r"[\s/\-_]", "", s)
    if not s_clean:
        return None
    if s in PRESETS: return dict(PRESETS[s])
    if s_clean in PRESETS: return dict(PRESETS[s_clean])
    m = re.match(r"^([A-Z]{3})/?([A-Z]{3})$", s.replace(" ", ""))
    if m and m.group(1) in CURRENCIES and m.group(2) in CURRENCIES:
        return forex_instrument(m.group(1), m.group(2))
    m_cnh = re.match(r"^(USD)/?(CNH)$", s.replace(" ", ""))
    if m_cnh:
        return dict(PRESETS["USDCNH"])
    if s_clean in CURRENCIES:  # single-currency scan, e.g. "GBP", "NGN", "USD"
        return currency_instrument(s_clean)
    m2 = re.match(r"^([A-Z]{3,6})(USD|USDT|EUR|GBP)$", s_clean)
    if m2 and len(s_clean) > 6:
        coin = m2.group(1)
        return {
            "symbol": s_clean, "display": f"{coin}/{m2.group(2)[:3]}", "name": f"{coin} / {m2.group(2)[:3]}",
            "type": "CRYPTO", "yahoo": f"{coin}-USD",
            "queries": [(f"{coin} crypto price", "CRYPTO"), (f"{coin} cryptocurrency news", "CRYPTO")],
        }
    if re.match(r"^[A-Z]{1,6}$", s_clean):
        return {
            "symbol": s_clean, "display": s_clean, "name": f"{s_clean} (ticker)",
            "type": "STOCK", "yahoo": s_clean,
            "queries": [(f'"{s_clean}" stock', "COMPANY"), (f"{s_clean} shares news", "COMPANY")],
        }
    pretty = (raw or "").strip()
    return {
        "symbol": s_clean[:24], "display": pretty, "name": pretty,
        "type": "CUSTOM", "yahoo": None,
        "queries": [(pretty, "GENERAL"), (f"{pretty} market news", "GENERAL")],
    }

# ---------------------------------------------------------------- source tiers & lexicons
TIER1 = ["reuters", "Bloomberg", "associated press", "ap news", "wall street journal", "financial times",
         "cnbc", "marketwatch", "dow jones", "barron", "bbc", "nikkei", "the economist", "afp"]
TIER2 = ["fxstreet", "forexlive", "investing.com", "dailyfx", "kitco", "benzinga", "seeking alpha",
         "yahoo finance", "tradingview", "business insider", "forbes", "fortune", "coindesk",
         "cointelegraph", "the guardian", "sky news", "telegraph", "independent", "thestreet",
         "marketbeat", "zacks", "motley fool", "oilprice", "fx empire", "fxempire", "action forex",
         "forex.com", "StoneX", "oanda", "city index", "cmc markets", "ig.com", "euronews"]

def source_tier(name):
    n = (name or "").lower()
    if any(t in n for t in TIER1): return 1
    if any(t in n for t in TIER2): return 2
    return 3

def tier_score(tier): return {1: 16, 2: 10, 3: 4}[tier]
def tier_weight(tier): return {1: 1.25, 2: 1.0, 3: 0.75}[tier]

MOVE_UP = ["rises", "rising", "rose", "gains", "gain", "gained", "jumps", "jumped", "soars", "soared",
           "rallies", "rally", "rallied", "climbs", "climbed", "advances", "higher", "strengthens",
           "strengthened", "stronger", "boosted", "surges", "surged", "surge", "rebound", "rebounds",
           "record high", "all-time high", "bullish", "beats estimates", "tops estimates", "beat expectations",
           "upgrade", "upgraded", "optimism", "raises forecast", "raises outlook", "tops forecast",
           "extends gains", "pushes higher", "breaks above", "outperforms"]
MOVE_DOWN = ["falls", "falling", "fell", "drops", "dropped", " drop ", "declines", "declined", "plunges",
             "plunged", "plunge", "slides", "slid", " slide ", "sinks", " sank ", "weakens", "weakened",
             "weaker", "selloff", "sell-off", "sell off", "losses", "lower", "slumps", "slumped", "slump",
             "bearish", "misses estimates", "missed estimates", "downgrade", "downgraded", "tumbles",
             "tumbled", "crashes", "crashed", " crash", "cuts outlook", "cuts forecast", "profit warning",
             "extends losses", "breaks below", "underperforms", "retreats", "eases back"]
HAWKISH = ["rate hike", "hikes rate", "hiked rate", "raises rate", "raised rate", "rate increase", "hawkish",
           "higher for longer", "tightening", "tighten policy", "hot inflation", "inflation above forecast",
           "inflation beats", "strong jobs", "jobs beat", "payrolls beat", "gdp beats", "growth beats",
           "retail sales beat", "rules out rate cut", "no rush to cut", "pushes back rate cut",
           "sticky inflation", "inflation accelerates", "wage growth rises"]
DOVISH = ["rate cut", "cuts rate", "cut rate", "rate decrease", "dovish", "easing cycle", "policy easing",
          "rate-cut bets", "rate cut bets", "inflation cools", "inflation falls", "inflation below forecast",
          "weak jobs", "jobs miss", "payrolls miss", "gdp miss", "growth slows", "retail sales miss",
          "recession risk", "recession fears", "signals rate cut", "opens door to rate cut",
          "inflation eases", "unemployment rises", "jobless claims rise"]
HIGH_KW = ["interest rate decision", "rate decision", "rate hike", "rate cut", "cpi", "inflation data",
           "nonfarm", "non-farm", "nfp", "fomc", "federal reserve", "fed decision", "ecb decision",
           "bank of england decision", "bank of japan decision", "gdp", "jobs report", "payrolls", "pce",
           "earnings report", "quarterly earnings", "reports earnings", "tariff", "tariffs", "central bank",
           "election result", "recession", "unemployment rate", "retail sales", "consumer price",
           "monetary policy", "powell", "lagarde speech", "emergency meeting", "intervenes", "intervention"]
MED_KW = ["pmi", "forecast", "outlook", "analyst", "price target", "guidance", "inflation", "yields",
          "treasury", "oil inventories", "manufacturing", "consumer sentiment", "trade balance",
          "speaks", "speech", "testimony", "minutes", "survey", "housing", "exports", "imports"]
DRIVERS = {
    "Interest rates": ["rate hike", "rate cut", "interest rate", "fomc", "federal reserve", "central bank", "ecb", "bank of england", "bank of japan", "monetary policy"],
    "Inflation": ["inflation", "cpi", "pce", "consumer price", "producer price", "price pressures"],
    "Jobs / labour": ["jobs", "payroll", "nonfarm", "non-farm", "unemployment", "jobless", "wage"],
    "Growth / GDP": ["gdp", "economic growth", "recession", "pmi", "manufacturing", "retail sales"],
    "Earnings": ["earnings", "revenue", "quarterly results", "profit", "guidance", "eps"],
    "Trade / tariffs": ["tariff", "trade war", "trade deal", "exports", "imports", "trade deficit"],
    "Energy": ["oil", "opec", "crude", "natural gas", "energy prices"],
    "Risk / geopolitics": ["war", "sanctions", "election", "geopolitical", "conflict", "strike", "ceasefire", "attack"],
    "AI / tech": ["artificial intelligence", " ai ", "chips", "semiconductor", "data center", "cloud"],
    "Crypto / regulation": ["etf inflows", "etf outflows", "sec", "regulation", "stablecoin", "exchange inflows"],
}

# 13F/institutional-filings churn ("$AAPL Stock Sold by X LLC", "X Buys 69,330 Shares..."):
# real filings but near-zero trading signal, and they flood big-cap stock scans.
LOW_SIGNAL_RE = [re.compile(x) for x in (
    r"\bstock\s+(sold|bought|acquired)\s+by\b",
    r"\bshares?\s+(sold|bought|acquired)\s+by\b",
    r"\b(buys?|bought|purchases?|purchased|sells?|sold)\s+[\d,]+\s+shares?\b",
    r"\b(increases?|raises?|lowers?|reduces?|boosts?|boosted|cuts?|trims?|grows?)\s+(its\s+)?(stake|position|holdings)\b",
    r"\bholdings\s+(raised|lowered|increased|decreased|boosted|reduced|trimmed)\s+by\b",
    r"\bstock\s+holdings\s+(reduced|raised|lowered|increased|decreased)\b",
    r"\bposition\s+(increased|decreased|raised|lowered)\s+by\b",
    r"\b(purchases?|buys?|acquires?)\s+new\s+(holdings|position|stake)\b",
    r"\bnew\s+holdings\s+in\b",
)]

def _count(t, words):
    return sum(1 for w in words if w in t)

def classify(title, source, ts, bucket):
    t = " " + title.lower() + " "
    up_terms = [w.strip() for w in MOVE_UP if w in t][:4]
    down_terms = [w.strip() for w in MOVE_DOWN if w in t][:4]
    hawk_terms = [w for w in HAWKISH if w in t][:4]
    dove_terms = [w for w in DOVISH if w in t][:4]
    high_terms = [w for w in HIGH_KW if w in t][:4]
    med_terms = [w for w in MED_KW if w in t][:4]
    move = _count(t, MOVE_UP) - _count(t, MOVE_DOWN)
    hawk = _count(t, HAWKISH) - _count(t, DOVISH)
    strength = hawk + (move if bucket in ("BASE", "QUOTE") else 0)
    if bucket == "BASE":
        pair_effect = strength
    elif bucket == "QUOTE":
        pair_effect = -strength
    else:
        pair_effect = move
    sentiment = "BULLISH" if move > 0 else ("BEARISH" if move < 0 else "NEUTRAL")
    direction = "UP" if pair_effect > 0 else ("DOWN" if pair_effect < 0 else "FLAT")

    tier = source_tier(source)
    age_h = max(0.0, (time.time() - ts) / 3600.0) if ts else 999.0
    reasons = []
    tpts = tier_score(tier)
    score = 18 + tpts
    reasons.append(f"Publisher grouped as Tier {tier} (+{tpts} impact points). "
                   + ("Tier 1 = major-wire class; this is a source-quality grouping, not proof a story is right."
                      if tier == 1 else "Lower tiers can still break real news — open the publisher to verify."))
    if high_terms:
        score += 36
        reasons.append("High-impact topic (+36): the headline mentions " + ", ".join(f"'{x}'" for x in high_terms)
                       + " — subjects that often move rates, currencies or earnings expectations.")
    elif med_terms:
        score += 18
        reasons.append("Medium-impact topic (+18): the headline mentions " + ", ".join(f"'{x}'" for x in med_terms) + ".")
    else:
        reasons.append("No major macro/earnings keyword was detected, so topic impact stays low.")
    if "breaking" in t or "just in" in t:
        score += 10
        reasons.append("Breaking/just-in wording (+10) — treat first reports cautiously; details often change.")
    if age_h < 1:
        score += 10
        reasons.append("Freshness (+10): published within the last hour, so the market may still be reacting.")
    elif age_h < 6:
        score += 5
        reasons.append("Freshness (+5): published within the last 6 hours.")
    elif ts:
        reasons.append("Older headline: no freshness points. Older does not mean irrelevant, but price may already have reacted.")
    if up_terms or down_terms:
        bits = []
        if up_terms: bits.append("up-wording: " + ", ".join(f"'{x}'" for x in up_terms))
        if down_terms: bits.append("down-wording: " + ", ".join(f"'{x}'" for x in down_terms))
        reasons.append("Directional wording detected — " + "; ".join(bits) + ".")
    else:
        reasons.append("No clear up/down wording detected, so the direction score is flat.")
    if hawk_terms or dove_terms:
        bits = []
        if hawk_terms: bits.append("hawkish/strong: " + ", ".join(f"'{x}'" for x in hawk_terms))
        if dove_terms: bits.append("dovish/weak: " + ", ".join(f"'{x}'" for x in dove_terms))
        reasons.append("Currency-strength wording — " + "; ".join(bits) + ".")
    if abs(move) >= 2 or abs(hawk) >= 1: score += 5
    low_signal = any(rx.search(t) for rx in LOW_SIGNAL_RE)
    if low_signal:
        score -= 16  # 13F/filings churn: real filings, near-zero trading signal
        reasons.append("Routine holdings/filings template detected (-16): usually an old institutional position report, rarely a live trading catalyst.")
    impact_score = max(1, min(100, int(score)))
    impact = "HIGH" if impact_score >= 62 else ("MEDIUM" if impact_score >= 38 else "LOW")
    driver = None
    for name, kws in DRIVERS.items():
        if any(k in t for k in kws):
            driver = name; break
    return {
        "sentiment": sentiment, "move": move, "currencyStrength": strength, "hawkish": hawk,
        "pairEffect": pair_effect, "direction": direction,
        "impact": impact, "impactScore": impact_score, "driver": driver, "tier": tier,
        "lowSignal": low_signal,
        "scoreReasons": reasons,
        "matchedTerms": (high_terms + hawk_terms + dove_terms + up_terms + down_terms)[:6],
    }

# ---------------------------------------------------------------- fetching primitives
def http_get(url, timeout=12):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

TAG_RE = re.compile(r"<[^>]+>")

def clean_text(x):
    x = ihtml.unescape(x or "")
    x = TAG_RE.sub(" ", x)
    return re.sub(r"\s+", " ", x).strip()

def parse_rss(raw, default_source, is_google):
    items = []
    root = ET.fromstring(raw)
    for it in root.iterfind(".//item"):
        title_el = (it.findtext("title", "") or "").strip()
        if not title_el:
            continue
        link = (it.findtext("link", "") or "").strip()
        pub = it.findtext("pubDate", "") or ""
        if not pub:
            for el in it.iter():
                if el.tag.endswith("}date") and el.text:
                    pub = el.text.strip(); break
        desc = clean_text(it.findtext("description", ""))
        source = default_source
        title = title_el
        if is_google:
            source_el = it.find("source")
            source = (source_el.text or "").strip() if source_el is not None and source_el.text else ""
            if " - " in title_el:
                parts = title_el.rsplit(" - ", 1)
                title = parts[0].strip()
                if not source: source = parts[1].strip()
            source = source or "Wire"
        ts = 0
        try:
            if pub:
                try:
                    ts = int(parsedate_to_datetime(pub).timestamp())
                except Exception:
                    ts = int(datetime.fromisoformat(pub.replace("Z", "+00:00")).timestamp())
        except Exception:
            ts = 0
        if desc.lower().startswith(title.lower()[:40]):
            desc = ""
        items.append({"title": title, "link": link, "source": source, "ts": ts, "snippet": desc[:260]})
    return items

def make_article(raw, bucket, query):
    cls = classify(raw["title"], raw["source"], raw["ts"], bucket)
    out = dict(raw)
    out.update({"bucket": bucket, "query": query})
    out.update(cls)
    return out

def fetch_google_news(query, bucket):
    q = urllib.parse.quote(query)
    url = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
    raw_items = parse_rss(http_get(url), "", True)
    set_status("Google News RSS", True)
    return [make_article(x, bucket, query) for x in raw_items]

WIRE_FEEDS = [
    ("CNBC", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    ("MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
]

def fetch_wire_feed(name, url):
    hit = cache_get("wire:" + url, 300)
    if hit is not None:
        return hit
    raw_items = parse_rss(http_get(url), name, False)
    items = [make_article(x, "MARKET", f"{name} wire") for x in raw_items]
    set_status(name + " wire", True)
    cache_set("wire:" + url, items)
    return items

# ---------------------------------------------------------------- Yahoo prices / charts
def yahoo_chart(yahoo_sym, interval, rng):
    q = urllib.parse.quote(yahoo_sym, safe="")
    last_err = None
    for attempt, host in enumerate(("query1.finance.yahoo.com", "query2.finance.yahoo.com")):
        try:
            data = json.loads(http_get(f"https://{host}/v8/finance/chart/{q}?interval={interval}&range={rng}").decode())
            res = data["chart"]["result"][0]
            set_status("Yahoo Finance", True)
            return res
        except Exception as e:
            last_err = e
            if attempt == 0: time.sleep(0.9)
    set_status("Yahoo Finance", False, last_err)
    raise last_err

def fetch_price(yahoo_sym):
    if not yahoo_sym: return None
    hit = cache_get("price:" + yahoo_sym, 60)
    if hit: return hit
    res = yahoo_chart(yahoo_sym, "1d", "1mo")
    meta = res["meta"]
    price = meta.get("regularMarketPrice")
    closes = []
    try:
        closes = [c for c in res["indicators"]["quote"][0]["close"] if c is not None]
    except Exception:
        pass
    # Daily change: prefer Yahoo's own regularMarketChangePercent (% units).
    # chartPreviousClose is the close before the 1mo window — do not use it for daily change.
    pct = meta.get("regularMarketChangePercent")
    if pct is not None and price is not None:
        prev = price / (1 + pct / 100.0) if pct != -100 else None
        change = (price - prev) if prev else None
    else:
        prev = closes[-2] if len(closes) >= 2 else meta.get("previousClose")
        change = (price - prev) if (price is not None and prev) else None
        pct = (change / prev * 100) if (change is not None and prev) else None
    out = {
        "price": price, "prevClose": prev, "change": change, "changePct": pct,
        "dayHigh": meta.get("regularMarketDayHigh"), "dayLow": meta.get("regularMarketDayLow"),
        "wk52High": meta.get("fiftyTwoWeekHigh"), "wk52Low": meta.get("fiftyTwoWeekLow"),
        "currency": meta.get("currency"), "exchange": meta.get("fullExchangeName") or meta.get("exchangeName"),
        "longName": meta.get("longName") or meta.get("shortName"),
        "spark": closes[-22:],
    }
    cache_set("price:" + yahoo_sym, out)
    return out

CHART_TF = {
    "1D": ("5m", "1d"), "5D": ("15m", "5d"), "1M": ("1d", "1mo"),
    "6M": ("1d", "6mo"), "1Y": ("1wk", "1y"), "5Y": ("1mo", "5y"),
}

def fetch_candles(inst, tf):
    tf = tf if tf in CHART_TF else "1M"
    yahoo = inst.get("yahoo")
    if not yahoo:
        return {"error": "No chart feed for this symbol", "candles": [], "tf": tf,
                "instrument": {k: inst.get(k) for k in ("symbol", "display", "name", "type")}}
    interval, rng = CHART_TF[tf]
    ttl = 30 if tf in ("1D", "5D") else 120
    hit = cache_get(f"candles:{yahoo}:{tf}", ttl)
    if hit: return hit
    res = yahoo_chart(yahoo, interval, rng)
    meta = res["meta"]
    candles = []
    try:
        ts_list = res.get("timestamp") or []
        quote = res["indicators"]["quote"][0]
        for i, t in enumerate(ts_list):
            c = quote["close"][i]
            if c is None: continue
            candles.append({
                "t": int(t), "o": quote["open"][i], "h": quote["high"][i],
                "l": quote["low"][i], "c": c, "v": (quote.get("volume") or [0]*len(ts_list))[i] or 0,
            })
    except Exception:
        pass
    out = {
        "instrument": {k: inst.get(k) for k in ("symbol", "display", "name", "type", "yahoo")},
        "tf": tf, "candles": candles,
        "meta": {"price": meta.get("regularMarketPrice"),
                 "changePct": meta.get("regularMarketChangePercent"),
                 "currency": meta.get("currency"), "exchange": meta.get("fullExchangeName")},
    }
    cache_set(f"candles:{yahoo}:{tf}", out)
    return out

# ---------------------------------------------------------------- relevance & scoring
STOP = set("""the a an and or of to in on for as at by with from after before amid over under into its it is are was were be been
price prices stock stocks share shares market markets news today latest update updates forecast forecasts analysis outlook
technical trading trade trades trader traders forex fx pair pairs currency currencies index indices rate rates could may might
will would can should than then this that these those week weekly daily day days year years month months ahead live blog report
says said say new highs lows high low gains losses""".split())

def tokens(text):
    return set(w for w in re.findall(r"[a-z0-9]{3,}", (text or "").lower()) if w not in STOP)

def instrument_terms(inst):
    terms = set()
    def add(x):
        if x: terms.add(str(x).lower().strip())
    add(inst.get("display")); add(inst.get("symbol")); add(inst.get("name"))
    sym = inst.get("symbol") or ""
    if len(sym) == 6 and inst.get("type") in ("FOREX", "CRYPTO", "COMMODITY"):
        add(f"{sym[:3]}/{sym[3:]}"); add(f"{sym[:3]} {sym[3:]}")
    for code_key in ("base", "quote"):
        code = inst.get(code_key)
        if code and code in CURRENCIES:
            add(code); add(CURRENCIES[code][0]); add(CURRENCIES[code][1])
            add(CURRENCIES[code][0].split()[-1])  # dollar / pound / yen / franc …
    add(inst.get("baseName")); add(inst.get("quoteName"))
    name = (inst.get("name") or "").lower()
    for piece in re.split(r"[/()\-—]", name):
        piece = piece.strip()
        if len(piece) >= 3: add(piece)
    return {t for t in terms if t and len(t) >= 2}

def term_in_title(term, title_l):
    if len(term) <= 3:
        return re.search(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", title_l) is not None
    return term in title_l

def score_article(a, inst, terms):
    title_l = a["title"].lower()
    rel = 8
    reasons = list(a.get("scoreReasons") or [])
    matched = []
    disp = (inst.get("display") or "").lower()
    sym = (inst.get("symbol") or "").lower()
    if disp and term_in_title(disp, title_l):
        rel += 42
        reasons.append(f"Relevance +42: the exact instrument '{inst.get('display')}' is named in the headline.")
    if sym and sym != disp and term_in_title(sym, title_l):
        rel += 34
        reasons.append(f"Relevance +34: the symbol '{inst.get('symbol')}' appears in the headline.")
    for term in terms:
        if term in (disp, sym): continue
        if term_in_title(term, title_l):
            matched.append(term)
            if len(matched) <= 3: rel += 11
    if matched:
        shown = sorted(set(matched), key=len, reverse=True)[:4]
        reasons.append("Relevance: headline matches this instrument's terms — " + ", ".join(f"'{x}'" for x in shown) + ".")
    bucket = a["bucket"]
    if bucket in ("PAIR", "COMPANY", "INDEX", "COMMODITY", "CRYPTO", "MACRO"):
        rel += 10
        reasons.append("Found by the direct instrument search (+10 relevance).")
    elif bucket in ("BASE", "QUOTE"):
        rel += 6
        side = inst.get("base") if bucket == "BASE" else inst.get("quote")
        reasons.append(f"Found by the {bucket.lower()}-currency search ({side} side, +6 relevance). "
                       "For a pair, quote-currency strength works in the opposite direction to base-currency strength.")
    rel = max(1, min(100, rel))
    age_h = max(0.0, (time.time() - a["ts"]) / 3600.0) if a["ts"] else 240.0
    recency = max(0.0, 100.0 - age_h * 2.2)
    if a.get("lowSignal"):
        rel -= 14
        reasons.append("Relevance reduced (-14): routine filings/holdings churn is demoted so real catalysts rank first.")
    a["relevance"] = int(max(1, rel))
    a["score"] = int(round(0.42 * a["relevance"] + 0.36 * a["impactScore"] + 0.22 * recency))
    reasons.append(f"Story Score {a['score']} blends relevance {a['relevance']} (42%), impact {a['impactScore']} (36%) "
                   f"and recency {recency:.0f} (22%). It is a sorting/attention score — not a buy or sell signal.")
    a["scoreReasons"] = reasons
    a["matchedTerms"] = sorted(set((a.get("matchedTerms") or []) + matched), key=len, reverse=True)[:6]
    return a

def matches_terms(a, terms):
    title_l = a["title"].lower()
    return any(term_in_title(t, title_l) for t in terms if len(t) >= 3)

def wire_bucket(a, inst, terms):
    title_l = a["title"].lower()
    typ = inst.get("type")
    if typ == "FOREX":
        base_terms = [inst.get("base", "").lower(), (inst.get("baseName") or "").lower()]
        quote_terms = [inst.get("quote", "").lower(), (inst.get("quoteName") or "").lower()]
        b = any(term_in_title(t, title_l) for t in base_terms if t)
        q = any(term_in_title(t, title_l) for t in quote_terms if t)
        if b and q: return "PAIR"
        if b: return "BASE"
        if q: return "QUOTE"
        return "MARKET"
    if typ == "STOCK": return "COMPANY"
    if typ in ("INDEX", "MACRO", "COMMODITY", "CRYPTO"): return typ
    return "MARKET"

# ---------------------------------------------------------------- clustering
def cluster_stories(news):
    ordered = sorted(news, key=lambda x: x["score"], reverse=True)
    clusters = []  # {rep, tokens, members}
    for a in ordered:
        toks = tokens(a["title"])
        best, best_sim = None, 0.0
        for c in clusters:
            # Same-story coverage lands close together. A 72h window stops daily roundup
            # templates ("exchange rate today...") from chaining weeks of editions into one story.
            if a["ts"] and c["rep"]["ts"] and abs(a["ts"] - c["rep"]["ts"]) > 72 * 3600:
                continue
            # Compare against the representative headline ONLY. Growing the token set with each
            # member snowballs unrelated template headlines into giant false clusters.
            inter = len(toks & c["tokens"])
            if inter < 3: continue
            jac = inter / max(1, len(toks | c["tokens"]))
            contain = inter / max(1, min(len(toks), len(c["tokens"])))
            sim = max(jac, contain * 0.85)
            if sim > best_sim:
                best_sim, best = sim, c
        if best is not None and best_sim >= 0.50:
            best["members"].append(a)
        else:
            clusters.append({"rep": a, "tokens": set(toks), "members": [a]})
    stories = []
    for i, c in enumerate(clusters):
        members = sorted(c["members"], key=lambda x: x["ts"], reverse=True)
        rep = c["rep"]
        sources = []
        for m in members:
            if m["source"] not in sources: sources.append(m["source"])
        eff = sum(m["pairEffect"] for m in members)
        stories.append({
            "id": f"s{i}",
            "article": rep,
            "coverage": [{"title": m["title"], "link": m["link"], "source": m["source"], "ts": m["ts"]}
                         for m in members if m is not rep][:9],
            "count": len(members),
            "sources": sources,
            "latestTs": max((m["ts"] for m in members), default=0),
            "firstTs": min((m["ts"] for m in members if m["ts"]), default=0),
            "score": min(100, rep["score"] + min(14, (len(members) - 1) * 4)),
            "impactScore": max(m["impactScore"] for m in members),
            "impact": "HIGH" if max(m["impactScore"] for m in members) >= 62 else
                      ("MEDIUM" if max(m["impactScore"] for m in members) >= 38 else "LOW"),
            "pairEffect": eff,
            "direction": "UP" if eff > 0 else ("DOWN" if eff < 0 else "FLAT"),
        })
    stories.sort(key=lambda s: s["latestTs"], reverse=True)
    return stories

# ---------------------------------------------------------------- bias / briefing
def _weighted_bias(items, field):
    num = den = 0.0
    now = time.time()
    for a in items:
        age_h = max(0.0, (now - a["ts"]) / 3600.0) if a["ts"] else 120.0
        w = (0.3 + a["impactScore"] / 100.0) * math.exp(-age_h / 22.0) * tier_weight(a["tier"])
        v = max(-2.5, min(2.5, float(a.get(field, 0) or 0)))
        num += v * w; den += w
    if den == 0: return 0.0
    return max(-100.0, min(100.0, (num / den) * 62.0))

def bias_label(v):
    if v >= 38: return "STRONG BULLISH BIAS"
    if v >= 14: return "BULLISH LEAN"
    if v <= -38: return "STRONG BEARISH BIAS"
    if v <= -14: return "BEARISH LEAN"
    return "MIXED / NO CLEAR BIAS"

def build_briefing(inst, news, stories, stats, price):
    is_fx = inst.get("type") == "FOREX"
    base_items = [a for a in news if a["bucket"] == "BASE"]
    quote_items = [a for a in news if a["bucket"] == "QUOTE"]
    pair_items = [a for a in news if a["bucket"] == "PAIR"]
    base_str = _weighted_bias(base_items, "currencyStrength") if base_items else 0.0
    quote_str = _weighted_bias(quote_items, "currencyStrength") if quote_items else 0.0
    pair_flow = _weighted_bias(pair_items, "move") if pair_items else 0.0
    net = _weighted_bias(news, "pairEffect")
    if is_fx:
        comps = []
        if pair_items: comps.append((pair_flow, 0.45))
        if base_items: comps.append((base_str, 0.30))
        if quote_items: comps.append((-quote_str, 0.25))
        if comps:
            wsum = sum(w for _, w in comps)
            net = 0.55 * net + 0.45 * (sum(v * w for v, w in comps) / wsum)
    net = int(round(max(-100, min(100, net))))
    pos = sum(1 for a in news if a["pairEffect"] > 0)
    neg = sum(1 for a in news if a["pairEffect"] < 0)
    agree = (abs(pos - neg) / max(1, pos + neg)) if (pos + neg) else 0
    confidence = int(round(min(96, 18 + min(30, stats["last24h"] * 1.1) + min(20, stats["highImpact"] * 3) + agree * 26)))

    drivers_ranked = sorted(stats["drivers"].items(), key=lambda kv: -kv[1])
    bullets = []
    bullets.append(f"{stats['last24h']} stories in the last 24h ({stats['total']} in scan) across "
                   f"{len(stats['sources'])} publishers — {stats['highImpact']} high-impact, {stats['last1h']} in the last hour.")
    if drivers_ranked:
        bullets.append(f"Dominant driver: {drivers_ranked[0][0]} ({drivers_ranked[0][1]} stories)"
                       + (f", followed by {drivers_ranked[1][0]}." if len(drivers_ranked) > 1 else "."))
    if is_fx and (base_items or quote_items):
        b, q = len(base_items), len(quote_items)
        side = inst["base"] if b >= q else inst["quote"]
        bullets.append(f"News pressure is heavier on the {side} side ({max(b,q)} vs {min(b,q)} stories). "
                       f"{inst['base']} strength {base_str:+.0f}, {inst['quote']} strength {quote_str:+.0f}, "
                       f"pair headline flow {pair_flow:+.0f} → net pair bias {net:+d}.")
    if price and price.get("changePct") is not None:
        pct = price["changePct"]
        bullets.append(f"Price is {'up' if pct >= 0 else 'down'} {abs(pct):.2f}% on the day at "
                       f"{price['price']} — headline bias is {'aligned with' if (pct >= 0) == (net >= 0) and abs(net) >= 14 else 'not clearly driving'} the move.")
    top = sorted(stories, key=lambda s: -s["score"])[:3]
    risks = [s["article"]["title"] for s in top if s["impactScore"] >= 50]
    watch = []
    if drivers_ranked:
        watch.append(drivers_ranked[0][0] + " headlines")
    if is_fx:
        watch.append(f"{inst['base']} & {inst['quote']} calendar events (panel right)")
    return {
        "biasScore": net, "biasLabel": bias_label(net), "confidence": confidence,
        "baseStrength": int(round(base_str)), "quoteStrength": int(round(quote_str)),
        "pairFlow": int(round(pair_flow)),
        "bullets": bullets, "risks": risks, "watch": watch,
    }


INDEX_CURRENCIES = {
    "UK100": "GBP", "GER40": "EUR", "FRA40": "EUR", "EUSTX50": "EUR", "JPN225": "JPY",
    "AUS200": "AUD", "HK50": "HKD", "IN50": "INR", "CHN50": "CNY",
}

def instrument_currencies(inst):
    typ = inst.get("type")
    if typ == "FOREX":
        return [c for c in (inst.get("base"), inst.get("quote")) if c]
    if typ == "CURRENCY":
        return [c for c in (inst.get("base"), "USD") if c]
    ccy = INDEX_CURRENCIES.get(inst.get("symbol"))
    return [c for c in (ccy, "USD") if c] or ["USD"]

def _event_points(minutes_until, level):
    """Points for one scheduled event. minutes_until < 0 means it was just released."""
    if minutes_until < -60 or minutes_until > 1440:
        return 0
    if level <= 0:  # e.g. bank holiday: thinner liquidity, not a data shock
        return 4 if -720 <= minutes_until <= 720 else 0
    if minutes_until < 0:
        base = 42 if minutes_until >= -30 else 26
    elif minutes_until <= 15:
        base = 46
    elif minutes_until <= 30:
        base = 39
    elif minutes_until <= 120:
        base = 29
    elif minutes_until <= 360:
        base = 17
    else:
        base = 7
    return int(round(base * {3: 1.0, 2: 0.55, 1: 0.25}.get(level, 0.25)))

def _minutes_phrase(minutes):
    m = int(round(abs(minutes)))
    if m < 60:
        txt = f"{m} minute" + ("" if m == 1 else "s")
    elif m < 1440:
        txt = f"{m // 60}h {m % 60:02d}m"
    else:
        txt = f"{m // 1440}d {(m % 1440) // 60}h"
    return f"in {txt}" if minutes >= 0 else f"{txt} ago"

def build_risk(inst, news, stats, briefing, price, heat, events):
    """
    News Conditions Risk Index (0-100).
    IMPORTANT: this estimates how disorderly / headline-driven conditions may be around
    news. It is NOT a win/loss probability and NOT a direction or trade recommendation.
    """
    now_ts = int(time.time())
    score = 8
    factors = [{"label": "Normal market baseline", "points": 8,
                "detail": "Prices can jump on unscheduled headlines even when no release is due. Low never means safe."}]

    currencies = instrument_currencies(inst)
    relevant = [e for e in (events or []) if e.get("ts")]
    scored = []
    next_event = None
    for e in sorted(relevant, key=lambda x: x["ts"]):
        mins = (e["ts"] - now_ts) / 60.0
        if mins >= 0 and next_event is None:
            next_event = e
        pts = _event_points(mins, int(e.get("impactLevel") or 0))
        if pts:
            scored.append((pts, mins, e))
    risk_event = None
    if scored:
        pts, mins, e = max(scored, key=lambda x: x[0])
        score += pts
        risk_event = e
        vals = []
        if e.get("forecast"): vals.append(f"forecast {e['forecast']}")
        if e.get("previous"): vals.append(f"previous {e['previous']}")
        if e.get("actual"): vals.append(f"actual {e['actual']}")
        factors.append({
            "label": f"Scheduled {e.get('impact') or 'calendar'} event: {e.get('country')} {e.get('title')}",
            "points": pts,
            "detail": f"{_minutes_phrase(mins)}" + (f" ({', '.join(vals)})" if vals else "")
                      + ". The surprise versus forecast, revisions and the report details usually matter more than the headline number alone.",
        })
    elif next_event:
        factors.append({"label": "No major relevant release imminent", "points": 0,
                        "detail": f"Next listed {'/'.join(currencies)} event: {next_event.get('country')} "
                                  f"{next_event.get('title')} {_minutes_phrase((next_event['ts']-now_ts)/60.0)}."})
    else:
        factors.append({"label": "No relevant calendar event found", "points": 0,
                        "detail": "This week's macro calendar has no listed event for this instrument's currencies. "
                                  "Unscheduled headlines can still break at any time."})

    def _fresh(window_s, high_only=False):
        return [a for a in news if a.get("ts") and (now_ts - a["ts"]) <= window_s
                and (a.get("impact") == "HIGH" if high_only else True)]

    high15, high60 = _fresh(900, True), _fresh(3600, True)
    if high15:
        pts = min(26, 16 + 5 * (len(high15) - 1))
        score += pts
        factors.append({"label": "High-impact headlines in the last 15 minutes", "points": pts,
                        "detail": f"{len(high15)} high-impact headline(s) just landed. First reports can whipsaw price before details are known."})
    elif high60:
        pts = min(18, 9 + 3 * (len(high60) - 1))
        score += pts
        factors.append({"label": "High-impact headlines in the last hour", "points": pts,
                        "detail": f"{len(high60)} in the last hour — the market may still be digesting them."})

    all15 = _fresh(900)
    if len(all15) >= 4:
        score += 8
        factors.append({"label": "Burst of headlines", "points": 8,
                        "detail": f"{len(all15)} headlines in 15 minutes. Bursts make it easy to react to noise or duplicated coverage."})

    heat_pts = 15 if heat >= 75 else (10 if heat >= 55 else (5 if heat >= 35 else 0))
    if heat_pts:
        score += heat_pts
        factors.append({"label": f"News heat {heat}/100", "points": heat_pts,
                        "detail": "A lot of attention on this instrument right now (volume + recency + impact + price move)."})

    pct = abs(price["changePct"]) if price and price.get("changePct") is not None else 0
    lo, hi = {"FOREX": (0.4, 0.8), "CURRENCY": (0.4, 0.8), "CRYPTO": (2.0, 4.0),
              "COMMODITY": (1.5, 3.0)}.get(inst.get("type"), (1.5, 3.0))
    move_pts = 12 if pct >= hi else (7 if pct >= lo else 0)
    if move_pts:
        score += move_pts
        factors.append({"label": f"Large daily price move ({pct:.2f}%)", "points": move_pts,
                        "detail": "An already-stretched daily move can snap back or extend violently when a new headline arrives."})

    pos, neg = stats.get("bullish", 0), stats.get("bearish", 0)
    if pos >= 4 and neg >= 4 and abs(pos - neg) <= 0.35 * max(pos, neg):
        score += 10
        factors.append({"label": "Headlines are pulling both ways", "points": 10,
                        "detail": f"{pos} pair-up vs {neg} pair-down scored headlines. Split flow often means choppy, two-way price action."})

    score = int(max(0, min(100, score)))
    if score >= 65:
        level, headline = "EXTREME", "Extreme news-risk window"
        meaning = ("Conditions around news can be disorderly right now: fast spikes, wide spreads and slippage are much "
                   "more likely than in quiet trade. This gauge says nothing about which direction price will go.")
    elif score >= 45:
        level, headline = "HIGH", "High news-risk window"
        meaning = ("A market-moving release or a burst of high-impact headlines is close enough that execution quality "
                   "(spread, slippage, stop fills) can deteriorate sharply around it.")
    elif score >= 25:
        level, headline = "MODERATE", "Some event risk"
        meaning = ("There is relevant news around, but no single imminent shock dominates. Check the calendar below "
                   "so a release does not surprise a position.")
    else:
        level, headline = "LOW", "Calmer news backdrop"
        meaning = ("No imminent high-impact scheduled shock was found for this instrument. Calm news is not the same as "
                   "low financial risk — unscheduled headlines and illiquid hours can still move price fast.")

    caveat = ("This calendar covers macro releases; check this company's earnings/announcement dates separately."
              if inst.get("type") == "STOCK" else
              "Crypto also reacts to exchange, ETF and regulatory headlines that are never on a calendar."
              if inst.get("type") == "CRYPTO" else
              "Central-bank speeches and unscheduled headlines can be added or change at short notice.")

    return {
        "score": score, "level": level, "headline": headline, "meaning": meaning,
        "factors": factors, "currenciesChecked": currencies,
        "nextEvent": next_event, "riskEvent": risk_event,
        "recentHighImpact1h": len(high60), "calculatedAt": datetime.now(timezone.utc).isoformat(),
        "isDirectionForecast": False,
        "warning": "This is a conditions/volatility gauge, not a probability of winning or losing and not a recommendation to trade or not trade.",
        "whatCanHappen": [
            "Spreads can widen sharply in the seconds around a major release.",
            "Orders and stop-losses can slip (fill worse than intended) or gap through a level.",
            "Price can spike one way, then reverse just as fast as traders read the details.",
            "Brokers may raise margin, throttle execution or requote around top-tier data.",
            "The actual-vs-forecast surprise, revisions and sub-components matter more than the first headline.",
        ],
        "checklist": [
            "Confirm the release time in your own timezone (calendar panel shows local countdowns).",
            "Know the forecast and previous values before the release — reaction is about the surprise.",
            "Assume worse spread/slippage than normal; check your broker's news-trading and stop rules.",
            "Decide your maximum loss before the number, not during the spike.",
            "Do not treat any score on this page as a buy/sell instruction.",
        ],
        "caveat": caveat,
    }

def related_instruments(inst):
    out, seen = [], set()
    def add(sym):
        r = resolve(sym)
        if r and r["symbol"] != inst.get("symbol") and r["symbol"] not in seen:
            seen.add(r["symbol"])
            out.append({"symbol": r["symbol"], "display": r["display"], "name": r["name"], "type": r["type"]})
    typ = inst.get("type")
    if typ == "FOREX":
        for p in FOREX_WATCH:
            if inst.get("base") in (p[:3], p[3:]) or inst.get("quote") in (p[:3], p[3:]):
                add(p)
            if len(out) >= 5: break
        for extra in ("DXY", "US10Y", "XAUUSD", "VIX"): add(extra)
    elif typ == "STOCK":
        g = TICKER_PEERGROUP.get(inst.get("symbol"))
        if g:
            for m in PEERS[g]: add(m)
        for extra in ("SPX500", "NAS100", "VIX", "US10Y"): add(extra)
    elif typ == "CRYPTO":
        for extra in ("BTCUSD", "ETHUSD", "SOLUSD", "NAS100", "DXY", "XAUUSD"): add(extra)
    elif typ == "COMMODITY":
        for extra in ("XAUUSD", "XAGUSD", "WTI", "BRENT", "COPPER", "DXY", "US10Y"): add(extra)
    else:
        for extra in ("SPX500", "NAS100", "US30", "VIX", "US10Y", "DXY", "XAUUSD", "BTCUSD"): add(extra)
    return out[:8]

# ---------------------------------------------------------------- main scan
def dedupe(items):
    prio = {"PAIR": 0, "COMPANY": 0, "INDEX": 0, "COMMODITY": 0, "CRYPTO": 0, "MACRO": 0,
            "BASE": 1, "QUOTE": 2, "GENERAL": 1, "MARKET": 3}
    seen = {}
    for it in sorted(items, key=lambda x: (prio.get(x["bucket"], 4), -x["impactScore"])):
        key = re.sub(r"[^a-z0-9]", "", it["title"].lower())[:80]
        if key and key not in seen:
            seen[key] = it
    return list(seen.values())

def scan(raw_symbol, lite=False):
    inst = resolve(raw_symbol)
    if not inst: return {"error": "Empty symbol"}
    key = ("scanlite:" if lite else "scan:") + inst["symbol"]
    cached = cache_get(key, 60)
    if cached:
        out = dict(cached); out["cacheHit"] = True
        return out

    if lite and inst.get("type") == "FOREX" and len(inst["queries"]) >= 4:
        # Radar needs the live base/quote wires, not the (often stale) pair-forecast search.
        queries = [inst["queries"][0], inst["queries"][2], inst["queries"][3]]
    elif lite:
        queries = inst["queries"][:2]
    else:
        queries = inst["queries"]
    terms = instrument_terms(inst)
    all_items, errors = [], []
    price, price_err = None, None
    with ThreadPoolExecutor(max_workers=7) as ex:
        futs = {ex.submit(fetch_google_news, q, b): ("google", q) for q, b in queries}
        if not lite:
            for wname, wurl in WIRE_FEEDS:
                futs[ex.submit(fetch_wire_feed, wname, wurl)] = ("wire", wname)
        price_fut = ex.submit(fetch_price, inst.get("yahoo")) if inst.get("yahoo") else None
        for f in as_completed(list(futs.keys())):
            kind, label = futs[f]
            try:
                got = f.result()
                if kind == "wire":
                    for a in got:
                        if matches_terms(a, terms) or (inst.get("type") in ("INDEX", "MACRO") and a["driver"]):
                            nb = wire_bucket(a, inst, terms)
                            if nb != a["bucket"]:
                                upd = classify(a["title"], a["source"], a["ts"], nb)
                                a = dict(a); a.update(upd); a["bucket"] = nb
                            all_items.append(a)
                else:
                    all_items.extend(got)
            except Exception as e:
                errors.append(f"{label}: {e}")
                set_status("Google News RSS" if kind == "google" else label + " wire", False, e)
        if price_fut:
            try: price = price_fut.result()
            except Exception as e: price_err = str(e)

    merged = dedupe(all_items)
    for i, a in enumerate(merged):
        score_article(a, inst, terms)
        a["id"] = f"a{i}-{abs(hash(a['title'])) % 1000000}"
    news = sorted(merged, key=lambda x: x["ts"], reverse=True)[:80]
    stories = cluster_stories(news)

    now_ts = int(time.time())
    stats = {
        "total": len(news), "storyCount": len(stories),
        "last24h": sum(1 for n in news if now_ts - n["ts"] < 86400),
        "last6h": sum(1 for n in news if now_ts - n["ts"] < 21600),
        "last1h": sum(1 for n in news if now_ts - n["ts"] < 3600),
        "bullish": sum(1 for n in news if n["pairEffect"] > 0),
        "bearish": sum(1 for n in news if n["pairEffect"] < 0),
        "neutral": sum(1 for n in news if n["pairEffect"] == 0),
        "headlineBullish": sum(1 for n in news if n["sentiment"] == "BULLISH"),
        "headlineBearish": sum(1 for n in news if n["sentiment"] == "BEARISH"),
        "highImpact": sum(1 for n in news if n["impact"] == "HIGH"),
        "buckets": {}, "sources": {}, "drivers": {}, "tiers": {"1": 0, "2": 0, "3": 0},
    }
    for n in news:
        stats["buckets"][n["bucket"]] = stats["buckets"].get(n["bucket"], 0) + 1
        stats["sources"][n["source"]] = stats["sources"].get(n["source"], 0) + 1
        stats["tiers"][str(n["tier"])] += 1
        if n["driver"]:
            stats["drivers"][n["driver"]] = stats["drivers"].get(n["driver"], 0) + 1

    timeline = []
    for h in range(23, -1, -1):
        start = now_ts - (h + 1) * 3600; end = now_ts - h * 3600
        inb = [n for n in news if start <= n["ts"] < end]
        timeline.append({"ts": end, "count": len(inb), "high": sum(1 for n in inb if n["impact"] == "HIGH")})

    briefing = build_briefing(inst, news, stories, stats, price)
    abs_pct = abs(price["changePct"]) if price and price.get("changePct") is not None else 0
    # Each component is capped so no single factor (e.g. crypto's huge 24h volume) can saturate heat alone.
    heat = int(round(min(100, min(26, stats["last1h"] * 6) + min(28, stats["last24h"] * 0.7)
                         + min(24, stats["highImpact"] * 5) + min(14, abs_pct * 4)
                         + min(8, len(stats["sources"]) * 0.4))))

    try:
        risk_events = calendar_events(instrument_currencies(inst))
    except Exception:
        risk_events = []
    risk = build_risk(inst, news, stats, briefing, price, heat, risk_events)

    result = {
        "instrument": {k: inst.get(k) for k in ("symbol", "display", "name", "type", "yahoo", "base", "quote", "baseName", "quoteName")},
        "queries": [q for q, _ in queries],
        "price": price, "priceError": price_err,
        "news": news, "stories": stories, "stats": stats, "timeline": timeline,
        "briefing": briefing, "risk": risk, "related": related_instruments(inst),
        "dataMode": "LIVE",
        "heat": heat, "errors": errors,
        "scannedAt": datetime.now(timezone.utc).isoformat(), "cacheHit": False,
    }
    cache_set(key, result)
    return result

# ---------------------------------------------------------------- tape / strength / radar / calendar
TAPE = [
    ("EUR/USD", "EURUSD=X"), ("GBP/USD", "GBPUSD=X"), ("USD/JPY", "JPY=X"),
    ("DXY", "DX-Y.NYB"), ("GOLD", "GC=F"), ("WTI OIL", "CL=F"),
    ("S&P 500", "^GSPC"), ("NASDAQ", "^IXIC"), ("DOW", "^DJI"),
    ("FTSE 100", "^FTSE"), ("DAX", "^GDAXI"), ("NIKKEI", "^N225"),
    ("US10Y", "^TNX"), ("VIX", "^VIX"), ("BTC/USD", "BTC-USD"), ("ETH/USD", "ETH-USD"),
]

def tape():
    cached = cache_get("tape", 60)
    if cached: return cached
    got = {}
    with ThreadPoolExecutor(max_workers=3) as ex:  # gentle: Yahoo throttles big bursts
        futs = {ex.submit(fetch_price, y): label for label, y in TAPE}
        for f in as_completed(futs):
            try:
                p = f.result()
                if p and p.get("price") is not None:
                    got[futs[f]] = {"label": futs[f], "price": p["price"], "changePct": p.get("changePct")}
            except Exception:
                pass
    out = [got[l] for l, _ in TAPE if l in got]
    cache_set("tape", out)
    return out

STRENGTH_MAP = [
    ("EUR", "EURUSD=X", 1), ("GBP", "GBPUSD=X", 1), ("AUD", "AUDUSD=X", 1), ("NZD", "NZDUSD=X", 1),
    ("JPY", "JPY=X", -1), ("CHF", "CHF=X", -1), ("CAD", "CAD=X", -1), ("USD", "DX-Y.NYB", 1),
]

def currency_strength():
    cached = cache_get("strength", 120)
    if cached: return cached
    rows = []
    with ThreadPoolExecutor(max_workers=3) as ex:
        futs = {ex.submit(fetch_price, y): (code, sign) for code, y, sign in STRENGTH_MAP}
        vals = {}
        for f in as_completed(futs):
            code, sign = futs[f]
            try:
                p = f.result()
                if p and p.get("changePct") is not None:
                    vals[code] = sign * p["changePct"]
            except Exception:
                pass
    for code, _, _ in STRENGTH_MAP:
        if code in vals:
            rows.append({"code": code, "name": CURRENCIES[code][0], "pct": round(vals[code], 3)})
    rows.sort(key=lambda r: -r["pct"])
    cache_set("strength", rows)
    return rows

def radar(symbols):
    symbols = [s for s in symbols if s][:12]
    rows = []
    with ThreadPoolExecutor(max_workers=3) as ex:
        # Full scans (not lite) so radar heat/bias match what the user sees when they open the instrument.
        futs = {ex.submit(scan, s, False): s for s in symbols}
        for f in as_completed(futs):
            try:
                d = f.result()
                if "instrument" not in d: continue
                top = None
                if d["stories"]:
                    best = sorted(d["stories"], key=lambda x: -x["score"])[0]
                    top = {"title": best["article"]["title"], "link": best["article"]["link"],
                           "source": best["article"]["source"], "ts": best["article"]["ts"]}
                p = d.get("price") or {}
                rows.append({
                    "instrument": d["instrument"], "heat": d["heat"],
                    "price": p.get("price"), "changePct": p.get("changePct"),
                    "last24h": d["stats"]["last24h"], "last1h": d["stats"]["last1h"],
                    "highImpact": d["stats"]["highImpact"],
                    "biasScore": d["briefing"]["biasScore"], "biasLabel": d["briefing"]["biasLabel"],
                    "riskScore": (d.get("risk") or {}).get("score"), "riskLevel": (d.get("risk") or {}).get("level"),
                    "top": top,
                })
            except Exception:
                pass
    rows.sort(key=lambda r: -r["heat"])
    return rows

CAL_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"

def calendar_events(currencies=None):
    hit = cache_get("calendar", 900)
    if hit is None:
        data = json.loads(http_get(CAL_URL).decode("utf-8", "ignore"))
        events = []
        for e in data:
            try:
                dt = datetime.fromisoformat((e.get("date") or "").replace("Z", "+00:00"))
                ts = int(dt.timestamp())
            except Exception:
                ts = 0
            impact = (e.get("impact") or "").strip()
            events.append({
                "title": e.get("title") or "", "country": (e.get("country") or "").upper(),
                "ts": ts, "date": e.get("date") or "",
                "impact": impact, "impactLevel": {"High": 3, "Medium": 2, "Low": 1}.get(impact, 0),
                "forecast": e.get("forecast") or "", "previous": e.get("previous") or "",
                "actual": e.get("actual") or "",
            })
        events.sort(key=lambda x: x["ts"])
        set_status("ForexFactory calendar", True)
        cache_set("calendar", events)
        hit = events
    if currencies:
        keep = {c.upper() for c in currencies}
        return [e for e in hit if e["country"] in keep]
    return hit

def symbols_payload():
    groups = {"FOREX": [], "INDEX": [], "STOCK": [], "CRYPTO": [], "COMMODITY": [], "MACRO": []}
    seen_ids = set()
    for key, inst in PRESETS.items():
        if id(inst) in seen_ids or key != inst["symbol"]:
            continue
        seen_ids.add(id(inst))
        if inst["type"] in groups:
            groups[inst["type"]].append({"symbol": inst["symbol"], "display": inst["display"],
                                          "name": inst["name"], "type": inst["type"]})
    for v in groups.values():
        v.sort(key=lambda x: x["display"])
    currencies = [{"code": c, "name": CURRENCIES[c][0], "bank": CURRENCIES[c][1]} for c in sorted(CURRENCIES)]
    return {"groups": groups, "currencies": currencies}

# ---------------------------------------------------------------- API dispatch
# One dispatcher used by every Vercel Function and by the local dev server,
# so production and local behaviour cannot drift apart.

def health_payload():
    with _status_lock:
        feeds = dict(_status)
    return {
        "ok": True,
        "time": datetime.now(timezone.utc).isoformat(),
        "environment": "Vercel" if os.environ.get("VERCEL") else "local",
        "feeds": feeds,
        "note": "Feed status and caches are per-process; on Vercel each serverless instance has its own memory. "
                "A successful /api/scan response is the authoritative live check.",
    }

def _first(qs, key, default=""):
    vals = (qs or {}).get(key) or [default]
    return vals[0] if vals else default

def _header(headers, name):
    if not headers:
        return ""
    try:
        val = headers.get(name)
        if val:
            return str(val)
    except Exception:
        pass
    try:
        items = headers.items() if hasattr(headers, "items") else []
        for k, v in items:
            if str(k).lower() == name.lower():
                return str(v)
    except Exception:
        pass
    return ""

def _cron_authorized(headers):
    secret = os.environ.get("CRON_SECRET", "")
    if secret:
        auth = _header(headers, "Authorization")
        alt = _header(headers, "x-cron-secret")
        return hmac.compare_digest(auth, f"Bearer {secret}") or hmac.compare_digest(alt, secret)
    # No secret configured: only accept requests that look like Vercel Cron.
    ua = _header(headers, "User-Agent").lower()
    return "vercel-cron" in ua or bool(_header(headers, "x-vercel-cron-schedule"))

def _env_int(name, default, minimum, maximum):
    try:
        return max(minimum, min(maximum, int(os.environ.get(name, default))))
    except Exception:
        return default

def _post_json(url, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=12) as r:
        return r.status

def _notify(text, alerts):
    """Optional outbound alerts. Nothing is sent unless the user configures env vars."""
    results = []
    webhook = os.environ.get("ALERT_WEBHOOK_URL", "")
    if webhook:
        # "text" suits Slack, "content" suits Discord; extra keys are ignored by each.
        try:
            code = _post_json(webhook, {"text": text[:3800], "content": text[:1900], "pairwire": {"alerts": alerts}})
            results.append({"channel": "webhook", "ok": 200 <= code < 300, "status": code})
        except Exception as e:
            results.append({"channel": "webhook", "ok": False, "error": type(e).__name__})
    tg_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    tg_chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if tg_token and tg_chat:
        try:
            code = _post_json(f"https://api.telegram.org/bot{tg_token}/sendMessage",
                              {"chat_id": tg_chat, "text": text[:3900], "disable_web_page_preview": True})
            results.append({"channel": "telegram", "ok": 200 <= code < 300, "status": code})
        except Exception as e:
            results.append({"channel": "telegram", "ok": False, "error": type(e).__name__})
    return results

def cron_payload():
    """
    Scheduled background monitor (Vercel Cron or any external scheduler hitting /api/cron).
    Scans a small watch set, finds fresh high-impact headlines and optionally notifies
    a webhook / Telegram. The public website does NOT depend on this — serverless pages
    and APIs are available on demand whether cron runs or not.
    """
    symbols = [x.strip() for x in os.environ.get(
        "CRON_SYMBOLS", "EURUSD,GBPUSD,USDJPY,XAUUSD,SPX500,BTCUSD").split(",") if x.strip()][:8]
    window_min = _env_int("CRON_WINDOW_MINUTES", 120, 10, 1440)
    min_impact = _env_int("CRON_MIN_IMPACT", 70, 1, 100)
    rows = radar(symbols)
    now_ts = int(time.time())
    alerts = []
    for row in rows:
        try:
            d = scan(row["instrument"]["display"])  # cache hit from radar()'s full scans
        except Exception:
            continue
        for a in d.get("news", []):
            if a.get("ts") and (now_ts - a["ts"]) <= window_min * 60 and a.get("impactScore", 0) >= min_impact:
                alerts.append({
                    "symbol": row["instrument"]["display"], "title": a["title"], "link": a["link"],
                    "source": a["source"], "impactScore": a["impactScore"], "score": a.get("score"),
                    "ts": a["ts"], "direction": a.get("direction"),
                    "key": re.sub(r"[^a-z0-9]", "", a["title"].lower())[:80],
                })
    alerts.sort(key=lambda x: (-(x.get("score") or 0), -x["ts"]))
    # Best-effort de-duplication. This survives while Vercel reuses the same instance;
    # a brand-new cold instance can re-send. Use a real store (KV/DB) for guaranteed de-dupe.
    seen = set(cache_get("cron:seen-alerts", 6 * 3600) or [])
    fresh = [a for a in alerts if a["key"] not in seen][:10]
    for a in fresh:
        seen.add(a["key"])
    cache_set("cron:seen-alerts", list(seen)[-300:])

    hottest = rows[0] if rows else None
    lines = [f"PAIRWIRE monitor — {datetime.now(timezone.utc).strftime('%a %d %b %H:%M UTC')}"]
    if hottest:
        lines.append(f"Hottest now: {hottest['instrument']['display']} (heat {hottest['heat']}, "
                     f"bias {hottest['biasScore']:+d}, {hottest['highImpact']} high-impact)")
    for a in fresh:
        lines.append(f"[{a['symbol']}] {a['title']} — {a['source']} (impact {a['impactScore']}) {a['link']}")
    always = os.environ.get("CRON_ALWAYS_NOTIFY", "").lower() in ("1", "true", "yes")
    notifications = _notify("\n".join(lines), fresh) if (fresh or always) else []
    return {
        "ok": True, "runAt": datetime.now(timezone.utc).isoformat(), "symbols": symbols,
        "windowMinutes": window_min, "minImpact": min_impact,
        "radar": rows, "alerts": [{k: v for k, v in a.items() if k != "key"} for a in fresh],
        "notifications": notifications,
        "note": "Website availability does not depend on cron. Alert de-duplication is best-effort per serverless instance.",
    }

def handle_api(path, qs, headers=None):
    """Returns (http_status, json_payload)."""
    path = (path or "").rstrip("/") or "/"
    if path == "/api/scan":
        return 200, scan(_first(qs, "symbol", "EURUSD")[:40])
    if path == "/api/chart":
        inst = resolve(_first(qs, "symbol", "EURUSD")[:40])
        tf = _first(qs, "tf", "1M").upper()
        return 200, (fetch_candles(inst, tf) if inst else {"error": "Bad symbol"})
    if path == "/api/tape":
        return 200, {"tape": tape()}
    if path == "/api/strength":
        return 200, {"strength": currency_strength()}
    if path == "/api/radar":
        raw = _first(qs, "symbols", "EURUSD,GBPUSD,USDJPY,GBPJPY,XAUUSD,WTI,SPX500,NAS100,BTCUSD,NVDA")
        return 200, {"radar": radar([x.strip() for x in raw.split(",")])}
    if path == "/api/calendar":
        cur = _first(qs, "currencies", "")
        curs = [x.strip() for x in cur.split(",") if x.strip()] or None
        return 200, {"events": calendar_events(curs), "now": int(time.time())}
    if path == "/api/symbols":
        return 200, symbols_payload()
    if path in ("/api/health", "/health"):
        return 200, health_payload()
    if path == "/api/cron":
        if not _cron_authorized(headers or {}):
            return 401, {"error": "Unauthorized cron request. Set CRON_SECRET in Vercel and call with "
                                  "Authorization: Bearer <secret>, or trigger it from Vercel Cron."}
        return 200, cron_payload()
    return 404, {"error": f"No such API route: {path}"}
