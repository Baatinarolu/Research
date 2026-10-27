// Node tests for the DOM-free cloud merge logic in public/static/sync.js
// Run: node --test tests/sync.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PW = require("../public/static/sync.js");

test("uuidv4 produces a valid v4 UUID", () => {
  const id = PW.uuidv4();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(PW.uuidv4(), id);
});

test("mergeWatchlist unions cloud-first, dedupes and caps", () => {
  const local = ["XAUUSD", "EUR/USD", "BTCUSD"];
  const cloud = ["EUR/USD", "GBP/JPY"];
  const merged = PW.mergeWatchlist(local, cloud);
  assert.deepEqual(merged, ["EUR/USD", "GBP/JPY", "XAUUSD", "BTCUSD"]);
  assert.ok(merged.length <= PW.CAPS.watchlist);
  const big = PW.mergeWatchlist(Array.from({ length: 300 }, (_, i) => "S" + i), []);
  assert.equal(big.length, PW.CAPS.watchlist);
});

test("mergeSaved normalises cloud rows and keeps local-only entries", () => {
  const local = { localk: { title: "Local", link: "http://x", source: "CNBC", ts: 5, symbol: "EUR/USD" } };
  const cloud = [
    { key: "cloudk", title: "Cloud", link: "http://y", source: "Reuters", ts: 9, symbol: "GBP/JPY" },
    { key: "bad" }, // missing nothing required by merge, but defaults applied
  ];
  const out = PW.mergeSaved(local, cloud);
  assert.equal(out.cloudk.title, "Cloud");
  assert.equal(out.localk.source, "CNBC");
  assert.equal(out.bad.title, "");
});

test("mergeRecent takes newest timestamp, sorts, caps at 20", () => {
  const localSymbols = ["A", "B"];
  const localTs = { A: 100, B: 50 };
  const cloud = [{ symbol: "B", ts: 200 }, { symbol: "C", ts: 150 }];
  const out = PW.mergeRecent(localSymbols, localTs, cloud);
  assert.deepEqual(out.symbols, ["B", "C", "A"]);
  assert.equal(out.ts.B, 200);
  assert.equal(out.ts.A, 100);
  const many = PW.mergeRecent(Array.from({ length: 40 }, (_, i) => "X" + i), {}, []);
  assert.equal(many.symbols.length, 20);
});

test("mergeSettings: cloud wins shared keys, local keys retained", () => {
  const out = PW.mergeSettings(
    { pw_theme: "wire", pw_tf: "1M" },
    { pw_theme: "terminal", pw_sound: true }
  );
  assert.deepEqual(out, { pw_theme: "terminal", pw_tf: "1M", pw_sound: true });
});

test("merge helpers tolerate empty/garbage input", () => {
  assert.deepEqual(PW.mergeWatchlist(null, undefined), []);
  assert.deepEqual(PW.mergeSaved(null, null), {});
  const r = PW.mergeRecent(null, null, null);
  assert.deepEqual(r.symbols, []);
});
