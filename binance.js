const BASE_URL = "https://api.binance.com/api/v3";

// Maps our CoinGecko-style coin ids to Binance USDT trading pairs.
const SYMBOL_MAP = {
  bitcoin: "BTCUSDT",
  ethereum: "ETHUSDT",
  ripple: "XRPUSDT",
  litecoin: "LTCUSDT",
  dogecoin: "DOGEUSDT",
  solana: "SOLUSDT",
};

const ALLOWED_INTERVALS = new Set([
  "1m", "3m", "5m", "15m", "30m",
  "1h", "2h", "4h", "6h", "8h", "12h",
  "1d", "3d", "1w", "1M",
]);

async function getCandles(coin, { interval = "1d", limit = 365 } = {}) {
  const symbol = SYMBOL_MAP[coin.toLowerCase()];
  if (!symbol) {
    const err = new Error(`Unknown coin "${coin}". Supported: ${Object.keys(SYMBOL_MAP).join(", ")}`);
    err.status = 400;
    throw err;
  }
  if (!ALLOWED_INTERVALS.has(interval)) {
    const err = new Error(`Unsupported interval "${interval}". Allowed: ${[...ALLOWED_INTERVALS].join(", ")}`);
    err.status = 400;
    throw err;
  }

  const res = await fetch(
    `${BASE_URL}/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(1000, limit)}`
  );
  const body = await res.json();
  if (!res.ok || body.code) {
    const err = new Error(body.msg || res.statusText);
    err.status = res.status;
    throw err;
  }

  // Binance kline shape: [openTime, open, high, low, close, volume, closeTime, ...]
  return body.map(([openTime, open, high, low, close, volume]) => ({
    time: Math.floor(openTime / 1000), // lightweight-charts wants seconds
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }));
}

module.exports = { getCandles, SYMBOL_MAP };
