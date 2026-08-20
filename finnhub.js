const BASE_URL = "https://finnhub.io/api/v1";

// A default watchlist mixing major tech names and broad-market ETFs — NVDA
// and QQQ echo the tokenized stock products already seen on the Luno side.
const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "NVDA", "META", "SPY", "QQQ"];

const quoteCache = new Map(); // symbol -> { data, expiresAt }
const QUOTE_TTL_MS = 30_000;

async function fetchQuote(symbol) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    const err = new Error("Finnhub API key not configured (set FINNHUB_API_KEY)");
    err.status = 500;
    throw err;
  }

  const cached = quoteCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const res = await fetch(`${BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`);
  const body = await res.json();
  if (!res.ok || body.error) {
    const err = new Error(body.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  if (body.c === 0 && body.h === 0 && body.l === 0 && body.pc === 0) {
    const err = new Error(`No quote data for "${symbol}" — check the ticker is valid`);
    err.status = 404;
    throw err;
  }

  const data = {
    symbol,
    current: body.c,
    change: body.d,
    changePct: body.dp,
    high: body.h,
    low: body.l,
    open: body.o,
    previousClose: body.pc,
    updatedAt: body.t,
  };
  quoteCache.set(symbol, { data, expiresAt: Date.now() + QUOTE_TTL_MS });
  return data;
}

async function getQuotes(symbols) {
  const results = await Promise.allSettled(symbols.map(fetchQuote));
  return results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { symbol: symbols[i], error: r.reason.message }
  );
}

module.exports = { getQuotes, DEFAULT_SYMBOLS };
