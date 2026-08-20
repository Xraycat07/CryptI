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

// Daily candles for a pair over the last `days` days (requires auth, unlike
// the ticker endpoint). Returns chronological ascending candles.
async function getCandleHistory(pair, { days = 30 } = {}) {
  const since = Date.now() - days * 86400 * 1000;
  const data = await lunoRequest("GET", "/api/exchange/1/candles", { pair, since, duration: 86400 });
  return (data.candles || []).map((c) => ({
    time: c.timestamp,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume),
  }));
}

async function cancelOrder(orderId) {
  if (!orderId) {
    const err = new Error("orderId is required");
    err.status = 400;
    throw err;
  }
  return lunoRequest("POST", "/api/1/stoporder", { order_id: orderId });
}

module.exports = { placeLimitOrder, placeMarketOrder, cancelOrder, getBalances, getOpenOrders, getTickers, getCandleHistory };
