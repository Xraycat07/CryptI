// Historical daily stock candles via Yahoo Finance's public (unofficial,
// no-key) chart endpoint. Finnhub — this app's existing stock data source
// for live quotes (see finnhub.js) — restricts historical candles to paid
// plans (confirmed against this project's real key: /stock/candle returns
// "You don't have access to this resource."), and Stooq's free CSV export
// now sits behind a JS bot-check that isn't fetchable server-side. Yahoo's
// chart endpoint is undocumented and could change or throttle without
// notice, but it's free and returns real OHLCV with Unix-second timestamps
// — the same convention coinbase.js already uses, so it drops into the
// existing chart/strategy code with no unit conversion.
const history = require("./history");
const { aggregateMonthly, aggregateFromMonthly, LONG_AGGREGATE_INTERVALS } = require("./candle-aggregate");

const BASE_URL = "https://query1.finance.yahoo.com";
const ALL_INTERVALS = ["1d", ...Object.keys(LONG_AGGREGATE_INTERVALS)];

// Curated default list — the same starting tickers stocks.html already
// offers as quote chips. Not a searchable universe; add more here as needed.
const SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "NVDA", "META", "SPY", "QQQ"];

function productKeyFor(symbol) {
  return `STOCK-${symbol}`;
}

function isKnownSymbol(symbol) {
  return SYMBOLS.includes(symbol.toUpperCase());
}

async function fetchRange(symbol, range) {
  const res = await fetch(
    `${BASE_URL}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`,
    { headers: { "User-Agent": "Mozilla/5.0 (crypto-api)" } }
  );
  const body = await res.json();
  const err = body.chart?.error;
  if (!res.ok || err) {
    const e = new Error(err?.description || res.statusText);
    e.status = res.status === 200 ? 502 : res.status;
    throw e;
  }
  const result = body.chart.result?.[0];
  if (!result) return [];
  const { timestamp = [], indicators } = result;
  const q = indicators?.quote?.[0] || {};
  const candles = [];
  for (let i = 0; i < timestamp.length; i++) {
    const { open, high, low, close, volume } = q;
    if (open?.[i] == null || high?.[i] == null || low?.[i] == null || close?.[i] == null) continue;
    candles.push({
      time: timestamp[i],
      open: Number(open[i]),
      high: Number(high[i]),
      low: Number(low[i]),
      close: Number(close[i]),
      volume: Number(volume?.[i] || 0),
    });
  }
  return candles; // Yahoo already returns chronological ascending
}

function assertKnownSymbol(symbol) {
  if (!isKnownSymbol(symbol)) {
    const err = new Error(`Unknown stock symbol "${symbol}". Supported: ${SYMBOLS.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

// Local archive (backfilled once, then grown daily — see below) merged with
// a small live top-up. interval "1d" (default) returns raw daily candles;
// "1M"/"3M"/"6M"/"1Y"/"2Y" aggregate the daily archive into calendar-month
// spans — same long-aggregate behavior as coinbase.js — so a multi-year
// view shows a readable handful of candles instead of hundreds of daily
// bars. No intraday intervals (this is a daily-only source).
async function getCandles(symbol, { interval = "1d", limit = 300 } = {}) {
  assertKnownSymbol(symbol);
  const sym = symbol.toUpperCase();
  const [stored, live] = await Promise.all([
    history.loadStoredDaily(productKeyFor(sym)),
    fetchRange(sym, "1mo").catch(() => []),
  ]);
  const daily = history.mergeDedupe(stored, live);

  const longAgg = LONG_AGGREGATE_INTERVALS[interval];
  if (longAgg) {
    const monthly = aggregateMonthly(daily);
    return aggregateFromMonthly(monthly, longAgg.groupMonths).slice(-limit);
  }
  if (interval !== "1d") {
    const err = new Error(`Unsupported interval "${interval}" for stocks. Allowed: ${ALL_INTERVALS.join(", ")}`);
    err.status = 400;
    throw err;
  }
  return daily.slice(-limit);
}

// Cheap top-up (1 request/symbol) so the archive keeps growing day over day.
async function recordRecentHistory() {
  for (const symbol of SYMBOLS) {
    try {
      const recent = await fetchRange(symbol, "1mo");
      const stored = await history.loadStoredDaily(productKeyFor(symbol));
      await history.saveStoredDaily(productKeyFor(symbol), history.mergeDedupe(stored, recent));
    } catch (err) {
      console.error(`yahoo recordRecentHistory: ${symbol} failed — ${err.message}`);
    }
  }
}

// One-time deep backfill — Yahoo returns up to 5 years in a single request
// (no pagination needed, unlike Coinbase's 300-candle-per-request cap).
// Safe to call on every startup — skips any symbol with substantial history.
const BACKFILL_MIN_DAYS = 200;

async function backfillHistoryIfNeeded() {
  for (const symbol of SYMBOLS) {
    try {
      const stored = await history.loadStoredDaily(productKeyFor(symbol));
      if (stored.length >= BACKFILL_MIN_DAYS) continue;
      const deep = await fetchRange(symbol, "5y");
      const merged = history.mergeDedupe(stored, deep);
      await history.saveStoredDaily(productKeyFor(symbol), merged);
      console.log(`yahoo backfillHistoryIfNeeded: ${symbol} now has ${merged.length} days stored`);
    } catch (err) {
      console.error(`yahoo backfillHistoryIfNeeded: ${symbol} failed — ${err.message}`);
    }
  }
}

async function getHistoryInfo(symbol) {
  assertKnownSymbol(symbol);
  const stored = await history.loadStoredDaily(productKeyFor(symbol.toUpperCase()));
  return { storedDays: stored.length, earliestTime: stored.length ? stored[0].time : null };
}

module.exports = { getCandles, SYMBOLS, ALL_INTERVALS, recordRecentHistory, backfillHistoryIfNeeded, getHistoryInfo };
