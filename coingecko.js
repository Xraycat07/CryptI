const BASE_URL = "https://api.coingecko.com/api/v3";
const DEFAULT_COINS = [
  "bitcoin", "ethereum", "ripple", "litecoin", "dogecoin", "solana",
  "cardano", "polkadot", "chainlink", "avalanche-2", "polygon-ecosystem-token", "uniswap",
];

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

const fxCache = { rate: null, expiresAt: 0 };
const FX_TTL_MS = 5 * 60_000;

// USD->ZAR rate, derived from a USD-pegged stablecoin's own ZAR quote rather
// than a separate forex API — reuses the same CoinGecko dependency already
// in place for prices.
async function getUsdZarRate({ force = false } = {}) {
  if (!force && fxCache.rate && fxCache.expiresAt > Date.now()) {
    return { rate: fxCache.rate, cached: true };
  }
  const data = await fetchJson(`/simple/price?ids=usd-coin&vs_currencies=usd,zar`);
  const rate = data["usd-coin"].zar / data["usd-coin"].usd;
  fxCache.rate = rate;
  fxCache.expiresAt = Date.now() + FX_TTL_MS;
  return { rate, cached: false };
}

const DEFAULT_FOREX_CURRENCIES = ["EUR", "GBP", "JPY", "ZAR", "AUD", "CAD", "CHF", "NZD"];
const forexCache = { rates: null, expiresAt: 0, currencies: "" };

// Rates for arbitrary currencies against USD, using the same USD-pegged
// stablecoin technique as getUsdZarRate — one free CoinGecko call covers
// every currency at once, no separate forex API/key needed.
async function getForexRates(currencies = DEFAULT_FOREX_CURRENCIES, { force = false } = {}) {
  const key = cacheKey(currencies);
  if (!force && forexCache.rates && forexCache.currencies === key && forexCache.expiresAt > Date.now()) {
    return { rates: forexCache.rates, cached: true };
  }
  const vsCurrencies = ["usd", ...currencies.map((c) => c.toLowerCase())].join(",");
  const data = await fetchJson(`/simple/price?ids=usd-coin&vs_currencies=${vsCurrencies}`);
  const usd = data["usd-coin"].usd;
  const rates = {};
  for (const c of currencies) {
    const v = data["usd-coin"][c.toLowerCase()];
    if (v != null) rates[c.toUpperCase()] = v / usd;
  }
  forexCache.rates = rates;
  forexCache.currencies = key;
  forexCache.expiresAt = Date.now() + FX_TTL_MS;
  return { rates, cached: false };
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

module.exports = {
  DEFAULT_COINS, getPrices, getDailyHistory, getHourlyHistory, getUsdZarRate,
  getForexRates, DEFAULT_FOREX_CURRENCIES,
};
