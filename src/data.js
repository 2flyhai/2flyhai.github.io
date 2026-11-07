// Free market data: Yahoo Finance chart JSON (query2, then query1), Stooq CSV fallback, Yahoo RSS headlines.
// Uses global fetch, so it runs in Node 18+ and Cloudflare Workers. No API keys.
import { analyze } from "./analyze.js";

const UA = "Mozilla/5.0 (compatible; StockAnalyzer/1.0; personal research)";
const HEADERS = { "User-Agent": UA, Accept: "application/json,text/csv,application/xml,*/*" };
const YAHOO_HOSTS = ["query2.finance.yahoo.com", "query1.finance.yahoo.com"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeTicker(raw) {
  const t = String(raw || "").trim().toUpperCase();
  return /^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$/.test(t) ? t : null;
}

// Safe file name for a symbol (^GSPC -> _GSPC, BRK.B -> BRK_B). Same rule in public/app.js.
export const fileKey = (sym) => sym.replace(/[^A-Z0-9]/g, "_");

class NotFound extends Error {}

async function yahooChart(sym, range) {
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&includePrePost=false`;
      let res;
      try {
        res = await fetch(url, { headers: HEADERS });
      } catch (e) {
        lastErr = e;
        break; // network error: try the other host
      }
      if (res.status === 404) throw new NotFound(`Unknown ticker ${sym}`);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${host} answered HTTP ${res.status}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (!res.ok) { lastErr = new Error(`${host} answered HTTP ${res.status}`); break; }
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      if (!r) {
        const msg = json?.chart?.error?.description || "empty chart result";
        if (/no data|not found|delisted/i.test(msg)) throw new NotFound(`${sym}: ${msg}`);
        throw new Error(`${sym}: ${msg}`);
      }
      return r;
    }
  }
  throw lastErr || new Error("Yahoo unavailable");
}

function parseYahoo(r) {
  const m = r.meta || {};
  const off = m.gmtoffset || 0;
  const q = r.indicators?.quote?.[0] || {};
  const ts = r.timestamp || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null || q.open?.[i] == null) continue;
    bars.push({
      date: new Date((ts[i] + off) * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] || 0,
    });
  }
  const now = Date.now() / 1000;
  const reg = m.currentTradingPeriod?.regular;
  const marketOpen = !!(reg && now >= reg.start && now <= reg.end);
  const price = m.regularMarketPrice ?? bars[bars.length - 1]?.close;
  const mtime = m.regularMarketTime || ts[ts.length - 1];
  const mdate = new Date((mtime + off) * 1000).toISOString().slice(0, 10);
  // Yahoo's last daily bar is today's (partial) session; patch it with the live price.
  const lastBar = bars[bars.length - 1];
  if (lastBar && lastBar.date === mdate && price != null) {
    lastBar.close = price;
    lastBar.high = Math.max(lastBar.high, price);
    lastBar.low = Math.min(lastBar.low, price);
  } else if (lastBar && price != null && mdate > lastBar.date) {
    bars.push({ date: mdate, open: price, high: price, low: price, close: price, volume: m.regularMarketVolume || 0 });
  }
  const prevClose = bars.length >= 2 ? bars[bars.length - 2].close : m.chartPreviousClose;
  return {
    name: m.longName || m.shortName || m.symbol,
    currency: m.currency, exchange: m.fullExchangeName || m.exchangeName, type: m.instrumentType,
    marketTime: new Date(mtime * 1000).toISOString(), marketOpen, price, prevClose, bars,
  };
}

// Stooq daily CSV: Date,Open,High,Low,Close,Volume. US listings only (ticker.us).
async function stooqChart(sym) {
  const s = sym.toLowerCase().replace(/\./g, "-") + ".us";
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok || !/^Date,Open/i.test(text)) throw new Error(`Stooq has no data for ${sym}`);
  const rows = text.trim().split(/\r?\n/).slice(1).map((l) => l.split(","));
  const bars = rows
    .filter((c) => c.length >= 5 && !isNaN(+c[4]))
    .map((c) => ({ date: c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] || 0 }))
    .slice(-504);
  if (bars.length < 30) throw new Error(`Stooq has no data for ${sym}`);
  const last = bars[bars.length - 1];
  return {
    name: sym, currency: "USD", exchange: "Stooq (end of day)",
    marketTime: new Date(last.date + "T21:00:00Z").toISOString(), marketOpen: false,
    price: last.close, prevClose: bars[bars.length - 2].close, bars,
  };
}

export async function fetchChart(ticker) {
  const candidates = [ticker];
  if (/^[A-Z]{1,5}\.[A-Z]$/.test(ticker)) candidates.push(ticker.replace(".", "-")); // BRK.B -> BRK-B
  let err;
  for (const sym of candidates) {
    try {
      return { ...parseYahoo(await yahooChart(sym, "2y")), source: "Yahoo Finance" };
    } catch (e) {
      err = e;
      if (!(e instanceof NotFound)) break; // rate limit / outage: go to Stooq
    }
  }
  if (/^[A-Z][A-Z.\-]{0,6}$/.test(ticker)) {
    try {
      return { ...(await stooqChart(ticker)), source: "Stooq" };
    } catch { /* keep the Yahoo error */ }
  }
  throw err;
}

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .trim();

export async function fetchNews(ticker, max = 25) {
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return [];
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t) => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decode(x[1]) : ""; };
    const title = tag("title");
    const link = tag("link");
    if (!title || !/^https?:\/\//.test(link)) continue;
    const d = Date.parse(tag("pubDate"));
    items.push({ title, link, date: isNaN(d) ? null : new Date(d).toISOString(), source: tag("source") || hostOf(link), text: tag("description").slice(0, 300) });
  }
  items.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return items.slice(0, max);
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

const GENERIC = /^(advanced|american|general|united|international|first|the|bank|global|national|new|royal)$/i;

// Yahoo's feed mixes in unrelated market stories; keep items that name the ticker or the company.
function relevant(news, symbol, name, type) {
  if (type && type !== "EQUITY") return news; // ETFs and indices: market news is relevant
  const words = String(name || "").replace(/[,.()]/g, " ").split(/\s+/).filter(Boolean);
  const key = words.length > 1 && GENERIC.test(words[0]) ? `${words[0]} ${words[1]}` : words[0] || symbol;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b(${esc(symbol)}|${esc(key)})\\b`, "i");
  return news.filter((n) => re.test(n.title) || re.test(n.text));
}

// Nasdaq's free earnings data (from Zacks): consensus EPS forecasts, past surprises and the next report date.
// Stocks only; ETFs and indices return nothing. Each call times out after 8 s, and any failure returns null.
const NASDAQ = "https://api.nasdaq.com/api";
const NASDAQ_HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
async function nasdaq(path) {
  try {
    const res = await fetch(`${NASDAQ}/${path}`, { headers: NASDAQ_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json())?.data || null;
  } catch { return null; }
}
const num = (v) => (v == null || v === "" || isNaN(+v) ? null : +v);

export async function fetchEarnings(symbol) {
  const s = encodeURIComponent(symbol.replace("-", ".").toLowerCase());
  const [fc, sp, dt] = await Promise.all([
    nasdaq(`analyst/${s}/earnings-forecast`),
    nasdaq(`company/${s}/earnings-surprise`),
    nasdaq(`analyst/${s}/earnings-date`),
  ]);
  const quarters = (fc?.quarterlyForecast?.rows || []).map((r) => ({
    quarter: r.fiscalEnd, consensus: num(r.consensusEPSForecast), high: num(r.highEPSForecast), low: num(r.lowEPSForecast),
    estimates: num(r.noOfEstimates), up: num(r.up) || 0, down: num(r.down) || 0,
  })).filter((q) => q.consensus != null);
  const history = (sp?.earningsSurpriseTable?.rows || []).map((r) => ({
    quarter: r.fiscalQtrEnd, reported: r.dateReported, eps: num(r.eps), consensus: num(r.consensusForecast), surprisePct: num(r.percentageSurprise),
  })).filter((h) => h.eps != null);
  if (!quarters.length && !history.length) return null;
  const text = String(dt?.reportText || "");
  const date = text.match(/report earnings on\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*(before market open|after market close)?/i);
  const qtr = text.match(/fiscal Quarter ending (\w+ \d{4})/i);
  const ly = text.match(/same quarter last year was\s+\$(-?\d+(?:\.\d+)?)/i);
  return {
    reportDate: date?.[1] || null, reportTime: date?.[2]?.toLowerCase() || null,
    reportQuarter: qtr?.[1] || null, lastYearEps: ly ? +ly[1] : null,
    quarters, history,
  };
}

export async function analyzeTicker(raw) {
  const symbol = normalizeTicker(raw);
  if (!symbol) throw new Error(`Invalid ticker: ${raw}`);
  const chart = await fetchChart(symbol);
  const isStock = !chart.type || chart.type === "EQUITY";
  const [all, earnings] = await Promise.all([
    fetchNews(symbol).catch(() => []),
    isStock && !/[\^=]/.test(symbol) ? fetchEarnings(symbol) : null,
  ]);
  const news = relevant(all, symbol, chart.name, chart.type).slice(0, 8).map(({ text, ...n }) => n);
  const out = analyze({ symbol, ...chart, news, earnings });
  out.source = chart.source;
  out.fetchedAt = new Date().toISOString();
  return out;
}
