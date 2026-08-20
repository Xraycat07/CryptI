# crypto-api

Local-first REST API + dashboard for tracking crypto prices, OHLC candles, technical indicators, and related news for BTC, ETH, XRP, LTC, DOGE, and SOL.

## Run locally

```
npm install
npm start
```

Opens on `http://localhost:3001` (or `$PORT` if set).

## Pages

- `/` — dashboard: individual candlestick charts + a normalized combined comparison chart
- `/single.html` — single-coin detail view
- `/trends.html` — 24h/7d/30d % change table with trend badges and sparklines
- `/indicators.html` — EMA/RSI/MACD for a selected coin
- `/news.html` — recent news tagged by coin (from CoinDesk, Cointelegraph, Decrypt RSS)

## API

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/prices?coins=ripple,litecoin` | Current prices (CoinGecko, 60s cache) |
| `POST /api/prices/refresh?coins=...` | Force-refresh price cache |
| `GET /api/prices/history/:coin?days=30` | Daily historical prices (CoinGecko, up to 365 days) |
| `GET /api/prices/hourly/:coin?hours=24` | Hourly historical prices (CoinGecko, up to ~90 days) |
| `GET /api/candles/:coin?interval=1d&limit=300` | OHLC candles (Coinbase Exchange) — used by the charts. Intervals: `1m`, `5m`, `15m`, `1h`, `6h`, `1d`, `1w` (weekly is aggregated from daily server-side) |
| `GET /api/coins` | List of supported coin ids |
| `GET /api/news?coin=ripple` | News articles tagged by coin |

## Notes

- Price/candle data is cached in-memory; it resets on restart or redeploy.
- No database, no auth — this is a single-instance tool, not built for multi-tenant use.
- CoinGecko's free tier rate-limits fairly aggressively; `/api/candles` uses Coinbase Exchange's public API instead for that reason. Binance was tried first but geoblocks most cloud hosting regions (Render included) under its ToS.

## Deploying

This is a stateful Node process (in-memory caching), so it needs a real host — not GitHub Pages (static-only). Any Node-friendly host works: point it at this repo, set the build command to `npm install` and the start command to `npm start`. The server already reads `process.env.PORT`.
