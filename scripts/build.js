// Fetches every watchlist ticker, runs the analysis and writes static JSON to public/data/.
// Run: node scripts/build.js   (optional: node scripts/build.js AAPL MSFT to build only those)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeTicker, normalizeTicker, fileKey } from "../src/data.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "public", "data");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const list = args.length ? args : JSON.parse(await readFile(path.join(root, "watchlist.json"), "utf8"));
const tickers = [...new Set(list.map(normalizeTicker).filter(Boolean))];
await mkdir(outDir, { recursive: true });

const summary = [];
let failures = 0;
for (const t of tickers) {
  try {
    const a = await analyzeTicker(t);
    await writeFile(path.join(outDir, `${fileKey(t)}.json`), JSON.stringify(a));
    summary.push({ symbol: t, name: a.name, price: a.price, changePct: a.changePct, verdict: a.verdict, score: a.score, currency: a.currency, marketTime: a.marketTime, spark: a.series.bars.slice(-30).map((b) => b[4]) });
    console.log(`${t.padEnd(8)} ${String(a.price).padStart(10)}  ${a.verdict.padEnd(8)} score ${a.score}  (${a.source})`);
  } catch (e) {
    failures++;
    summary.push({ symbol: t, error: String(e.message || e) });
    console.error(`${t.padEnd(8)} FAILED: ${e.message || e}`);
  }
  await sleep(400); // be polite to the free endpoints
}

await writeFile(
  path.join(outDir, "index.json"),
  JSON.stringify({ updatedAt: new Date().toISOString(), tickers: summary }, null, 1)
);
// For search engines: robots.txt and sitemap.xml need the public URL (SITE_URL, set by the GitHub Action).
const site = (process.env.SITE_URL || "").replace(/\/?$/, "/");
if (site !== "/") {
  await writeFile(path.join(root, "public", "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${site}sitemap.xml\n`);
  await writeFile(path.join(root, "public", "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${site}</loc><lastmod>${new Date().toISOString().slice(0, 10)}</lastmod><changefreq>daily</changefreq></url>\n</urlset>\n`);
  console.log(`Wrote robots.txt and sitemap.xml for ${site}`);
}
console.log(`\nWrote ${tickers.length - failures}/${tickers.length} tickers to public/data/`);
if (failures === tickers.length) process.exit(1); // nothing worked: fail the CI run so the old site stays up
