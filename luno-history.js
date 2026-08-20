// Local on-disk archive of Luno's daily ZAR candles for held coins, so
// history accumulates day over day instead of being capped at whatever a
// single live request returns. Reuses history.js's generic on-disk JSON
// store — the same pattern coinbase.js already uses for its own coins —
// keyed by a "LUNO-<PAIR>" product id so the two archives never collide.
const history = require("./history");
const { getBalances, getTickers, getCandleHistory } = require("./luno");

const DAY_MS = 86400 * 1000;
// Confirmed empirically: Luno's candle endpoint returns at most ~1000
// candles per request, oldest-first from `since` — the opposite direction
// from Coinbase, which returns newest-first. So deep backfill here pages
// *forward* from a pair's earliest available candle, not backward from now.
const MAX_CANDLES_PER_REQUEST = 1000;
const MAX_BACKFILL_PAGES = 10; // 10k days ≈ 27 years — comfortably covers any pair
const BACKFILL_MIN_DAYS = 200;
// Well before Luno (or any of its listed pairs) existed — pagination just
// stops naturally once a page returns fewer than the request cap.
const EARLIEST_POSSIBLE = Date.parse("2013-01-01T00:00:00.000Z");

function productKeyFor(pair) {
  return `LUNO-${pair}`;
}

// Which ZAR pairs are worth archiving: whatever you currently hold that
// Luno actually prices in ZAR. Re-derived each call since holdings change,
// rather than a fixed list.
async function getTrackedPairs() {
  const [balances, tickers] = await Promise.all([getBalances(), getTickers()]);
  const zarPairs = new Set(
    tickers.filter((t) => t.pair.endsWith("ZAR") && t.pair !== "ZAR").map((t) => t.pair)
  );
  const heldAssets = new Set();
  for (const b of balances) {
    if (Number(b.balance) + Number(b.reserved) > 0) heldAssets.add(b.asset);
  }
  return [...heldAssets].map((asset) => `${asset}ZAR`).filter((pair) => zarPairs.has(pair));
}

async function fetchDeepHistory(pair) {
  const all = [];
  let sinceMs = EARLIEST_POSSIBLE;
  for (let page = 0; page < MAX_BACKFILL_PAGES && sinceMs < Date.now(); page++) {
    const chunk = await getCandleHistory(pair, { since: sinceMs });
    if (!chunk.length) break;
    all.push(...chunk);
    const lastTime = chunk[chunk.length - 1].time;
    if (lastTime <= sinceMs) break; // no progress — avoid looping forever
    sinceMs = lastTime + DAY_MS;
    if (chunk.length < MAX_CANDLES_PER_REQUEST) break; // short page means we've reached "now"
  }
  return history.mergeDedupe(all);
}

// Pulls a small recent window (cheap: 1 request/pair) and merges any new
// days into the local archive. Call this periodically (see server.js) so
// the archive keeps growing instead of only ever reflecting a live fetch.
async function recordRecentHistory() {
  const pairs = await getTrackedPairs();
  for (const pair of pairs) {
    const key = productKeyFor(pair);
    try {
      const recent = await getCandleHistory(pair, { days: 5 });
      const stored = await history.loadStoredDaily(key);
      await history.saveStoredDaily(key, history.mergeDedupe(stored, recent));
    } catch (err) {
      console.error(`luno-history: recordRecentHistory ${pair} failed — ${err.message}`);
    }
  }
}

// One-time deep backfill so the archive starts with real depth instead of
// slowly accumulating five days at a time. Safe to call on every startup —
// skips any pair that already has substantial history stored.
async function backfillHistoryIfNeeded() {
  const pairs = await getTrackedPairs();
  for (const pair of pairs) {
    const key = productKeyFor(pair);
    try {
      const stored = await history.loadStoredDaily(key);
      if (stored.length >= BACKFILL_MIN_DAYS) continue;
      const deep = await fetchDeepHistory(pair);
      const merged = history.mergeDedupe(stored, deep);
      await history.saveStoredDaily(key, merged);
      console.log(`luno-history: ${pair} now has ${merged.length} days stored`);
    } catch (err) {
      console.error(`luno-history: backfill ${pair} failed — ${err.message}`);
    }
  }
}

// Serves from the local archive merged with a small live top-up, so a
// request doesn't depend entirely on Luno's live endpoint every time. Falls
// back to a pure live fetch for any pair not (yet) tracked in the archive.
async function getMergedHistory(pair, { days = 30 } = {}) {
  const key = productKeyFor(pair);
  const [stored, live] = await Promise.all([
    history.loadStoredDaily(key),
    getCandleHistory(pair, { days: Math.min(days, 5) }),
  ]);
  const merged = history.mergeDedupe(stored, live);
  if (!merged.length) return getCandleHistory(pair, { days });
  const cutoff = Date.now() - days * DAY_MS;
  return merged.filter((c) => c.time >= cutoff);
}

module.exports = {
  getTrackedPairs, recordRecentHistory, backfillHistoryIfNeeded, getMergedHistory,
};
