"use strict";
const $ = (id) => document.getElementById(id);

const DEFAULT_RADAR = ["EURUSD", "GBPUSD", "USDJPY", "GBPJPY", "XAUUSD", "WTI", "SPX500", "NAS100", "BTCUSD", "NVDA"];
const TAPE_MAP = {"S&P 500": "SPX500", "NASDAQ": "NAS100", "DOW": "US30", "FTSE 100": "UK100", "DAX": "GER40",
  "NIKKEI": "JPN225", "GOLD": "XAUUSD", "WTI OIL": "WTI", "BTC/USD": "BTCUSD", "ETH/USD": "ETHUSD"};
const INDEX_CURRENCY = {UK100: "GBP", GER40: "EUR", FRA40: "EUR", EUSTX50: "EUR", JPN225: "JPY",
  AUS200: "AUD", HK50: "HKD", IN50: "INR", CHN50: "CNY"};

let state = {
  groups: {}, currencies: [], allSymbols: [], tab: "FOREX",
  symbol: "EUR/USD", data: null, chart: null, chartMarkers: [], tf: "1M",
  calendar: [], calFilter: "pair",
  view: "stories", sentFilter: "ALL", timeFilter: 0, bucketFilter: "ALL",
  scanning: false, pendingSymbol: null, progressTimer: null,
  countdownTimer: null, nextIn: null,
  renderedItems: [], showLimit: 30,
  seen: {}, radarLoaded: false, lastRadarAt: 0,
  myList: loadJSON("pw_mylist", []),
  saved: loadJSON("pw_saved", {}),
  notifyOn: loadJSON("pw_notify", false),
  paletteSel: 0, paletteItems: [],
  demoMode: false, demoCalendar: [], preDemoSymbol: "EUR/USD",
};

/* ───────────────── storage / utils */
function loadJSON(k, fallback){ try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fallback; } catch(e){ return fallback; } }
function saveJSON(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function keyOf(a){ return (a.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 80); }
function fmtPrice(p, type){
  if (p === null || p === undefined || isNaN(p)) return "—";
  const dec = type === "FOREX" ? (Math.abs(p) < 10 ? 4 : 3) : 2;
  return Number(p).toLocaleString("en-US", {minimumFractionDigits: dec, maximumFractionDigits: dec});
}
function fmtPct(p, signed=true){ if (p === null || p === undefined || isNaN(p)) return "—"; return (signed && p >= 0 ? "+" : "") + Number(p).toFixed(2) + "%"; }
function ago(ts){
  if (!ts) return "—";
  const s = Math.max(0, Math.floor(Date.now()/1000) - ts);
  if (s < 90) return "just now";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h " + Math.floor((s%3600)/60) + "m";
  return Math.floor(s/86400) + "d " + Math.floor((s%86400)/3600) + "h";
}
function until(ts){
  const s = ts - Math.floor(Date.now()/1000);
  if (s <= 0) return ago(ts).replace(" ago", "") + " ago";
  if (s < 3600) return "in " + Math.max(1, Math.floor(s/60)) + "m";
  if (s < 86400) return "in " + Math.floor(s/3600) + "h " + Math.floor((s%3600)/60) + "m";
  return "in " + Math.floor(s/86400) + "d " + Math.floor((s%86400)/3600) + "h";
}
function absTime(ts){
  if (!ts) return "";
  const d = new Date(ts*1000);
  return d.toLocaleDateString("en-GB", {day:"2-digit", month:"short"}) + " " + d.toLocaleTimeString("en-GB", {hour:"2-digit", minute:"2-digit"});
}
function toast(msg){
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 2600);
}
function log(msg, cls){
  const el = $("scanLog"); if (!el) return;
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = `[${new Date().toLocaleTimeString("en-GB")}] ${msg}`;
  el.prepend(div);
  while (el.children.length > 60) el.removeChild(el.lastChild);
}
function download(name, text, type){
  const blob = new Blob([text], {type: type || "text/plain"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 800);
}

/* ───────────────── theme / settings */
function applyTheme(name){
  if (name === "terminal") document.documentElement.dataset.theme = "terminal";
  else document.documentElement.removeAttribute("data-theme");
  $("themeBtn").textContent = "THEME: " + (name === "terminal" ? "TERMINAL" : "WIRE");
  saveJSON("pw_theme", name);
  if (state.chart) renderChart();
}
function applySettings(){
  applyTheme(loadJSON("pw_theme", "wire"));
  const iv = loadJSON("pw_interval", "60");
  if ([...$("intervalSel").options].some(o => o.value === String(iv))) $("intervalSel").value = String(iv);
  $("soundChk").checked = !!loadJSON("pw_sound", false);
  const compact = !!loadJSON("pw_compact", false);
  document.body.classList.toggle("compact", compact);
  $("densityBtn").textContent = "COMPACT: " + (compact ? "ON" : "OFF");
  updateNotifyBtn();
}
function updateNotifyBtn(){
  const b = $("notifyBtn");
  if (!("Notification" in window)) { b.textContent = "Browser alerts: unsupported"; return; }
  b.textContent = "Browser alerts: " + (state.notifyOn && Notification.permission === "granted" ? "on" : "off");
}

/* ───────────────── clock & sessions */
function sessionOpen(h, start, end){ return start <= end ? (h >= start && h < end) : (h >= start || h < end); }
function tickClock(){
  const now = new Date();
  $("clock").textContent = now.toLocaleTimeString("en-GB");
  const h = now.getUTCHours() + now.getUTCMinutes()/60;
  const sessions = [["Sydney", 21, 6], ["Tokyo", 0, 9], ["London", 8, 16.5], ["New York", 13, 22]];
  $("sessions").innerHTML = "<b>SESSIONS (UTC)</b> " + sessions.map(([n, s, e]) =>
    `<span class="session">${n} <span class="${sessionOpen(h, s, e) ? "open" : "shut"}">${sessionOpen(h, s, e) ? "OPEN" : "shut"}</span></span>`).join(" · ");
}
setInterval(tickClock, 1000);
setInterval(() => { renderCalendar(); renderRisk(); }, 45000);
$("todayLine").textContent = new Date().toLocaleDateString("en-GB", {weekday:"long", day:"numeric", month:"long", year:"numeric"});

async function loadHealth(){
  if (state.demoMode) { $("feedStatus").textContent = "DEMO: fictional sample data · live scan paused"; $("feedStatus").classList.remove("bad"); return; }
  try {
    const j = await (await fetch("/api/health")).json();
    const feeds = Object.entries(j.feeds || {});
    if (!feeds.length && j.environment && j.environment !== "local") {
      // On Vercel each serverless instance has its own memory, so the health function
      // cannot see the scan function's feed log. Say so instead of looking broken.
      $("feedStatus").textContent = "Feeds: Vercel serverless · verified by each scan";
      $("feedStatus").classList.remove("bad"); return;
    }
    if (!feeds.length) { $("feedStatus").textContent = "Feeds: awaiting first scan"; return; }
    const bad = feeds.filter(([, v]) => !v.ok).map(([k]) => k);
    $("feedStatus").textContent = bad.length ? "Feeds DOWN: " + bad.join(", ") : "Feeds OK: " + feeds.map(([k]) => k).join(" · ");
    $("feedStatus").classList.toggle("bad", bad.length > 0);
  } catch(e){ $("feedStatus").textContent = "Feeds: server unreachable"; $("feedStatus").classList.add("bad"); }
}

/* ───────────────── ticker tape */
async function loadTape(){
  if (state.demoMode) return;
  try {
    const j = await (await fetch("/api/tape")).json();
    if (state.demoMode) return;
    if (!j.tape || !j.tape.length) { $("tape").textContent = "Market tape unavailable — news scanning still works."; return; }
    const html = j.tape.map(t => {
      const cls = (t.changePct ?? 0) >= 0 ? "up" : "down";
      const arrow = (t.changePct ?? 0) >= 0 ? "▲" : "▼";
      const sym = TAPE_MAP[t.label] || t.label;
      return `<span class="tp" data-sym="${esc(sym)}" title="Scan ${esc(sym)}"><b>${esc(t.label)}</b> ${fmtPrice(t.price)} <span class="${cls}">${arrow} ${fmtPct(t.changePct)}</span></span>`;
    }).join("·");
    $("tape").innerHTML = html + "·" + html;
    $("tape").querySelectorAll(".tp").forEach(el => el.addEventListener("click", () => { $("symbolInput").value = el.dataset.sym; scan(el.dataset.sym); window.scrollTo({top: 0, behavior: "smooth"}); }));
  } catch(e){ $("tape").textContent = "Market tape unavailable — news scanning still works."; }
}

/* ───────────────── symbols / watchlist */
async function loadSymbols(){
  const j = await (await fetch("/api/symbols")).json();
  state.groups = j.groups; state.currencies = j.currencies;
  state.allSymbols = Object.values(j.groups).flat();
  $("symbolList").innerHTML = state.allSymbols.map(s => `<option value="${esc(s.display)}">${esc(s.name)}</option>`).join("");
  const fill = (sel, def) => { sel.innerHTML = j.currencies.map(c => `<option value="${c.code}" ${c.code===def?"selected":""}>${c.code}</option>`).join(""); };
  fill($("baseSel"), "GBP"); fill($("quoteSel"), "JPY");
  renderWatch();
}
function findSymbolInfo(display){
  return state.allSymbols.find(s => s.display.toLowerCase() === String(display).toLowerCase() || s.symbol.toLowerCase() === String(display).replace("/", "").toLowerCase());
}
function renderWatch(){
  let list = [];
  if (state.tab === "MY") {
    list = state.myList.map(d => { const i = findSymbolInfo(d); return {display: d, name: i ? i.name : "Custom instrument", mine: true}; });
  } else {
    list = state.groups[state.tab] || [];
  }
  $("watchMeta").textContent = list.length + " symbols";
  const cur = state.data ? state.data.instrument.display : null;
  $("watchTable").querySelector("tbody").innerHTML = list.length ? list.map(s => `
    <tr${s.display === cur ? ' class="active"' : ""} data-sym="${esc(s.display)}">
      <td><span class="wsym">${esc(s.display)}</span><span class="wname">${esc(s.name)}</span></td>
      ${s.mine ? `<td style="width:24px"><button class="watch-del" data-del="${esc(s.display)}" title="Remove">×</button></td>` : ""}
    </tr>`).join("")
    : `<tr><td class="muted" style="cursor:default">Nothing pinned yet — scan something and press ☆ MY LIST.</td></tr>`;
  $("watchTable").querySelectorAll("tr[data-sym]").forEach(tr => tr.addEventListener("click", (e) => {
    if (e.target.closest("[data-del]")) return;
    $("symbolInput").value = tr.dataset.sym; scan(tr.dataset.sym);
  }));
  $("watchTable").querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
    state.myList = state.myList.filter(x => x !== b.dataset.del);
    saveJSON("pw_mylist", state.myList); renderWatch(); updateStarBtn();
  }));
}
function updateStarBtn(){
  const cur = state.data ? state.data.instrument.display : $("symbolInput").value.trim();
  const starred = state.myList.includes(cur);
  $("starBtn").classList.toggle("starred", starred);
  $("starBtn").textContent = starred ? "★ IN MY LIST" : "☆ MY LIST";
}
$("starBtn").addEventListener("click", () => {
  const cur = state.data ? state.data.instrument.display : $("symbolInput").value.trim();
  if (!cur) return;
  if (state.myList.includes(cur)) state.myList = state.myList.filter(x => x !== cur);
  else state.myList.unshift(cur);
  saveJSON("pw_mylist", state.myList); renderWatch(); updateStarBtn();
  toast(state.myList.includes(cur) ? cur + " added to My List" : cur + " removed from My List");
});
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.tab = b.dataset.tab;
  $("tabs").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  renderWatch();
});

/* ───────────────── recent */
function getRecent(){ return loadJSON("pw_recent", []); }
function pushRecent(disp){
  let arr = getRecent().filter(x => x !== disp);
  arr.unshift(disp); saveJSON("pw_recent", arr.slice(0, 8)); renderRecent();
}
function renderRecent(){
  const arr = getRecent();
  $("recentRow").innerHTML = arr.length ? "Recent: " + arr.map(x => `<button data-sym="${esc(x)}">${esc(x)}</button>`).join("") : "";
  $("recentRow").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { $("symbolInput").value = b.dataset.sym; scan(b.dataset.sym); }));
}

/* ───────────────── labels */
function bucketLabels(inst){
  if (!inst) return {};
  const L = {PAIR: "Pair news", COMPANY: "Company", INDEX: "Index", COMMODITY: "Commodity", CRYPTO: "Crypto",
    MACRO: "Macro", MARKET: "Wider market", GENERAL: "General", BASE: "Base", QUOTE: "Quote"};
  if (inst.type === "FOREX") {
    L.PAIR = inst.display + " pair";
    L.BASE = `${inst.base} — ${inst.baseName || ""}`;
    L.QUOTE = `${inst.quote} — ${inst.quoteName || ""}`;
  }
  if (inst.type === "CURRENCY") L.BASE = inst.display + " currency";
  return L;
}
function effectText(a, inst){
  if (!inst || !a.pairEffect) return "";
  const dirWord = a.pairEffect > 0 ? "supports" : "pressures";
  if (inst.type === "FOREX") {
    if (a.bucket === "BASE") return `${inst.base}-side story: scored ${a.currencyStrength > 0 ? "currency-positive (hawkish/strong)" : "currency-negative (dovish/weak)"} → ${dirWord} ${inst.display}.`;
    if (a.bucket === "QUOTE") return `${inst.quote}-side story: scored ${a.currencyStrength > 0 ? "currency-positive (hawkish/strong)" : "currency-negative (dovish/weak)"} → ${dirWord} ${inst.display} (quote strength works against the pair).`;
    return `Pair headline direction scored ${a.pairEffect > 0 ? "up" : "down"} for ${inst.display}.`;
  }
  return `Headline direction scored ${a.pairEffect > 0 ? "bullish" : "bearish"} for ${inst.display}.`;
}
function rangeTrack(label, low, high, cur, type){
  if (low === null || high === null || cur === null || low === undefined || high === undefined || high <= low) return "";
  const pos = Math.max(0, Math.min(100, (cur - low) / (high - low) * 100));
  return `<div class="range-wrap"><div class="range-label"><span>${label}</span><span>${fmtPrice(low, type)} — ${fmtPrice(high, type)}</span></div>
    <div class="range-track"><div class="range-marker" style="left:${pos}%"></div></div></div>`;
}

/* ───────────────── rendering: centre panels */
function renderAll(){
  const d = state.data; if (!d) return;
  const inst = d.instrument, p = d.price, st = d.stats, br = d.briefing;
  const chgCls = p && (p.changePct ?? 0) >= 0 ? "up" : "down";
  const arrow = p ? ((p.changePct ?? 0) >= 0 ? "▲" : "▼") : "";

  $("instHead").innerHTML = `
    <div class="inst-top">
      <div>
        <span class="inst-sym">${esc(inst.display)}</span><span class="inst-type">${esc(inst.type)}</span><span class="inst-heat" title="News heat = how much attention this instrument is getting: last-hour intensity + 24h volume + high-impact count + price move. Busy does not mean bullish.">HEAT ${d.heat}/100</span><span class="mode-badge ${state.demoMode ? "demo" : "live"}">${state.demoMode ? "DEMO DATA — FICTIONAL" : "LIVE PUBLIC FEEDS"}</span>
        <div class="inst-name">${esc(inst.name)}${p && p.exchange ? " · " + esc(p.exchange) : ""}${p && p.longName && p.longName !== inst.name ? " · " + esc(p.longName) : ""}</div>
      </div>
      <div class="inst-price">
        ${p ? `<div class="p">${fmtPrice(p.price, inst.type)}</div>
               <div class="c ${chgCls}">${arrow} ${p.change !== null && p.change !== undefined ? (p.change>=0?"+":"") + fmtPrice(p.change, inst.type) : ""} (${fmtPct(p.changePct)}) today</div>`
            : `<div class="p" style="font-size:15px;color:var(--muted)">No live quote<br>for this symbol</div>`}
      </div>
    </div>
    <div class="inst-queries">${state.demoMode ? "DEMO SCENARIO — no live searches were run for this sample." : `WIRE SEARCHES: ${d.queries.map(q => `<b>“${esc(q)}”</b>`).join(" &nbsp;·&nbsp; ")} &nbsp;+ CNBC / MarketWatch wires`}</div>`;

  const biasCls = br.biasScore >= 14 ? "up" : (br.biasScore <= -14 ? "down" : "");
  $("briefBody").innerHTML = `
    <div class="brief-verdict"><span class="${biasCls}">${esc(inst.display)}: ${esc(br.biasLabel)} (${br.biasScore > 0 ? "+" : ""}${br.biasScore})</span>
      <span class="conf">confidence ${br.confidence}% · rule-scored, see Bias Meter</span></div>
    <div class="plain-box"><b>In plain English:</b> ${esc(plainEnglishSummary(d))}</div>
    <ul>${br.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>
    ${br.risks && br.risks.length ? `<div class="brief-risk"><b>KEY HEADLINE RISK</b><br>${br.risks.map(r => {
      const hit = d.news.find(n => n.title === r);
      return hit ? `<a href="${esc(hit.link)}" target="_blank" rel="noopener">${esc(r)}</a>` : esc(r);
    }).join("<br>")}</div>` : ""}
    ${br.watch && br.watch.length ? `<div class="note" style="margin-top:7px"><b>Watch next:</b> ${br.watch.map(esc).join(" · ")}</div>` : ""}`;

  $("statsStrip").innerHTML = [
    [st.storyCount, "Stories"], [st.total, "Headlines"], [st.last24h, "Last 24h"], [st.last1h, "Last hour"],
    [st.highImpact, "High impact"], [st.bullish, "Pair ▲ scored"], [st.bearish, "Pair ▼ scored"],
    [Object.keys(st.sources).length, "Publishers"], [st.tiers["1"], "Tier-1 sources"],
  ].map(([v,k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");

  /* headline flow */
  const maxFlow = Math.max(1, ...d.timeline.map(t => t.count));
  $("flowBars").innerHTML = d.timeline.map(t =>
    `<div class="flow-bar${t.high ? " has-high" : ""}" style="height:${Math.max(4, t.count/maxFlow*100)}%" title="${absTime(t.ts)} — ${t.count} headlines, ${t.high} high-impact"></div>`).join("");
  $("flowMeta").textContent = `(${st.last24h} headlines · red dot = high-impact hour)`;

  /* quote panel */
  $("priceBody").innerHTML = p ? `
    <div class="big-quote">${fmtPrice(p.price, inst.type)} <span style="font-size:13px;color:var(--muted)">${esc(p.currency || "")}</span></div>
    <div class="${chgCls}" style="font-family:Consolas,Menlo,monospace;font-size:13px">${arrow} ${fmtPct(p.changePct)} vs prev. close (${fmtPrice(p.prevClose, inst.type)})</div>
    ${rangeTrack("DAY RANGE", p.dayLow, p.dayHigh, p.price, inst.type)}
    ${rangeTrack("52-WEEK RANGE", p.wk52Low, p.wk52High, p.price, inst.type)}
    <table class="kv" style="margin-top:8px">
      <tr><td>Day high</td><td>${fmtPrice(p.dayHigh, inst.type)}</td></tr>
      <tr><td>Day low</td><td>${fmtPrice(p.dayLow, inst.type)}</td></tr>
      <tr><td>52-wk high</td><td>${fmtPrice(p.wk52High, inst.type)}</td></tr>
      <tr><td>52-wk low</td><td>${fmtPrice(p.wk52Low, inst.type)}</td></tr>
      <tr><td>Exchange</td><td>${esc(p.exchange || "—")}</td></tr>
    </table>
    <div class="note">${state.demoMode ? "DEMO price — invented for this teaching example. Exit demo for live delayed quotes." : "Delayed quote via Yahoo Finance — confirm tradable prices and spreads with your broker."}</div>`
  : `<div class="note" style="font-size:12px">No price feed matched this symbol${d.priceError ? " (" + esc(d.priceError) + ")" : ""}. News scanning is unaffected.</div>`;

  renderRisk(); renderBias(); renderBreakdown(); renderDriversSources(); renderRelated();
  renderBucketFilters(); renderNews(); renderWatch(); updateStarBtn(); renderCalendar();
}


function plainEnglishSummary(d){
  const inst = d.instrument, br = d.briefing, st = d.stats, r = d.risk || {};
  let dir;
  if (br.biasScore >= 38) dir = `most scored headlines are currently pressing ${inst.display} upward`;
  else if (br.biasScore >= 14) dir = `headline pressure leans upward on ${inst.display}, but it is not one-sided`;
  else if (br.biasScore <= -38) dir = `most scored headlines are currently pressing ${inst.display} downward`;
  else if (br.biasScore <= -14) dir = `headline pressure leans downward on ${inst.display}, but it is not one-sided`;
  else dir = `headlines are mixed, so there is no clear news direction for ${inst.display} right now`;
  const drivers = Object.entries(st.drivers || {}).sort((a,b) => b[1]-a[1]);
  const driverTxt = drivers.length ? ` The biggest theme is ${drivers[0][0].toLowerCase()} (${drivers[0][1]} stories).` : "";
  const riskTxt = r.level ? ` Separately, trading conditions around news look ${r.level} (${r.score}/100): ${String(r.meaning || "").split(".")[0].toLowerCase()}.` : "";
  const lead = state.demoMode ? "This is a fictional teaching example. In this invented scan, " : "Right now, ";
  return `${lead}${dir}.${driverTxt}${riskTxt} This describes headline pressure and conditions only — it is not a prediction and not a recommendation to trade.`;
}
function eventWhenText(e){
  if (!e || !e.ts) return "";
  return `${e.country} ${e.title} — ${until(e.ts)} (${new Date(e.ts*1000).toLocaleString("en-GB", {weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit"})})`;
}
function renderRisk(){
  const body = $("riskBody"); if (!body) return;
  const d = state.data;
  if (!d || !d.risk) { body.innerHTML = "Assessing scheduled releases and headline pressure…"; return; }
  const r = d.risk;
  $("riskPanel").className = "risk-panel risk-" + r.level;
  const event = r.riskEvent || r.nextEvent;
  const factors = [...(r.factors || [])].sort((a,b) => (b.points||0) - (a.points||0));
  body.innerHTML = `
    <div class="risk-main">
      <div class="risk-scorebox"><div class="risk-score">${r.score}<small>RISK INDEX / 100</small></div></div>
      <div class="risk-copy">
        <div class="risk-level">${esc(r.headline)} — ${esc(r.level)}</div>
        <div class="risk-meaning">${esc(r.meaning)}</div>
        <div class="risk-meter"><div class="risk-fill" style="width:${r.score}%"></div></div>
        <div class="risk-scale"><span>0 CALMER</span><span>25 MODERATE</span><span>45 HIGH</span><span>65 EXTREME</span></div>
      </div>
    </div>
    ${event ? `<div class="risk-event"><b>${r.riskEvent ? "Main scheduled risk" : "Next relevant calendar event"}:</b> ${esc(eventWhenText(event))}
      ${event.forecast ? ` · Forecast <b>${esc(event.forecast)}</b>` : ""}${event.previous ? ` · Previous <b>${esc(event.previous)}</b>` : ""}${event.actual ? ` · Actual <b>${esc(event.actual)}</b>` : ""}
      <div class="note">Markets mainly react to the <b>surprise versus forecast</b>, revisions and details — a "good" number can still disappoint if traders expected better.</div></div>` : ""}
    <table class="risk-factors">${factors.map(f => `<tr><td class="pts">+${f.points}</td><td><b>${esc(f.label)}</b><span class="fdetail">${esc(f.detail)}</span></td></tr>`).join("")}</table>
    <details class="risk-details">
      <summary>WHAT CAN GO WRONG AROUND MAJOR NEWS? OPEN THE RISK CHECKLIST ▸</summary>
      <div class="risk-cols">
        <div><h4>WHAT CAN HAPPEN</h4><ul>${(r.whatCanHappen || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div><h4>BEFORE YOU ACT</h4><ul>${(r.checklist || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
      </div>
      ${r.caveat ? `<div class="note" style="margin-top:7px">${esc(r.caveat)}</div>` : ""}
    </details>
    <div class="risk-warning">${esc(r.warning || "Not a direction forecast.")}</div>
    <div class="note">Calculated at scan time (${d.scannedAt ? new Date(d.scannedAt).toLocaleTimeString("en-GB") : "—"}) for ${esc((r.currenciesChecked || []).join("/"))}. ${state.demoMode ? "Demo events are fictional and timed relative to when you opened demo mode." : "Re-scan to update it as releases approach."}</div>`;
}

function renderBias(){
  const d = state.data, inst = d.instrument, st = d.stats, br = d.briefing;
  const net = br.biasScore;
  const fill = net >= 0
    ? `<div class="bias-fill-r" style="width:${net/2}%"></div>`
    : `<div class="bias-fill-l" style="width:${Math.abs(net)/2}%"></div>`;
  const tot = Math.max(1, st.bullish + st.bearish + st.neutral);
  const bp = Math.round(st.bullish/tot*100), rp = Math.round(st.bearish/tot*100), np = 100 - bp - rp;
  let components = "";
  if (inst.type === "FOREX") {
    const row = (label, v) => `<div class="str-row"><span class="bl">${label}</span><span class="bar-wrap"><span class="bar-fill ${v >= 0 ? "pos" : "neg"}" style="width:${Math.min(100, Math.abs(v))}%"></span></span><span class="bn">${v > 0 ? "+" : ""}${v}</span></div>`;
    components = row(`${inst.base} strength (base)`, br.baseStrength)
      + row(`${inst.quote} strength (quote)`, br.quoteStrength)
      + row("Pair headline flow", br.pairFlow)
      + `<div class="note">Pair bias = pair flow + base strength − quote strength, weighted by impact, source tier and recency. A strong quote currency pulls the pair down — that is handled for you here.</div>`;
  } else {
    components = `<div class="note">Headline flow for ${esc(inst.display)}: ${st.headlineBullish} bullish-worded vs ${st.headlineBearish} bearish-worded headlines, weighted by impact, source tier and recency.</div>`;
  }
  $("biasBody").innerHTML = `
    <div class="bias-track">${fill}<div class="bias-zero"></div><div class="bias-needle" style="left:${(net+100)/2}%"></div></div>
    <div class="bias-scale"><span>-100 BEARISH</span><span>0</span><span>BULLISH +100</span></div>
    <div class="verdict ${net >= 14 ? "up" : net <= -14 ? "down" : ""}">${esc(br.biasLabel)} <span style="font-family:Consolas,Menlo,monospace;font-size:13px">(${net > 0 ? "+" : ""}${net}, conf. ${br.confidence}%)</span></div>
    <div class="sent-bar"><div class="b" style="width:${bp}%"></div><div class="n" style="width:${np}%"></div><div class="r" style="width:${rp}%"></div></div>
    <div class="sent-legend"><span class="up">▲ ${st.bullish}</span><span>FLAT ${st.neutral}</span><span class="down">▼ ${st.bearish}</span></div>
    <div style="margin-top:9px">${components}</div>`;
}

function renderBreakdown(){
  const d = state.data, inst = d.instrument, st = d.stats, labels = bucketLabels(inst);
  const entries = Object.entries(st.buckets).sort((a,b) => b[1]-a[1]);
  const max = Math.max(1, ...entries.map(e => e[1]));
  let domNote = "";
  if (inst.type === "FOREX") {
    const b = st.buckets.BASE || 0, q = st.buckets.QUOTE || 0;
    if (b || q) domNote = `<div class="note">Pressure is coming mostly from the <b>${b >= q ? inst.base : inst.quote} side</b> (${Math.max(b,q)} vs ${Math.min(b,q)} stories). That side's calendar events (below) are the ones most likely to move ${esc(inst.display)} next.</div>`;
  }
  $("breakdownBody").innerHTML = entries.map(([k,v]) =>
    `<div class="bucket-row"><span class="bl">${esc(labels[k] || k)}</span><span class="bar-wrap"><span class="bar-fill" style="width:${Math.round(v/max*100)}%"></span></span><span class="bn">${v}</span></div>`).join("") + domNote;
}

function renderDriversSources(){
  const st = state.data.stats;
  const dr = Object.entries(st.drivers).sort((a,b) => b[1]-a[1]);
  $("driversBody").innerHTML = dr.length
    ? `<table class="kv">${dr.map(([k,v]) => `<tr><td class="plain">${esc(k)}</td><td>${v} ${v===1?"story":"stories"}</td></tr>`).join("")}</table>`
    : `<div class="note">No dominant macro driver flagged in current headlines.</div>`;
  const src = Object.entries(st.sources).sort((a,b) => b[1]-a[1]).slice(0, 9);
  $("sourcesBody").innerHTML = `
    <table class="kv">
      <tr><td class="plain"><span class="tier-badge">T1</span> Reuters/Bloomberg class</td><td>${st.tiers["1"]}</td></tr>
      <tr><td class="plain"><span class="tier-badge">T2</span> Specialist wires</td><td>${st.tiers["2"]}</td></tr>
      <tr><td class="plain"><span class="tier-badge">T3</span> Other publishers</td><td>${st.tiers["3"]}</td></tr>
    </table>
    <table class="kv" style="margin-top:6px">${src.map(([k,v]) => `<tr><td class="plain">${esc(k)}</td><td>${v}</td></tr>`).join("")}</table>`;
}

function renderRelated(){
  const rel = state.data.related || [];
  $("relatedBody").innerHTML = rel.length
    ? `<div class="rel-chips">${rel.map(r => `<button class="rel-chip" data-sym="${esc(r.display)}">${esc(r.display)}<small>${esc(r.name)}</small></button>`).join("")}</div>`
    : `<div class="note">No related set for this instrument.</div>`;
  $("relatedBody").querySelectorAll(".rel-chip").forEach(b => b.addEventListener("click", () => { $("symbolInput").value = b.dataset.sym; scan(b.dataset.sym); window.scrollTo({top: 0, behavior: "smooth"}); }));
}

function renderBucketFilters(){
  const inst = state.data.instrument, labels = bucketLabels(inst);
  const keys = ["ALL", ...Object.keys(state.data.stats.buckets)];
  if (!keys.includes(state.bucketFilter)) state.bucketFilter = "ALL";
  $("bucketFilters").innerHTML = keys.map(k =>
    `<button data-b="${k}" class="${state.bucketFilter===k ? "on" : ""}">${k === "ALL" ? "ALL SIDES" : esc((labels[k] || k).toUpperCase().split("—")[0].trim())}</button>`).join("");
  $("bucketFilters").querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => {
    state.bucketFilter = btn.dataset.b; state.showLimit = 30; renderBucketFilters(); renderNews();
  }));
}

/* ───────────────── news list */
function normalizeItems(){
  const d = state.data;
  if (state.view === "stories") {
    return d.stories.map(s => ({
      kind: "story", story: s, a: s.article,
      ts: s.latestTs || s.article.ts, score: s.score, relevance: s.article.relevance,
      impactScore: s.impactScore, impact: s.impact, direction: s.direction, pairEffect: s.pairEffect,
    }));
  }
  return d.news.map(a => ({
    kind: "article", story: null, a,
    ts: a.ts, score: a.score, relevance: a.relevance,
    impactScore: a.impactScore, impact: a.impact, direction: a.direction, pairEffect: a.pairEffect,
  }));
}
function applyFilters(items){
  const nowS = Date.now()/1000;
  let list = items.slice();
  if (state.sentFilter === "UP") list = list.filter(x => x.pairEffect > 0);
  if (state.sentFilter === "DOWN") list = list.filter(x => x.pairEffect < 0);
  if (state.sentFilter === "HIGH") list = list.filter(x => x.impact === "HIGH");
  if (state.timeFilter) list = list.filter(x => x.ts && (nowS - x.ts) <= state.timeFilter);
  if (state.bucketFilter !== "ALL") list = list.filter(x => x.a.bucket === state.bucketFilter);
  const tierMax = parseInt($("tierSel").value, 10);
  if (tierMax) list = list.filter(x => x.a.tier <= tierMax);
  if ($("savedOnlyChk").checked) list = list.filter(x => state.saved[keyOf(x.a)]);
  const q = $("textFilter").value.trim().toLowerCase();
  if (q) list = list.filter(x => {
    const extra = x.story ? x.story.coverage.map(c => c.title + " " + c.source).join(" ") : "";
    return (x.a.title + " " + x.a.source + " " + extra).toLowerCase().includes(q);
  });
  const sort = $("sortSel").value;
  if (sort === "top") list.sort((a,b) => b.score - a.score || b.ts - a.ts);
  else if (sort === "impact") list.sort((a,b) => b.impactScore - a.impactScore || b.ts - a.ts);
  else if (sort === "relevance") list.sort((a,b) => b.relevance - a.relevance || b.ts - a.ts);
  else list.sort((a,b) => b.ts - a.ts);
  return list;
}
function renderNews(){
  const d = state.data; if (!d) return;
  const inst = d.instrument;
  const all = normalizeItems();
  const list = applyFilters(all);
  const shown = list.slice(0, state.showLimit);
  state.renderedItems = shown;
  $("moreBtn").hidden = list.length <= state.showLimit;
  $("moreBtn").textContent = `SHOW MORE (${list.length - shown.length} remaining) ▾`;
  $("newsMeta").textContent =
    `${state.view === "stories" ? "Stories" : "Headlines"}: showing ${shown.length} of ${list.length} (scan: ${d.stats.storyCount} stories / ${d.stats.total} headlines) · ${d.cacheHit ? "cached <60s" : "fresh"} · scanned ${new Date(d.scannedAt).toLocaleTimeString("en-GB")} · ${state.demoMode ? "DEMO sample — fictional data" : "Live aggregated headlines · scores calculated by PairWire"} · Score = relevance + impact + recency (+ coverage) · open WHY THIS SCORE? to audit any headline`;
  if (!shown.length) {
    $("newsList").innerHTML = `<div class="empty-state">No headlines match these filters.<br><span style="font-size:13px">Widen the time window, clear the text filter, or include Tier-3 sources.</span></div>`;
    return;
  }
  const nowS = Date.now()/1000;
  $("newsList").innerHTML = shown.map((x, idx) => {
    const a = x.a, saved = !!state.saved[keyOf(a)];
    const dirTag = x.pairEffect > 0
      ? `<span class="tag tag-bull">${inst.type === "FOREX" ? esc(inst.display) + " ▲" : "Bullish ▲"}</span>`
      : x.pairEffect < 0
        ? `<span class="tag tag-bear">${inst.type === "FOREX" ? esc(inst.display) + " ▼" : "Bearish ▼"}</span>`
        : `<span class="tag tag-neutral">No direction</span>`;
    const coverage = (x.kind === "story" && x.story.count > 1) ? `
      <div class="coverage">
        <button class="coverage-toggle" data-idx="${idx}">▸ +${x.story.count - 1} more outlet${x.story.count > 2 ? "s" : ""} on this story (${x.story.sources.length} publishers)</button>
        <div class="coverage-list" hidden>${x.story.coverage.map(c =>
          `<div><a href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.title)}</a> <span class="cs">${esc(c.source)} · ${ago(c.ts)}</span></div>`).join("")}</div>
      </div>` : "";
    const eff = effectText(a, inst);
    const whyReasons = [...(a.scoreReasons || [])];
    if (x.kind === "story" && x.story.count > 1)
      whyReasons.push(`Coverage: ${x.story.count} matching headlines from ${x.story.sources.length} publisher(s) were clustered as the same story. Wider coverage raises the Story Score a little, but syndicated copies are not independent confirmation.`);
    if (!whyReasons.length)
      whyReasons.push("Score inputs: relevance " + x.relevance + ", impact " + x.impactScore + ", source Tier " + a.tier + ". (Detailed reasons appear on fresh scans.)");
    const why = `<div class="why-wrap"><button class="why-toggle" data-idx="${idx}" type="button">▸ WHY THIS SCORE?</button>
      <div class="why-box" hidden><b>How PairWire scored this headline</b><ul>${whyReasons.map(r2 => `<li>${esc(r2)}</li>`).join("")}</ul>
      <div class="note">Impact bands: 0–37 low, 38–61 medium, 62–100 high. Direction is scored for ${esc(inst.display)} (quote-currency strength counts against a pair). These are transparent estimates — open the publisher's article before relying on it.</div></div></div>`;
    return `
    <article class="article" data-key="${keyOf(a)}">
      <div class="article-time"><div class="ago">${ago(x.ts)}</div><div class="abs">${absTime(x.ts)}</div>
        <span class="article-score" title="Story Score ${x.score}/100 = what to read first. Impact ${x.impactScore}/100 (62+ = high) · Relevance ${x.relevance}/100. Open WHY THIS SCORE? for the inputs.">${x.score}<small>SCORE</small></span></div>
      <div class="article-main">
        <h3><a href="${esc(a.link)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
        ${a.snippet ? `<div class="snippet">${esc(a.snippet)}</div>` : ""}
        ${eff ? `<div class="note">${esc(eff)}</div>` : ""}
        <div class="article-tags">
          <span class="src">${esc(a.source)}</span><span class="tier-badge" title="PairWire source grouping: T1 major-wire class, T2 specialist wire, T3 other publisher. A tier is not a guarantee a story is correct.">T${a.tier}</span>
          ${nowS - x.ts < 3600 && x.ts ? `<span class="tag tag-fresh">&lt;1H OLD</span>` : ""}
          ${dirTag}
          ${x.impact === "HIGH" ? `<span class="tag tag-high" title="PairWire impact 62–100: potentially market-moving topic/source/freshness. Impact is not direction.">High impact ${x.impactScore}</span>` : x.impact === "MEDIUM" ? `<span class="tag tag-med" title="PairWire impact 38–61: worth reading; may matter if it changes expectations.">Impact ${x.impactScore}</span>` : `<span class="tag" title="PairWire impact 0–37: background unless it contains a surprise.">Impact ${x.impactScore}</span>`}
          <span class="tag">${esc(a.bucket)}</span>
          ${a.driver ? `<span class="tag tag-driver">${esc(a.driver)}</span>` : ""}
          <span class="tag" title="How directly this headline is about ${esc(inst.display)}">REL ${x.relevance}</span>
        </div>
        ${why}
        ${coverage}
      </div>
      <div class="article-actions">
        <button class="icon-btn save-btn${saved ? " saved" : ""}" data-idx="${idx}" title="${saved ? "Remove from saved" : "Save headline"}">${saved ? "★" : "☆"}</button>
        <button class="icon-btn copy-btn" data-idx="${idx}" title="Copy article link">⧉</button>
      </div>
    </article>`;
  }).join("");
}
$("newsList").addEventListener("click", async (e) => {
  const demoLink = e.target.closest('a[href^="#demo"]');
  if (demoLink) { e.preventDefault(); toast("Demo headline — fictional example, there is no publisher article to open"); return; }
  const whyBtn = e.target.closest(".why-toggle");
  if (whyBtn) {
    const box = whyBtn.parentElement.querySelector(".why-box");
    box.hidden = !box.hidden;
    whyBtn.textContent = (box.hidden ? "▸ " : "▾ ") + whyBtn.textContent.slice(2);
    return;
  }
  const cov = e.target.closest(".coverage-toggle");
  if (cov) {
    const list = cov.parentElement.querySelector(".coverage-list");
    list.hidden = !list.hidden;
    cov.textContent = (list.hidden ? "▸ " : "▾ ") + cov.textContent.slice(2);
    return;
  }
  const save = e.target.closest(".save-btn");
  if (save) {
    const item = state.renderedItems[Number(save.dataset.idx)]; if (!item) return;
    toggleSave(item.a); renderNews(); return;
  }
  const copy = e.target.closest(".copy-btn");
  if (copy) {
    const item = state.renderedItems[Number(copy.dataset.idx)]; if (!item) return;
    if (state.demoMode || String(item.a.link || "").startsWith("#demo")) { toast("Demo headline — there is no publisher link to copy"); return; }
    try { await navigator.clipboard.writeText(item.a.link); toast("Article link copied"); }
    catch(err){ toast("Copy blocked by browser — open the headline instead"); }
  }
});
$("moreBtn").addEventListener("click", () => { state.showLimit += 30; renderNews(); });

/* saved headlines */
function toggleSave(a){
  if (state.demoMode || String(a.link || "").startsWith("#demo")) { toast("Demo headlines are fictional and cannot be saved"); return; }
  const k = keyOf(a);
  if (state.saved[k]) { delete state.saved[k]; toast("Removed from saved"); }
  else {
    state.saved[k] = {title: a.title, link: a.link, source: a.source, ts: a.ts,
                      symbol: state.data ? state.data.instrument.display : ""};
    toast("Saved headline");
  }
  saveJSON("pw_saved", state.saved); renderSaved();
}
function renderSaved(){
  const items = Object.entries(state.saved).map(([k, v]) => ({k, ...v})).sort((a, b) => b.ts - a.ts);
  $("savedCount").textContent = items.length;
  $("savedBody").innerHTML = items.length ? items.slice(0, 20).map(x => `
    <div class="saved-item"><a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a>
      <div class="smeta">${esc(x.symbol)} · ${esc(x.source)} · ${ago(x.ts)}<button data-unsave="${esc(x.k)}">REMOVE</button></div></div>`).join("")
    : `<div class="note" style="padding:8px 10px">Press ☆ on any headline to pin it here. Saved on this device.</div>`;
  $("savedBody").querySelectorAll("[data-unsave]").forEach(b => b.addEventListener("click", () => {
    delete state.saved[b.dataset.unsave]; saveJSON("pw_saved", state.saved); renderSaved(); renderNews();
  }));
}

/* ───────────────── chart */
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
async function loadChart(tf){
  const d = state.data; if (!d) return;
  state.tf = tf;
  $("tfGroup").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.tf === tf));
  if (state.demoMode) { setDemoChart(tf); return; }
  if (!d.instrument.yahoo) {
    state.chart = {candles: []}; renderChart();
    $("chartMeta").textContent = "No chart feed for this symbol — news only";
    return;
  }
  $("chartMeta").textContent = "Loading " + tf + " candles…";
  try {
    const j = await (await fetch(`/api/chart?symbol=${encodeURIComponent(d.instrument.display)}&tf=${tf}`)).json();
    if (!state.data || state.data.instrument.symbol !== d.instrument.symbol) return; // stale
    state.chart = j;
    const last = j.candles[j.candles.length - 1];
    $("chartMeta").textContent = `${d.instrument.display} · ${tf} · ${j.candles.length} candles` + (last ? ` · last ${fmtPrice(last.c, d.instrument.type)}` : "");
    renderChart();
  } catch(e){
    $("chartMeta").textContent = "Chart feed error: " + e.message;
    state.chart = {candles: []}; renderChart();
  }
}
function chartNewsMarkers(candles){
  if (!state.data || !candles.length) return [];
  const t0 = candles[0].t, t1 = candles[candles.length - 1].t;
  return state.data.news
    .filter(a => a.ts >= t0 && a.ts <= t1 + 86400 && (a.impact === "HIGH" || a.score >= 78))
    .sort((a, b) => b.score - a.score).slice(0, 26);
}
function renderChart(hoverIdx = null){
  const canvas = $("chart"); if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || canvas.parentElement.clientWidth || 800;
  const H = canvas.clientHeight || 300;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const up = cssVar("--chart-up") || "#0a6b2d", down = cssVar("--chart-down") || "#b00020";
  const grid = cssVar("--chart-grid") || "#e4e1d6", axis = cssVar("--chart-axis") || "#888", markerC = cssVar("--marker") || "#b00020";
  const candles = (state.chart && state.chart.candles) || [];
  ctx.font = "10px Consolas, Menlo, monospace"; ctx.fillStyle = axis;
  if (!candles.length) {
    ctx.font = "14px Georgia, serif";
    ctx.fillText(state.data && !state.data.instrument.yahoo ? "No price chart for this symbol — the news scan below is fully live." : "No candle data returned for this timeframe.", 16, 40);
    state.chartMarkers = []; return;
  }
  const padR = 66, padB = 20, padT = 10, padL = 6;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  let min = Math.min(...candles.map(c => c.l)), max = Math.max(...candles.map(c => c.h));
  const pad = (max - min) * 0.06 || max * 0.01 || 1; min -= pad; max += pad;
  const y = (v) => padT + (max - v) / (max - min) * plotH;
  const step = plotW / candles.length;
  const type = state.data ? state.data.instrument.type : "";
  // grid + y labels
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = min + (max - min) * i / 4, yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
    ctx.fillStyle = axis; ctx.fillText(fmtPrice(v, type), padL + plotW + 6, yy + 3);
  }
  // x labels
  ctx.fillStyle = axis;
  for (let i = 0; i < 5; i++) {
    const idx = Math.min(candles.length - 1, Math.floor(i * (candles.length - 1) / 4));
    const dt = new Date(candles[idx].t * 1000);
    const lbl = (state.tf === "1D" || state.tf === "5D")
      ? dt.toLocaleDateString("en-GB", {day: "2-digit", month: "short"}) + " " + dt.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"})
      : dt.toLocaleDateString("en-GB", {day: "2-digit", month: "short", year: "2-digit"});
    const x = padL + idx * step;
    ctx.fillText(lbl, Math.min(x, padL + plotW - 74), H - 6);
  }
  // candles or line
  if (step >= 2.2) {
    const bw = Math.max(1, Math.min(11, step * 0.62));
    candles.forEach((c, i) => {
      const x = padL + i * step + step/2;
      const col = c.c >= c.o ? up : down;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
      const yO = y(c.o), yC = y(c.c);
      ctx.fillRect(x - bw/2, Math.min(yO, yC), bw, Math.max(1, Math.abs(yC - yO)));
    });
  } else {
    ctx.strokeStyle = up; ctx.lineWidth = 1.4; ctx.beginPath();
    candles.forEach((c, i) => { const x = padL + i * step, yy = y(c.c); i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); });
    ctx.stroke();
  }
  // last price line
  const last = candles[candles.length - 1];
  ctx.strokeStyle = axis; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, y(last.c)); ctx.lineTo(padL + plotW, y(last.c)); ctx.stroke();
  ctx.setLineDash([]);
  // hover crosshair
  if (hoverIdx !== null && candles[hoverIdx]) {
    const x = padL + hoverIdx * step + step/2;
    ctx.strokeStyle = axis; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
  }
  // news markers
  state.chartMarkers = [];
  const marks = chartNewsMarkers(candles);
  const t0 = candles[0].t, t1 = candles[candles.length - 1].t;
  marks.forEach(a => {
    const frac = t1 > t0 ? (Math.min(a.ts, t1) - t0) / (t1 - t0) : 1;
    const x = padL + frac * plotW;
    const idx = Math.min(candles.length - 1, Math.max(0, Math.round(frac * (candles.length - 1))));
    const yy = y(candles[idx].h) - 9;
    ctx.fillStyle = markerC;
    ctx.beginPath(); ctx.moveTo(x, yy - 5); ctx.lineTo(x + 5, yy); ctx.lineTo(x, yy + 5); ctx.lineTo(x - 5, yy); ctx.closePath(); ctx.fill();
    state.chartMarkers.push({x, y: yy, article: a});
  });
}
$("chart").addEventListener("mousemove", (e) => {
  const canvas = $("chart"), rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const tip = $("chartTip");
  const marker = state.chartMarkers.find(m => Math.hypot(m.x - mx, m.y - my) <= 11);
  const candles = (state.chart && state.chart.candles) || [];
  if (marker) {
    tip.hidden = false;
    tip.style.left = Math.min(mx + 12, rect.width - 300) + "px"; tip.style.top = Math.max(4, my - 10) + "px";
    tip.innerHTML = `<b>◆ HIGH-IMPACT HEADLINE — click to open below</b><br>${esc(marker.article.title)}<br>${esc(marker.article.source)} · ${absTime(marker.article.ts)} · score ${marker.article.score}`;
    canvas.style.cursor = "pointer"; return;
  }
  if (!candles.length) { tip.hidden = true; return; }
  const padL = 6, plotW = rect.width - 72;
  const idx = Math.max(0, Math.min(candles.length - 1, Math.floor((mx - padL) / (plotW / candles.length))));
  const c = candles[idx]; if (!c) { tip.hidden = true; return; }
  const type = state.data ? state.data.instrument.type : "";
  tip.hidden = false;
  tip.style.left = Math.min(mx + 12, rect.width - 230) + "px"; tip.style.top = Math.max(4, my - 10) + "px";
  tip.innerHTML = `${new Date(c.t*1000).toLocaleString("en-GB", {day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit"})}<br>O ${fmtPrice(c.o, type)}  H ${fmtPrice(c.h, type)}<br>L ${fmtPrice(c.l, type)}  C ${fmtPrice(c.c, type)}`;
  canvas.style.cursor = "crosshair";
  renderChart(idx);
});
$("chart").addEventListener("mouseleave", () => { $("chartTip").hidden = true; renderChart(); });
$("chart").addEventListener("click", (e) => {
  const rect = $("chart").getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const marker = state.chartMarkers.find(m => Math.hypot(m.x - mx, m.y - my) <= 12);
  if (!marker) return;
  // reset filters so the story is visible, then scroll to + flash it
  state.view = "articles"; state.sentFilter = "ALL"; state.timeFilter = 0; state.bucketFilter = "ALL";
  $("viewToggle").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.view === "articles"));
  $("sentFilters").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.f === "ALL"));
  $("timeFilters").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.t === "0"));
  $("tierSel").value = "0"; $("textFilter").value = ""; $("savedOnlyChk").checked = false;
  state.showLimit = 100; renderBucketFilters(); renderNews();
  const el = document.querySelector(`.article[data-key="${keyOf(marker.article)}"]`);
  if (el) { el.scrollIntoView({behavior: "smooth", block: "center"}); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 2600); }
  else toast("That headline is outside the current scan list");
});
$("tfGroup").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  loadChart(b.dataset.tf);
});
let resizeH = null;
window.addEventListener("resize", () => { clearTimeout(resizeH); resizeH = setTimeout(renderChart, 180); });

/* ───────────────── calendar */
async function loadCalendar(){
  if (state.demoMode) { renderCalendar(); return; }
  try {
    const j = await (await fetch("/api/calendar")).json();
    if (state.demoMode) { renderCalendar(); return; }
    state.calendar = j.events || [];
    renderCalendar();
  } catch(e){ $("calBody").innerHTML = `<div class="note" style="padding:9px 10px">Calendar feed error: ${esc(e.message)}</div>`; }
}
function instrumentCurrencies(){
  const inst = state.data ? state.data.instrument : null;
  if (!inst) return ["USD"];
  if (inst.type === "FOREX") return [inst.base, inst.quote].filter(Boolean);
  if (inst.type === "CURRENCY") return [inst.base, "USD"].filter(Boolean);
  if (INDEX_CURRENCY[inst.symbol]) return [INDEX_CURRENCY[inst.symbol], "USD"];
  return ["USD"];
}

function eventExplainer(e){
  const t = (e.title || "").toLowerCase();
  const lvl = e.impactLevel >= 3 ? " Calendar class: High — releases of this type often move currencies, but only the surprise versus forecast tells the direction."
    : e.impactLevel === 2 ? " Calendar class: Medium — can matter when it reinforces or contradicts the bigger story."
    : "";
  let what = "";
  if (t.includes("bank holiday")) what = "Market holiday: thinner liquidity in that currency can exaggerate moves.";
  else if (t.includes("consumer price") || t.includes("cpi") || t.includes("inflation rate")) what = "Inflation (consumer prices). Hotter/cooler than forecast can change interest-rate expectations.";
  else if (t.includes("core pce") || t.includes("pce")) what = "US PCE inflation — the Federal Reserve's preferred inflation gauge.";
  else if (t.includes("producer price") || t.includes("ppi")) what = "Producer prices: business input costs that can feed into consumer inflation.";
  else if (t.includes("rate decision") || t.includes("interest rate") || t.includes("bank rate") || t.includes("cash rate") || t.includes("refinancing rate") || t.includes("monetary policy")) what = "Central-bank rate decision / policy. The decision, statement wording and press conference all matter — not just hike/cut/hold.";
  else if (t.includes("fomc") || t.includes("meeting minutes") || t.includes("minutes")) what = "Central-bank minutes: clues on how officials debated the next rate move.";
  else if (t.includes("nonfarm") || t.includes("non-farm") || t.includes("payroll") || t.includes("adp")) what = "Jobs creation. Strong/weak hiring changes growth and rate expectations; watch revisions and wages too.";
  else if (t.includes("unemployment") || t.includes("jobless") || t.includes("claimant")) what = "Labour-market slack: rising joblessness can argue for easier policy, depending on inflation.";
  else if (t.includes("gdp") || t.includes("gross domestic")) what = "Economic growth (GDP). First estimates move markets most; later revisions usually less.";
  else if (t.includes("retail sales")) what = "Consumer spending — a big part of growth in consumer-led economies.";
  else if (t.includes("pmi") || t.includes("ism")) what = "Business-activity survey (50 ≈ no change). A timely growth signal, but it is a survey, not hard output data.";
  else if (t.includes("trade balance") || t.includes("current account")) what = "Trade/current-account flows: exports minus imports and related income flows.";
  else if (t.includes("consumer confidence") || t.includes("consumer sentiment") || t.includes("sentiment")) what = "Household/business confidence survey — useful colour, usually secondary to hard data.";
  else if (t.includes("durable goods") || t.includes("factory orders") || t.includes("industrial production") || t.includes("manufacturing production")) what = "Factory/orders activity: a read on investment and industrial demand.";
  else if (t.includes("housing") || t.includes("building permit") || t.includes("home sales") || t.includes("house price")) what = "Housing activity — interest-rate sensitive and a window on household demand.";
  else if (t.includes("crude oil inventories") || t.includes("oil inventories")) what = "US oil stockpiles: a draw/build surprise mainly moves crude and energy-linked currencies.";
  else if (t.includes("speak") || t.includes("speech") || t.includes("testif") || t.includes("press conference")) what = "Official speech/testimony. Impact depends on the speaker, topic and whether guidance actually changes.";
  else if (e.impactLevel >= 3) what = "Top-tier scheduled release for this currency. Compare actual with forecast and check revisions.";
  return what ? (what + lvl) : "";
}

function renderCalendar(){
  const body = $("calBody"); if (!body) return;
  const sourceEvents = state.demoMode ? state.demoCalendar : state.calendar;
  if (!sourceEvents.length) { body.innerHTML = `<div class="note" style="padding:9px 10px">${state.demoMode ? "No demo events." : "Loading calendar…"}</div>`; return; }
  const nowS = Math.floor(Date.now()/1000);
  let events = sourceEvents.filter(e => e.ts >= nowS - 7200);
  if (state.calFilter === "pair") {
    const curs = new Set(instrumentCurrencies());
    events = events.filter(e => curs.has(e.country));
  } else if (state.calFilter === "high") {
    events = events.filter(e => e.impactLevel >= 3);
  }
  events = events.slice(0, 34);
  if (!events.length) {
    body.innerHTML = `<div class="note" style="padding:9px 10px">No${state.calFilter === "pair" ? " " + instrumentCurrencies().join("/") : ""} events left on this week's calendar. Try ALL HIGH IMPACT.</div>`;
    return;
  }
  let html = "", lastDay = "";
  events.forEach(e => {
    const day = new Date(e.ts*1000).toLocaleDateString("en-GB", {weekday: "short", day: "numeric", month: "short"});
    if (day !== lastDay) { html += `<div class="cal-day">${day.toUpperCase()}</div>`; lastDay = day; }
    const past = e.ts < nowS, soon = !past && (e.ts - nowS) < 7200;
    const vals = [
      e.actual ? `Actual <b>${esc(e.actual)}</b>` : "",
      e.forecast ? `Fcst ${esc(e.forecast)}` : "",
      e.previous ? `Prev ${esc(e.previous)}` : "",
    ].filter(Boolean).join(" · ");
    const info = eventExplainer(e);
    html += `<div class="cal-event${past ? " past" : ""}${soon ? " soon" : ""}">
      <div class="cal-impact l${e.impactLevel}" title="ForexFactory expected impact class (3 = High). This is not PairWire's headline Impact score."></div>
      <div class="cal-main"><div class="cal-title">${esc(e.title)}</div>
        <div class="cal-meta">${esc(e.country)} · ${esc(e.impact || "—")} impact${vals ? " · " + vals : ""}</div>
        ${info ? `<div class="cal-info">${esc(info)}</div>` : ""}</div>
      <div class="cal-when"><div class="cd">${past ? ago(e.ts) : until(e.ts)}</div><div class="ct">${new Date(e.ts*1000).toLocaleTimeString("en-GB", {hour:"2-digit", minute:"2-digit"})}</div></div>
    </div>`;
  });
  body.innerHTML = html;
}
$("calFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.calFilter = b.dataset.c;
  $("calFilters").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  renderCalendar();
});

/* ───────────────── currency strength */
async function loadStrength(){
  if (state.demoMode) return;
  try {
    const j = await (await fetch("/api/strength")).json();
    if (state.demoMode) return;
    const rows = j.strength || [];
    if (!rows.length) { $("strengthBody").innerHTML = `<div class="note">Strength feed unavailable right now.</div>`; return; }
    const max = Math.max(0.05, ...rows.map(r => Math.abs(r.pct)));
    $("strengthBody").innerHTML = rows.map(r => `
      <div class="str-row strength-row" data-ccy="${r.code}" title="Scan ${r.code} as a single currency">
        <span class="bl">${r.code} <span class="muted" style="font-weight:400">${esc(r.name.split(" ").pop())}</span></span>
        <span class="bar-wrap"><span class="bar-fill ${r.pct >= 0 ? "pos" : "neg"}" style="width:${Math.round(Math.abs(r.pct)/max*100)}%"></span></span>
        <span class="bn ${r.pct >= 0 ? "up" : "down"}">${fmtPct(r.pct)}</span></div>`).join("")
      + `<div class="note">Daily % vs USD (USD = DXY). Click a currency to scan it on its own. Building a pair? Strongest vs weakest is the classic cross to investigate — then read its news.</div>`;
    $("strengthBody").querySelectorAll(".strength-row").forEach(el => el.addEventListener("click", () => {
      $("symbolInput").value = el.dataset.ccy; scan(el.dataset.ccy); window.scrollTo({top: 0, behavior: "smooth"});
    }));
  } catch(e){ $("strengthBody").innerHTML = `<div class="note">Strength feed error: ${esc(e.message)}</div>`; }
}

/* ───────────────── radar */
async function loadRadar(reason){
  if (state.demoMode) { toast("Radar is paused in demo mode — exit demo for live rankings"); return; }
  const btn = $("radarBtn");
  btn.disabled = true; btn.textContent = "SCANNING…";
  $("radarMeta").textContent = reason || "";
  try {
    const symbols = state.myList.length >= 3 ? state.myList.slice(0, 12) : DEFAULT_RADAR;
    const j = await (await fetch("/api/radar?symbols=" + encodeURIComponent(symbols.join(",")))).json();
    if (state.demoMode) return;
    const rows = j.radar || [];
    state.radarLoaded = true; state.lastRadarAt = Date.now();
    $("radarMeta").textContent = `${rows.length} scanned · ${symbols === DEFAULT_RADAR ? "majors set" : "My List"} · ${new Date().toLocaleTimeString("en-GB")}`;
    $("radarBody").innerHTML = rows.length ? rows.map(r => `
      <div class="radar-row" data-sym="${esc(r.instrument.display)}" title="Open full scan">
        <div class="radar-sym">${esc(r.instrument.display)}<small>${r.biasScore > 0 ? "+" : ""}${r.biasScore} bias · ${r.highImpact} high${r.riskScore !== null && r.riskScore !== undefined ? ` · risk ${r.riskScore} ${esc(r.riskLevel || "")}` : ""}</small></div>
        <div class="heat-wrap"><div class="heat-fill" style="width:${r.heat}%"></div></div>
        <div class="radar-nums">HEAT ${r.heat}<br><span class="${(r.changePct ?? 0) >= 0 ? "up" : "down"}">${fmtPct(r.changePct)}</span></div>
        ${r.top ? `<div class="radar-top">▶ <a href="${esc(r.top.link)}" target="_blank" rel="noopener">${esc(r.top.title)}</a> — ${esc(r.top.source)}, ${ago(r.top.ts)} · ${r.last24h} stories/24h</div>` : ""}
      </div>`).join("")
      : `<div class="note" style="padding:9px 10px">Radar returned nothing — feeds may be catching up. Try again.</div>`;
    $("radarBody").querySelectorAll(".radar-row").forEach(el => el.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      $("symbolInput").value = el.dataset.sym; scan(el.dataset.sym); window.scrollTo({top: 0, behavior: "smooth"});
    }));
    log(`RADAR OK: ${rows.length} instruments ranked. Hottest: ${rows[0] ? rows[0].instrument.display + " (" + rows[0].heat + ")" : "—"}`, "ok");
  } catch(e){
    $("radarBody").innerHTML = `<div class="note" style="padding:9px 10px">Radar error: ${esc(e.message)}</div>`;
    log("RADAR FAILED: " + e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = "▸ SCAN RADAR";
  }
}
$("radarBtn").addEventListener("click", () => loadRadar("manual"));

/* ───────────────── alerts */
function beep(){
  if (!$("soundChk").checked) return;
  try {
    const ctx = beep._ctx || (beep._ctx = new (window.AudioContext || window.webkitAudioContext)());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "square"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.06, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.36);
  } catch(e){}
}
function fireBreaking(article, count, instDisplay){
  const banner = $("breakingBanner"), txt = $("breakingText");
  txt.href = article.link;
  txt.textContent = `${instDisplay}: ${article.title} — ${article.source}${count > 1 ? `  (+${count - 1} more high-impact)` : ""}`;
  banner.hidden = false;
  log(`BREAKING ${instDisplay}: ${article.title} (${article.source}, impact ${article.impactScore})`, "alert");
  beep();
  if (state.notifyOn && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(`PAIRWIRE breaking — ${instDisplay}`, {body: article.title + " — " + article.source});
      n.onclick = () => { window.focus(); window.open(article.link, "_blank"); };
    } catch(e){}
  }
}
$("breakingClose").addEventListener("click", () => { $("breakingBanner").hidden = true; });
$("notifyBtn").addEventListener("click", async () => {
  if (!("Notification" in window)) { toast("This browser does not support notifications"); return; }
  if (Notification.permission === "default") await Notification.requestPermission();
  state.notifyOn = Notification.permission === "granted" ? !state.notifyOn : false;
  saveJSON("pw_notify", state.notifyOn); updateNotifyBtn();
  toast(Notification.permission !== "granted" ? "Notification permission not granted" : "Browser alerts " + (state.notifyOn ? "ON — high-impact breaking headlines will pop up" : "off"));
});

/* ───────────────── scanning */
function setScanning(on, sym){
  $("scanBtn").disabled = on;
  $("scanBtn").textContent = on ? "SCANNING…" : "SCAN NOW ▸";
  $("liveLabel").textContent = on ? "SCANNING " + (sym || "") : "LIVE SCAN";
  const wrap = $("scanProgress"), bar = $("scanProgressBar");
  clearInterval(state.progressTimer);
  if (on) {
    wrap.classList.add("on"); bar.style.width = "18%";
    const steps = [38, 57, 74, 86, 93]; let i = 0;
    state.progressTimer = setInterval(() => { if (i < steps.length) bar.style.width = steps[i++] + "%"; }, 650);
  } else {
    bar.style.width = "100%";
    setTimeout(() => wrap.classList.remove("on"), 350);
  }
}
async function scan(sym, isAuto){
  if (state.demoMode) { leaveDemoMode(); restoreLiveSideFeeds(); }
  sym = (sym || $("symbolInput").value || "").trim();
  if (!sym) { log("Empty symbol ignored.", "warn"); return; }
  if (state.scanning) { state.pendingSymbol = sym; log("Scan queued: " + sym.toUpperCase(), "warn"); return; }
  state.scanning = true;
  const prevSymbol = state.data ? state.data.instrument.symbol : null;
  state.symbol = sym;
  setScanning(true, sym.toUpperCase());
  log(`SCAN ${sym.toUpperCase()}${isAuto ? " (auto)" : ""} — requesting wires…`);
  if (!state.data || (state.data.instrument.display.toLowerCase() !== sym.toLowerCase())) {
    $("newsList").innerHTML =
      `<div class="skeleton">▸ Contacting wire feeds for “${esc(sym)}”…</div>
       <div class="skeleton">▸ Running pair / base / quote searches + CNBC &amp; MarketWatch wires…</div>
       <div class="skeleton">▸ Scoring impact &amp; bias, clustering duplicate coverage…</div>`;
  }
  const t0 = Date.now();
  try {
    const j = await (await fetch("/api/scan?symbol=" + encodeURIComponent(sym))).json();
    if (j.error && !j.news) throw new Error(j.error);
    const newSymbol = j.instrument.symbol;
    // breaking detection against what we've already seen for this instrument
    const seenSet = state.seen[newSymbol];
    let freshHigh = [];
    if (seenSet) {
      const nowS = Date.now()/1000;
      freshHigh = j.news.filter(a => !seenSet.has(keyOf(a)) && a.impactScore >= 70 && a.ts && (nowS - a.ts) < 7200)
                        .sort((a, b) => b.score - a.score);
    }
    state.seen[newSymbol] = new Set(j.news.map(keyOf));
    if (newSymbol !== prevSymbol) { state.bucketFilter = "ALL"; state.showLimit = 30; state.chart = null; }
    state.data = j;
    $("symbolInput").value = j.instrument.display;
    $("lastScan").textContent = `Last scan: ${new Date().toLocaleTimeString("en-GB")} · ${j.stats.storyCount} stories / ${j.stats.total} headlines · heat ${j.heat}`;
    pushRecent(j.instrument.display);
    renderAll();
    loadChart(state.tf);
    loadHealth();
    if (freshHigh.length) fireBreaking(freshHigh[0], freshHigh.length, j.instrument.display);
    log(`OK ${j.instrument.display}: ${j.stats.storyCount} stories, ${j.stats.highImpact} high-impact, ${j.stats.last1h} last hour, bias ${j.briefing.biasScore > 0 ? "+" : ""}${j.briefing.biasScore} (${Date.now()-t0}ms${j.cacheHit ? ", cache" : ""})`, "ok");
    if (j.errors && j.errors.length) log("Partial wire errors: " + j.errors.join("; ").slice(0, 150), "warn");
    if (!j.price && j.priceError) log("No quote feed for " + j.instrument.display + " — news only.", "warn");
    if (!state.radarLoaded) loadRadar("auto after first scan");
    else if (isAuto && Date.now() - state.lastRadarAt > 12 * 60 * 1000) loadRadar("auto refresh");
  } catch(e){
    log("SCAN FAILED: " + e.message, "err");
    $("newsList").innerHTML = `<div class="empty-state">The wire request failed (${esc(e.message)}).<br><span style="font-size:13px">Check the server is running, then scan again.</span></div>`;
  } finally {
    state.scanning = false;
    setScanning(false);
    scheduleAuto();
    if (state.pendingSymbol) { const nxt = state.pendingSymbol; state.pendingSymbol = null; scan(nxt); }
  }
}
function scheduleAuto(){
  clearInterval(state.countdownTimer);
  if (state.demoMode) { $("countdown").textContent = "Demo mode — auto-scan paused"; return; }
  const secs = parseInt($("intervalSel").value, 10);
  saveJSON("pw_interval", String(secs));
  if (!secs) { $("countdown").textContent = "Auto-scan off"; $("liveDot").classList.add("off"); return; }
  $("liveDot").classList.remove("off");
  state.nextIn = secs;
  $("countdown").textContent = "Next scan: " + state.nextIn + "s";
  state.countdownTimer = setInterval(() => {
    state.nextIn--;
    if (state.nextIn <= 0) {
      clearInterval(state.countdownTimer);
      scan(state.symbol, true);
      loadTape();
      renderCalendar();
    } else {
      $("countdown").textContent = "Next scan: " + state.nextIn + "s";
    }
  }, 1000);
}

/* ───────────────── exports */
function csvCell(v){ return '"' + String(v ?? "").replace(/"/g, '""') + '"'; }
$("exportCsvBtn").addEventListener("click", () => {
  if (!state.data) { toast("Scan something first"); return; }
  const d = state.data;
  const rows = [["symbol","datetime_utc","age","source","tier","bucket","impact","impact_score","score","relevance","pair_direction","driver","title","link"].join(",")];
  d.news.forEach(a => rows.push([d.instrument.display, a.ts ? new Date(a.ts*1000).toISOString() : "", ago(a.ts), a.source, a.tier,
    a.bucket, a.impact, a.impactScore, a.score, a.relevance, a.direction, a.driver || "", a.title, a.link].map(csvCell).join(",")));
  download(`${state.demoMode ? "DEMO_" : ""}pairwire_${d.instrument.symbol}_${new Date().toISOString().slice(0,10)}.csv`, rows.join("\n"), "text/csv");
  toast((state.demoMode ? "DEMO CSV (fictional data): " : "CSV exported: ") + d.news.length + " headlines");
});
$("exportBriefBtn").addEventListener("click", () => {
  if (!state.data) { toast("Scan something first"); return; }
  const d = state.data, b = d.briefing, p = d.price;
  const top = [...d.stories].sort((x, y) => y.score - x.score).slice(0, 8);
  const txt = [
    `PAIRWIRE DESK BRIEF — ${d.instrument.display} (${d.instrument.name})`,
    `Generated ${new Date().toLocaleString("en-GB")} · scan ${new Date(d.scannedAt).toLocaleString("en-GB")}`,
    p ? `Price ${fmtPrice(p.price, d.instrument.type)} ${p.currency || ""} (${fmtPct(p.changePct)} today)` : "Price: no quote feed",
    `News bias: ${b.biasLabel} (${b.biasScore > 0 ? "+" : ""}${b.biasScore}, confidence ${b.confidence}%) · Heat ${d.heat}/100`,
    "", "SUMMARY", ...b.bullets.map(x => "- " + x),
    "", "KEY HEADLINE RISK", ...(b.risks.length ? b.risks.map(x => "- " + x) : ["- none flagged"]),
    "", "TOP STORIES BY SCORE",
    ...top.map((s, i) => `${i+1}. [score ${s.score} · impact ${s.impactScore} · ${s.count} outlets · ${ago(s.latestTs)}] ${s.article.title} — ${s.article.source}\n   ${s.article.link}`),
    "", "Method: transparent keyword/rule scoring (impact, relevance, source tier, recency; pair-aware base/quote strength). Not financial advice.",
  ].join("\n");
  download(`pairwire_brief_${d.instrument.symbol}.txt`, txt);
  toast("Desk brief exported");
});

/* ───────────────── palette */
function fuzzyScore(q, text){
  q = q.toLowerCase(); text = text.toLowerCase();
  if (!q) return 1;
  if (text.includes(q)) return 100 - text.indexOf(q);
  let qi = 0, score = 0;
  for (let i = 0; i < text.length && qi < q.length; i++) if (text[i] === q[qi]) { qi++; score += 2; }
  return qi === q.length ? score : 0;
}
function paletteCandidates(q){
  const pool = [...state.allSymbols,
    ...state.currencies.map(c => ({symbol: c.code, display: c.code, name: c.name + " (single currency)", type: "CURRENCY"}))];
  const seen = new Set(), items = [];
  if (!q) {
    getRecent().forEach(d => { const i = findSymbolInfo(d) || {display: d, name: "Recent scan", type: ""}; if (!seen.has(i.display)) { seen.add(i.display); items.push(i); } });
  }
  pool.map(s => ({s, sc: Math.max(fuzzyScore(q, s.display), fuzzyScore(q, s.name), fuzzyScore(q, s.symbol))}))
      .filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc)
      .forEach(x => { if (!seen.has(x.s.display)) { seen.add(x.s.display); items.push(x.s); } });
  const out = items.slice(0, 28);
  if (q && !out.some(s => s.display.toLowerCase() === q.toLowerCase()))
    out.push({symbol: q, display: q.toUpperCase(), name: "Scan exactly as typed (any pair/ticker/search)", type: "CUSTOM"});
  return out;
}
function renderPalette(){
  const q = $("paletteInput").value.trim();
  state.paletteItems = paletteCandidates(q);
  state.paletteSel = Math.min(state.paletteSel, Math.max(0, state.paletteItems.length - 1));
  $("paletteResults").innerHTML = state.paletteItems.length ? state.paletteItems.map((s, i) => `
    <div class="palette-item${i === state.paletteSel ? " sel" : ""}" data-i="${i}">
      <span><span class="ps">${esc(s.display)}</span> <span class="pn">${esc(s.name)}</span></span>
      <span class="pt">${esc(s.type || "")}</span></div>`).join("")
    : `<div class="palette-item">No matches — press Enter to scan as typed</div>`;
  $("paletteResults").querySelectorAll(".palette-item[data-i]").forEach(el => el.addEventListener("click", () => choosePalette(Number(el.dataset.i))));
}
function openPalette(){ $("palette").hidden = false; state.paletteSel = 0; $("paletteInput").value = ""; renderPalette(); $("paletteInput").focus(); }
function closePalette(){ $("palette").hidden = true; }
function choosePalette(i){
  const item = state.paletteItems[i];
  const val = item ? item.display : $("paletteInput").value.trim();
  closePalette();
  if (val) { $("symbolInput").value = val; scan(val); window.scrollTo({top: 0, behavior: "smooth"}); }
}
$("paletteBtn").addEventListener("click", openPalette);
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) closePalette(); });
$("paletteInput").addEventListener("input", () => { state.paletteSel = 0; renderPalette(); });
$("paletteInput").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); state.paletteSel = Math.min(state.paletteItems.length - 1, state.paletteSel + 1); renderPalette(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); state.paletteSel = Math.max(0, state.paletteSel - 1); renderPalette(); }
  else if (e.key === "Enter") { choosePalette(state.paletteSel); }
  else if (e.key === "Escape") { closePalette(); }
});

/* ───────────────── global events */
function isTyping(e){ const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"); }
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("palette").hidden ? openPalette() : closePalette(); return; }
  if (isTyping(e)) return;
  if (e.key === "/") { e.preventDefault(); $("symbolInput").focus(); $("symbolInput").select(); }
  else if (e.key.toLowerCase() === "r") { scan(state.symbol); }
  else if (["1","2","3","4"].includes(e.key)) {
    const map = {"1": "ALL", "2": "UP", "3": "DOWN", "4": "HIGH"};
    state.sentFilter = map[e.key];
    $("sentFilters").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.f === state.sentFilter));
    state.showLimit = 30; renderNews();
  }
});
$("themeBtn").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "terminal" ? "wire" : "terminal"));
$("scanBtn").addEventListener("click", () => scan());
$("symbolInput").addEventListener("keydown", (e) => { if (e.key === "Enter") scan(); });
let debounce = null;
$("symbolInput").addEventListener("input", () => {
  const v = $("symbolInput").value.trim();
  clearTimeout(debounce);
  if (!v) return;
  const known = state.allSymbols.some(s => s.display.toLowerCase() === v.toLowerCase());
  if (known) debounce = setTimeout(() => scan(v), 450);
});
$("buildBtn").addEventListener("click", () => {
  const pair = $("baseSel").value + "/" + $("quoteSel").value;
  $("symbolInput").value = pair; scan(pair);
});
$("swapBtn").addEventListener("click", () => {
  const b = $("baseSel").value; $("baseSel").value = $("quoteSel").value; $("quoteSel").value = b;
});
$("intervalSel").addEventListener("change", scheduleAuto);
$("soundChk").addEventListener("change", () => { saveJSON("pw_sound", $("soundChk").checked); if ($("soundChk").checked) beep(); });
$("densityBtn").addEventListener("click", () => {
  const on = document.body.classList.toggle("compact");
  $("densityBtn").textContent = "COMPACT: " + (on ? "ON" : "OFF"); saveJSON("pw_compact", on);
});
$("clearLogBtn").addEventListener("click", () => { $("scanLog").innerHTML = ""; log("Log cleared."); });
$("viewToggle").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.view = b.dataset.view;
  $("viewToggle").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  state.showLimit = 30; renderNews();
});
$("sentFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.sentFilter = b.dataset.f;
  $("sentFilters").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  state.showLimit = 30; renderNews();
});
$("timeFilters").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.timeFilter = parseInt(b.dataset.t, 10);
  $("timeFilters").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  state.showLimit = 30; renderNews();
});
$("textFilter").addEventListener("input", () => { state.showLimit = 30; renderNews(); });
$("sortSel").addEventListener("change", renderNews);
$("tierSel").addEventListener("change", () => { state.showLimit = 30; renderNews(); });
$("savedOnlyChk").addEventListener("change", () => { state.showLimit = 30; renderNews(); });


/* ───────────────── reading guide + fictional DEMO mode ─────────────────
   Demo data below is invented in the browser for teaching. It is NOT fetched
   from any publisher and must never be shown as market news. Default mode is
   live public-feed aggregation; demo mode is bannered and pauses live loads. */
function openGuide(){
  $("guide").hidden = false;
  document.body.style.overflow = "hidden";
  const box = document.querySelector(".guide-box"); if (box) box.scrollTop = 0;
}
function closeGuide(){
  $("guide").hidden = true;
  document.body.style.overflow = "";
}
["guideBtn", "guideBtn2", "riskGuideBtn"].forEach(id => { const el = $(id); if (el) el.addEventListener("click", openGuide); });
$("guideClose").addEventListener("click", closeGuide);
$("guideClose2").addEventListener("click", closeGuide);
$("guide").addEventListener("click", (e) => { if (e.target === $("guide")) closeGuide(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("guide").hidden) closeGuide(); });
$("guideDemoBtn").addEventListener("click", () => { closeGuide(); loadDemo(); });
$("demoBtn").addEventListener("click", loadDemo);
$("exitDemoBtn").addEventListener("click", exitDemo);

function demoStory(article, members){
  members = members || [article];
  const impactScore = Math.max(...members.map(m => m.impactScore));
  const pairEffect = members.reduce((sum, m) => sum + (m.pairEffect || 0), 0);
  return {
    id: "demo-" + article.link, article,
    coverage: members.filter(m => m !== article).map(m => ({title: m.title, link: m.link, source: m.source, ts: m.ts})),
    count: members.length,
    sources: [...new Set(members.map(m => m.source))],
    latestTs: Math.max(...members.map(m => m.ts)),
    firstTs: Math.min(...members.map(m => m.ts)),
    score: Math.min(100, article.score + (members.length - 1) * 4),
    impactScore,
    impact: impactScore >= 62 ? "HIGH" : (impactScore >= 38 ? "MEDIUM" : "LOW"),
    pairEffect,
    direction: pairEffect > 0 ? "UP" : (pairEffect < 0 ? "DOWN" : "FLAT"),
  };
}
function buildDemoData(){
  const nowS = Math.floor(Date.now() / 1000);
  const atMin = (mins) => nowS - mins * 60;
  const article = (minsAgo, fields) => {
    const pairEffect = fields.pairEffect || 0;
    return Object.assign({
      ts: atMin(minsAgo), snippet: "FICTIONAL DEMO TEXT: invented example written only to teach the scoring labels. Do not treat this as market news.",
      pairEffect, currencyStrength: fields.currencyStrength || 0,
      direction: pairEffect > 0 ? "UP" : (pairEffect < 0 ? "DOWN" : "FLAT"),
      impact: fields.impactScore >= 62 ? "HIGH" : (fields.impactScore >= 38 ? "MEDIUM" : "LOW"),
      sentiment: pairEffect > 0 ? "BULLISH" : (pairEffect < 0 ? "BEARISH" : "NEUTRAL"),
      matchedTerms: ["demo"],
    }, fields);
  };
  const news = [
    article(12, {
      title: "DEMO: Federal Reserve officials warn persistent inflation could delay rate cuts",
      link: "#demo-fedhawkish", source: "Demo Wire A", tier: 1,
      impactScore: 85, relevance: 95, score: 98, bucket: "QUOTE", pairEffect: -28, currencyStrength: 28,
      driver: "CENTRAL BANK", sentiment: "BULLISH",
      why: "Demo example: delayed US rate cuts can support the dollar, which is the quote currency in EUR/USD.",
      scoreReasons: [
        "Impact 85/100 → HIGH (62–100), so read it first; high impact still does not tell you the trade direction by itself.",
        "Source: Demo Wire A is shown as Tier 1 in this fictional example (+16 impact points). In live mode, never assume a tier proves a story true.",
        "Topic: Federal Reserve + inflation wording is the largest impact input (+36) because it can change interest-rate expectations.",
        "Freshness: 12 minutes old in the demo timeline (+10). Freshness fades as markets absorb the story.",
        "Direction: “delay rate cuts / persistent inflation” is hawkish for USD. USD is the quote currency, so dollar strength presses EUR/USD down.",
        "Story Score 98: relevance 95×42% + impact 85×36% + recency×22% ≈ what to read first, not a win probability.",
      ],
    }),
    article(24, {
      title: "DEMO: Euro steadies as traders wait for fictional US inflation release",
      link: "#demo-euro-steadies-a", source: "Demo Markets Desk", tier: 2,
      impactScore: 58, relevance: 91, score: 84, bucket: "PAIR", pairEffect: 0, currencyStrength: 0,
      driver: "INFLATION",
      why: "Demo example: the calendar event matters, but this preview headline contains no actual result yet.",
      scoreReasons: [
        "Impact 58/100 → MEDIUM (38–61): worth reading because it points to a known risk window, not because it contains new data.",
        "Source: fictional Tier-2 specialist desk (+9 impact points).",
        "Topic: mentions inflation and an imminent release (+36 topic input), but it is a preview rather than an actual result.",
        "Direction: no clear up/down wording, so the pair direction is flat. A busy headline can be important without being bullish or bearish.",
        "Coverage: a near-identical demo headline below is clustered with this one; duplicate coverage is not independent proof.",
        "Story Score 84 mainly reflects very high relevance (91) and freshness.",
      ],
    }),
    article(41, {
      title: "DEMO: Euro steadies ahead of fictional US inflation release, traders say",
      link: "#demo-euro-steadies-b", source: "Demo Economics Desk", tier: 2,
      impactScore: 54, relevance: 88, score: 79, bucket: "PAIR", pairEffect: 0, currencyStrength: 0,
      driver: "INFLATION",
      why: "Demo example: duplicate wording demonstrates story clustering.",
      scoreReasons: [
        "Impact 54/100 → MEDIUM (38–61): same event-preview topic as the other demo outlet.",
        "This is intentionally near-duplicate coverage. In story view it is grouped instead of being treated as a second independent event.",
        "Direction: “steadies / ahead of” gives no reliable up/down signal, so pair effect is zero.",
        "Story Score 79: relevance 88×42% + impact 54×36% + recency×22%. Clustering can add a small coverage bonus in story view.",
      ],
    }),
    article(95, {
      title: "DEMO: ECB official says euro-area inflation is easing but wage growth needs watching",
      link: "#demo-ecb-easing", source: "Demo Central-Bank Watch", tier: 2,
      impactScore: 66, relevance: 89, score: 82, bucket: "BASE", pairEffect: -17, currencyStrength: -17,
      driver: "CENTRAL BANK", sentiment: "BEARISH",
      why: "Demo example: easing inflation can reduce pressure for higher euro-area rates.",
      scoreReasons: [
        "Impact 66/100 → HIGH (62–100) because a central-bank speaker is discussing the inflation path.",
        "Source: fictional Tier-2 specialist source (+9). The exact speaker and full quote would matter in a real story.",
        "Topic: ECB + inflation (+36). It is slightly older than the newest demo item, so freshness adds less.",
        "Direction: “inflation is easing” is scored mildly dovish for EUR. EUR is the base currency, so euro softness presses EUR/USD down.",
        "Caution inside the headline: “wage growth needs watching” limits the strength of that dovish read; PairWire rules cannot capture every nuance.",
        "Story Score 82: relevance 89×42% + impact 66×36% + recency×22%.",
      ],
    }),
    article(186, {
      title: "DEMO: Blog says EUR/USD could explode after invented data release",
      link: "#demo-blog-hype", source: "Demo Markets Blog", tier: 3,
      impactScore: 24, relevance: 72, score: 48, bucket: "PAIR", pairEffect: 0, currencyStrength: 0,
      driver: null,
      why: "Demo example: dramatic wording is not evidence and does not create a direction score.",
      scoreReasons: [
        "Impact 24/100 → LOW (0–37): read last, if at all.",
        "Source: fictional Tier-3 blog (+0). That does not prove it false, but it requires independent verification.",
        "Topic: no named official, data result, forecast comparison or new fact — only “could explode”.",
        "Direction: hype words alone do not say up or down, so pair effect is zero.",
        "Story Score 48: it names EUR/USD (relevance 72) but weak impact and age keep it below the serious demo stories.",
      ],
    }),
    article(318, {
      title: "DEMO: Euro-area factory survey beats forecast in sample data",
      link: "#demo-factory-beat", source: "Demo Data Service", tier: 2,
      impactScore: 61, relevance: 84, score: 76, bucket: "BASE", pairEffect: 16, currencyStrength: 16,
      driver: "GROWTH", sentiment: "BULLISH",
      why: "Demo example: stronger euro-area activity can support EUR, the base currency.",
      scoreReasons: [
        "Impact 61/100 → top of MEDIUM (38–61), just below HIGH. A survey beat matters, but it is not a central-bank decision.",
        "Topic: growth/PMI-style wording (+22) plus a forecast beat.",
        "Direction: better euro-area activity is EUR-positive. EUR is the base, so this pushes against the bearish demo headlines above.",
        "Conflict lesson: one bullish EUR story does not cancel a hawkish USD story automatically; the Bias Meter weights impact, tier and recency.",
        "Story Score 76: relevance 84×42% + impact 61×36% + recency×22%; being several hours old lowers the recency part.",
      ],
    }),
    article(1225, {
      title: "DEMO: Travel guide names Lisbon among Europe's best weekend breaks",
      link: "#demo-travel", source: "Demo Travel Journal", tier: 3,
      impactScore: 8, relevance: 34, score: 21, bucket: "BASE", pairEffect: 0, currencyStrength: 0,
      driver: null,
      why: "Demo example: mentioning Europe does not make a story relevant to EUR/USD.",
      scoreReasons: [
        "Impact 8/100 → LOW and relevance only 34/100: this is background noise for a currency scan.",
        "Source: fictional Tier-3 lifestyle publisher (+0), and there is no economy, rates, trade or market topic.",
        "Direction: none. PairWire should not invent a market meaning from a travel headline.",
        "Story Score 21 puts it at the bottom. Use relevance to separate “mentions a place/currency” from “could affect this instrument”.",
      ],
    }),
  ];
  const stories = [
    demoStory(news[0]),
    demoStory(news[1], [news[1], news[2]]),
    demoStory(news[3]),
    demoStory(news[4]),
    demoStory(news[5]),
    demoStory(news[6]),
  ];
  const cpi = {
    title: "Consumer Price Index m/m (demo scenario)", country: "USD", impact: "High", impactLevel: 3,
    ts: nowS + 28 * 60, date: new Date((nowS + 28 * 60) * 1000).toISOString(),
    forecast: "0.3%", previous: "0.4%", actual: "",
  };
  const demoCalendar = [
    {
      title: "German Factory Orders m/m (demo scenario)", country: "EUR", impact: "Medium", impactLevel: 2,
      ts: nowS - 52 * 60, date: new Date((nowS - 52 * 60) * 1000).toISOString(),
      forecast: "0.4%", previous: "-0.2%", actual: "0.9%",
    },
    cpi,
    {
      title: "Fed Chair Speaks (demo scenario)", country: "USD", impact: "Medium", impactLevel: 2,
      ts: nowS + 140 * 60, date: new Date((nowS + 140 * 60) * 1000).toISOString(), forecast: "", previous: "", actual: "",
    },
    {
      title: "ECB President Speaks (demo scenario)", country: "EUR", impact: "High", impactLevel: 3,
      ts: nowS + 26 * 3600, date: new Date((nowS + 26 * 3600) * 1000).toISOString(), forecast: "", previous: "", actual: "",
    },
  ];
  const timeline = [];
  for (let h = 23; h >= 0; h--) {
    const start = nowS - (h + 1) * 3600, end = nowS - h * 3600;
    const inb = news.filter(n => n.ts >= start && n.ts < end);
    timeline.push({ts: end, count: inb.length, high: inb.filter(n => n.impact === "HIGH").length});
  }
  const stats = {
    total: 7, storyCount: 6, last24h: 7, last6h: 6, last1h: 3,
    bullish: 1, bearish: 2, neutral: 4, headlineBullish: 2, headlineBearish: 1, highImpact: 2,
    buckets: {"BASE": 3, "QUOTE": 1, "PAIR": 3},
    sources: {"Demo Wire A": 1, "Demo Markets Desk": 1, "Demo Economics Desk": 1, "Demo Central-Bank Watch": 1, "Demo Markets Blog": 1, "Demo Data Service": 1, "Demo Travel Journal": 1},
    drivers: {"CENTRAL BANK": 2, "INFLATION": 2, "GROWTH": 1},
    tiers: {"1": 1, "2": 4, "3": 2},
  };
  return {
    instrument: {
      symbol: "EURUSD-DEMO", display: "EUR/USD", name: "Euro / U.S. Dollar — DEMO SCENARIO (FICTIONAL)",
      type: "FOREX", yahoo: "DEMO", base: "EUR", quote: "USD", baseName: "Euro", quoteName: "U.S. Dollar",
    },
    queries: [], dataMode: "DEMO",
    price: {
      price: 1.0848, prevClose: 1.0882, change: -0.0034, changePct: -0.31,
      dayHigh: 1.0891, dayLow: 1.0839, wk52High: 1.1210, wk52Low: 1.0140,
      currency: "USD (demo)", exchange: "DEMO — invented price", longName: "Fictional EUR/USD teaching example",
      spark: [1.091, 1.090, 1.089, 1.088, 1.087, 1.086, 1.085, 1.0848],
    },
    priceError: null, news, stories, stats, timeline,
    briefing: {
      biasScore: -17, biasLabel: "BEARISH LEAN", confidence: 58,
      baseStrength: -4, quoteStrength: 10, pairFlow: -3,
      bullets: [
        "DEMO DATA: every headline, price and calendar time on this screen is fictional and exists only to teach the interface.",
        "Direction in the invented example: bias -17/100 (bearish lean). The strongest demo pressure is a hawkish USD story; because USD is the quote currency, it presses EUR/USD down.",
        "Why confidence is only 58%: the demo set is tiny, one base-EUR story pushes the other way, and a fictional high-impact release is only 28 minutes away.",
        "Fresh flow: 3 of 7 invented headlines landed in the last hour; two are the same story, so story view clusters them instead of double-counting them as separate events.",
        "Price in the demo is down 0.31% on the invented day — use it to see how the panels line up, not as a market observation.",
      ],
      risks: [news[0].title],
      watch: ["USD — Consumer Price Index m/m (demo scenario) in about 28 minutes", "Open WHY THIS SCORE? under the blog and travel items to see low scores explained"],
    },
    risk: {
      score: 82, level: "EXTREME", headline: "DEMO: RELEASE WINDOW — EXECUTION RISK DOMINATES",
      meaning: "In this fictional setup, a top-tier USD inflation release is 28 minutes away while fresh high-impact headlines are already flowing. Wide spreads, slippage and two-way whipsaws are the lesson here — not a forecast that EUR/USD must fall or rise.",
      currenciesChecked: ["EUR", "USD"], nextEvent: cpi, riskEvent: cpi,
      freshHighImpact2h: 2, dayChangePct: -0.31, conflictingMessages: true,
      factors: [
        {label: "Demo top-tier release in 28 minutes", points: 34, detail: "Consumer Price Index m/m (demo scenario). In live use, the surprise versus forecast matters more than whether the number sounds good or bad."},
        {label: "Fresh high-impact demo flow", points: 18, detail: "Two invented HIGH-impact items in the last two hours show how an already-sensitive market can react violently to the next headline."},
        {label: "Conflicting demo messages", points: 9, detail: "Hawkish USD and slightly dovish EUR stories push one way, while the factory-survey beat pushes back — a classic whipsaw setup."},
        {label: "Invented price already moving", points: 8, detail: "The fictional -0.31% day move shows existing volatility before the release, not a guaranteed continuation."},
        {label: "Demo news heat 64/100", points: 13, detail: "Heat measures crowding/attention. Crowded conditions can amplify the first move and the reversal."},
      ],
      whatCanHappen: [
        "Spreads can widen sharply before and just after a top-tier release, so the cost of entering/exiting jumps.",
        "Price can gap or slip through a stop level; a normal stop is an order to exit, not a guaranteed fill price.",
        "The first spike can reverse when traders read revisions/details or when the result matches what was already priced in.",
        "Market, stop and some pending orders can fill far from the quoted level in a fast move; broker rules differ.",
        "Thin liquidity can exaggerate moves, trigger margin close-outs sooner than expected, and make charts look cleaner after the fact than trading felt live.",
      ],
      checklist: [
        "Know the exact release time in your timezone and which currency/instrument it hits first.",
        "Compare actual with forecast, then check revisions and the components before treating it as good or bad.",
        "Check your broker's live spread, margin close-out level, guaranteed-stop availability/cost and slippage policy.",
        "If you do not have a written plan for invalidation, position size and maximum loss, waiting is a valid decision.",
        "Do not let a bias score talk you into chasing the first candle; conditions risk and direction pressure are separate questions.",
      ],
      caveat: "This demo risk score is hand-built for teaching. In live mode PairWire calculates it from calendar proximity, fresh high-impact flow, heat, price movement and conflicting headlines — but it cannot see your broker's true spread, depth, leverage or execution quality.",
      warning: "DEMO ONLY: this is a fictional risk lesson, not a live EUR/USD warning and not financial advice.",
    },
    related: [
      {display: "USD/JPY", name: "U.S. Dollar / Japanese Yen"},
      {display: "GBP/USD", name: "British Pound / U.S. Dollar"},
      {display: "DXY", name: "U.S. Dollar Index"},
      {display: "US10Y", name: "US 10-Year Treasury Yield"},
    ],
    heat: 64, errors: [], scannedAt: new Date().toISOString(), cacheHit: false,
    demoCalendar,
  };
}
function setDemoSideFeeds(){
  $("tape").textContent = "DEMO MODE · FICTIONAL EUR/USD EXAMPLE 1.0848 ▼ -0.31% · live tape paused · exit demo for real delayed quotes · ";
  $("feedStatus").textContent = "DEMO: fictional sample data · live scan paused";
  $("feedStatus").classList.remove("bad");
  $("lastScan").textContent = "Demo scenario loaded: 6 fictional stories / 7 fictional headlines · heat 64";
  $("countdown").textContent = "Demo mode — auto-scan paused";
  $("liveDot").classList.add("off"); $("liveLabel").textContent = "DEMO — FICTIONAL";
  $("strengthBody").innerHTML = `<div class="note">DEMO MODE: live currency-strength prices are paused so real market numbers are not mixed into the fictional example. <b>Exit demo</b> to restore the live delayed board.</div>`;
  $("radarMeta").textContent = "paused in demo mode";
  $("radarBody").innerHTML = `<div class="note" style="padding:9px 10px">DEMO MODE: radar rankings are paused. Exit demo, then run SCAN RADAR for live full-engine rankings.</div>`;
}
function setDemoChart(tf){
  const specs = {"1D": [78, 300], "5D": [80, 3600], "1M": [30, 86400], "6M": [60, 259200], "1Y": [52, 604800], "5Y": [60, 2592000]};
  const spec = specs[tf] || specs["1M"], n = spec[0], step = spec[1];
  const nowS = Math.floor(Date.now() / 1000);
  const start = 1.0882, end = 1.0848, drift = (end - start) / Math.max(1, n - 1);
  const candles = [];
  let prevClose = start;
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 4.7) * 0.00055 + Math.sin(i / 11.3) * 0.00035;
    const close = +(start + drift * i + wave).toFixed(5);
    const open = +prevClose.toFixed(5);
    const high = +(Math.max(open, close) + 0.00032 + (i % 5) * 0.00003).toFixed(5);
    const low = +(Math.min(open, close) - 0.00030 - (i % 4) * 0.00003).toFixed(5);
    candles.push({t: nowS - (n - 1 - i) * step, o: open, h: high, l: low, c: close, v: 1000 + i * 17});
    prevClose = close;
  }
  if (candles.length) candles[candles.length - 1].c = end;
  state.chart = {candles, interval: "DEMO", range: tf};
  $("chartMeta").textContent = `DEMO CHART · EUR/USD · ${tf} · ${candles.length} fictional candles · last 1.0848 (invented)`;
  renderChart();
}
function loadDemo(){
  if (state.scanning) { toast("Wait for the current live scan to finish, then open demo mode"); return; }
  if (state.demoMode) { toast("Demo mode is already on — all data on this screen is fictional"); window.scrollTo({top: 0, behavior: "smooth"}); return; }
  state.preDemoSymbol = state.data ? state.data.instrument.display : (($("symbolInput").value || "").trim() || "EUR/USD");
  const data = buildDemoData();
  state.demoMode = true;
  document.body.classList.add("demo-mode");
  state.demoCalendar = data.demoCalendar;
  state.data = data;
  state.symbol = data.instrument.symbol;
  state.bucketFilter = "ALL"; state.showLimit = 30; state.chart = null;
  $("demoBanner").hidden = false;
  $("breakingBanner").hidden = true;
  $("symbolInput").value = "EUR/USD";
  renderAll();
  loadChart(state.tf || "1M");
  scheduleAuto();
  setDemoSideFeeds();
  renderCalendar(); renderRisk();
  log("DEMO MODE loaded: fictional EUR/USD headlines, price, calendar and chart. Live auto-scan/tape/strength/radar paused.", "warn");
  toast("DEMO MODE: fictional data — exit demo for live public feeds");
  window.scrollTo({top: 0, behavior: "smooth"});
}
function leaveDemoMode(){
  if (!state.demoMode) return;
  state.demoMode = false;
  document.body.classList.remove("demo-mode");
  state.demoCalendar = [];
  $("demoBanner").hidden = true;
  log("Demo mode off — returning to live public feeds.", "ok");
}
function restoreLiveSideFeeds(){
  $("liveDot").classList.remove("off"); $("liveLabel").textContent = "LIVE SCAN";
  loadTape(); loadHealth(); loadCalendar(); loadStrength();
  if (state.radarLoaded) loadRadar("restored after demo");
}
function exitDemo(){
  if (!state.demoMode) return;
  const sym = state.preDemoSymbol || "EUR/USD";
  $("symbolInput").value = sym;
  scan(sym, false);
  toast("Back to LIVE public feeds");
}

/* ───────────────── boot */
(async function boot(){
  tickClock();
  applySettings();
  renderRecent();
  renderSaved();
  loadTape();
  loadCalendar();
  loadStrength();
  try { await loadSymbols(); } catch(e){ log("Symbol list failed: " + e.message, "err"); }
  log("PAIRWIRE v2 ready — chart, calendar, radar, alerts online. First scan…");
  scan($("symbolInput").value);
})();
