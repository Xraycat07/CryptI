const path = require("path");
const express = require("express");
const { DEFAULT_COINS, getPrices, getDailyHistory, getHourlyHistory } = require("./coingecko");
const { getCandles, SYMBOL_MAP } = require("./coinbase");
const { getNews } = require("./news");

const app = express();
const PORT = process.env.PORT || 3001;

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

app.listen(PORT, () => {
  console.log(`crypto-api listening on http://localhost:${PORT}`);
});
