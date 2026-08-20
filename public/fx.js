// Shared currency toggle (USD/ZAR) used across pages that show USD prices.
// The selected currency persists in localStorage so it stays consistent
// as you move between tabs.
(function (global) {
  "use strict";

  const STORAGE_KEY = "cryptoApiCurrency";

  function getCurrency() {
    return localStorage.getItem(STORAGE_KEY) === "ZAR" ? "ZAR" : "USD";
  }

  function setCurrency(code) {
    localStorage.setItem(STORAGE_KEY, code === "ZAR" ? "ZAR" : "USD");
  }

  let cachedRate = null;
  let cachedAt = 0;
  const TTL_MS = 5 * 60_000;

  async function getUsdZarRate({ force = false } = {}) {
    if (!force && cachedRate != null && Date.now() - cachedAt < TTL_MS) return cachedRate;
    const res = await fetch("/api/fx/usdzar");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    cachedRate = body.rate;
    cachedAt = Date.now();
    return cachedRate;
  }

  // Converts a USD amount to the target currency's numeric value.
  function convert(usdValue, currency, rate) {
    return currency === "ZAR" ? usdValue * rate : usdValue;
  }

  function symbol(currency) {
    return currency === "ZAR" ? "R" : "$";
  }

  // Formats a value that is already denominated in `currency` — use this
  // when the underlying data was converted upstream (e.g. a whole candle
  // series), so it isn't converted a second time here.
  function formatConverted(value, currency, { compact = false } = {}) {
    const abs = Math.abs(value);
    if (compact) {
      if (abs >= 1_000_000) return symbol(currency) + (value / 1_000_000).toFixed(2) + "M";
      if (abs >= 1_000) return symbol(currency) + (value / 1_000).toFixed(1) + "K";
    }
    const maxFrac = abs < 10 ? 4 : 2;
    return symbol(currency) + " " + value.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
  }

  // Converts a raw USD value to `currency` and formats it in one step.
  function formatMoney(usdValue, currency, rate, opts) {
    return formatConverted(convert(usdValue, currency, rate), currency, opts);
  }

  // Wires a <select id="currency"> control: initializes it from storage,
  // fetches the rate, calls onChange(currency, rate) once immediately and
  // again whenever the user switches currency. Returns a `refresh()` you
  // can call after refetching data to reapply the current currency.
  function bindCurrencySelect(selectEl, onChange) {
    selectEl.value = getCurrency();
    let rate = 1;

    async function apply() {
      const currency = selectEl.value;
      setCurrency(currency);
      if (currency === "ZAR") {
        try {
          rate = await getUsdZarRate();
        } catch (err) {
          console.error("USD/ZAR rate unavailable:", err.message);
          rate = rate || 1;
        }
      }
      onChange(currency, rate);
    }

    selectEl.addEventListener("change", apply);
    apply();

    return { refresh: () => onChange(selectEl.value, rate) };
  }

  global.FX = { getCurrency, setCurrency, getUsdZarRate, convert, formatMoney, formatConverted, bindCurrencySelect };
})(window);
