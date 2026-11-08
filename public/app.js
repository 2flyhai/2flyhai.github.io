"use strict";
// Hai's Stock Analyzer front end. Data modes:
//  live   - served by `node server.js` (or a proxyUrl Worker): any ticker, live price, auto-refresh
//  static - GitHub/Cloudflare Pages: prebuilt data/*.json from the scheduled build
const CFG = window.STOCK_CONFIG || {};
const APP = "Hai's Stock Analyzer";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fileKey = (sym) => sym.replace(/[^A-Z0-9]/g, "_");
const norm = (raw) => { const t = String(raw || "").trim().toUpperCase(); return /^[A-Z0-9^][A-Z0-9.\-=^]{0,14}$/.test(t) ? t : null; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const state = {
  api: null, index: null, watch: [], custom: store.get("custom", []), rows: {}, sel: null, cur: null,
  chart: null, sub: null, refs: null, timer: null,
  range: store.get("range", "1Y"),
  overlays: { sma20: true, sma50: true, sma200: true, levels: true, volume: true, ...store.get("overlays", {}) },
  pane: store.get("pane", "rsi"),
  filter: "all", sort: store.get("sort", "list"), search: "", newsTone: "all",
  theme: store.get("theme", "auto"),
};

const apiUrl = (p) => (state.api ? state.api + "/" : "") + p;

async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  const isJson = (r.headers.get("content-type") || "").includes("json");
  const body = isJson ? await r.json() : null;
  if (!r.ok || !body) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}

async function detectApi() {
  try { if ((await getJson("api/ping")).ok) return ""; } catch { /* not the local server */ }
  const p = (CFG.proxyUrl || "").replace(/\/+$/, "");
  if (p) { try { if ((await getJson(p + "/api/ping")).ok) return p; } catch { /* proxy down */ } }
  return null;
}

// ---------- formatting ----------
function fmtPrice(v, cur = "USD") {
  if (v == null) return "–";
  const d = Math.abs(v) < 1 ? 4 : 2;
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(v); }
  catch { return v.toFixed(d); }
}
const fmtNum = (v, d = 2) => (v == null ? "–" : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtVol = (v) => (v == null ? "–" : v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(v));
const fmtPct = (v) => (v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(2) + "%");
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");
const fmtDate = (s) => new Date(s + "T12:00:00Z").toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

// ---------- data ----------
async function loadIndex() {
  try { state.index = await getJson("data/index.json"); } catch { state.index = null; }
  if (state.index) state.watch = state.index.tickers.map((t) => t.symbol);
  else if (state.api !== null) { try { state.watch = await getJson(apiUrl("api/watchlist")); } catch { state.watch = []; } }
  for (const t of state.index?.tickers || []) state.rows[t.symbol] = t;
}

async function fetchTicker(sym) {
  if (state.api !== null) {
    try { return await getJson(apiUrl("api/analyze?t=" + encodeURIComponent(sym))); }
    catch (e) {
      try { return await getJson(`data/${fileKey(sym)}.json`); } catch { throw e; }
    }
  }
  try { return await getJson(`data/${fileKey(sym)}.json`); }
  catch {
    throw new Error(`${sym} is not in the prebuilt data. Add it to watchlist.json (it appears after the next scheduled build), or set up the free proxy in config.js for any ticker.`);
  }
}

// ---------- sidebar ----------
function allSyms() { return [...state.watch, ...state.custom.filter((c) => !state.watch.includes(c))]; }

function visibleSyms() {
  const q = state.search.trim().toLowerCase();
  let list = allSyms().filter((s) => {
    const r = state.rows[s] || {};
    if (state.filter !== "all" && r.verdict !== state.filter) return false;
    return !q || s.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q);
  });
  const val = (s, k) => state.rows[s]?.[k] ?? -Infinity;
  if (state.sort === "score") list.sort((a, b) => val(b, "score") - val(a, "score"));
  else if (state.sort === "change") list.sort((a, b) => val(b, "changePct") - val(a, "changePct"));
  else if (state.sort === "az") list.sort();
  return list;
}

function spark(vals) {
  if (!vals || vals.length < 2) return "";
  const lo = Math.min(...vals), hi = Math.max(...vals), w = 56, h = 18;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / (hi - lo || 1)) * h).toFixed(1)}`).join(" ");
  const c = vals[vals.length - 1] >= vals[0] ? "var(--up)" : "var(--down)";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}

function renderFilters() {
  const syms = allSyms();
  const count = (v) => syms.filter((s) => state.rows[s]?.verdict === v).length;
  const n = { all: syms.length, bullish: count("bullish"), neutral: count("neutral"), bearish: count("bearish") };
  $("#filters").innerHTML = ["all", "bullish", "neutral", "bearish"].map((f) =>
    `<button type="button" class="fchip ${f}${state.filter === f ? " on" : ""}" data-f="${f}" aria-pressed="${state.filter === f}">${f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)} <b>${n[f]}</b></button>`).join("");
  const tot = n.bullish + n.neutral + n.bearish || 1;
  $("#mix").innerHTML = ["bullish", "neutral", "bearish"].map((v) => `<span class="${v}" style="width:${(n[v] / tot) * 100}%"></span>`).join("");
}

function renderList() {
  renderFilters();
  const ul = $("#list");
  const list = visibleSyms();
  if (!list.length) { ul.innerHTML = `<li class="none muted small">No tickers match.</li>`; return; }
  ul.innerHTML = list.map((s) => {
    const r = state.rows[s] || {};
    const custom = !state.watch.includes(s);
    const chip = r.error ? `<span class="chip err">n/a</span>` : r.verdict ? `<span class="chip ${r.verdict}">${r.verdict}</span>` : `<span class="chip err">…</span>`;
    return `<li class="row${s === state.sel ? " sel" : ""}" data-s="${esc(s)}" tabindex="0" role="button" aria-label="${esc(s)} ${esc(r.verdict || "")}">
      ${custom ? `<button class="x" data-x="${esc(s)}" title="Remove ${esc(s)}" aria-label="Remove ${esc(s)}">×</button>` : ""}
      <span class="sym">${esc(s)}</span>
      <span class="sp">${spark(r.spark)}</span>
      <span class="px">${r.price != null ? fmtPrice(r.price, r.currency) : ""}</span>
      <span class="nm">${esc(r.name || (r.error ? "No data" : ""))}</span>
      <span class="meta"><span class="${cls(r.changePct)}">${r.changePct != null ? fmtPct(r.changePct) : ""}</span>${chip}</span>
    </li>`;
  }).join("");
}

function setRow(d) {
  state.rows[d.symbol] = {
    symbol: d.symbol, name: d.name, price: d.price, changePct: d.changePct, verdict: d.verdict, score: d.score,
    currency: d.currency, spark: d.series.bars.slice(-30).map((b) => b[4]),
  };
}

async function refreshAllRows() {
  if (state.api === null) return;
  for (const s of allSyms()) {
    if (s === state.sel) continue;
    try { setRow(await fetchTicker(s)); } catch { state.rows[s] = { ...(state.rows[s] || {}), error: true }; }
    renderList();
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------- detail ----------
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function bar(pos, label, zones = "") {
  const p = Math.max(0, Math.min(100, pos));
  return `<div class="bar" role="img" aria-label="${esc(label)}">${zones}<div class="fill" style="width:${p}%"></div><div class="pin" style="left:${p}%"></div></div>`;
}

const OVERLAYS = [
  ["sma20", "SMA 20", "--sma20"], ["sma50", "SMA 50", "--sma50"], ["sma200", "SMA 200", "--sma200"],
  ["levels", "Support / resistance", "--accent"], ["volume", "Volume", "--muted"],
];

function renderDetail(d) {
  state.cur = d;
  const i = d.indicators;
  const cur = d.currency;
  const px = (v) => fmtPrice(v, cur);
  const vs = (ma) => (ma == null ? "" : ` <span class="${cls(d.price - ma)} small">${fmtPct(((d.price - ma) / ma) * 100)}</span>`);
  const icon = (w) => (w > 0 ? `<span class="ic up">+</span>` : w < 0 ? `<span class="ic down">−</span>` : `<span class="ic muted">•</span>`);
  const rsiNote = i.rsi == null ? "" : i.rsi >= 70 ? "Overbought" : i.rsi <= 30 ? "Oversold" : i.rsi >= 50 ? "Positive momentum" : "Weak momentum";
  const lvl = (arr, kind) => arr.length
    ? arr.map((l) => `<dt>${kind} <span class="muted small">(${l.touches} touch${l.touches > 1 ? "es" : ""})</span></dt><dd><button type="button" class="lv" data-price="${l.price}" title="Show on chart">${px(l.price)}</button> <span class="muted small">${fmtPct(((l.price - d.price) / d.price) * 100)}</span></dd>`).join("")
    : `<dt>${kind}</dt><dd class="muted">none nearby</dd>`;
  const scorePos = ((Math.max(-8, Math.min(8, d.score)) + 8) / 16) * 100;
  const tones = { all: d.news.length, positive: 0, negative: 0, neutral: 0 };
  d.news.forEach((n) => tones[n.tone]++);

  $("#main").innerHTML = `
  <section class="card">
    <div class="head">
      <div>
        <p class="title">${esc(d.symbol)} <span class="chip ${d.verdict}">${d.verdict}</span></p>
        <div class="sub">${esc(d.name)}${d.exchange ? " · " + esc(d.exchange) : ""} · ${esc(cur)}</div>
        <div class="actions">
          <button type="button" class="ghost" id="refresh" title="Refresh (R)">↻ Refresh</button>
          <button type="button" class="ghost" id="share" title="Copy a link to this ticker">🔗 Copy link</button>
        </div>
      </div>
      <div>
        <div class="price" id="livePrice">${px(d.price)}</div>
        <div class="chg ${cls(d.change)}">${d.change > 0 ? "+" : ""}${fmtNum(d.change)} (${fmtPct(d.changePct)})</div>
        <div class="asof">${d.marketOpen ? `<span class="dot-live"></span>Market open · ` : "Market closed · "}price as of ${fmtTime(d.marketTime)} · ${esc(d.source || "")}</div>
      </div>
    </div>
  </section>

  <section class="card" data-k="verdict">
    <h3>Daily verdict</h3>
    <div class="verdict">
      <div class="vleft">
        <span class="chip vbig ${d.verdict}">${d.verdict}</span>
        <div class="meter" title="Score ${d.score} on a -8 to +8 scale">
          <div class="meter-track"><span class="mz bear"></span><span class="mz neu"></span><span class="mz bull"></span></div>
          <div class="meter-pin" style="left:${scorePos}%"></div>
          <div class="meter-l"><span>-8</span><span>score ${d.score > 0 ? "+" : ""}${d.score}</span><span>+8</span></div>
        </div>
      </div>
      <div>
        <p class="vtext">${esc(d.headline)}</p>
        <ul class="reasons">${d.reasons.map((r) => `<li><button type="button" class="reason" data-k="${esc(r.key || "")}" title="Show details">${icon(r.weight)}<span>${esc(r.text)}</span></button></li>`).join("")}</ul>
        <p class="note">Tip: click a reason to jump to its panel.</p>
      </div>
    </div>
  </section>

  <section class="card" data-k="chart">
    <div class="chartbar">
      <div class="toggles" role="group" aria-label="Chart overlays">${OVERLAYS.map(([k, label, c]) =>
        `<button type="button" class="tog${state.overlays[k] ? " on" : ""}" data-o="${k}" aria-pressed="${state.overlays[k]}"><i style="background:var(${c})"></i>${label}</button>`).join("")}</div>
      <div class="seg" role="group" aria-label="Chart range">${["3M", "6M", "1Y", "2Y"].map((r) => `<button type="button" data-r="${r}" class="${r === state.range ? "on" : ""}">${r}</button>`).join("")}</div>
    </div>
    <div class="chartwrap">
      <div id="chart"></div>
      <div id="tip" class="tip" aria-live="off"></div>
    </div>
    <div class="panebar">
      <div class="seg" role="tablist" aria-label="Indicator">${[["rsi", "RSI"], ["macd", "MACD"]].map(([k, l]) => `<button type="button" role="tab" data-p="${k}" aria-selected="${state.pane === k}" class="${state.pane === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <span id="paneVal" class="muted small"></span>
    </div>
    <div id="subchart"></div>
  </section>

  <div class="grid">
    <section class="card" data-k="trend"><h3>Trend (moving averages)</h3>
      <dl class="kv"><dt><i class="sw" style="background:var(--sma20)"></i>SMA 20</dt><dd>${px(i.sma20)}${vs(i.sma20)}</dd><dt><i class="sw" style="background:var(--sma50)"></i>SMA 50</dt><dd>${px(i.sma50)}${vs(i.sma50)}</dd><dt><i class="sw" style="background:var(--sma200)"></i>SMA 200</dt><dd>${i.sma200 == null ? "n/a" : px(i.sma200) + vs(i.sma200)}</dd></dl>
      <p class="note">Percent shows how far price is above or below each average. Hover to highlight the lines.</p>
    </section>
    <section class="card" data-k="rsi"><h3>RSI (14)</h3>
      <dl class="kv"><dt>Value</dt><dd>${fmtNum(i.rsi, 1)}</dd><dt>Reading</dt><dd>${rsiNote}</dd></dl>
      ${bar(i.rsi ?? 50, "RSI " + i.rsi, `<span class="zone" style="left:0;width:30%"></span><span class="zone" style="left:70%;width:30%"></span>`)}<div class="bar-l"><span>0</span><span>30</span><span>50</span><span>70</span><span>100</span></div>
    </section>
    <section class="card" data-k="macd"><h3>MACD (12, 26, 9)</h3>
      <dl class="kv"><dt>MACD line</dt><dd>${fmtNum(i.macd, 3)}</dd><dt>Signal</dt><dd>${fmtNum(i.macdSignal, 3)}</dd><dt>Histogram</dt><dd class="${cls(i.macdHist)}">${fmtNum(i.macdHist, 3)}</dd></dl>
      <p class="note">${i.macdHist > 0 ? "Line above signal: momentum rising." : "Line below signal: momentum fading."}</p>
    </section>
    <section class="card" data-k="volume"><h3>Volume</h3>
      <dl class="kv"><dt>${d.marketOpen ? "Today so far" : "Last session"}</dt><dd>${fmtVol(i.volume)}</dd><dt>20-day average</dt><dd>${fmtVol(i.avgVolume20)}</dd><dt>Ratio</dt><dd class="${i.volumeRatio >= 1.5 ? "up" : ""}">${fmtNum(i.volumeRatio)}x</dd></dl>
      ${bar(Math.min(100, (i.volumeRatio || 0) * 50), "Volume ratio " + i.volumeRatio)}<div class="bar-l"><span>0x</span><span>1x avg</span><span>2x+</span></div>
    </section>
    <section class="card" data-k="levels"><h3>Support / resistance</h3>
      <dl class="kv">${lvl(i.resistances, "Resistance")}${lvl(i.supports, "Support")}</dl>
      <p class="note">Swing highs and lows from 6 months, grouped within 1.5%. Click a price to mark it on the chart.</p>
    </section>
    <section class="card" data-k="range"><h3>52-week range</h3>
      <dl class="kv"><dt>Low</dt><dd>${px(i.low52)}</dd><dt>High</dt><dd>${px(i.high52)}</dd><dt>Off high</dt><dd>${fmtPct(((d.price - i.high52) / i.high52) * 100)}</dd></dl>
      ${bar(i.pos52, "Position in 52-week range " + i.pos52 + "%")}<div class="bar-l"><span>Low</span><span>${fmtNum(i.pos52, 0)}% of range</span><span>High</span></div>
    </section>
  </div>

  ${earningsCard(d, px)}

  <section class="card" data-k="news">
    <div class="newsbar">
      <h3>Recent news</h3>
      ${d.news.length ? `<div class="seg" role="group" aria-label="Filter headlines">${["all", "positive", "negative", "neutral"].map((t) => `<button type="button" data-t="${t}" class="${state.newsTone === t ? "on" : ""}">${t[0].toUpperCase() + t.slice(1)} ${tones[t]}</button>`).join("")}</div>` : ""}
    </div>
    <p>${esc(d.newsSummary)}</p>
    <ul class="news" id="newsList"></ul>
    <p class="note">Headlines from the free Yahoo Finance RSS feed. Dot colour is a keyword guess at tone.</p>
  </section>
  <p class="muted small">Analysis computed ${fmtTime(d.fetchedAt)}. Not financial advice.</p>`;

  renderNews();
  drawCharts(d);
  wireDetail();
}

function earningsCard(d, px) {
  const e = d.earnings;
  if (!e) return "";
  const n = e.next;
  const when = e.reportDate
    ? `${esc(e.reportDate)}${e.reportTime ? ` <span class="muted small">${esc(e.reportTime)}</span>` : ""}${e.daysToReport != null && e.daysToReport >= 0 ? ` <span class="chip ${e.daysToReport <= 14 ? "neutral" : ""} small">in ${e.daysToReport} day${e.daysToReport === 1 ? "" : "s"}</span>` : ""}`
    : `<span class="muted">not announced yet</span>`;
  const maxS = Math.max(1, ...e.history.map((h) => Math.abs(h.surprisePct || 0)));
  const rows = e.history.map((h) => {
    const s = h.surprisePct;
    const w = s == null ? 0 : (Math.abs(s) / maxS) * 100;
    return `<tr><td>${esc(h.quarter)}</td><td class="muted">${esc(h.reported || "")}</td><td>${px(h.eps)}</td><td>${px(h.consensus)}</td>
      <td class="${cls(s)}"><span class="sbar"><i class="${s > 0 ? "up" : "down"}" style="width:${w}%"></i></span>${s == null ? "n/a" : fmtPct(s)}</td>
      <td>${s > 0 ? `<span class="chip bullish">beat</span>` : s < 0 ? `<span class="chip bearish">miss</span>` : `<span class="chip neutral">met</span>`}</td></tr>`;
  }).join("");
  return `
  <section class="card" data-k="earnings">
    <div class="newsbar"><h3>Earnings</h3>
      ${e.history.length ? `<span class="small ${e.beats >= 3 ? "up" : e.history.length - e.beats >= 2 ? "down" : "muted"}">Beat ${e.beats} of ${e.history.length}${e.streak >= 2 ? ` · ${e.streak} in a row` : ""}${e.avgSurprise != null ? ` · avg surprise ${fmtPct(e.avgSurprise)}` : ""}</span>` : ""}
    </div>
    <div class="egrid">
      <dl class="kv">
        <dt>Next report</dt><dd>${when}</dd>
        ${n ? `<dt>Quarter</dt><dd>${esc(e.reportQuarter || n.quarter)}</dd>
        <dt>Consensus EPS</dt><dd>${px(n.consensus)} <span class="muted small">(${n.estimates ?? "?"} analysts)</span></dd>
        <dt>Estimate range</dt><dd>${px(n.low)} to ${px(n.high)}</dd>
        <dt>Revisions, 4 wks</dt><dd><span class="up">▲ ${n.up}</span> <span class="down">▼ ${n.down}</span></dd>` : ""}
        ${e.lastYearEps != null ? `<dt>Same quarter last year</dt><dd>${px(e.lastYearEps)}${n ? ` <span class="${cls(n.consensus - e.lastYearEps)} small">${fmtPct(((n.consensus - e.lastYearEps) / Math.abs(e.lastYearEps)) * 100)} expected growth</span>` : ""}</dd>` : ""}
        ${e.beatAdjusted != null ? `<dt title="Consensus scaled by the average surprise of the last quarters">Beat-adjusted est.</dt><dd><b>${px(e.beatAdjusted)}</b> <span class="muted small">if the usual ${fmtPct(e.avgSurprise)} surprise repeats</span></dd>` : ""}
      </dl>
      ${rows ? `<div class="etable"><table><thead><tr><th>Quarter</th><th>Reported</th><th>Actual</th><th>Consensus</th><th>Surprise</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    </div>
    <p class="note">Consensus data from Nasdaq (Zacks). Whisper numbers (the unofficial estimate traders expect, e.g. on EarningsWhispers) have no free feed. The beat-adjusted estimate is a rough stand-in: if a company keeps beating, the street usually expects more than the consensus. A stock can still fall after a beat if the whisper was higher.</p>
  </section>`;
}

function renderNews() {
  const d = state.cur;
  const list = d.news.filter((n) => state.newsTone === "all" || n.tone === state.newsTone);
  $("#newsList").innerHTML = list.length
    ? list.map((n) => `<li><span class="dot ${n.tone}" title="${n.tone}"></span><div><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><div class="src">${esc(n.source)}${n.date ? " · " + ago(n.date) : ""}</div></div></li>`).join("")
    : d.news.length ? `<li class="muted small">No ${state.newsTone} headlines.</li>` : "";
}

function flash(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

function wireDetail() {
  const main = $("#main");
  $$(".seg [data-r]", main).forEach((b) => b.addEventListener("click", () => setRange(b.dataset.r)));
  $$(".tog", main).forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.o;
    state.overlays[k] = !state.overlays[k];
    store.set("overlays", state.overlays);
    b.classList.toggle("on", state.overlays[k]);
    b.setAttribute("aria-pressed", state.overlays[k]);
    applyOverlays();
  }));
  $$("[data-p]", main).forEach((b) => b.addEventListener("click", () => {
    state.pane = b.dataset.p;
    store.set("pane", state.pane);
    $$("[data-p]", main).forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", x === b); });
    applyPane();
  }));
  $$("[data-t]", main).forEach((b) => b.addEventListener("click", () => {
    state.newsTone = b.dataset.t;
    $$("[data-t]", main).forEach((x) => x.classList.toggle("on", x === b));
    renderNews();
  }));
  $$(".reason", main).forEach((b) => {
    const target = () => (b.dataset.k ? $(`.card[data-k="${b.dataset.k}"]`, main) : null);
    b.addEventListener("click", () => flash(target()));
    b.addEventListener("mouseenter", () => target()?.classList.add("hl"));
    b.addEventListener("mouseleave", () => target()?.classList.remove("hl"));
  });
  $$(".lv", main).forEach((b) => b.addEventListener("click", () => markLevel(+b.dataset.price)));
  const trend = $('.card[data-k="trend"]', main);
  trend.addEventListener("mouseenter", () => emphasizeSma(true));
  trend.addEventListener("mouseleave", () => emphasizeSma(false));
  $("#refresh").addEventListener("click", () => refreshSelected());
  $("#share").addEventListener("click", async () => {
    const url = location.href.split("#")[0] + "#" + encodeURIComponent(state.sel);
    try { await navigator.clipboard.writeText(url); toast("Link copied."); } catch { toast(url); }
  });
}

// ---------- charts ----------
function chartOpts(LC, height) {
  const text = cssVar("--muted"), line = cssVar("--line");
  return {
    autoSize: true, height,
    layout: { background: { type: "solid", color: "transparent" }, textColor: text, fontFamily: "system-ui, sans-serif" },
    grid: { vertLines: { color: line }, horzLines: { color: line } },
    rightPriceScale: { borderColor: line, minimumWidth: 72 },
    timeScale: { borderColor: line },
    crosshair: { mode: LC.CrosshairMode.Normal },
  };
}

function destroyCharts() {
  if (state.chart) state.chart.remove();
  if (state.sub) state.sub.remove();
  state.chart = state.sub = state.refs = null;
}

function drawCharts(d) {
  destroyCharts();
  const el = $("#chart");
  if (!window.LightweightCharts) { el.outerHTML = `<div class="chart-err">Chart library did not load (offline or blocked CDN).</div>`; $("#subchart").remove(); return; }
  const LC = window.LightweightCharts;
  const b = d.series.bars;
  const up = cssVar("--up"), down = cssVar("--down");
  const chart = LC.createChart(el, chartOpts(LC));
  const candles = chart.addCandlestickSeries({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
  candles.setData(b.map(([time, open, high, low, close]) => ({ time, open, high, low, close })));
  const sma = {};
  for (const k of ["sma20", "sma50", "sma200"]) {
    sma[k] = chart.addLineSeries({ color: cssVar("--" + k), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    sma[k].setData(b.map((x, i) => (d.series[k][i] == null ? { time: x[0] } : { time: x[0], value: d.series[k][i] })));
  }
  const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vol.setData(b.map(([time, o, , , c, v]) => ({ time, value: v, color: (c >= o ? up : down) + "66" })));

  // indicator pane
  const sub = LC.createChart($("#subchart"), { ...chartOpts(LC), timeScale: { visible: false, borderColor: cssVar("--line") } });
  const rsiS = sub.addLineSeries({ color: cssVar("--accent"), lineWidth: 2, priceLineVisible: false });
  rsiS.setData(b.map((x, i) => (d.series.rsi[i] == null ? { time: x[0] } : { time: x[0], value: d.series.rsi[i] })));
  const rsiLines = [70, 30].map((p) => rsiS.createPriceLine({ price: p, color: p === 70 ? down : up, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: p === 70 ? "overbought" : "oversold" }));
  const hasMacd = Array.isArray(d.series.macd);
  const histS = sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  histS.setData(b.map((x, i) => (d.series.macdHist[i] == null ? { time: x[0] } : { time: x[0], value: d.series.macdHist[i], color: (d.series.macdHist[i] >= 0 ? up : down) + "99" })));
  const macdS = sub.addLineSeries({ color: cssVar("--sma20"), lineWidth: 2, priceLineVisible: false });
  const sigS = sub.addLineSeries({ color: cssVar("--sma50"), lineWidth: 2, priceLineVisible: false });
  if (hasMacd) {
    macdS.setData(b.map((x, i) => (d.series.macd[i] == null ? { time: x[0] } : { time: x[0], value: d.series.macd[i] })));
    sigS.setData(b.map((x, i) => (d.series.macdSignal[i] == null ? { time: x[0] } : { time: x[0], value: d.series.macdSignal[i] })));
  }

  state.chart = chart;
  state.sub = sub;
  state.refs = { LC, candles, sma, vol, rsiS, rsiLines, histS, macdS, sigS, levelLines: [], mark: null, idx: new Map(b.map((x, i) => [x[0], i])) };

  // keep the two panes in step
  let syncing = false;
  const link = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (syncing || !r) return;
    syncing = true; to.timeScale().setVisibleLogicalRange(r); syncing = false;
  });
  link(chart, sub); link(sub, chart);
  chart.subscribeCrosshairMove((p) => {
    const i = p.time != null ? state.refs.idx.get(p.time) : undefined;
    updateTip(i);
    if (sub.setCrosshairPosition) {
      if (i == null) sub.clearCrosshairPosition();
      else if (state.pane === "rsi" && d.series.rsi[i] != null) sub.setCrosshairPosition(d.series.rsi[i], p.time, rsiS);
      else if (state.pane === "macd" && d.series.macdHist[i] != null) sub.setCrosshairPosition(d.series.macdHist[i], p.time, histS);
    }
  });
  sub.subscribeCrosshairMove((p) => updateTip(p.time != null ? state.refs.idx.get(p.time) : undefined));

  applyOverlays();
  applyPane();
  applyRange();
  updateTip();
}

function updateTip(i) {
  const d = state.cur, s = d.series;
  if (!s) return;
  const n = s.bars.length - 1;
  const k = i == null ? n : i;
  const [date, o, h, l, c, v] = s.bars[k];
  const prev = k > 0 ? s.bars[k - 1][4] : null;
  const ch = prev ? ((c - prev) / prev) * 100 : null;
  const px = (x) => fmtPrice(x, d.currency);
  const ma = [["sma20", "20"], ["sma50", "50"], ["sma200", "200"]].filter(([key]) => state.overlays[key] && s[key][k] != null)
    .map(([key, lab]) => `<span><i style="background:var(--${key})"></i>${lab}: ${px(s[key][k])}</span>`).join("");
  $("#tip").innerHTML = `<b>${fmtDate(date)}</b>${i == null ? ' <span class="muted">(latest)</span>' : ""}
    <div>O ${px(o)} · H ${px(h)} · L ${px(l)} · C <b>${px(c)}</b> <span class="${cls(ch)}">${fmtPct(ch)}</span> · Vol ${fmtVol(v)}</div>
    ${ma ? `<div class="tma">${ma}</div>` : ""}`;
  const pv = $("#paneVal");
  if (pv) {
    pv.innerHTML = state.pane === "rsi"
      ? `RSI ${fmtNum(s.rsi[k], 1)} · above 70 overbought, below 30 oversold`
      : Array.isArray(s.macd) ? `MACD ${fmtNum(s.macd[k], 3)} · signal ${fmtNum(s.macdSignal[k], 3)} · hist <span class="${cls(s.macdHist[k])}">${fmtNum(s.macdHist[k], 3)}</span>` : `Histogram ${fmtNum(s.macdHist[k], 3)}`;
  }
}

function applyOverlays() {
  const r = state.refs;
  if (!r) return;
  const o = state.overlays;
  for (const k of ["sma20", "sma50", "sma200"]) r.sma[k].applyOptions({ visible: o[k] });
  r.vol.applyOptions({ visible: o.volume });
  r.levelLines.forEach((l) => r.candles.removePriceLine(l));
  r.levelLines = [];
  if (o.levels) {
    const ind = state.cur.indicators;
    for (const s of ind.supports) r.levelLines.push(r.candles.createPriceLine({ price: s.price, color: cssVar("--up"), lineWidth: 1, lineStyle: r.LC.LineStyle.Dashed, axisLabelVisible: true, title: "S" }));
    for (const x of ind.resistances) r.levelLines.push(r.candles.createPriceLine({ price: x.price, color: cssVar("--down"), lineWidth: 1, lineStyle: r.LC.LineStyle.Dashed, axisLabelVisible: true, title: "R" }));
  }
  updateTip();
}

function applyPane() {
  const r = state.refs;
  if (!r) return;
  const rsi = state.pane === "rsi";
  r.rsiS.applyOptions({ visible: rsi });
  r.histS.applyOptions({ visible: !rsi });
  r.macdS.applyOptions({ visible: !rsi });
  r.sigS.applyOptions({ visible: !rsi });
  state.sub.priceScale("right").applyOptions({ autoScale: true });
  updateTip();
}

function emphasizeSma(on) {
  const r = state.refs;
  if (!r) return;
  for (const k of ["sma20", "sma50", "sma200"]) r.sma[k].applyOptions({ lineWidth: on ? 4 : 2 });
}

function markLevel(price) {
  const r = state.refs;
  if (!r) return;
  if (r.mark) r.candles.removePriceLine(r.mark);
  r.mark = r.candles.createPriceLine({ price, color: cssVar("--accent"), lineWidth: 3, lineStyle: r.LC.LineStyle.Solid, axisLabelVisible: true, title: "marked" });
  flash($('.card[data-k="chart"]'));
  toast(`Marked ${fmtPrice(price, state.cur.currency)} on the chart.`);
}

function setRange(r) {
  state.range = r;
  store.set("range", r);
  $$(".seg [data-r]").forEach((x) => x.classList.toggle("on", x.dataset.r === r));
  applyRange();
}

function applyRange() {
  if (!state.chart || !state.cur) return;
  const n = state.cur.series.bars.length;
  const days = { "3M": 63, "6M": 126, "1Y": 252, "2Y": 504 }[state.range] || 252;
  state.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - days), to: n + 2 });
}

// ---------- selection ----------
function renderError(sym, msg) {
  destroyCharts();
  state.cur = null;
  $("#main").innerHTML = `<section class="card err-card"><h3>${esc(sym)}</h3><p>${esc(msg)}</p></section>`;
}

function skeleton(sym) {
  destroyCharts();
  $("#main").innerHTML = `<section class="card"><p class="title">${esc(sym)}</p><div class="skel w40"></div><div class="skel w20"></div></section>
    <section class="card"><div class="skel w60"></div><div class="skel w80"></div><div class="skel w70"></div></section>
    <section class="card"><div class="skel tall"></div></section>`;
}

async function select(sym, { quiet = false, add = false } = {}) {
  state.sel = sym;
  if (decodeURIComponent(location.hash.slice(1)) !== sym) history.replaceState(null, "", "#" + encodeURIComponent(sym));
  renderList();
  if (!quiet) skeleton(sym);
  try {
    const d = await fetchTicker(sym);
    if (state.sel !== sym) return;
    if (add && !allSyms().includes(sym)) { state.custom.push(sym); store.set("custom", state.custom); toast(`Added ${sym}.`); }
    const old = state.cur?.symbol === sym ? state.cur.price : null;
    setRow(d);
    renderList();
    const scroll = window.scrollY;
    renderDetail(d);
    if (quiet) {
      window.scrollTo(0, scroll);
      if (old != null && old !== d.price) $("#livePrice").classList.add(d.price > old ? "tick-up" : "tick-down");
    }
    document.title = `${sym} ${fmtPrice(d.price, d.currency)} · ${APP}`;
    if (state.api !== null) $("#updated").textContent = "Live data · fetched " + fmtTime(d.fetchedAt);
    schedule(d);
  } catch (e) {
    if (state.sel !== sym) return;
    if (allSyms().includes(sym)) state.rows[sym] = { ...(state.rows[sym] || {}), error: true };
    renderList();
    if (!quiet) renderError(sym, e.message);
    else toast(`Refresh failed: ${e.message}`);
  }
}

function refreshSelected() {
  if (!state.sel) return;
  toast(state.api === null ? "Reloading the daily snapshot…" : "Fetching live data…");
  select(state.sel, { quiet: !!state.cur });
}

function schedule(d) {
  clearTimeout(state.timer);
  if (state.api === null || !d.marketOpen) return;
  state.timer = setTimeout(() => { if (document.visibilityState === "visible") select(d.symbol, { quiet: true }); else schedule(d); }, (CFG.refreshSeconds || 60) * 1000);
}

function step(dir) {
  const list = visibleSyms();
  if (!list.length) return;
  const i = list.indexOf(state.sel);
  const next = list[(i + dir + list.length) % list.length];
  select(next);
  document.querySelector(`.row[data-s="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "nearest" });
}

// ---------- theme ----------
function applyTheme() {
  const t = state.theme;
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const b = $("#theme");
  b.textContent = t === "light" ? "☀" : t === "dark" ? "☾" : "◐";
  b.title = "Theme: " + t + " (T)";
}
function cycleTheme() {
  state.theme = { auto: "light", light: "dark", dark: "auto" }[state.theme] || "auto";
  store.set("theme", state.theme);
  applyTheme();
  if (state.cur) renderDetail(state.cur);
  toast("Theme: " + state.theme);
}

// ---------- wiring ----------
$("#list").addEventListener("click", (e) => {
  const x = e.target.closest("[data-x]");
  if (x) {
    e.stopPropagation();
    state.custom = state.custom.filter((c) => c !== x.dataset.x);
    store.set("custom", state.custom);
    toast(`Removed ${x.dataset.x}.`);
    if (state.sel === x.dataset.x) select(allSyms()[0]); else renderList();
    return;
  }
  const row = e.target.closest(".row");
  if (row) select(row.dataset.s);
});
$("#list").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("row")) { e.preventDefault(); select(e.target.dataset.s); }
});
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]");
  if (!b) return;
  state.filter = b.dataset.f;
  renderList();
});
$("#search").addEventListener("input", (e) => { state.search = e.target.value; renderList(); });
$("#sort").value = state.sort;
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; store.set("sort", state.sort); renderList(); });
// ---------- ticker search (live: any ticker through /api/search; snapshot: the built list) ----------
const sug = { items: [], active: -1, timer: null, seq: 0 };
function showSuggest(items, emptyText) {
  const ul = $("#suggest"), inp = $("#ticker");
  sug.items = items; sug.active = items.length ? 0 : -1;
  ul.innerHTML = items.length
    ? items.map((x, i) => `<li role="option" id="sg${i}" data-i="${i}" aria-selected="${i === 0}"><b>${esc(x.symbol)}</b><span>${esc(x.name)}</span><small>${esc([x.type, x.exchange].filter(Boolean).join(" · "))}</small></li>`).join("")
    : emptyText ? `<li class="empty">${esc(emptyText)}</li>` : "";
  ul.hidden = !ul.innerHTML;
  inp.setAttribute("aria-expanded", String(!ul.hidden));
  inp.setAttribute("aria-activedescendant", sug.active >= 0 ? "sg0" : "");
}
function hideSuggest() { $("#suggest").hidden = true; $("#ticker").setAttribute("aria-expanded", "false"); sug.items = []; sug.active = -1; }
function moveSuggest(d) {
  if (!sug.items.length) return;
  sug.active = (sug.active + d + sug.items.length) % sug.items.length;
  $$("#suggest li").forEach((li, i) => li.setAttribute("aria-selected", String(i === sug.active)));
  $("#sg" + sug.active)?.scrollIntoView({ block: "nearest" });
  $("#ticker").setAttribute("aria-activedescendant", "sg" + sug.active);
}
function pickTicker(sym) {
  hideSuggest();
  $("#ticker").value = "";
  $("#addMsg").textContent = state.api === null && !state.rows[sym] ? "Snapshot mode: only tickers in the daily build have data." : "";
  select(sym, { add: true });
}
async function runSuggest(q) {
  const my = ++sug.seq;
  if (!q) return hideSuggest();
  if (state.api === null) {
    const ql = q.toLowerCase();
    const hits = Object.values(state.rows)
      .filter((r) => r.symbol.toLowerCase().startsWith(ql) || (r.name || "").toLowerCase().includes(ql))
      .slice(0, 8).map((r) => ({ symbol: r.symbol, name: r.name || "", type: "", exchange: "" }));
    return showSuggest(hits, "Not in the daily list.");
  }
  try {
    const list = await getJson(apiUrl("api/search?q=" + encodeURIComponent(q)));
    if (my === sug.seq) showSuggest(list, "No matches. Press Enter to try it as a ticker.");
  } catch { if (my === sug.seq) hideSuggest(); }
}
$("#ticker").addEventListener("input", (e) => {
  clearTimeout(sug.timer);
  const q = e.target.value.trim();
  sug.timer = setTimeout(() => runSuggest(q), 200);
});
$("#ticker").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveSuggest(-1); }
  else if (e.key === "Escape") hideSuggest();
});
$("#ticker").addEventListener("blur", () => setTimeout(hideSuggest, 150));
$("#suggest").addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) { e.preventDefault(); pickTicker(sug.items[+li.dataset.i].symbol); }
});
$("#add").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(sug.timer);
  if (sug.active >= 0 && sug.items[sug.active]) return pickTicker(sug.items[sug.active].symbol);
  const s = norm($("#ticker").value);
  if (!s) { $("#addMsg").textContent = "Type a company name or a ticker like NFLX, BRK.B or ^GSPC."; return; }
  pickTicker(s);
});
$("#theme").addEventListener("click", cycleTheme);
$("#help").addEventListener("click", () => $("#keys").showModal());
document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || $("#keys").open) return;
  const k = e.key;
  if (k === "ArrowDown" || k === "j") { e.preventDefault(); step(1); }
  else if (k === "ArrowUp" || k === "k") { e.preventDefault(); step(-1); }
  else if (k === "/") { e.preventDefault(); $("#search").focus(); }
  else if (k === "a") { e.preventDefault(); $("#ticker").focus(); }
  else if (k === "r") refreshSelected();
  else if (k === "t") cycleTheme();
  else if (k === "?") $("#keys").showModal();
  else if ("1234".includes(k) && k.length === 1) setRange(["3M", "6M", "1Y", "2Y"][+k - 1]);
});
window.addEventListener("hashchange", () => { const s = norm(decodeURIComponent(location.hash.slice(1))); if (s && s !== state.sel) select(s); });
if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (state.theme === "auto" && state.cur) renderDetail(state.cur); });

(async function init() {
  applyTheme();
  state.api = await detectApi();
  await loadIndex();
  const mode = $("#mode");
  if (state.api !== null) { mode.textContent = "Live"; mode.classList.add("live"); mode.title = "Prices fetched live through " + (state.api || "the local server"); }
  else { mode.textContent = "Daily snapshot"; mode.title = "Prebuilt data from the scheduled build"; }
  $("#updated").textContent = state.index ? "Data updated " + fmtTime(state.index.updatedAt) + " (" + ago(state.index.updatedAt) + ")" : state.api !== null ? "" : "No data built yet: run npm run build";
  renderList();
  const first = norm(decodeURIComponent(location.hash.slice(1))) || allSyms()[0];
  if (first) await select(first);
  refreshAllRows();
})();
