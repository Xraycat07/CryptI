require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const { DEFAULT_COINS, getPrices, getDailyHistory, getHourlyHistory, getUsdZarRate, getForexRates, DEFAULT_FOREX_CURRENCIES } = require("./coingecko");
const { getCandles, SYMBOL_MAP, recordRecentHistory, backfillHistoryIfNeeded, getHistoryInfo, ALL_INTERVALS } = require("./coinbase");
const {
  getCandles: getStockCandles, SYMBOLS: STOCK_SYMBOLS, recordRecentHistory: recordRecentStockHistory,
  backfillHistoryIfNeeded: backfillStockHistoryIfNeeded, getHistoryInfo: getStockHistoryInfo,
} = require("./yahoo");
const {
  getCandles: getForexCandles, SYMBOLS: FOREX_SYMBOLS, recordRecentHistory: recordRecentForexHistory,
  backfillHistoryIfNeeded: backfillForexHistoryIfNeeded, getHistoryInfo: getForexHistoryInfo,
} = require("./forex");
const { getNews } = require("./news");
const { placeLimitOrder, placeMarketOrder, cancelOrder, getBalances, getOpenOrders, getTickers, getMarketInfo, getAccountTransactions, getFeeInfo } = require("./luno");
const { getQuotes, DEFAULT_SYMBOLS } = require("./finnhub");
const { startBotLoop, checkOnceFor: runBotCheckOnceFor, getProposals: getBotProposals, getState: getBotState, getConfig: getBotConfig, setProposalStatus: setBotProposalStatus, ADMIN_ID: BOT_ADMIN_ID } = require("./luno-bot");
const { recordRecentHistory: recordRecentLunoHistory, backfillHistoryIfNeeded: backfillLunoHistoryIfNeeded, getMergedHistory: getMergedLunoHistory } = require("./luno-history");
const { findOrCreateUser, getUserById, getUserCredentials, setUserLunoKeys, clearUserLunoKeys } = require("./users");

const app = express();
const PORT = process.env.PORT || 3001;

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Session-cookie gate for the Luno tab (page + API), used instead of HTTP
// Basic Auth because embedded webviews (e.g. VS Code's Simple Browser) don't
// reliably show the native Basic Auth login popup. Off by default when
// neither auth method below is configured, so the rest of the dashboard
// stays open. Sessions live in memory only — they reset on server restart.
const SESSION_COOKIE = "luno_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// sessionId -> { expiresAt, kind: "admin" | "user", userId? }. "admin"
// sessions (password login) use the server's own env-var Luno credentials,
// unchanged from before. "user" sessions (Google sign-in) are a
// registered account with its own Luno API keys — see users.js.
const sessions = new Map();

// "Sign in with Google", meant for the hosted deployment (no shared
// password to leak, and Google handles the actual credential check) —
// GOOGLE_CLIENT_ID is a public value (safe in frontend JS), obtained by
// registering an OAuth client at console.cloud.google.com/apis/credentials
// with the hosted origin under "Authorized JavaScript origins". Local dev
// can keep using LUNO_APP_USER/LUNO_APP_PASSWORD instead; both can be
// enabled at once. Registration is open — anyone who signs in with Google
// gets their own account, and can only ever trade on their own Luno
// account (their own API keys), so there's no shared-credential risk in
// leaving this unrestricted.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

function createSession(kind, userId) {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS, kind, userId });
  return id;
}

function getSession(id) {
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function setSessionCookie(req, res, id) {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

function requireLunoSession(req, res, next) {
  const passwordAuthEnabled = Boolean(process.env.LUNO_APP_USER && process.env.LUNO_APP_PASSWORD);
  if (!passwordAuthEnabled && !GOOGLE_CLIENT_ID) return next();

  const cookies = parseCookies(req);
  const session = getSession(cookies[SESSION_COOKIE]);
  if (session) {
    req.lunoAuth = { kind: session.kind, userId: session.userId };
    return next();
  }

  if (req.originalUrl === "/luno.html") {
    return res.sendFile(path.join(__dirname, "public", "luno-login.html"));
  }
  res.status(401).json({ error: "Not authenticated" });
}

// Resolves { keyId, secret } for the current session, or null if a
// registered user hasn't saved their own Luno keys yet. Admin (password)
// sessions return undefined, meaning "use the server's env credentials" —
// luno.js's functions already default to that when no credentials are passed.
async function resolveLunoCredentials(req) {
  if (!req.lunoAuth || req.lunoAuth.kind === "admin") return undefined;
  return getUserCredentials(req.lunoAuth.userId);
}

function botIdentityId(req) {
  return !req.lunoAuth || req.lunoAuth.kind === "admin" ? BOT_ADMIN_ID : req.lunoAuth.userId;
}

// Resolves this session's Luno credentials onto req.lunoCredentials for the
// account-specific routes below. A registered user with no saved keys gets
// a clear 400 instead of the route ever calling Luno.
async function withLunoCredentials(req, res, next) {
  try {
    const credentials = await resolveLunoCredentials(req);
    if (credentials === null) {
      return res.status(400).json({ error: "Add your Luno API keys first (see the Account tab)." });
    }
    req.lunoCredentials = credentials;
    next();
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}

app.use(express.json());

app.post("/api/luno/login", (req, res) => {
  const expectedUser = process.env.LUNO_APP_USER;
  const expectedPass = process.env.LUNO_APP_PASSWORD;
  if (!expectedUser || !expectedPass) {
    return res.status(500).json({ error: "Login is not configured on the server" });
  }
  const { user, password } = req.body || {};
  if (
    !user || !password ||
    !timingSafeStringEqual(user, expectedUser) ||
    !timingSafeStringEqual(password, expectedPass)
  ) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  setSessionCookie(req, res, createSession("admin"));
  res.json({ ok: true });
});

app.post("/api/luno/logout", (req, res) => {
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE]) sessions.delete(cookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

// Tells the login page which auth method(s) to render.
app.get("/api/luno/auth-config", (req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    passwordAuthEnabled: Boolean(process.env.LUNO_APP_USER && process.env.LUNO_APP_PASSWORD),
  });
});

// Open registration: any verified Google account gets an account (created
// on first sign-in) that trades on its own Luno API keys, added afterward
// from the Account tab — never the server's shared credentials.
app.post("/api/luno/google-login", async (req, res) => {
  if (!googleClient) {
    return res.status(500).json({ error: "Google sign-in is not configured on the server" });
  }
  try {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: "Missing credential" });
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload.email_verified) {
      return res.status(401).json({ error: "Google account email is not verified" });
    }
    const user = await findOrCreateUser(payload.email);
    setSessionCookie(req, res, createSession("user", user.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ error: "Google sign-in failed: " + err.message });
  }
});

app.use(["/luno.html", "/api/luno"], requireLunoSession);
app.use(express.static(path.join(__dirname, "public")));

function parseCoins(query) {
  if (!query) return DEFAULT_COINS;
  return query.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
});

// Pull current prices (cached for 60s unless ?force=true)
// USD->ZAR exchange rate, used by the frontend's currency toggle
app.get("/api/fx/usdzar", async (req, res) => {
  try {
    const force = req.query.force === "true";
    const { rate, cached } = await getUsdZarRate({ force });
    res.json({ rate, cached });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.get("/api/prices", async (req, res) => {
  try {
    const coins = parseCoins(req.query.coins);
    const force = req.query.force === "true";
    const { data, cached } = await getPrices(coins, { force });
    res.json({ cached, coins, data });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Force-refresh current prices, bypassing cache
app.post("/api/prices/refresh", async (req, res) => {
  try {
    const coins = parseCoins(req.query.coins || req.body?.coins?.join(","));
    const { data } = await getPrices(coins, { force: true });
    res.json({ refreshedAt: new Date().toISOString(), coins, data });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Daily historical prices (up to 365 days on the free CoinGecko tier)
app.get("/api/prices/history/:coin", async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const chart = await getDailyHistory(req.params.coin, days);
    res.json({ coin: req.params.coin, days, prices: chart.prices });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Hourly historical prices (up to ~90 days back)
app.get("/api/prices/hourly/:coin", async (req, res) => {
  try {
    const hours = Math.min(24 * 90, Math.max(1, parseInt(req.query.hours, 10) || 24));
    const chart = await getHourlyHistory(req.params.coin, hours);
    res.json({ coin: req.params.coin, hours, prices: chart.prices });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// OHLC candles for charting (Coinbase-backed; Binance geoblocks most cloud hosts)
app.get("/api/candles/:coin", async (req, res) => {
  try {
    const interval = req.query.interval || "1d";
    const limit = Math.min(300, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const candles = await getCandles(req.params.coin, { interval, limit });
    res.json({ coin: req.params.coin, interval, candles });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// List coins supported by the candle endpoint
app.get("/api/coins", (req, res) => {
  res.json({ coins: Object.keys(SYMBOL_MAP) });
});

// Every interval the candle endpoint understands, smallest to largest
app.get("/api/intervals", (req, res) => {
  res.json({ intervals: ALL_INTERVALS });
});

// How much daily history is actually stored for a coin — used by the
// frontend to dynamically enable/disable long intervals (6M/1Y/2Y) per coin
app.get("/api/coins/:coin/history-info", async (req, res) => {
  try {
    const info = await getHistoryInfo(req.params.coin);
    res.json(info);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Daily stock candles — see yahoo.js for why Yahoo instead of Finnhub.
// Daily-only (no interval param), unlike the crypto candle endpoint above.
app.get("/api/stocks/candles/:symbol", async (req, res) => {
  try {
    const interval = req.query.interval || "1d";
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const candles = await getStockCandles(req.params.symbol, { interval, limit });
    res.json({ symbol: req.params.symbol.toUpperCase(), interval, candles });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.get("/api/stocks/symbols", (req, res) => {
  res.json({ symbols: STOCK_SYMBOLS });
});

app.get("/api/stocks/symbols/:symbol/history-info", async (req, res) => {
  try {
    res.json(await getStockHistoryInfo(req.params.symbol));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Daily forex candles — see forex.js. One rate per day (open=high=low=close,
// volume=0), not real OHLC; daily-only, same as the stock candles above.
app.get("/api/forex/candles/:pair", async (req, res) => {
  try {
    const interval = req.query.interval || "1d";
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const candles = await getForexCandles(req.params.pair, { interval, limit });
    res.json({ pair: req.params.pair.toUpperCase(), interval, candles });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.get("/api/forex/symbols", (req, res) => {
  res.json({ symbols: FOREX_SYMBOLS });
});

app.get("/api/forex/symbols/:pair/history-info", async (req, res) => {
  try {
    res.json(await getForexHistoryInfo(req.params.pair));
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Live stock quotes (Finnhub). Requires FINNHUB_API_KEY in .env.
app.get("/api/stocks/quotes", async (req, res) => {
  try {
    const symbols = req.query.symbols
      ? req.query.symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
      : DEFAULT_SYMBOLS;
    const quotes = await getQuotes(symbols);
    res.json({ quotes });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Forex rates against USD (free, no API key — see coingecko.js)
app.get("/api/forex/rates", async (req, res) => {
  try {
    const currencies = req.query.currencies
      ? req.query.currencies.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean)
      : DEFAULT_FOREX_CURRENCIES;
    const force = req.query.force === "true";
    const { rates, cached } = await getForexRates(currencies, { force });
    res.json({ base: "USD", rates, cached });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// News related to the tracked coins, pulled from CoinDesk/Cointelegraph/Decrypt RSS
app.get("/api/news", async (req, res) => {
  try {
    const force = req.query.force === "true";
    const { articles, cached, errors } = await getNews({ force });
    const coin = req.query.coin;
    const filtered = coin ? articles.filter((a) => a.coins.includes(coin)) : articles;
    res.json({ cached, count: filtered.length, errors, articles: filtered });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Current session's identity + whether it has Luno keys saved. Admin
// (password-login) sessions always report keys as configured, since they
// use the server's own env credentials rather than a saved key.
app.get("/api/luno/account", async (req, res) => {
  if (req.lunoAuth.kind === "admin") {
    return res.json({ kind: "admin", email: null, hasLunoKeys: true, keyIdMasked: null });
  }
  const user = await getUserById(req.lunoAuth.userId);
  const keyId = user?.luno?.keyId || null;
  res.json({
    kind: "user",
    email: user?.email || null,
    hasLunoKeys: Boolean(user?.luno),
    keyIdMasked: keyId ? `${keyId.slice(0, 4)}${"*".repeat(Math.max(0, keyId.length - 4))}` : null,
  });
});

app.post("/api/luno/account/luno-keys", async (req, res) => {
  if (req.lunoAuth.kind === "admin") {
    return res.status(400).json({ error: "This session uses the server's configured Luno credentials." });
  }
  try {
    const { keyId, secret } = req.body || {};
    if (!keyId || !secret) return res.status(400).json({ error: "keyId and secret are required" });
    // Verify the keys actually work before saving, so a typo is caught now
    // instead of surfacing later as a confusing failure.
    await getBalances({ keyId, secret });
    await setUserLunoKeys(req.lunoAuth.userId, { keyId, secret });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.delete("/api/luno/account/luno-keys", async (req, res) => {
  if (req.lunoAuth.kind === "admin") {
    return res.status(400).json({ error: "This session uses the server's configured Luno credentials." });
  }
  try {
    await clearUserLunoKeys(req.lunoAuth.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Wallet balances for the connected Luno account
app.get("/api/luno/balance", withLunoCredentials, async (req, res) => {
  try {
    const balance = await getBalances(req.lunoCredentials);
    res.json({ balance });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Currently open (pending) orders on the connected Luno account
app.get("/api/luno/orders", withLunoCredentials, async (req, res) => {
  try {
    const orders = await getOpenOrders(req.lunoCredentials);
    res.json({ orders });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Public Luno market tickers (all pairs) — used to price account balances
app.get("/api/luno/market", async (req, res) => {
  try {
    const tickers = await getTickers();
    res.json({ tickers });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Per-pair trading rules (decimal precision, min/max volume) — the frontend
// uses this to round order volume/price to what Luno's postorder will accept.
app.get("/api/luno/markets", async (req, res) => {
  try {
    const markets = await getMarketInfo();
    res.json({ markets });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Daily ZAR price history for a held asset (e.g. /api/luno/history/ETH).
// Served from the local archive (see luno-history.js) merged with a small
// live top-up, so it doesn't depend entirely on a live Luno call each time.
app.get("/api/luno/history/:asset", async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const asset = req.params.asset.toUpperCase();
    const candles = await getMergedLunoHistory(`${asset}ZAR`, { days });
    res.json({ asset, pair: `${asset}ZAR`, days, candles });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Place a real Luno order (limit by default, or market with orderType: "market").
// Moves real money, so the caller must explicitly pass confirm: true.
app.post("/api/luno/orders", withLunoCredentials, async (req, res) => {
  try {
    const { confirm, orderType, ...params } = req.body || {};
    if (!confirm) {
      return res.status(400).json({ error: "Set confirm: true in the request body to place a real order." });
    }
    const result = orderType === "market"
      ? await placeMarketOrder(params, req.lunoCredentials)
      : await placeLimitOrder(params, req.lunoCredentials);
    res.json(result);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Maker/taker fee rates for a pair, used to estimate cost before confirming an order.
app.get("/api/luno/fees/:pair", withLunoCredentials, async (req, res) => {
  try {
    const fees = await getFeeInfo(req.params.pair.toUpperCase(), req.lunoCredentials);
    res.json(fees);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Ledger of deposits/withdrawals/trades on the ZAR account — covers every
// buy/sell across all pairs since each trade has a ZAR leg.
app.get("/api/luno/transactions", withLunoCredentials, async (req, res) => {
  try {
    const count = Math.min(200, Math.max(1, parseInt(req.query.count, 10) || 50));
    const transactions = await getAccountTransactions({ count }, req.lunoCredentials);
    res.json({ transactions });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// The bot's queued buy/sell proposals — it only ever suggests, never trades
// on its own; accepting one still requires an explicit Confirm click. Each
// account (admin, or a registered user) only ever sees its own proposals.
app.get("/api/luno/bot/proposals", async (req, res) => {
  try {
    const identityId = botIdentityId(req);
    const [proposals, state] = await Promise.all([getBotProposals(identityId), getBotState(identityId)]);
    res.json({ proposals, lastCheckedAt: state.lastCheckedAt, ...getBotConfig() });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Runs a check immediately instead of waiting for the hourly interval —
// scoped to just the requesting session's own account.
app.post("/api/luno/bot/check-now", withLunoCredentials, async (req, res) => {
  try {
    const identityId = botIdentityId(req);
    const added = await runBotCheckOnceFor(identityId, req.lunoCredentials);
    const [proposals, state] = await Promise.all([getBotProposals(identityId), getBotState(identityId)]);
    res.json({ added: added.length, proposals, lastCheckedAt: state.lastCheckedAt, ...getBotConfig() });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post("/api/luno/bot/proposals/:id/accept", async (req, res) => {
  try {
    const proposal = await setBotProposalStatus(botIdentityId(req), req.params.id, "accepted");
    res.json({ proposal });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.post("/api/luno/bot/proposals/:id/dismiss", async (req, res) => {
  try {
    const proposal = await setBotProposalStatus(botIdentityId(req), req.params.id, "dismissed");
    res.json({ proposal });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

// Cancel an open Luno order
app.post("/api/luno/orders/:orderId/cancel", withLunoCredentials, async (req, res) => {
  try {
    const result = await cancelOrder(req.params.orderId, req.lunoCredentials);
    res.json(result);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`crypto-api listening on http://localhost:${PORT}`);
});

// Grows the local daily-candle archive over time (see history.js) instead
// of relying solely on how far Coinbase paginates on demand. Backfill runs
// once (skips products already deep enough), then the recorder keeps it
// fresh with new days going forward.
backfillHistoryIfNeeded()
  .then(() => recordRecentHistory())
  .catch((err) => console.error("initial history backfill/recording failed:", err.message));
setInterval(() => {
  recordRecentHistory().catch((err) => console.error("history recording failed:", err.message));
}, 6 * 60 * 60 * 1000);

// Same idea again, but for the Stocks/Forex asset classes (see yahoo.js /
// forex.js) — each backfills once, then the recorder keeps it fresh.
backfillStockHistoryIfNeeded()
  .then(() => recordRecentStockHistory())
  .catch((err) => console.error("initial stock history backfill/recording failed:", err.message));
setInterval(() => {
  recordRecentStockHistory().catch((err) => console.error("stock history recording failed:", err.message));
}, 6 * 60 * 60 * 1000);

backfillForexHistoryIfNeeded()
  .then(() => recordRecentForexHistory())
  .catch((err) => console.error("initial forex history backfill/recording failed:", err.message));
setInterval(() => {
  recordRecentForexHistory().catch((err) => console.error("forex history recording failed:", err.message));
}, 6 * 60 * 60 * 1000);

// Same idea as the Coinbase archive above, but for Luno's held ZAR coins
// (see luno-history.js) — grows a local daily-candle archive instead of
// depending entirely on a live Luno call every time.
backfillLunoHistoryIfNeeded()
  .then(() => recordRecentLunoHistory())
  .catch((err) => console.error("initial Luno history backfill/recording failed:", err.message));
setInterval(() => {
  recordRecentLunoHistory().catch((err) => console.error("Luno history recording failed:", err.message));
}, 6 * 60 * 60 * 1000);

// Watches held, ZAR-priced Luno coins for a fresh buy/sell signal once a
// day and queues a proposal — see luno-bot.js. Never places an order.
startBotLoop();
