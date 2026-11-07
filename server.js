// Local server: serves public/ and a tiny live API (the browser cannot call Yahoo directly because of CORS).
//   GET /api/ping              -> {ok:true}
//   GET /api/watchlist         -> ["SPY", ...]
//   GET /api/analyze?t=AAPL    -> live analysis payload (cached 60 s per ticker)
// Run: node server.js   then open http://localhost:8080   (PORT env var to change)
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeTicker, normalizeTicker } from "./src/data.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(root, "public");
const PORT = +process.env.PORT || 8080;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const cache = new Map(); // ticker -> {at, data | promise}
const TTL = 60_000;

const send = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

async function analyzeCached(t) {
  const hit = cache.get(t);
  if (hit && Date.now() - hit.at < TTL) return hit.promise;
  const promise = analyzeTicker(t);
  cache.set(t, { at: Date.now(), promise });
  promise.catch(() => cache.delete(t));
  return promise;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/ping") return send(res, 200, { ok: true, live: true });
    if (url.pathname === "/api/watchlist") return send(res, 200, await readFile(path.join(root, "watchlist.json"), "utf8"));
    if (url.pathname === "/api/analyze") {
      const t = normalizeTicker(url.searchParams.get("t"));
      if (!t) return send(res, 400, { error: "Invalid ticker" });
      try {
        return send(res, 200, await analyzeCached(t));
      } catch (e) {
        return send(res, /unknown|not found|no data/i.test(e.message) ? 404 : 502, { error: e.message });
      }
    }
    // static files
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.normalize(path.join(pub, p));
    if (!file.startsWith(pub)) return send(res, 403, "Forbidden", "text/plain");
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) return send(res, 404, "Not found", "text/plain");
    send(res, 200, await readFile(file), TYPES[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Hai's Stock Analyzer running at http://localhost:${PORT}`));
