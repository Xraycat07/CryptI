const BASE_URL = "https://api.coingecko.com/api/v3";
const DEFAULT_COINS = ["bitcoin", "ethereum", "ripple", "litecoin", "dogecoin", "solana"];

const priceCache = new Map(); // key: sorted coin ids -> { data, expiresAt }
const PRICE_TTL_MS = 60_000;

async function fetchJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const body = await res.json();
  if (!res.ok || body.error) {
    const message = body.error?.status?.error_message || body.error || res.statusText;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

function cacheKey(coins) {
  return [...coins].sort().join(",");
}

async function getPrices(coins = DEFAULT_COINS, { force = false } = {}) {
  const key = cacheKey(coins);
  const cached = priceCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return { data: cached.data, cached: true };
  }

  const data = await fetchJson(
    `/simple/price?ids=${coins.join(",")}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_last_updated_at=true`
  );
  priceCache.set(key, { data, expiresAt: Date.now() + PRICE_TTL_MS });
  return { data, cached: false };
}

async function getDailyHistory(coin, days) {
  return fetchJson(`/coins/${coin}/market_chart?vs_currency=usd&days=${days}&interval=daily`);
}

async function getHourlyHistory(coin, hours) {
  // CoinGecko auto-selects hourly granularity for any days value between 2 and 90.
  const days = Math.min(90, Math.max(2, Math.ceil(hours / 24) + 1));
  const chart = await fetchJson(`/coins/${coin}/market_chart?vs_currency=usd&days=${days}`);
  const cutoff = Date.now() - hours * 3600_000;
  return {
    ...chart,
    prices: chart.prices.filter(([ts]) => ts >= cutoff),
  };
}

module.exports = { DEFAULT_COINS, getPrices, getDailyHistory, getHourlyHistory };
