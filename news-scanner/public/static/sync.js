/* PAIRWIRE cloud sync — pure merge logic, no DOM references.
   Loaded before app.js in the browser; also require()-able by the Node tests.
   Strategy: union merges keyed by stable IDs, cloud timestamps win for recents,
   cloud settings win per key, everything is capped to the server's limits. */
(function (global) {
  "use strict";

  const CAPS = { watchlist: 200, saved: 500, recent: 20 };

  function uuidv4() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    // Fallback for non-secure contexts (e.g. plain-http LAN access).
    const b = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function uniqPreserve(arr) {
    const seen = new Set();
    const out = [];
    for (const x of arr) {
      if (!x || seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
    return out;
  }

  // Cloud order first (it already reflects the oldest pinning order), then
  // local-only symbols appended.
  function mergeWatchlist(local, cloud) {
    return uniqPreserve([...(cloud || []), ...(local || [])]).slice(0, CAPS.watchlist);
  }

  // Keyed union. Cloud rows are normalised; local-only rows are kept as-is.
  function mergeSaved(localObj, cloudRows) {
    const out = {};
    for (const r of cloudRows || []) {
      if (!r || !r.key) continue;
      out[r.key] = {
        title: r.title || "", link: r.link || "", source: r.source || "",
        ts: r.ts || 0, symbol: r.symbol || "",
      };
    }
    for (const [k, v] of Object.entries(localObj || {})) {
      if (!out[k]) out[k] = v;
    }
    return out;
  }

  // Newest scan timestamp per symbol wins, then sort and cap.
  function mergeRecent(localSymbols, localTs, cloudRows) {
    const ts = {};
    for (const r of cloudRows || []) {
      if (r && r.symbol) ts[r.symbol] = Math.max(ts[r.symbol] || 0, r.ts || 0);
    }
    for (const s of localSymbols || []) {
      ts[s] = Math.max(ts[s] || 0, (localTs || {})[s] || 0);
    }
    const symbols = Object.keys(ts).sort((a, b) => ts[b] - ts[a]).slice(0, CAPS.recent);
    return { symbols, ts };
  }

  // Per-key last-write-wins: cloud overrides shared keys, local-only keys kept.
  function mergeSettings(local, cloud) {
    return Object.assign({}, local || {}, cloud || {});
  }

  const PW = { uuidv4, uniqPreserve, mergeWatchlist, mergeSaved,
               mergeRecent, mergeSettings, CAPS };

  if (typeof module !== "undefined" && module.exports) module.exports = PW;
  global.PW = PW;
})(typeof window !== "undefined" ? window : globalThis);
