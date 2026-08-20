const Parser = require("rss-parser");
const parser = new Parser({ timeout: 10000 });

const FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
];

// Word-boundary match so "sol" doesn't match inside unrelated words.
const COIN_PATTERNS = {
  bitcoin: /\b(bitcoin|btc)\b/i,
  ethereum: /\b(ethereum|eth)\b/i,
  ripple: /\b(ripple|xrp)\b/i,
  litecoin: /\b(litecoin|ltc)\b/i,
  dogecoin: /\b(dogecoin|doge)\b/i,
  solana: /\b(solana|sol)\b/i,
};

let cache = { data: null, expiresAt: 0 };
const NEWS_TTL_MS = 5 * 60_000;

function stripHtml(html = "") {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(text, maxLen = 240) {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  return cut.slice(0, cut.lastIndexOf(" ")) + "…";
}

function tagCoins(text) {
  return Object.entries(COIN_PATTERNS)
    .filter(([, pattern]) => pattern.test(text))
    .map(([coin]) => coin);
}

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    return (parsed.items || []).map((item) => {
      const summaryText = stripHtml(item.contentSnippet || item.content || item.summary || "");
      const haystack = `${item.title || ""} ${summaryText}`;
      return {
        title: item.title,
        url: item.link,
        source: feed.name,
        publishedAt: item.isoDate || item.pubDate || null,
        summary: summarize(summaryText),
        coins: tagCoins(haystack),
      };
    });
  } catch (err) {
    return { error: `${feed.name}: ${err.message}` };
  }
}

async function getNews({ force = false } = {}) {
  if (!force && cache.data && cache.expiresAt > Date.now()) {
    return { articles: cache.data, cached: true };
  }

  const results = await Promise.all(FEEDS.map(fetchFeed));
  const errors = results.filter((r) => r && r.error).map((r) => r.error);
  const articles = results
    .filter((r) => Array.isArray(r))
    .flat()
    .filter((a) => a.coins.length > 0)
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

  cache = { data: articles, expiresAt: Date.now() + NEWS_TTL_MS };
  return { articles, cached: false, errors };
}

module.exports = { getNews, COIN_PATTERNS };
