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
- `/indicators.html` — EMA/RSI/MACD + rule-based backtest and account-equity simulation for a selected coin
- `/predictions.html` — naive linear projection per coin
- `/performance.html` — strategy backtest summary across every tracked coin
- `/stocks.html` — live stock quotes (Finnhub) and forex rates, editable ticker/currency chips
- `/news.html` — recent news tagged by coin (from CoinDesk, Cointelegraph, Decrypt RSS)

All six of the first six pages above have a **Market** dropdown (Crypto/Stocks/Forex) in the header — switching it reloads the page against a different symbol list and data source, so every one of those views (charts, EMA/RSI/MACD, backtest, predictions) works for stocks and forex too, not just crypto. Choice persists across pages via `localStorage`. See `yahoo.js`/`forex.js` below for the data sources and their limitations.

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
| `GET /api/stocks/candles/:symbol?days=300` | Daily OHLCV candles (Yahoo Finance chart endpoint — see notes below). `symbol` is one of `/api/stocks/symbols` |
| `GET /api/stocks/symbols` | List of supported stock tickers |
| `GET /api/forex/candles/:pair?days=300` | Daily rate "candles" (frankfurter.dev, ECB reference rates) — `open=high=low=close`, `volume=0`. `pair` is one of `/api/forex/symbols` |
| `GET /api/forex/symbols` | List of supported forex pairs |
| `GET /api/news?coin=ripple` | News articles tagged by coin |

## Notes

- Price/candle data is cached in-memory; it resets on restart or redeploy. The daily-candle *archives* (`data/history/`) are on-disk JSON and survive restarts, backfilling once then growing a few days at a time.
- No database, no auth — this is a single-instance tool, not built for multi-tenant use (except the Luno tab — see below).
- CoinGecko's free tier rate-limits fairly aggressively; `/api/candles` uses Coinbase Exchange's public API instead for that reason. Binance was tried first but geoblocks most cloud hosting regions (Render included) under its ToS.
- **Stock history** (`yahoo.js`) comes from Yahoo Finance's public chart endpoint, not Finnhub — Finnhub's free tier (used for `/api/stocks/quotes`) restricts historical candles to paid plans (confirmed directly against this project's key). Yahoo's endpoint is free but unofficial/undocumented, with no published SLA — it could change or get rate-limited without notice. Daily-only, no intraday granularity.
- **Forex history** (`forex.js`) comes from frankfurter.dev — free, no key, ECB reference rates. It's one rate per day, not real OHLC, so forex candles are `open=high=low=close` (visible as thin dashes rather than solid candlestick bodies) and `volume=0`. EMA/RSI/MACD/predictions (all close-price-driven) work normally on this; anything relying on a real high/low range looks flat.

## Deploying

This is a stateful Node process (in-memory caching), so it needs a real host — not GitHub Pages (static-only). Any Node-friendly host works: point it at this repo, set the build command to `npm install` and the start command to `npm start`. The server already reads `process.env.PORT`.

### Luno tab sign-in

The Luno tab (page + `/api/luno/*`) is gated by a session cookie once either auth method below is configured; with neither set, it's open like the rest of the dashboard. Sessions are in-memory and reset on restart/redeploy either way.

- **Password** — set `LUNO_APP_USER` and `LUNO_APP_PASSWORD`. This session always trades on the server's own Luno API keys (`LUNO_API_KEY_ID`/`LUNO_API_KEY_SECRET` below) — there's one such session, shared by anyone with the password.
- **Google sign-in** (recommended once hosted) — open registration: anyone who signs in with Google gets their own account automatically, and adds their *own* Luno API key/secret afterward (from the dashboard's Account tab) to trade on their own Luno account. One person's keys/orders/bot proposals are never visible to another. The app owner's own email (`LUNO_OWNER_EMAIL`, defaults to `mikkiedutoit@gmail.com`) is the one exception — signing in with that address gets an **admin** session (the server's own env-var Luno keys) instead of a separate registered account, since there's no need to re-enter credentials that are already configured.
  1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an OAuth 2.0 Client ID of type "Web application".
  2. Under "Authorized JavaScript origins", add your hosted URL (e.g. `https://your-app.onrender.com`).
  3. Set `GOOGLE_CLIENT_ID` on the host to that client ID (it's a public value, safe to expose to the browser).
  4. Set `CREDENTIAL_ENCRYPTION_KEY` on the host to any secret string — used to encrypt each user's saved Luno API secret at rest (`data/users.json`). Required for the "save Luno keys" step to work; changing it later makes previously-saved keys unreadable (that user would need to re-enter them).

Both methods can be enabled together — password login is unaffected by any of the above and keeps working exactly as before. The admin session (password *or* the owner's Google account) is also the only one that appears in the Account tab's "Registered users" list as an admin rather than a row in that list — see the Account tab for who else has registered.

**Data persistence caveat**: registered users, their Luno keys, and bot proposals are stored as JSON files under `data/` (gitignored, same as the rest of the app's local storage). If your host's disk is ephemeral (no persistent volume attached — Render's default, for example), a redeploy wipes this data and everyone would need to sign in and re-add their keys. For anything beyond light personal/family use, attach a persistent disk or move this to a real database.

### Trade tab bots

Three independent bots per account — **Low / Medium / High risk** (`luno-bot.js`) — each watch that account's held, ZAR-priced coins once an hour (`LUNO_BOT_CHECK_INTERVAL_MINUTES`, default 60) for a fresh buy/sell signal, using the same indicator engine as the Indicators tab but with different confluence/stop settings per tier (Low needs 4/5 indicators to agree with a tight 1.5% stop; Medium is the Indicators tab's own default; High only needs 2/5 with a wider 3% stop) — so they're genuinely independent opinions on the same data, not just relabeled copies. None of them ever place a trade: accepting a proposal jumps to the order form's Confirm step (sized from `LUNO_BOT_BUY_ZAR`, default 500, for buys — sells use the full held balance), and nothing reaches Luno until that Confirm click.

**Email notifications** (optional, `email.js`) — whenever any bot queues a new proposal (whether from the hourly background check or a manual "Check now"), an email goes to that account's own address: the registered user's email for a Google sign-in, or `LUNO_OWNER_EMAIL` for the admin session. Sent via Gmail SMTP ([nodemailer](https://nodemailer.com/)):
1. On the Gmail account you want to send *from*, turn on 2-Step Verification, then create an [app password](https://myaccount.google.com/apppasswords) (Google Account → Security → 2-Step Verification → App passwords).
2. Set `EMAIL_FROM` to that Gmail address and `EMAIL_APP_PASSWORD` to the generated app password (not the account's real password — Gmail rejects that for SMTP).

Without both set, this silently no-ops — proposals still queue normally, no email attempted. A failed send (bad credentials, rate limit, etc.) is logged and never blocks the actual bot check.
