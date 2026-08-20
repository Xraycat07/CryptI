const history = require("./history");

const BASE_URL = "https://api.exchange.coinbase.com";

// Maps our CoinGecko-style coin ids to Coinbase Exchange product ids.
const SYMBOL_MAP = {
  bitcoin: "BTC-USD",
  ethereum: "ETH-USD",
  ripple: "XRP-USD",
  litecoin: "LTC-USD",
  dogecoin: "DOGE-USD",
  solana: "SOL-USD",
  cardano: "ADA-USD",
  polkadot: "DOT-USD",
  chainlink: "LINK-USD",
  "avalanche-2": "AVAX-USD",
  "polygon-ecosystem-token": "POL-USD",
  uniswap: "UNI-USD",
};

// Coinbase's public candles endpoint only supports these granularities (seconds).
const GRANULARITY_SECONDS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "1d": 86400,
};

const MAX_CANDLES_PER_REQUEST = 300; // Coinbase API limit

async function fetchRawCandles(product, granularity, count) {
  const res = await fetch(
    `${BASE_URL}/products/${product}/candles?granularity=${granularity}`,
    { headers: { "User-Agent": "crypto-api" } }
  );
  const body = await res.json();
  if (!res.ok || body.message) {
    const err = new Error(body.message || res.statusText);
    err.status = res.status;
    throw err;
  }

  // Coinbase returns newest-first: [time, low, high, open, close, volume]
  return body
    .slice(0, count)
    .map(([time, low, high, open, close, volume]) => ({
      time,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }))
    .reverse(); // chronological ascending, as charts expect
}

// Groups a chronological candle series into fixed-size counts (e.g. 4 hourly
// candles -> 4h, 7 daily -> 1w), counting back from the most recent candle
// so only a leftover *oldest* partial group gets dropped.
function aggregateByCount(candlesAsc, groupSize) {
  const groups = [];
  for (let i = candlesAsc.length; i > 0; i -= groupSize) {
    const start = Math.max(0, i - groupSize);
    const chunk = candlesAsc.slice(start, i);
    if (chunk.length < groupSize) continue;
    groups.push({
      time: chunk[0].time,
      open: chunk[0].open,
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      volume: chunk.reduce((sum, c) => sum + c.volume, 0),
    });
  }
  return groups.reverse();
}

function aggregateMonthly(dailyCandlesAsc) {
  const groups = [];
  let currentKey = null;
  let chunk = [];
  for (const c of dailyCandlesAsc) {
    const d = new Date(c.time * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (key !== currentKey) {
      if (chunk.length) groups.push(chunk);
      chunk = [];
      currentKey = key;
    }
    chunk.push(c);
  }
  if (chunk.length) groups.push(chunk);

  // drop a trailing in-progress (current calendar month) group
  const last = groups[groups.length - 1];
  if (last) {
    const lastDate = new Date(last[last.length - 1].time * 1000);
    const now = new Date();
    if (lastDate.getUTCFullYear() === now.getUTCFullYear() && lastDate.getUTCMonth() === now.getUTCMonth()) {
      groups.pop();
    }
  }

  return groups.map((c) => ({
    time: c[0].time,
    open: c[0].open,
    close: c[c.length - 1].close,
    high: Math.max(...c.map((x) => x.high)),
    low: Math.min(...c.map((x) => x.low)),
    volume: c.reduce((sum, x) => sum + x.volume, 0),
  }));
}

// Groups consecutive monthly candles into fixed-size spans (e.g. 3 for
// quarterly, 12 for yearly). Not calendar-quarter-aligned — just N months
// at a time, dropping a leftover partial span at the (most recent) end.
function aggregateFromMonthly(monthlyCandlesAsc, groupSize) {
  const out = [];
  for (let i = 0; i < monthlyCandlesAsc.length; i += groupSize) {
    const chunk = monthlyCandlesAsc.slice(i, i + groupSize);
    if (chunk.length < groupSize) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map((x) => x.high)),
      low: Math.min(...chunk.map((x) => x.low)),
      volume: chunk.reduce((sum, x) => sum + x.volume, 0),
    });
  }
  return out;
}

async function fetchDailyCandlesRange(product, startISO, endISO) {
  const res = await fetch(
    `${BASE_URL}/products/${product}/candles?granularity=${GRANULARITY_SECONDS["1d"]}&start=${startISO}&end=${endISO}`,
    { headers: { "User-Agent": "crypto-api" } }
  );
  const body = await res.json();
  if (!res.ok || body.message) {
    const err = new Error(body.message || res.statusText);
    err.status = res.status;
    throw err;
  }
  return body
    .map(([time, low, high, open, close, volume]) => ({
      time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume),
    }))
    .reverse();
}

const DAY_SECONDS = 86400;
// Only used by the one-time backfill below (not per-request), so this can
// be generous: 12 x 300 days ≈ 9.9 years — comfortably covers Coinbase's
// full listing history for the older majors.
const MAX_HISTORY_PAGES = 12;

// Coinbase's candles endpoint caps a single request at 300 points, so
// multi-year history (needed for quarterly/yearly candles) is built by
// paging backward with the start/end range params, stopping early once we
// run out of listed history for that product.
async function fetchDailyCandlesPaginated(product, totalDays) {
  const all = [];
  let end = new Date();
  let remaining = totalDays;
  for (let page = 0; page < MAX_HISTORY_PAGES && remaining > 0; page++) {
    const chunkDays = Math.min(MAX_CANDLES_PER_REQUEST, remaining);
    const start = new Date(end.getTime() - chunkDays * DAY_SECONDS * 1000);
    let chunk;
    try {
      chunk = await fetchDailyCandlesRange(product, start.toISOString(), end.toISOString());
    } catch {
      break; // likely before the product's listing date — stop paginating
    }
    if (!chunk.length) break;
    all.unshift(...chunk);
    end = new Date((chunk[0].time - DAY_SECONDS) * 1000);
    remaining -= chunkDays;
  }
  const merged = new Map();
  for (const c of all) merged.set(c.time, c);
  return [...merged.values()].sort((a, b) => a.time - b.time);
}

// Short-window aggregates: one cheap fetch (<=300 candles) at a base
// granularity, grouped into fixed-size spans. Always available for any
// actively-trading product — doesn't depend on the local archive.
const SHORT_AGGREGATE_INTERVALS = {
  "4h": { base: "1h", groupSize: 4 },
  "12h": { base: "6h", groupSize: 2 },
  "3d": { base: "1d", groupSize: 3 },
  "1w": { base: "1d", groupSize: 7 },
  "2w": { base: "1d", groupSize: 14 },
};

// Calendar-month-based aggregates, built from the merged local archive +
// live daily candles — depth varies per coin depending on archive history.
const LONG_AGGREGATE_INTERVALS = {
  "1M": { groupMonths: 1 },
  "3M": { groupMonths: 3 },
  "6M": { groupMonths: 6 },
  "1Y": { groupMonths: 12 },
  "2Y": { groupMonths: 24 },
};

// Every interval this app understands, ordered smallest to largest —
// exposed via /api/intervals so the frontend doesn't have to hardcode it.
const ALL_INTERVALS = [
  ...Object.keys(GRANULARITY_SECONDS),
  ...Object.keys(SHORT_AGGREGATE_INTERVALS),
  ...Object.keys(LONG_AGGREGATE_INTERVALS),
].filter((v, i, arr) => arr.indexOf(v) === i); // "1d" appears in both native + short-agg base

async function getCandles(coin, { interval = "1d", limit = 300 } = {}) {
  const product = SYMBOL_MAP[coin.toLowerCase()];
  if (!product) {
    const err = new Error(`Unknown coin "${coin}". Supported: ${Object.keys(SYMBOL_MAP).join(", ")}`);
    err.status = 400;
    throw err;
  }

  const shortAgg = SHORT_AGGREGATE_INTERVALS[interval];
  if (shortAgg) {
    const base = await fetchRawCandles(product, GRANULARITY_SECONDS[shortAgg.base], MAX_CANDLES_PER_REQUEST);
    return aggregateByCount(base, shortAgg.groupSize).slice(-limit);
  }

  const longAgg = LONG_AGGREGATE_INTERVALS[interval];
  if (longAgg) {
    // Depth comes from the local archive (backfilled once, then grown daily
    // — see backfillHistoryIfNeeded/recordRecentHistory), so the live call
    // here only needs a single cheap page to cover whatever's happened
    // since the archive's last write.
    const [stored, live] = await Promise.all([
      history.loadStoredDaily(product),
      fetchRawCandles(product, GRANULARITY_SECONDS["1d"], MAX_CANDLES_PER_REQUEST),
    ]);
    const daily = history.mergeDedupe(stored, live);
    const monthly = aggregateMonthly(daily);
    return aggregateFromMonthly(monthly, longAgg.groupMonths).slice(-limit);
  }

  const granularity = GRANULARITY_SECONDS[interval];
  if (!granularity) {
    const err = new Error(`Unsupported interval "${interval}". Allowed: ${ALL_INTERVALS.join(", ")}`);
    err.status = 400;
    throw err;
  }

  return fetchRawCandles(product, granularity, Math.min(MAX_CANDLES_PER_REQUEST, limit));
}

// Pulls a small recent window (cheap: 1 request/product) and merges any new
// days into the local archive. Call this periodically (see server.js) so
// history keeps accumulating day over day instead of only ever reflecting
// however far Coinbase happens to paginate on demand.
async function recordRecentHistory() {
  for (const product of Object.values(SYMBOL_MAP)) {
    try {
      const recent = await fetchRawCandles(product, GRANULARITY_SECONDS["1d"], 5);
      const stored = await history.loadStoredDaily(product);
      await history.saveStoredDaily(product, history.mergeDedupe(stored, recent));
    } catch (err) {
      console.error(`recordRecentHistory: ${product} failed — ${err.message}`);
    }
  }
}

// One-time deep backfill so the local archive starts with real depth
// instead of slowly accumulating five days at a time. Safe to call on every
// startup — skips any product that already has substantial history stored.
const BACKFILL_MIN_DAYS = 200;

async function backfillHistoryIfNeeded() {
  for (const product of Object.values(SYMBOL_MAP)) {
    try {
      const stored = await history.loadStoredDaily(product);
      if (stored.length >= BACKFILL_MIN_DAYS) continue;
      const deep = await fetchDailyCandlesPaginated(product, MAX_HISTORY_PAGES * MAX_CANDLES_PER_REQUEST);
      const merged = history.mergeDedupe(stored, deep);
      await history.saveStoredDaily(product, merged);
      console.log(`backfillHistoryIfNeeded: ${product} now has ${merged.length} days stored`);
    } catch (err) {
      console.error(`backfillHistoryIfNeeded: ${product} failed — ${err.message}`);
    }
  }
}

// Reports how much daily history is actually available for a coin, so the
// frontend can dynamically enable/disable long intervals (6M/1Y/2Y) per
// coin instead of offering an option that would return almost nothing.
async function getHistoryInfo(coin) {
  const product = SYMBOL_MAP[coin.toLowerCase()];
  if (!product) {
    const err = new Error(`Unknown coin "${coin}". Supported: ${Object.keys(SYMBOL_MAP).join(", ")}`);
    err.status = 400;
    throw err;
  }
  const stored = await history.loadStoredDaily(product);
  return {
    storedDays: stored.length,
    earliestTime: stored.length ? stored[0].time : null,
  };
}

module.exports = {
  getCandles, SYMBOL_MAP, recordRecentHistory, backfillHistoryIfNeeded,
  getHistoryInfo, ALL_INTERVALS,
};
