// Server-side "bot" that watches your held, ZAR-priced coins for a fresh
// buy/sell signal — the same indicator engine as the Trading signal panel
// (EMA cross, RSI, MACD, S/R zones, trendlines) — and queues a proposal for
// you to approve or reject. It never places an order itself; "accepting" a
// proposal only pre-fills the existing order form, which still requires the
// normal Review -> Confirm flow before any real trade happens.
//
// Runs independently of the browser (checked on a server-side interval), so
// proposals accumulate even if no one has the dashboard open, and persist
// across restarts in a local JSON file (data/luno-bot/), the same pattern
// history.js uses for candle archives.
const fs = require("fs/promises");
const path = require("path");
const Strategy = require("./public/strategy.js");
const { getBalances, getTickers, getCandleHistory } = require("./luno");

const DATA_DIR = path.join(__dirname, "data", "luno-bot");
const PROPOSALS_FILE = path.join(DATA_DIR, "proposals.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");

const SIGNAL_DAYS = 90;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// Same account_type-agnostic total-quantity grouping the dashboard uses,
// filtered to assets that both have a balance and a Luno ZAR ticker.
async function getHeldPricedAssets() {
  const [balances, tickers] = await Promise.all([getBalances(), getTickers()]);
  const priceByAsset = {};
  for (const t of tickers) {
    if (t.pair.endsWith("ZAR") && t.pair !== "ZAR") priceByAsset[t.pair.slice(0, -3)] = Number(t.last_trade);
  }
  const qtyByAsset = {};
  for (const b of balances) {
    qtyByAsset[b.asset] = (qtyByAsset[b.asset] || 0) + Number(b.balance) + Number(b.reserved);
  }
  return Object.keys(qtyByAsset).filter((asset) => qtyByAsset[asset] > 0 && priceByAsset[asset] != null);
}

// Uses the shared DEFAULT_CONFIG rather than any per-browser tuned config
// from the Indicators page — localStorage doesn't exist server-side, so
// there's no per-user config to read here.
async function checkOnce() {
  const assets = await getHeldPricedAssets();
  const proposals = await loadJson(PROPOSALS_FILE, []);
  const seenKeys = new Set(proposals.map((p) => `${p.asset}:${p.signalTime}`));
  const config = Strategy.DEFAULT_CONFIG;
  const added = [];

  for (const asset of assets) {
    try {
      const candles = await getCandleHistory(`${asset}ZAR`, { days: SIGNAL_DAYS });
      if (candles.length < 55) continue;

      const result = Strategy.runStrategy(candles, config);
      const lastSignal = result.signals[result.signals.length - 1];
      if (!lastSignal) continue;

      const barsAgo = (candles.length - 1) - lastSignal.index;
      const isFresh = barsAgo <= (config.cooldownBars ?? 5);
      if (!isFresh) continue;

      const key = `${asset}:${lastSignal.time}`;
      if (seenKeys.has(key)) continue; // already queued or already resolved

      added.push({
        id: `${asset}-${lastSignal.time}`,
        asset,
        pair: `${asset}ZAR`,
        side: lastSignal.side,
        signalTime: lastSignal.time,
        price: lastSignal.price,
        stopLoss: lastSignal.stopLoss,
        takeProfit: lastSignal.takeProfit,
        score: lastSignal.score,
        createdAt: Date.now(),
        status: "pending",
      });
    } catch (err) {
      console.error(`luno-bot: failed to check ${asset}:`, err.message);
    }
  }

  if (added.length) {
    await saveJson(PROPOSALS_FILE, [...proposals, ...added]);
    console.log(`luno-bot: queued ${added.length} new proposal(s)`);
  }
  await saveJson(STATE_FILE, { lastCheckedAt: Date.now() });
  return added;
}

async function getProposals() {
  return loadJson(PROPOSALS_FILE, []);
}

async function getState() {
  return loadJson(STATE_FILE, { lastCheckedAt: null });
}

async function setProposalStatus(id, status) {
  const proposals = await loadJson(PROPOSALS_FILE, []);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) {
    const err = new Error("Proposal not found");
    err.status = 404;
    throw err;
  }
  proposal.status = status;
  proposal.resolvedAt = Date.now();
  await saveJson(PROPOSALS_FILE, proposals);
  return proposal;
}

function startBotLoop() {
  checkOnce().catch((err) => console.error("luno-bot: initial check failed:", err.message));
  setInterval(() => {
    checkOnce().catch((err) => console.error("luno-bot: check failed:", err.message));
  }, CHECK_INTERVAL_MS);
}

module.exports = { startBotLoop, checkOnce, getProposals, getState, setProposalStatus };
