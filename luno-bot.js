// Server-side "bots" that watch each account's held, ZAR-priced coins for
// a fresh buy/sell signal — the same indicator engine as the Trading
// signal panel (EMA cross, RSI, MACD, S/R zones, trendlines) — and queue a
// proposal for that account's owner to approve or reject. There are three
// independent bots per account, one per risk tier (see RISK_TIERS below) —
// same signal engine, different confluence/stop settings, so they watch
// the same candles but don't necessarily agree on when a signal is worth
// surfacing. None of them ever place an order itself; "accepting" a
// proposal jumps straight to the order form's Confirm step (as a limit
// order at the signal price, sized from BUY_ZAR / the full held balance),
// but placing the real order still requires that explicit Confirm click.
//
// Runs independently of the browser (checked on a server-side interval),
// once per account × tier: "admin" (the server's own env-var Luno
// credentials, used by password login) plus every registered user who has
// saved their own Luno keys (see users.js, wired up via Google sign-in).
// Each account/tier's proposals/state persist separately under
// data/luno-bot/<id>/<tier>/, the same on-disk JSON pattern history.js
// uses for candle archives.
const fs = require("fs/promises");
const path = require("path");
const Strategy = require("./public/strategy.js");
const { getBalances, getTickers, getCandleHistory } = require("./luno");
const { getUsers, getUserCredentials } = require("./users");

const DATA_DIR = path.join(__dirname, "data", "luno-bot");
const ADMIN_ID = "admin";

// Three configs built on the same DEFAULT_CONFIG the Indicators page
// starts from — only confluence strictness and stop/cooldown differ, so
// each tier is a genuinely different filter over the same signal engine,
// not just a label. "medium" is exactly DEFAULT_CONFIG (unchanged from
// before this was split into tiers).
const RISK_TIERS = {
  low: {
    ...Strategy.DEFAULT_CONFIG,
    confluence: { minBullish: 4, minBearish: 4 },
    cooldownBars: 10,
    risk: { stopMode: "zone", stopPct: 1.5, riskReward: 2.5 },
  },
  medium: Strategy.DEFAULT_CONFIG,
  high: {
    ...Strategy.DEFAULT_CONFIG,
    confluence: { minBullish: 2, minBearish: 2 },
    cooldownBars: 2,
    risk: { stopMode: "zone", stopPct: 3, riskReward: 1.5 },
  },
};
const TIERS = Object.keys(RISK_TIERS);
const TIER_INFO = {
  low: { label: "Low risk", description: "Needs 4 of 5 indicators to agree, tighter 1.5% stop, longer 10-bar cooldown — fewer, higher-conviction signals." },
  medium: { label: "Medium risk", description: "The default balance — 3 of 5 indicators must agree, 2% stop, 5-bar cooldown." },
  high: { label: "High risk", description: "Only 2 of 5 indicators need to agree, wider 3% stop, short 2-bar cooldown — more frequent, lower-conviction signals." },
};

function assertKnownTier(tier) {
  if (!RISK_TIERS[tier]) {
    const err = new Error(`Unknown risk tier "${tier}". Allowed: ${TIERS.join(", ")}`);
    err.status = 400;
    throw err;
  }
}

const SIGNAL_DAYS = 90;
// Signals are still based on daily candles, but the current day's candle
// keeps updating intraday — checking more often just shortens how long a
// fresh signal sits unnoticed before it shows up as a proposal.
const CHECK_INTERVAL_MINUTES = Number(process.env.LUNO_BOT_CHECK_INTERVAL_MINUTES) || 60;
const CHECK_INTERVAL_MS = CHECK_INTERVAL_MINUTES * 60 * 1000;

// ZAR amount to spend on an accepted buy proposal — sells always use the
// full held balance of the asset instead, since there's no equivalent
// "how much to keep" question there. Same across all three tiers for now;
// risk is expressed via signal strictness/stop distance above, not size.
const BUY_ZAR = Number(process.env.LUNO_BOT_BUY_ZAR) || 500;

function dirFor(identityId, tier) {
  return path.join(DATA_DIR, identityId, tier);
}
function proposalsFileFor(identityId, tier) {
  return path.join(dirFor(identityId, tier), "proposals.json");
}
function stateFileFor(identityId, tier) {
  return path.join(dirFor(identityId, tier), "state.json");
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

// One-time migrations, run at most once per process:
//  1. This bot used to be single-account, with proposals.json/state.json
//     sitting directly under DATA_DIR — move them into admin/.
//  2. It then became single-tier-per-account, with those files directly
//     under <identityId>/ — move them into <identityId>/medium/, since
//     that one bot used exactly what's now the "medium" config.
// Existing proposal history survives both moves either way.
let migrated = false;
async function migrateLegacyFilesOnce() {
  if (migrated) return;
  migrated = true;

  const legacyFlatProposals = path.join(DATA_DIR, "proposals.json");
  const legacyFlatState = path.join(DATA_DIR, "state.json");
  const adminDir = path.join(DATA_DIR, ADMIN_ID);
  await fs.mkdir(adminDir, { recursive: true });
  for (const [legacy, target] of [
    [legacyFlatProposals, path.join(adminDir, "proposals.json")],
    [legacyFlatState, path.join(adminDir, "state.json")],
  ]) {
    try {
      await fs.access(legacy);
      try {
        await fs.access(target);
      } catch {
        await fs.rename(legacy, target);
        console.log(`luno-bot: migrated ${path.basename(legacy)} into admin/`);
      }
    } catch {
      // No legacy flat file — nothing to do here.
    }
  }

  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const identityDir = path.join(DATA_DIR, entry.name);
    const legacyProposals = path.join(identityDir, "proposals.json");
    const legacyState = path.join(identityDir, "state.json");
    const targetDir = path.join(identityDir, "medium");
    for (const [legacy, targetFile] of [
      [legacyProposals, path.join(targetDir, "proposals.json")],
      [legacyState, path.join(targetDir, "state.json")],
    ]) {
      try {
        await fs.access(legacy);
        await fs.mkdir(targetDir, { recursive: true });
        try {
          await fs.access(targetFile);
        } catch {
          await fs.rename(legacy, targetFile);
          console.log(`luno-bot: migrated ${entry.name}/${path.basename(legacy)} into ${entry.name}/medium/`);
        }
      } catch {
        // No legacy per-identity file — nothing to do here.
      }
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

async function checkOnceForTier(identityId, tier, credentials) {
  assertKnownTier(tier);
  await migrateLegacyFilesOnce();
  const assets = await getHeldPricedAssets(credentials);
  const proposals = await loadJson(proposalsFileFor(identityId, tier), []);
  const seenKeys = new Set(proposals.map((p) => `${p.asset}:${p.signalTime}`));
  const config = RISK_TIERS[tier];
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
      console.error(`luno-bot(${identityId}/${tier}): failed to check ${asset}:`, err.message);
    }
  }

  if (added.length) {
    await saveJson(proposalsFileFor(identityId, tier), [...proposals, ...added]);
    console.log(`luno-bot(${identityId}/${tier}): queued ${added.length} new proposal(s)`);
  }
  await saveJson(stateFileFor(identityId, tier), { lastCheckedAt: Date.now() });
  return added;
}

// Full sweep across every account × every risk tier — admin (server env
// credentials) plus every registered user who has saved their own Luno
// keys. Used by the background interval loop; the "Check now" button
// instead calls checkOnceForTier directly for one tier of the requesting
// session's own identity.
async function checkOnce() {
  const identities = [{ id: ADMIN_ID, credentials: undefined }];
  const users = await getUsers();
  for (const user of users) {
    const credentials = await getUserCredentials(user.id);
    if (credentials) identities.push({ id: user.id, credentials });
  }

  const added = [];
  for (const { id, credentials } of identities) {
    for (const tier of TIERS) {
      try {
        added.push(...(await checkOnceForTier(id, tier, credentials)));
      } catch (err) {
        console.error(`luno-bot(${id}/${tier}): check failed:`, err.message);
      }
    }
  }
  return added;
}

async function getProposals(identityId, tier) {
  assertKnownTier(tier);
  await migrateLegacyFilesOnce();
  return loadJson(proposalsFileFor(identityId, tier), []);
}

async function getState(identityId, tier) {
  assertKnownTier(tier);
  await migrateLegacyFilesOnce();
  return loadJson(stateFileFor(identityId, tier), { lastCheckedAt: null });
}

function getConfig() {
  return { buyZar: BUY_ZAR };
}

function getTiers() {
  return TIERS.map((id) => ({ id, ...TIER_INFO[id] }));
}

async function setProposalStatus(identityId, tier, id, status) {
  assertKnownTier(tier);
  const file = proposalsFileFor(identityId, tier);
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

module.exports = {
  startBotLoop, checkOnce, checkOnceForTier, getProposals, getState, getConfig, getTiers,
  setProposalStatus, ADMIN_ID, TIERS,
};
