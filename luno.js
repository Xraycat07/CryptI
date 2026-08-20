const BASE_URL = "https://api.luno.com";

// Primary credentials, with an optional secondary key (LUNO_API_KEY_ID2 /
// LUNO_API_KEY_SECRET2) used as a failover if the primary is rejected
// (e.g. revoked, or blocked by an IP allowlist mismatch).
const CREDENTIAL_SETS = [
  { keyId: () => process.env.LUNO_API_KEY_ID, secret: () => process.env.LUNO_API_KEY_SECRET },
  { keyId: () => process.env.LUNO_API_KEY_ID2, secret: () => process.env.LUNO_API_KEY_SECRET2 },
];

function authHeader({ keyId, secret }) {
  return "Basic " + Buffer.from(`${keyId}:${secret}`).toString("base64");
}

async function lunoRequestOnce(auth, method, path, params) {
  const headers = { Authorization: auth };
  let url = `${BASE_URL}${path}`;
  let body;

  if (method === "GET") {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
  } else {
    body = new URLSearchParams(params).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const res = await fetch(url, { method, headers, body });
  const data = await res.json();
  if (!res.ok || data.error) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function lunoRequest(method, path, params = {}) {
  const configured = CREDENTIAL_SETS
    .map((set) => ({ keyId: set.keyId(), secret: set.secret() }))
    .filter((c) => c.keyId && c.secret);

  if (!configured.length) {
    const err = new Error("Luno API credentials not configured (set LUNO_API_KEY_ID and LUNO_API_KEY_SECRET)");
    err.status = 500;
    throw err;
  }

  let lastErr;
  for (const creds of configured) {
    try {
      return await lunoRequestOnce(authHeader(creds), method, path, params);
    } catch (err) {
      lastErr = err;
      if (err.status !== 401) throw err; // only fail over on auth/allowlist rejections
    }
  }
  throw lastErr;
}

// Limit order: type is "BID" (buy) or "ASK" (sell).
async function placeLimitOrder({ pair, type, volume, price }) {
  if (!pair || !type || !volume || !price) {
    const err = new Error("pair, type (BID/ASK), volume, and price are required");
    err.status = 400;
    throw err;
  }
  return lunoRequest("POST", "/api/1/postorder", { pair, type, volume, price });
}

// Market order: type is "BUY" or "SELL". Luno expects counter_volume for BUY
// (amount of quote currency to spend) and base_volume for SELL (amount to sell).
async function placeMarketOrder({ pair, type, volume }) {
  if (!pair || !type || !volume) {
    const err = new Error("pair, type (BUY/SELL), and volume are required");
    err.status = 400;
    throw err;
  }
  const params = { pair, type };
  if (type === "BUY") params.counter_volume = volume;
  else if (type === "SELL") params.base_volume = volume;
  else {
    const err = new Error('type must be "BUY" or "SELL"');
    err.status = 400;
    throw err;
  }
  return lunoRequest("POST", "/api/1/marketorder", params);
}

async function getBalances() {
  const data = await lunoRequest("GET", "/api/1/balance");
  return data.balance || [];
}

async function getOpenOrders() {
  const data = await lunoRequest("GET", "/api/1/listorders", { state: "PENDING" });
  return data.orders || [];
}

// Public market tickers (no auth). Used to price account balances.
async function getTickers() {
  const res = await fetch(`${BASE_URL}/api/1/tickers`);
  const data = await res.json();
  if (!res.ok || data.error) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data.tickers || [];
}

// Daily candles for a pair, requires auth (unlike the ticker endpoint).
// Returns chronological ascending candles. Luno caps a single response at
// ~1000 candles counting forward from `since` — so for a `since` more than
// 1000 days back, this returns the *oldest* 1000 days from that point, not
// the most recent ones. Callers wanting deep history must page forward
// (see luno-history.js's fetchDeepHistory), not just request more days.
async function getCandleHistory(pair, { days = 30, since } = {}) {
  const sinceMs = since != null ? since : Date.now() - days * 86400 * 1000;
  const data = await lunoRequest("GET", "/api/exchange/1/candles", { pair, since: sinceMs, duration: 86400 });
  return (data.candles || []).map((c) => ({
    time: c.timestamp,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  }));
}

// Maker/taker fee rates and 30-day trading volume for a pair.
async function getFeeInfo(pair) {
  return lunoRequest("GET", "/api/1/fee_info", { pair });
}

// Ledger entries (deposits, withdrawals, trades, fees) for the ZAR account.
// Every trade has a ZAR leg, so this one account's ledger captures buy/sell
// activity across all pairs, not just ZAR itself. Luno's row range is
// negative-indexed from most recent, and rows come back newest-first.
async function getAccountTransactions({ count = 50 } = {}) {
  const balances = await getBalances();
  const zarAccount = balances.find((b) => b.asset === "ZAR");
  if (!zarAccount) return [];
  const data = await lunoRequest("GET", `/api/1/accounts/${zarAccount.account_id}/transactions`, {
    min_row: -count,
    max_row: 0,
  });
  return data.transactions || [];
}

async function cancelOrder(orderId) {
  if (!orderId) {
    const err = new Error("orderId is required");
    err.status = 400;
    throw err;
  }
  return lunoRequest("POST", "/api/1/stoporder", { order_id: orderId });
}

module.exports = { placeLimitOrder, placeMarketOrder, cancelOrder, getBalances, getOpenOrders, getTickers, getCandleHistory, getAccountTransactions, getFeeInfo };
