// Server-side "bots" that watch each account's held, ZAR-priced coins for
// a fresh buy/sell signal — the same indicator engine as the Trading
// signal panel (EMA cross, RSI, MACD, S/R zones, trendlines, Bollinger
// Bands, volume confirmation) — and queue a proposal for that account's
// owner to approve or reject. There are three
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
const { getBalances, getTickers, getCandleHistory, getFeeInfo } = require("./luno");
const { getUsers, getUserCredentials } = require("./users");
const Email = require("./email");

const DATA_DIR = path.join(__dirname, "data", "luno-bot");
const ADMIN_ID = "admin";
// Same default this app's admin identity resolves to elsewhere (see
// OWNER_EMAIL in server.js) — duplicated here rather than shared, since
// it's one env-var read and this module already reads several of its own.
const ADMIN_EMAIL = process.env.LUNO_OWNER_EMAIL || "mikkiedutoit@gmail.com";

// Three configs built on the same DEFAULT_CONFIG the Indicators page
// starts from — only confluence strictness and stop/cooldown differ, so
// each tier is a genuinely different filter over the same signal engine,
// not just a label. "medium" is exactly DEFAULT_CONFIG (unchanged from
// before this was split into tiers).
//
// The indicator engine now has 7 indicators (added bollinger + volume) —
// thresholds here were re-tested against ~2 years of real Luno candle
// history across 11 pairs before settling: with 7 voting, 2/7 fires very
// often (500+ signals total in that test), 3/7 is a sane default frequency
// (~7/asset over 2 years), and 4/7 is already rare (2 signals total) —
// 5/7 never fired once. So "low risk" tops out at 4/7 deliberately, not 5+,
// since a threshold that (near-)never fires isn't useful at any risk tier.
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
  low: { label: "Low risk", description: "Needs 4 of 7 indicators to agree, tighter 1.5% stop, longer 10-bar cooldown — rare but real, higher-conviction signals." },
  medium: { label: "Medium risk", description: "The default balance — 3 of 7 indicators must agree, 2% stop, 5-bar cooldown." },
  high: { label: "High risk", description: "Only 2 of 7 indicators need to agree, wider 3% stop, short 2-bar cooldown — more frequent, lower-conviction signals." },
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

// Richer version for the rebalance bot — returns qty, price and ZAR value
// per asset so it can filter out dust positions and size the swap.
async function getHeldPricedAssetsDetailed(credentials) {
  const [balances, tickers] = await Promise.all([getBalances(credentials), getTickers()]);
  const priceByAsset = {};
  for (const t of tickers) {
    if (t.pair.endsWith("ZAR") && t.pair !== "ZAR") priceByAsset[t.pair.slice(0, -3)] = Number(t.last_trade);
  }
  const byAsset = {};
  for (const b of balances) {
    const total = Number(b.balance) + Number(b.reserved);
    if (!byAsset[b.asset]) byAsset[b.asset] = { asset: b.asset, qty: 0, available: 0 };
    byAsset[b.asset].qty += total;
    if (b.account_type === "TRANSACTIONAL") byAsset[b.asset].available += total;
  }
  return Object.values(byAsset)
    .filter((h) => h.qty > 0 && priceByAsset[h.asset] != null)
    .map((h) => ({ ...h, price: priceByAsset[h.asset], valueZar: h.qty * priceByAsset[h.asset] }));
}

async function checkOnceForTier(identityId, tier, credentials, notifyEmail) {
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
    if (notifyEmail) {
      const label = TIER_INFO[tier].label;
      const lines = added.map(
        (p) => `${p.side.toUpperCase()} ${p.pair} at R${p.price.toFixed(2)} (stop R${p.stopLoss.toFixed(2)} / target R${p.takeProfit.toFixed(2)})`
      );
      Email.sendMail({
        to: notifyEmail,
        subject: `${label} bot: ${added.length} new proposal${added.length > 1 ? "s" : ""}`,
        text: `Your ${label.toLowerCase()} Luno bot found ${added.length} new signal(s):\n\n${lines.join("\n")}\n\nReview and accept/dismiss in the Luno tab's Trade page.`,
      }).catch((err) => console.error(`luno-bot(${identityId}/${tier}): email notification failed:`, err.message));
    }
  }
  await saveJson(stateFileFor(identityId, tier), { lastCheckedAt: Date.now() });
  return added;
}

// ---------- rebalance bot ----------
// Compares all held coins' momentum and proposes swapping the weakest
// (declining) coin into the strongest (rising) coin when the projected
// gain after round-trip fees is worthwhile. Uses the same indicator +
// projection engine as the risk-tier bots above, but instead of per-coin
// buy/sell signals it ranks coins against each other.

const REBALANCE_MIN_NET_GAIN_PCT = 1;
const REBALANCE_MIN_VALUE_ZAR = 10;
const REBALANCE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function rebalanceDir(identityId) {
  return path.join(DATA_DIR, identityId, "rebalance");
}
function rebalanceProposalsFile(identityId) {
  return path.join(rebalanceDir(identityId), "proposals.json");
}
function rebalanceStateFile(identityId) {
  return path.join(rebalanceDir(identityId), "state.json");
}

function scoreAsset(candles) {
  if (candles.length < 55) return null;
  const closes = candles.map((c) => c.close);
  const projected = Strategy.projectForward(closes, 7);
  const last = closes[closes.length - 1];
  const projectedPct = ((projected[projected.length - 1] - last) / last) * 100;

  const config = Strategy.DEFAULT_CONFIG;
  const result = Strategy.runStrategy(candles, config);
  const lastSignal = result.signals[result.signals.length - 1];
  const barsAgo = lastSignal ? (candles.length - 1) - lastSignal.index : null;
  const isFresh = lastSignal && barsAgo <= (config.cooldownBars ?? 5);

  let signalBonus = 0;
  if (isFresh) signalBonus = lastSignal.side === "buy" ? 3 : -3;

  return {
    projectedPct,
    compositeScore: projectedPct + signalBonus,
    signal: isFresh ? lastSignal.side : null,
  };
}

async function checkRebalanceForIdentity(identityId, credentials, notifyEmail) {
  await migrateLegacyFilesOnce();
  const saveState = () => saveJson(rebalanceStateFile(identityId), { lastCheckedAt: Date.now() });
  const holdings = await getHeldPricedAssetsDetailed(credentials);
  const tradeable = holdings.filter((h) => h.valueZar >= REBALANCE_MIN_VALUE_ZAR && h.available > 0);
  if (tradeable.length < 2) { await saveState(); return []; }

  const scored = [];
  for (const h of tradeable) {
    try {
      const candles = await getCandleHistory(`${h.asset}ZAR`, { days: SIGNAL_DAYS });
      const s = scoreAsset(candles);
      if (s) scored.push({ ...h, ...s });
    } catch (err) {
      console.error(`luno-bot(${identityId}/rebalance): score ${h.asset} failed:`, err.message);
    }
  }
  if (scored.length < 2) { await saveState(); return []; }

  scored.sort((a, b) => a.compositeScore - b.compositeScore);
  const weakest = scored[0];
  const strongest = scored[scored.length - 1];

  if (strongest.compositeScore <= 0 || weakest.compositeScore >= 0) { await saveState(); return []; }
  if (strongest.projectedPct - weakest.projectedPct < REBALANCE_MIN_NET_GAIN_PCT) { await saveState(); return []; }

  let sellFeePct, buyFeePct;
  try {
    const [sf, bf] = await Promise.all([
      getFeeInfo(`${weakest.asset}ZAR`, credentials),
      getFeeInfo(`${strongest.asset}ZAR`, credentials),
    ]);
    sellFeePct = Number(sf.taker_fee) * 100;
    buyFeePct = Number(bf.taker_fee) * 100;
  } catch {
    sellFeePct = 1;
    buyFeePct = 1;
  }
  const roundTripFeePct = sellFeePct + buyFeePct;
  const netGainPct = strongest.projectedPct - weakest.projectedPct - roundTripFeePct;

  if (netGainPct < REBALANCE_MIN_NET_GAIN_PCT) { await saveState(); return []; }

  const proposals = await loadJson(rebalanceProposalsFile(identityId), []);
  const swapKey = `${weakest.asset}->${strongest.asset}`;
  const recent = proposals.find((p) => p.swapKey === swapKey && Date.now() - p.createdAt < REBALANCE_COOLDOWN_MS);
  if (recent) { await saveState(); return []; }

  const estimatedSellZar = weakest.available * weakest.price * (1 - sellFeePct / 100);
  const estimatedBuyQty = estimatedSellZar / strongest.price;

  const proposal = {
    id: `rebal-${weakest.asset}-${strongest.asset}-${Date.now()}`,
    swapKey,
    sellAsset: weakest.asset,
    sellPair: `${weakest.asset}ZAR`,
    sellPrice: weakest.price,
    sellQty: weakest.available,
    sellProjectedPct: weakest.projectedPct,
    sellSignal: weakest.signal,
    buyAsset: strongest.asset,
    buyPair: `${strongest.asset}ZAR`,
    buyPrice: strongest.price,
    buyEstimatedQty: estimatedBuyQty,
    buyProjectedPct: strongest.projectedPct,
    buySignal: strongest.signal,
    sellFeePct,
    buyFeePct,
    roundTripFeePct,
    netGainPct,
    estimatedSellZar,
    createdAt: Date.now(),
    status: "pending",
  };

  proposals.push(proposal);
  await saveJson(rebalanceProposalsFile(identityId), proposals);
  console.log(`luno-bot(${identityId}/rebalance): proposed ${weakest.asset} → ${strongest.asset} (net +${netGainPct.toFixed(1)}%)`);

  if (notifyEmail) {
    Email.sendMail({
      to: notifyEmail,
      subject: `Rebalance bot: swap ${weakest.asset} → ${strongest.asset}`,
      text: [
        `Your rebalance bot suggests swapping ${weakest.asset} into ${strongest.asset}:`,
        ``,
        `Sell ${weakest.asset} (projected ${weakest.projectedPct >= 0 ? "+" : ""}${weakest.projectedPct.toFixed(1)}%)`,
        `Buy  ${strongest.asset} (projected +${strongest.projectedPct.toFixed(1)}%)`,
        `Round-trip fees: ~${roundTripFeePct.toFixed(2)}%`,
        `Estimated net gain: +${netGainPct.toFixed(1)}%`,
        ``,
        `Review in the Luno tab's Trade page.`,
      ].join("\n"),
    }).catch((err) => console.error(`luno-bot(${identityId}/rebalance): email failed:`, err.message));
  }

  await saveJson(rebalanceStateFile(identityId), { lastCheckedAt: Date.now() });
  return [proposal];
}

async function getRebalanceProposals(identityId) {
  await migrateLegacyFilesOnce();
  return loadJson(rebalanceProposalsFile(identityId), []);
}

async function getRebalanceState(identityId) {
  await migrateLegacyFilesOnce();
  return loadJson(rebalanceStateFile(identityId), { lastCheckedAt: null });
}

async function setRebalanceProposalStatus(identityId, id, status) {
  const file = rebalanceProposalsFile(identityId);
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

// Full sweep across every account × every risk tier — admin (server env
// credentials) plus every registered user who has saved their own Luno
// keys. Used by the background interval loop; the "Check now" button
// instead calls checkOnceForTier directly for one tier of the requesting
// session's own identity.
async function checkOnce() {
  const identities = [{ id: ADMIN_ID, credentials: undefined, email: ADMIN_EMAIL }];
  const users = await getUsers();
  for (const user of users) {
    const credentials = await getUserCredentials(user.id);
    if (credentials) identities.push({ id: user.id, credentials, email: user.email });
  }

  const added = [];
  for (const { id, credentials, email } of identities) {
    for (const tier of TIERS) {
      try {
        added.push(...(await checkOnceForTier(id, tier, credentials, email)));
      } catch (err) {
        console.error(`luno-bot(${id}/${tier}): check failed:`, err.message);
      }
    }
    try {
      added.push(...(await checkRebalanceForIdentity(id, credentials, email)));
    } catch (err) {
      console.error(`luno-bot(${id}/rebalance): check failed:`, err.message);
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
  checkRebalanceForIdentity, getRebalanceProposals, getRebalanceState, setRebalanceProposalStatus,
};
