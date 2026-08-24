// Historical daily forex rates via frankfurter.dev — free, no API key,
// unlimited, backed by ECB reference rates. Verified live before wiring
// this in (no equivalent free historical option exists for the live-quote
// path in coingecko.js, which only derives a current rate via a stablecoin
// trick). Frankfurter gives one rate per day, not real OHLC, so each candle
// here is open=high=low=close at that day's rate and volume=0 — EMA/RSI/
// MACD and the Predictions page (all close-price-driven) work fine on
// this; anything relying on a real high/low range will look flat.
const history = require("./history");
const { aggregateMonthly, aggregateFromMonthly, LONG_AGGREGATE_INTERVALS } = require("./candle-aggregate");

const BASE_URL = "https://api.frankfurter.dev/v1";
const ALL_INTERVALS = ["1d", ...Object.keys(LONG_AGGREGATE_INTERVALS)];

// Curated pairs, matching stocks.html's existing forex currency defaults
// made explicit as base/quote pairs (standard market convention — e.g.
// EURUSD's rate is USD per 1 EUR).
const PAIRS = {
  EURUSD: { base: "EUR", quote: "USD" },
  GBPUSD: { base: "GBP", quote: "USD" },
  USDJPY: { base: "USD", quote: "JPY" },
  USDZAR: { base: "USD", quote: "ZAR" },
  AUDUSD: { base: "AUD", quote: "USD" },
  USDCAD: { base: "USD", quote: "CAD" },
  USDCHF: { base: "USD", quote: "CHF" },
  NZDUSD: { base: "NZD", quote: "USD" },
};
const SYMBOLS = Object.keys(PAIRS);

function productKeyFor(pair) {
  return `FX-${pair}`;
}

function assertKnownPair(pair) {
  if (!PAIRS[pair.toUpperCase()]) {
    const err = new Error(`Unknown forex pair "${pair}". Supported: ${SYMBOLS.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchRange(pair, startDate, endDate) {
  const { base, quote } = PAIRS[pair];
  const res = await fetch(`${BASE_URL}/${toDateStr(startDate)}..${toDateStr(endDate)}?base=${base}&symbols=${quote}`);
  const body = await res.json();
  if (!res.ok || body.error) {
    const err = new Error(body.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return Object.entries(body.rates || {})
    .map(([dateStr, rates]) => {
      const rate = rates[quote];
      if (rate == null) return null;
      const time = Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / 1000);
      return { time, open: rate, high: rate, low: rate, close: rate, volume: 0 };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}

// interval "1d" (default) returns raw daily rate candles; "1M".."2Y"
// aggregate into calendar-month spans, same as yahoo.js/coinbase.js, so a
// multi-year view shows a readable handful of candles.
async function getCandles(pair, { interval = "1d", limit = 300 } = {}) {
  assertKnownPair(pair);
  const p = pair.toUpperCase();
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400 * 1000);
  const [stored, live] = await Promise.all([
    history.loadStoredDaily(productKeyFor(p)),
    fetchRange(p, start, end).catch(() => []),
  ]);
  const daily = history.mergeDedupe(stored, live);

  const longAgg = LONG_AGGREGATE_INTERVALS[interval];
  if (longAgg) {
    const monthly = aggregateMonthly(daily);
    return aggregateFromMonthly(monthly, longAgg.groupMonths).slice(-limit);
  }
  if (interval !== "1d") {
    const err = new Error(`Unsupported interval "${interval}" for forex. Allowed: ${ALL_INTERVALS.join(", ")}`);
    err.status = 400;
    throw err;
  }
  return daily.slice(-limit);
}

// Cheap top-up (1 request/pair, ~30 days) so the archive keeps growing.
async function recordRecentHistory() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86400 * 1000);
  for (const pair of SYMBOLS) {
    try {
      const recent = await fetchRange(pair, start, end);
      const stored = await history.loadStoredDaily(productKeyFor(pair));
      await history.saveStoredDaily(productKeyFor(pair), history.mergeDedupe(stored, recent));
    } catch (err) {
      console.error(`forex recordRecentHistory: ${pair} failed — ${err.message}`);
    }
  }
}

// One-time deep backfill — Frankfurter has no pagination limit worth
// worrying about at this depth, so a single ~5-year range request suffices.
const BACKFILL_MIN_DAYS = 200;
const BACKFILL_YEARS = 5;

async function backfillHistoryIfNeeded() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - BACKFILL_YEARS);
  for (const pair of SYMBOLS) {
    try {
      const stored = await history.loadStoredDaily(productKeyFor(pair));
      if (stored.length >= BACKFILL_MIN_DAYS) continue;
      const deep = await fetchRange(pair, start, end);
      const merged = history.mergeDedupe(stored, deep);
      await history.saveStoredDaily(productKeyFor(pair), merged);
      console.log(`forex backfillHistoryIfNeeded: ${pair} now has ${merged.length} days stored`);
    } catch (err) {
      console.error(`forex backfillHistoryIfNeeded: ${pair} failed — ${err.message}`);
    }
  }
}

async function getHistoryInfo(pair) {
  assertKnownPair(pair);
  const stored = await history.loadStoredDaily(productKeyFor(pair.toUpperCase()));
  return { storedDays: stored.length, earliestTime: stored.length ? stored[0].time : null };
}

module.exports = { getCandles, SYMBOLS, PAIRS, ALL_INTERVALS, recordRecentHistory, backfillHistoryIfNeeded, getHistoryInfo };
