// Calendar-month aggregation for daily candle archives, shared by every
// data source that has one (coinbase.js keeps its own inline copy since
// it's already working/tested; yahoo.js and forex.js use this so "1Y"/"2Y"
// etc. show a readable handful of aggregated candles instead of hundreds
// of individual daily bars).

function aggregateMonthly(dailyCandlesAsc) {
  const groups = [];
  let currentKey = null;
  let chunk = [];
  for (const c of dailyCandlesAsc) {
    const d = new Date(c.time * 1000);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (key !== currentKey) {
      if (chunk.length) groups.push(chunk);
      chunk = [];
      currentKey = key;
    }
    chunk.push(c);
  }
  if (chunk.length) groups.push(chunk);

  // drop a trailing in-progress (current calendar month) group
  const last = groups[groups.length - 1];
  if (last) {
    const lastDate = new Date(last[last.length - 1].time * 1000);
    const now = new Date();
    if (lastDate.getUTCFullYear() === now.getUTCFullYear() && lastDate.getUTCMonth() === now.getUTCMonth()) {
      groups.pop();
    }
  }

  return groups.map((c) => ({
    time: c[0].time,
    open: c[0].open,
    close: c[c.length - 1].close,
    high: Math.max(...c.map((x) => x.high)),
    low: Math.min(...c.map((x) => x.low)),
    volume: c.reduce((sum, x) => sum + x.volume, 0),
  }));
}

// Groups consecutive monthly candles into fixed-size spans (e.g. 3 for
// quarterly, 12 for yearly). Not calendar-quarter-aligned — just N months
// at a time, dropping a leftover partial span at the (most recent) end.
function aggregateFromMonthly(monthlyCandlesAsc, groupSize) {
  const out = [];
  for (let i = 0; i < monthlyCandlesAsc.length; i += groupSize) {
    const chunk = monthlyCandlesAsc.slice(i, i + groupSize);
    if (chunk.length < groupSize) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      close: chunk[chunk.length - 1].close,
      high: Math.max(...chunk.map((x) => x.high)),
      low: Math.min(...chunk.map((x) => x.low)),
      volume: chunk.reduce((sum, x) => sum + x.volume, 0),
    });
  }
  return out;
}

const LONG_AGGREGATE_INTERVALS = {
  "1M": { groupMonths: 1 },
  "3M": { groupMonths: 3 },
  "6M": { groupMonths: 6 },
  "1Y": { groupMonths: 12 },
  "2Y": { groupMonths: 24 },
};

module.exports = { aggregateMonthly, aggregateFromMonthly, LONG_AGGREGATE_INTERVALS };
