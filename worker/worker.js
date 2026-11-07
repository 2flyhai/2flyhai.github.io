// Optional free Cloudflare Worker: live analysis for any ticker from the hosted site (fixes CORS).
// Same API as server.js: /api/ping, /api/analyze?t=AAPL. Deploy: see README "Optional: live proxy".
import { analyzeTicker, normalizeTicker } from "../src/data.js";

// Set ALLOWED_ORIGIN in wrangler.toml to your site (e.g. https://you.github.io) to stop others using your quota.
const cors = (env) => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
});

export default {
  async fetch(request, env, ctx) {
    const h = cors(env);
    if (request.method === "OPTIONS") return new Response(null, { headers: h });
    const url = new URL(request.url);
    if (url.pathname === "/api/ping") return new Response(JSON.stringify({ ok: true, live: true }), { headers: h });
    if (url.pathname !== "/api/analyze") return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: h });

    const t = normalizeTicker(url.searchParams.get("t"));
    if (!t) return new Response(JSON.stringify({ error: "Invalid ticker" }), { status: 400, headers: h });

    // Edge cache for 60 s so many viewers make one upstream request.
    const cacheKey = new Request(`https://cache.local/analyze/${t}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { headers: h });
    try {
      const body = JSON.stringify(await analyzeTicker(t));
      ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { "Cache-Control": "max-age=60" } })));
      return new Response(body, { headers: h });
    } catch (e) {
      const status = /unknown|not found|no data/i.test(e.message) ? 404 : 502;
      return new Response(JSON.stringify({ error: e.message }), { status, headers: h });
    }
  },
};
