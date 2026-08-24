// Shared Stocks/Crypto/Forex switch, same pattern as fx.js's currency
// toggle: persists to localStorage so the choice sticks as you move
// between pages. Each page keeps its own existing crypto coin list
// (id/label/color) unchanged — this only supplies the curated stock/forex
// lists and the per-class API URL builders, so "crypto" behaves exactly as
// it did before this existed.
//
// Switching classes reloads the page rather than rebuilding charts in
// place: every page here builds its per-symbol DOM/chart objects once at
// load from a fixed coin list, so a reload is the simplest way to rebuild
// them for a different symbol set without juggling chart-library lifecycle
// bugs.
(function (global) {
  "use strict";

  const STORAGE_KEY = "cryptoApiAssetClass";

  const STOCK_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "NVDA", "META", "SPY", "QQQ"];
  const FOREX_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "USDZAR", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"];
  // Reused across symbols so stocks/forex charts still get distinct colors,
  // same as crypto's per-coin palette.
  const PALETTE = ["#4f8cff", "#26a69a", "#e6007a", "#f0c419", "#9945ff", "#e84142", "#00d1b2", "#b45309", "#84cc16"];

  function asCoins(symbols) {
    return symbols.map((symbol, i) => ({ id: symbol, label: symbol, color: PALETTE[i % PALETTE.length] }));
  }

  const NON_CRYPTO_COINS = { stocks: asCoins(STOCK_SYMBOLS), forex: asCoins(FOREX_SYMBOLS) };

  function getAssetClass() {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "stocks" || v === "forex" ? v : "crypto";
  }

  function setAssetClass(cls) {
    localStorage.setItem(STORAGE_KEY, cls === "stocks" || cls === "forex" ? cls : "crypto");
  }

  // Coin list for a class — pass the page's own existing crypto array
  // through for "crypto" so that path is untouched; stocks/forex use the
  // curated lists above.
  function coinsFor(cls, cryptoCoins) {
    return cls === "crypto" ? cryptoCoins : NON_CRYPTO_COINS[cls];
  }

  function candlesUrl(cls, symbol, params = {}) {
    const base = cls === "stocks" ? `/api/stocks/candles/${symbol}`
      : cls === "forex" ? `/api/forex/candles/${symbol}`
      : `/api/candles/${symbol}`;
    const qs = new URLSearchParams(params).toString();
    return qs ? `${base}?${qs}` : base;
  }

  function historyInfoUrl(cls, symbol) {
    return cls === "stocks" ? `/api/stocks/symbols/${symbol}/history-info`
      : cls === "forex" ? `/api/forex/symbols/${symbol}/history-info`
      : `/api/coins/${symbol}/history-info`;
  }

  // Wires a <select> control: initializes from storage, and on change
  // persists + reloads the page (see file comment above for why).
  function bindAssetClassSelect(selectEl) {
    selectEl.value = getAssetClass();
    selectEl.addEventListener("change", () => {
      setAssetClass(selectEl.value);
      window.location.reload();
    });
  }

  global.AssetClass = {
    getAssetClass, setAssetClass, coinsFor, candlesUrl, historyInfoUrl, bindAssetClassSelect,
    STOCK_SYMBOLS, FOREX_SYMBOLS,
  };
})(window);
