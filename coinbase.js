const BASE_URL = "https://api.exchange.coinbase.com";

// Maps our CoinGecko-style coin ids to Coinbase Exchange product ids.
const SYMBOL_MAP = {
  bitcoin: "BTC-USD",
  ethereum: "ETH-USD",
  ripple: "XRP-USD",
  litecoin: "LTC-USD",
  dogecoin: "DOGE-USD",
  solana: "SOL-USD",
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

function aggregateWeekly(dailyCandlesAsc) {
  // Group from the most recent day backward so the latest week is complete,
  // then flip back to ascending order.
  const groups = [];
  for (let i = dailyCandlesAsc.length; i > 0; i -= 7) {
    const start = Math.max(0, i - 7);
    const chunk = dailyCandlesAsc.slice(start, i);
    if (chunk.length < 7) continue; // drop a leftover partial oldest week
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

async function getCandles(coin, { interval = "1d", limit = 300 } = {}) {
  const product = SYMBOL_MAP[coin.toLowerCase()];
  if (!product) {
    const err = new Error(`Unknown coin "${coin}". Supported: ${Object.keys(SYMBOL_MAP).join(", ")}`);
    err.status = 400;
    throw err;
  }

  if (interval === "1w") {
    const daily = await fetchRawCandles(product, GRANULARITY_SECONDS["1d"], MAX_CANDLES_PER_REQUEST);
    const weekly = aggregateWeekly(daily);
    return weekly.slice(-limit);
  }

  const granularity = GRANULARITY_SECONDS[interval];
  if (!granularity) {
    const err = new Error(`Unsupported interval "${interval}". Allowed: ${[...Object.keys(GRANULARITY_SECONDS), "1w"].join(", ")}`);
    err.status = 400;
    throw err;
  }

  return fetchRawCandles(product, granularity, Math.min(MAX_CANDLES_PER_REQUEST, limit));
}

module.exports = { getCandles, SYMBOL_MAP };
