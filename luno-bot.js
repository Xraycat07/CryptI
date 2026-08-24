// Server-side "bot" that watches each account's held, ZAR-priced coins for
// a fresh buy/sell signal — the same indicator engine as the Trading
// signal panel (EMA cross, RSI, MACD, S/R zones, trendlines) — and queues
// a proposal for that account's owner to approve or reject. It never
// places an order itself; "accepting" a proposal jumps straight to the
// order form's Confirm step (as a limit order at the signal price, sized
// from BUY_ZAR / the full held balance), but placing the real order still
// requires that explicit Confirm click.
//
// Runs independently of the browser (checked on a server-side interval),
// once per account: "admin" (the server's own env-var Luno credentials,
// used by password login) plus every registered user who has saved their
// own Luno keys (see users.js, wired up via Google sign-in). Each
// account's proposals/state persist separately under data/luno-bot/<id>/,
// the same on-disk JSON pattern history.js uses for candle archives.
const fs = require("fs/promises");
const path = require("path");
const Strategy = require("./public/strategy.js");
const { getBalances, getTickers, getCandleHistory } = require("./luno");
const { getUsers, getUserCredentials } = require("./users");

const DATA_DIR = path.join(__dirname, "data", "luno-bot");
const ADMIN_ID = "admin";

const SIGNAL_DAYS = 90;
// Signals are still based on daily candles, but the current day's candle
// keeps updating intraday — checking more often just shortens how long a
// fresh signal sits unnoticed before it shows up as a proposal.
const CHECK_INTERVAL_MINUTES = Number(process.env.LUNO_BOT_CHECK_INTERVAL_MINUTES) || 60;
const CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * 60 * 1000;

// ZAR amount to spend on an accepted buy proposal — sells always use the
// full held balance of the asset instead, since there's no equivalent
// "how much to keep" question there.
const BUY_ZAR = Number(process.env.LUNO_BOT_BUY_ZAR) || 500;

function dirFor(identityId) {
  return path.join(DATA_DIR, identityId);
}
function proposalsFileFor(identityId) {
  return path.join(dirFor(identityId), "proposals.json");
}
function stateFileFor(identityId) {
  return path.join(dirFor(identityId), "state.json");
}

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

// One-time migration: this bot used to be single-account, with
// proposals.json/state.json sitting directly under DATA_DIR. Move them
// into admin/ so existing proposal history isn't lost.
let migrated = false;
async function migrateLegacyFilesOnce() {
  if (migrated) return;
  migrated = true;
  const legacyProposals = path.join(DATA_DIR, "proposals.json");
  const legacyState = path.join(DATA_DIR, "state.json");
  await fs.mkdir(dirFor(ADMIN_ID), { recursive: true });
  for (const [legacy, target] of [
    [legacyProposals, proposalsFileFor(ADMIN_ID)],
    [legacyState, stateFileFor(ADMIN_ID)],
  ]) {
    try {
      await fs.access(legacy);
      try {
        await fs.access(target);
        // Already migrated (target exists) — leave the legacy file alone.
      } catch {
        await fs.rename(legacy, target);
        console.log(`luno-bot: migrated ${path.basename(legacy)} into admin/`);
      }
    } catch {
      // No legacy file — nothing to migrate.
    }
  }
}

// Same account_type-agnostic total-quantity grouping the dashboard uses,
// filtered to assets that both have a balance and a Luno ZAR ticker.
async function getHeldPricedAssets(credentials) {
  const [balances, tickers] = await Promise.all([getBalances(credentials), getTickers()]);
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
async function checkOnceFor(identityId, credentials) {
  await migrateLegacyFilesOnce();
  const assets = await getHeldPricedAssets(credentials);
  const proposals = await loadJson(proposalsFileFor(identityId), []);
  const seenKeys = new Set(proposals.map((p) => `${p.asset}:${p.signalTime}`));
  const config = Strategy.DEFAULT_CONFIG;
  const added = [];

  for (const asset of assets) {
    try {
      // Candle history is public/account-agnostic (see luno.js), so this
      // doesn't need `credentials` — only the balance lookup above does.
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
      console.error(`luno-bot(${identityId}): failed to check ${asset}:`, err.message);
    }
  }

  if (added.length) {
    await saveJson(proposalsFileFor(identityId), [...proposals, ...added]);
    console.log(`luno-bot(${identityId}): queued ${added.length} new proposal(s)`);
  }
  await saveJson(stateFileFor(identityId), { lastCheckedAt: Date.now() });
  return added;
}

// Full sweep across every account — admin (server env credentials) plus
// every registered user who has saved their own Luno keys. Used by the
// background interval loop; the "Check now" button instead calls
// checkOnceFor directly for just the requesting session's own identity.
async function checkOnce() {
  const identities = [{ id: ADMIN_ID, credentials: undefined }];
  const users = await getUsers();
  for (const user of users) {
    const credentials = await getUserCredentials(user.id);
    if (credentials) identities.push({ id: user.id, credentials });
  }

  const added = [];
  for (const { id, credentials } of identities) {
    try {
      added.push(...(await checkOnceFor(id, credentials)));
    } catch (err) {
      console.error(`luno-bot(${id}): check failed:`, err.message);
    }
  }
  return added;
}

async function getProposals(identityId) {
  await migrateLegacyFilesOnce();
  return loadJson(proposalsFileFor(identityId), []);
}

async function getState(identityId) {
  await migrateLegacyFilesOnce();
  return loadJson(stateFileFor(identityId), { lastCheckedAt: null });
}

function getConfig() {
  return { buyZar: BUY_ZAR };
}

async function setProposalStatus(identityId, id, status) {
  const file = proposalsFileFor(identityId);
  const proposals = await loadJson(file, []);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) {
    const err = new Error("Proposal not found");
    err.status = 404;
    throw err;
  }
  proposal.status = status;
  proposal.resolvedAt = Date.now();
  await saveJson(file, proposals);
  return proposal;
}

function startBotLoop() {
  checkOnce().catch((err) => console.error("luno-bot: initial check failed:", err.message));
  setInterval(() => {
    checkOnce().catch((err) => console.error("luno-bot: check failed:", err.message));
  }, CHECK_INTERVAL_MS);
}

module.exports = { startBotLoop, checkOnce, checkOnceFor, getProposals, getState, getConfig, setProposalStatus, ADMIN_ID };
