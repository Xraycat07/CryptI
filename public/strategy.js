// Configurable technical-analysis strategy engine, shared by any chart page
// that includes this script. Everything is built around a small plugin
// registry so new indicators/strategies can be added without touching the
// core runner: call Strategy.registerIndicator(name, fn) and reference
// `name` in a strategy config's `indicators` map.
(function (global) {
  "use strict";

  // ---------- base indicator math ----------
  function ema(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let prev;
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) continue;
      if (i === period - 1) {
        prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
        out[i] = prev;
        continue;
      }
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function rsi(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length < period + 1) return out;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = values[i] - values[i - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const diff = values[i] - values[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
    const emaFast = ema(values, fast);
    const emaSlow = ema(values, slow);
    const macdLine = values.map((_, i) =>
      emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
    );
    const validStart = macdLine.findIndex((v) => v != null);
    const signalTail = validStart === -1 ? [] : ema(macdLine.slice(validStart), signalPeriod);
    const signalLine = new Array(Math.max(validStart, 0)).fill(null).concat(signalTail);
    const histogram = macdLine.map((v, i) =>
      v != null && signalLine[i] != null ? v - signalLine[i] : null
    );
    return { macdLine, signalLine, histogram };
  }

  // ---------- swing points (fractals) ----------
  function findSwingPoints(candles, lookback = 3) {
    const highs = [], lows = [];
    for (let i = lookback; i < candles.length - lookback; i++) {
      let isHigh = true, isLow = true;
      for (let k = i - lookback; k <= i + lookback; k++) {
        if (k === i) continue;
        if (candles[k].high > candles[i].high) isHigh = false;
        if (candles[k].low < candles[i].low) isLow = false;
      }
      if (isHigh) highs.push({ index: i, time: candles[i].time, price: candles[i].high });
      if (isLow) lows.push({ index: i, time: candles[i].time, price: candles[i].low });
    }
    return { highs, lows };
  }

  // ---------- support / resistance zones ----------
  // Clusters nearby swing prices into zones, then classifies each zone as
  // support/resistance relative to the latest close (a broken resistance
  // reads as support once price is above it, and vice versa).
  function findSRZones(candles, swings, { tolerancePct = 1.5, minTouches = 2, maxZones = 6 } = {}) {
    const points = [...swings.highs, ...swings.lows].map((p) => p.price).sort((a, b) => a - b);
    if (!points.length) return [];

    const clusters = [];
    let current = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const avg = current.reduce((a, b) => a + b, 0) / current.length;
      if ((Math.abs(points[i] - avg) / avg) * 100 <= tolerancePct) {
        current.push(points[i]);
      } else {
        clusters.push(current);
        current = [points[i]];
      }
    }
    clusters.push(current);

    const lastClose = candles[candles.length - 1].close;
    const zones = clusters
      .filter((c) => c.length >= minTouches)
      .map((c) => {
        const priceLow = Math.min(...c);
        const priceHigh = Math.max(...c);
        const mid = (priceLow + priceHigh) / 2;
        return {
          type: mid > lastClose ? "resistance" : "support",
          priceLow, priceHigh, mid,
          touches: c.length,
          distancePct: (Math.abs(mid - lastClose) / lastClose) * 100,
        };
      });

    return zones
      .sort((a, b) => b.touches - a.touches || a.distancePct - b.distancePct)
      .slice(0, maxZones);
  }

  // ---------- trend lines ----------
  function lineValueAt(line, time) {
    return line.slope * (time - line.t0) + line.p0;
  }

  function bestTrendLine(points, direction, candles, { tolerancePct = 0.75 } = {}) {
    let best = null;
    for (let a = 0; a < points.length; a++) {
      for (let b = a + 1; b < points.length; b++) {
        const p1 = points[a], p2 = points[b];
        const slope = (p2.price - p1.price) / (p2.time - p1.time);
        if (direction === "up" && slope <= 0) continue;
        if (direction === "down" && slope >= 0) continue;

        let violations = 0, touches = 0;
        for (const c of candles) {
          if (c.time < p1.time) continue;
          const lineVal = slope * (c.time - p1.time) + p1.price;
          const tol = (lineVal * tolerancePct) / 100;
          if (direction === "up") {
            if (c.low < lineVal - tol) violations++;
            else if (Math.abs(c.low - lineVal) <= tol) touches++;
          } else {
            if (c.high > lineVal + tol) violations++;
            else if (Math.abs(c.high - lineVal) <= tol) touches++;
          }
        }
        if (violations > 1) continue; // allow a little noise, not a clean break
        const score = touches - violations * 5;
        if (!best || score > best.score) {
          best = { direction, t0: p1.time, p0: p1.price, slope, touches, violations, score };
        }
      }
    }
    return best;
  }

  function findTrendLines(candles, swings, opts = {}) {
    const lines = [];
    const up = bestTrendLine(swings.lows, "up", candles, opts);
    if (up && up.touches >= (opts.minTouches ?? 2)) lines.push(up);
    const down = bestTrendLine(swings.highs, "down", candles, opts);
    if (down && down.touches >= (opts.minTouches ?? 2)) lines.push(down);
    return lines;
  }

  // ---------- naive trend projection ----------
  // A least-squares line through the series, extended forward `count` more
  // bars — a statistical extrapolation of the recent trend, not a forecast.
  function projectForward(values, count) {
    const n = values.length;
    if (n < 2) return new Array(count).fill(values[n - 1] ?? null);
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let i = 0; i < n; i++) { sumX += i; sumY += values[i]; sumXY += i * values[i]; sumXX += i * i; }
    const denom = n * sumXX - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;
    return Array.from({ length: count }, (_, i) => slope * (n + i) + intercept);
  }

  function extendTimes(times, count) {
    const last = times[times.length - 1];
    const step = times.length > 1 ? last - times[times.length - 2] : 86400;
    return Array.from({ length: count }, (_, i) => last + step * (i + 1));
  }

  // ---------- indicator registry ----------
  // Each registered indicator takes (candles, params, ctx) and returns
  // { scores, series? } — scores is one entry per candle in {-1, 0, 1}
  // (bearish/neutral/bullish); series is optional data for charting.
  const registry = {};
  function registerIndicator(name, fn) { registry[name] = fn; }

  registerIndicator("emaCross", (candles, p = {}) => {
    const closes = candles.map((c) => c.close);
    const fast = ema(closes, p.fast ?? 20);
    const slow = ema(closes, p.slow ?? 50);
    const scores = candles.map((_, i) =>
      fast[i] == null || slow[i] == null ? 0 : fast[i] > slow[i] ? 1 : fast[i] < slow[i] ? -1 : 0
    );
    return { scores, series: { fast, slow } };
  });

  registerIndicator("rsi", (candles, p = {}) => {
    const closes = candles.map((c) => c.close);
    const values = rsi(closes, p.period ?? 14);
    const scores = values.map((v) =>
      v == null ? 0 : v < (p.oversold ?? 30) ? 1 : v > (p.overbought ?? 70) ? -1 : 0
    );
    return { scores, series: { rsi: values } };
  });

  registerIndicator("macd", (candles, p = {}) => {
    const closes = candles.map((c) => c.close);
    const { macdLine, signalLine, histogram } = macd(closes, p.fast ?? 12, p.slow ?? 26, p.signal ?? 9);
    const scores = histogram.map((h, i) => {
      if (h == null || i === 0 || histogram[i - 1] == null) return 0;
      if (h > 0 && histogram[i - 1] <= 0) return 1;
      if (h < 0 && histogram[i - 1] >= 0) return -1;
      return 0;
    });
    return { scores, series: { macdLine, signalLine, histogram } };
  });

  registerIndicator("srZones", (candles, p = {}, ctx) => {
    const zones = ctx.zones || [];
    const proximityPct = p.proximityPct ?? 1;
    const scores = candles.map((c) => {
      for (const z of zones) {
        const distLow = (Math.abs(c.low - z.priceLow) / z.priceLow) * 100;
        const distHigh = (Math.abs(c.high - z.priceHigh) / z.priceHigh) * 100;
        if (z.type === "support" && distLow <= proximityPct && c.close > c.open) return 1;
        if (z.type === "resistance" && distHigh <= proximityPct && c.close < c.open) return -1;
      }
      return 0;
    });
    return { scores };
  });

  registerIndicator("trendlines", (candles, p = {}, ctx) => {
    const lines = ctx.trendlines || [];
    const tol = p.tolerancePct ?? 0.75;
    const scores = candles.map((c) => {
      for (const l of lines) {
        if (c.time < l.t0) continue;
        const val = lineValueAt(l, c.time);
        const distPct = (Math.abs((l.direction === "up" ? c.low : c.high) - val) / val) * 100;
        if (distPct <= tol) {
          if (l.direction === "up" && c.close > c.open) return 1;
          if (l.direction === "down" && c.close < c.open) return -1;
        }
      }
      return 0;
    });
    return { scores };
  });

  // ---------- risk (stop-loss / take-profit) ----------
  function computeRisk(entry, side, zones, riskCfg = {}) {
    const stopPct = riskCfg.stopPct ?? 2;
    const rr = riskCfg.riskReward ?? 2;
    let stopLoss;
    if (riskCfg.stopMode === "zone") {
      if (side === "buy") {
        const below = [...zones].filter((z) => z.priceHigh < entry).sort((a, b) => b.priceHigh - a.priceHigh)[0];
        stopLoss = below ? below.priceLow * 0.997 : entry * (1 - stopPct / 100);
      } else {
        const above = [...zones].filter((z) => z.priceLow > entry).sort((a, b) => a.priceLow - b.priceLow)[0];
        stopLoss = above ? above.priceHigh * 1.003 : entry * (1 + stopPct / 100);
      }
    } else {
      stopLoss = side === "buy" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
    }
    const risk = Math.abs(entry - stopLoss);
    const takeProfit = side === "buy" ? entry + rr * risk : entry - rr * risk;
    return { stopLoss, takeProfit };
  }

  // ---------- strategy runner ----------
  // config: {
  //   swingLookback, indicators: { <name>: { enabled, ...params } },
  //   confluence: { minBullish, minBearish }, cooldownBars,
  //   risk: { stopMode: "pct"|"zone", stopPct, riskReward },
  // }
  function runStrategy(candles, config) {
    const swings = findSwingPoints(candles, config.swingLookback ?? 3);
    const needZones = config.indicators?.srZones?.enabled || config.risk?.stopMode === "zone";
    const zones = needZones ? findSRZones(candles, swings, config.indicators?.srZones ?? {}) : [];
    const trendlines = config.indicators?.trendlines?.enabled
      ? findTrendLines(candles, swings, config.indicators.trendlines)
      : [];

    const ctx = { zones, trendlines };
    const enabledNames = Object.keys(config.indicators || {}).filter(
      (name) => config.indicators[name]?.enabled && registry[name]
    );

    const indicatorResults = {};
    for (const name of enabledNames) indicatorResults[name] = registry[name](candles, config.indicators[name], ctx);

    const n = candles.length;
    const totalScore = new Array(n).fill(0);
    for (const name of enabledNames) {
      const s = indicatorResults[name].scores;
      for (let i = 0; i < n; i++) totalScore[i] += s[i] || 0;
    }

    const minBull = config.confluence?.minBullish ?? 2;
    const minBear = config.confluence?.minBearish ?? 2;
    const cooldown = config.cooldownBars ?? 5;

    const signals = [];
    let lastBuyIdx = -Infinity, lastSellIdx = -Infinity;
    for (let i = 0; i < n; i++) {
      if (totalScore[i] >= minBull && i - lastBuyIdx > cooldown) {
        const entry = candles[i].close;
        const { stopLoss, takeProfit } = computeRisk(entry, "buy", zones, config.risk);
        signals.push({ index: i, time: candles[i].time, side: "buy", price: entry, score: totalScore[i], stopLoss, takeProfit });
        lastBuyIdx = i;
      } else if (totalScore[i] <= -minBear && i - lastSellIdx > cooldown) {
        const entry = candles[i].close;
        const { stopLoss, takeProfit } = computeRisk(entry, "sell", zones, config.risk);
        signals.push({ index: i, time: candles[i].time, side: "sell", price: entry, score: totalScore[i], stopLoss, takeProfit });
        lastSellIdx = i;
      }
    }

    return { swings, zones, trendlines, indicatorResults, totalScore, signals };
  }

  global.Strategy = {
    ema, rsi, macd,
    findSwingPoints, findSRZones, findTrendLines, lineValueAt,
    projectForward, extendTimes,
    registerIndicator, runStrategy,
  };
})(window);
