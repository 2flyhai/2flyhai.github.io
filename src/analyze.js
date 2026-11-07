// Pure technical-analysis functions. No network, no DOM: runs in Node, browsers and Workers.

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// EMA over an array that may start with nulls (seeded with the SMA of the first n real values).
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = start; i < start + n; i++) prev += values[i];
  prev /= n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI.
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalN = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const signal = ema(line, signalN);
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

// Support / resistance from swing highs and lows over the last ~6 months, clustered within 1.5%.
export function levels(bars, price) {
  const look = bars.slice(-130);
  const w = 5;
  const pts = [];
  for (let i = w; i < look.length - w; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (look[j].high > look[i].high) isHigh = false;
      if (look[j].low < look[i].low) isLow = false;
    }
    if (isHigh) pts.push(look[i].high);
    if (isLow) pts.push(look[i].low);
  }
  pts.sort((a, b) => a - b);
  const clusters = [];
  for (const p of pts) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p - c.avg) / c.avg <= 0.015) {
      c.sum += p; c.touches++; c.avg = c.sum / c.touches;
    } else clusters.push({ sum: p, touches: 1, avg: p });
  }
  const below = clusters.filter((c) => c.avg < price * 0.995).sort((a, b) => b.avg - a.avg);
  const above = clusters.filter((c) => c.avg > price * 1.005).sort((a, b) => a.avg - b.avg);
  const recent = bars.slice(-20);
  const lo20 = Math.min(...recent.map((b) => b.low));
  const hi20 = Math.max(...recent.map((b) => b.high));
  const pick = (arr) => arr.slice(0, 2).map((c) => ({ price: c.avg, touches: c.touches }));
  const supports = pick(below);
  const resistances = pick(above);
  if (!supports.length && lo20 < price) supports.push({ price: lo20, touches: 1 });
  if (!resistances.length && hi20 > price) resistances.push({ price: hi20, touches: 1 });
  return { supports, resistances };
}

const POS = /\b(beat|beats|surge[sd]?|soar(s|ed)?|jump(s|ed)?|rall(y|ies|ied)|record|upgrade[sd]?|raise[sd]?|strong|growth|outperform|gain(s|ed)?|rise[sn]?|rising|higher|tops?|wins?|approv(al|ed|es)|partnership|bullish|boost(s|ed)?|expand(s|ed)?)\b/i;
const NEG = /\b(miss(es|ed)?|plunge[sd]?|fall(s|en)?|fell|drop(s|ped)?|slump(s|ed)?|downgrade[sd]?|cuts?|weak(er|ness)?|lawsuit|sue[sd]?|probe|investigation|recall(s|ed)?|underperform|loss(es)?|lower(s|ed)?|warn(s|ing)?|layoffs?|decline[sd]?|fraud|sinks?|tumble[sd]?|bearish|crash(es|ed)?|halt(s|ed)?)\b/i;

export function newsSentiment(news) {
  let pos = 0, neg = 0;
  const tagged = news.map((n) => {
    const p = POS.test(n.title), q = NEG.test(n.title);
    const tone = p && !q ? "positive" : q && !p ? "negative" : "neutral";
    if (tone === "positive") pos++;
    if (tone === "negative") neg++;
    return { ...n, tone };
  });
  let summary;
  if (!news.length) summary = "No recent headlines found.";
  else {
    const lean = pos - neg >= 2 ? "leans positive" : neg - pos >= 2 ? "leans negative" : "is mixed or neutral";
    summary = `${news.length} recent headlines: ${pos} positive, ${neg} negative, ${news.length - pos - neg} neutral. Coverage ${lean} (keyword scan of headlines, not a reading of the articles).`;
  }
  return { items: tagged, pos, neg, summary };
}

const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const r4 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000);
const pct = (a, b) => ((a - b) / b) * 100;
const money = (v) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(2) : v.toFixed(4));

// bars: [{date, open, high, low, close, volume}] oldest first. Returns the full payload the page renders.
export function analyze({ symbol, name, currency, exchange, marketTime, marketOpen, price, prevClose, bars, news = [], earnings = null }) {
  if (!bars || bars.length < 30) throw new Error(`Not enough price history for ${symbol} (${bars ? bars.length : 0} days).`);
  const closes = bars.map((b) => b.close);
  const n = closes.length - 1;
  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const rs = rsi(closes, 14);
  const md = macd(closes);
  const reasons = [];
  const add = (weight, text, key) => reasons.push({ weight, text, key });

  const last = { sma20: s20[n], sma50: s50[n], sma200: s200[n], rsi: rs[n], macd: md.line[n], signal: md.signal[n], hist: md.hist[n] };

  // Trend
  if (last.sma200 != null) {
    const d = pct(price, last.sma200);
    add(price > last.sma200 ? 1 : -1, `Price is ${Math.abs(d).toFixed(1)}% ${price > last.sma200 ? "above" : "below"} the 200-day average (long-term ${price > last.sma200 ? "uptrend" : "downtrend"}).`, "trend", "levels");
  } else add(0, "Less than 200 days of history, so the 200-day average is not available.", "trend", "levels");
  if (last.sma50 != null) {
    add(price > last.sma50 ? 1 : -1, `Price is ${price > last.sma50 ? "above" : "below"} the 50-day average (${money(last.sma50)}).`, "trend", "levels");
  }
  if (last.sma50 != null && last.sma200 != null) {
    const golden = last.sma50 > last.sma200;
    let cross = "";
    for (let i = n; i > n - 20 && i > 0; i--) {
      if (s50[i - 1] != null && s200[i - 1] != null && (s50[i] > s200[i]) !== (s50[i - 1] > s200[i - 1])) {
        cross = ` It crossed ${n - i === 0 ? "today" : `${n - i} trading days ago`} (${golden ? "golden" : "death"} cross).`;
        break;
      }
    }
    add(golden ? 1 : -1, `50-day average is ${golden ? "above" : "below"} the 200-day.${cross}`, "trend", "levels");
  }
  if (last.sma20 != null) add(price > last.sma20 ? 0.5 : -0.5, `Short-term: price is ${price > last.sma20 ? "above" : "below"} the 20-day average (${money(last.sma20)}).`, "trend", "levels");

  // Momentum
  if (last.rsi != null) {
    const v = last.rsi;
    if (v >= 70) add(-1, `RSI ${v.toFixed(0)} is overbought (above 70): a pullback is more likely.`, "rsi", "levels");
    else if (v <= 30) add(1, `RSI ${v.toFixed(0)} is oversold (below 30): a bounce is more likely.`, "rsi", "levels");
    else if (v >= 50) add(0.5, `RSI ${v.toFixed(0)} shows positive momentum (50-70).`, "rsi", "levels");
    else add(-0.5, `RSI ${v.toFixed(0)} shows weak momentum (30-50).`, "rsi", "levels");
  }
  if (last.macd != null && last.signal != null) {
    const above = last.macd > last.signal;
    let cross = "";
    for (let i = n; i > n - 5 && i > 0; i--) {
      if (md.hist[i - 1] != null && (md.hist[i] > 0) !== (md.hist[i - 1] > 0)) {
        cross = ` Fresh ${above ? "bullish" : "bearish"} crossover ${n - i === 0 ? "today" : `${n - i} day(s) ago`}.`;
        break;
      }
    }
    add(above ? 1 : -1, `MACD (${last.macd.toFixed(2)}) is ${above ? "above" : "below"} its signal line (${last.signal.toFixed(2)}).${cross}`, "macd", "levels");
  }

  // Volume
  const vols = bars.map((b) => b.volume || 0);
  const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, vols.length - 1);
  const volRatio = avgVol20 ? vols[n] / avgVol20 : null;
  const dayChangePct = prevClose ? pct(price, prevClose) : 0;
  if (volRatio != null) {
    if (marketOpen) add(0, `Volume so far is ${volRatio.toFixed(2)}x the 20-day average (session still open, so this is partial).`, "volume", "levels");
    else if (volRatio >= 1.5) add(dayChangePct >= 0 ? 0.5 : -0.5, `Volume was ${volRatio.toFixed(1)}x the 20-day average on a ${dayChangePct >= 0 ? "up" : "down"} day: strong ${dayChangePct >= 0 ? "buying" : "selling"} interest.`, "volume", "levels");
    else if (volRatio <= 0.6) add(0, `Volume was light (${volRatio.toFixed(2)}x average): the move has little conviction.`, "volume", "levels");
    else add(0, `Volume was normal (${volRatio.toFixed(2)}x the 20-day average).`, "volume", "levels");
  }

  // 52-week range
  const yr = bars.slice(-252);
  const hi52 = Math.max(...yr.map((b) => b.high), price);
  const lo52 = Math.min(...yr.map((b) => b.low), price);
  const pos52 = hi52 > lo52 ? ((price - lo52) / (hi52 - lo52)) * 100 : 50;
  const offHigh = pct(price, hi52);
  if (offHigh > -3) add(0.5, `Trading within ${Math.abs(offHigh).toFixed(1)}% of its 52-week high: strength.`, "range", "levels");
  else if (pct(price, lo52) < 3) add(-0.5, `Trading within ${pct(price, lo52).toFixed(1)}% of its 52-week low: weakness.`, "range", "levels");

  // Support / resistance
  const lv = levels(bars, price);
  const sup = lv.supports[0], res = lv.resistances[0];
  if (sup && pct(price, sup.price) < 2) add(0, `Sitting just above support near ${money(sup.price)}: a break below would be bearish.`, "levels");
  if (res && pct(res.price, price) < 2) add(0, `Just under resistance near ${money(res.price)}: a close above would be bullish.`, "levels");

  // News
  const ns = newsSentiment(news);
  if (ns.pos - ns.neg >= 2) add(0.5, "Recent headlines lean positive.", "news");
  else if (ns.neg - ns.pos >= 2) add(-0.5, "Recent headlines lean negative.", "news");

  // Earnings (Nasdaq / Zacks consensus; not a whisper number)
  const er = earningsView(earnings, marketTime);
  if (er) {
    if (er.beats >= 3) add(0.5, `Beat the EPS consensus in ${er.beats} of the last ${er.history.length} quarters (average surprise ${er.avgSurprise > 0 ? "+" : ""}${er.avgSurprise}%).`, "earnings");
    else if (er.history.length >= 2 && er.history.length - er.beats >= 2) add(-0.5, `Missed or met the EPS consensus in ${er.history.length - er.beats} of the last ${er.history.length} quarters.`, "earnings");
    const nq = er.next;
    if (nq && nq.up - nq.down >= 2) add(0.5, `Analysts raised next-quarter EPS estimates (${nq.up} up, ${nq.down} down in 4 weeks).`, "earnings");
    else if (nq && nq.down - nq.up >= 2) add(-0.5, `Analysts cut next-quarter EPS estimates (${nq.down} down, ${nq.up} up in 4 weeks).`, "earnings");
    if (er.daysToReport != null && er.daysToReport >= 0 && er.daysToReport <= 14) add(0, `Earnings report in ${er.daysToReport === 0 ? "less than a day" : er.daysToReport + " day(s)"} (${er.reportDate}${er.reportTime ? ", " + er.reportTime : ""}): expect a big move either way.`, "earnings");
  }

  const score = reasons.reduce((a, r) => a + r.weight, 0);
  const verdict = score >= 2 ? "bullish" : score <= -2 ? "bearish" : "neutral";
  const top = [...reasons].filter((r) => r.weight !== 0).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const pro = top.filter((r) => r.weight > 0).length, con = top.filter((r) => r.weight < 0).length;
  const headline =
    verdict === "bullish" ? `Bullish: ${pro} of ${pro + con} signals point up. Trend and momentum favor buyers.`
    : verdict === "bearish" ? `Bearish: ${con} of ${pro + con} signals point down. Trend and momentum favor sellers.`
    : `Neutral: signals are split (${pro} up, ${con} down). No clear edge either way.`;

  const tail = (arr, k) => arr.slice(-k);
  const keep = 504;
  return {
    symbol, name: name || symbol, currency: currency || "USD", exchange: exchange || "",
    price: r4(price), prevClose: r4(prevClose), change: r4(price - prevClose), changePct: r2(dayChangePct),
    marketTime, marketOpen: !!marketOpen,
    verdict, score: r2(score), headline, reasons,
    indicators: {
      sma20: r4(last.sma20), sma50: r4(last.sma50), sma200: r4(last.sma200),
      rsi: r2(last.rsi), macd: r4(last.macd), macdSignal: r4(last.signal), macdHist: r4(last.hist),
      volume: vols[n], avgVolume20: Math.round(avgVol20), volumeRatio: r2(volRatio),
      high52: r4(hi52), low52: r4(lo52), pos52: r2(pos52),
      supports: lv.supports.map((s) => ({ price: r4(s.price), touches: s.touches })),
      resistances: lv.resistances.map((s) => ({ price: r4(s.price), touches: s.touches })),
    },
    series: {
      bars: tail(bars, keep).map((b) => [b.date, r4(b.open), r4(b.high), r4(b.low), r4(b.close), b.volume || 0]),
      sma20: tail(s20, keep).map(r4), sma50: tail(s50, keep).map(r4), sma200: tail(s200, keep).map(r4),
      rsi: tail(rs, keep).map(r2), macd: tail(md.line, keep).map(r4), macdSignal: tail(md.signal, keep).map(r4), macdHist: tail(md.hist, keep).map(r4),
    },
    news: ns.items, newsSummary: ns.summary,
    earnings: er,
  };
}

// Normalizes the raw Nasdaq earnings data. Returns null when there is none (ETFs, indices, foreign tickers).
export function earningsView(e, asOf) {
  if (!e || (!e.history?.length && !e.quarters?.length)) return null;
  const history = (e.history || []).slice(0, 4);
  const beats = history.filter((h) => h.surprisePct > 0).length;
  const surprises = history.map((h) => h.surprisePct).filter((v) => v != null && isFinite(v));
  const avgSurprise = surprises.length ? r2(surprises.reduce((a, b) => a + b, 0) / surprises.length) : null;
  let streak = 0;
  for (const h of history) { if (h.surprisePct > 0) streak++; else break; }
  const next = e.quarters?.[0] || null;
  // Beat-adjusted estimate: consensus scaled by the average past surprise. A rough stand-in for a whisper number.
  const beatAdjusted = next && avgSurprise != null ? r2(next.consensus * (1 + avgSurprise / 100)) : null;
  let daysToReport = null;
  if (e.reportDate) {
    const [m, d, y] = e.reportDate.split("/").map(Number);
    const t = Date.UTC(y, m - 1, d);
    const now = asOf ? Date.parse(asOf) : Date.now();
    daysToReport = Math.ceil((t - now) / 86400000);
  }
  return {
    reportDate: e.reportDate || null, reportTime: e.reportTime || null, reportQuarter: e.reportQuarter || null, lastYearEps: e.lastYearEps ?? null,
    next, quarters: (e.quarters || []).slice(0, 4), history, beats, streak, avgSurprise, beatAdjusted, daysToReport,
  };
}
