// Local on-disk cache of daily candles per product, so history keeps
// accumulating over time (recorded going forward) instead of being purely
// dependent on how far back a live exchange API will paginate on demand.
const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data", "history");

function filePathFor(product) {
  return path.join(DATA_DIR, `${product}.json`);
}

async function loadStoredDaily(product) {
  try {
    const raw = await fs.readFile(filePathFor(product), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveStoredDaily(product, candles) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(filePathFor(product), JSON.stringify(candles));
}

function mergeDedupe(...candleArrays) {
  const byTime = new Map();
  for (const arr of candleArrays) for (const c of arr) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

module.exports = { loadStoredDaily, saveStoredDaily, mergeDedupe };
