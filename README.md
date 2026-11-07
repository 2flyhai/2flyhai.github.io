# Hai's Stock Analyzer

A free stock analysis site. For each ticker it shows the price, a candlestick chart and a daily analysis:

- Trend: 20, 50 and 200-day simple moving averages, golden and death crosses
- RSI (14, Wilder) and MACD (12, 26, 9)
- Volume compared with the 20-day average
- Support and resistance from 6 months of swing highs and lows
- 52-week range
- Earnings: next report date, consensus EPS with high/low and revisions, the last 4 beats or misses, and a beat-adjusted estimate
- Recent headlines (Yahoo Finance RSS) with a keyword tone summary
- A plain-English verdict per stock (bullish, neutral or bearish) with the reasons and a score

**Not financial advice.** Signals are automatic and use free data that can be delayed or wrong.

Everything is free. There are no API keys and no paid services. Data comes from:

| Source | Used for |
| --- | --- |
| Yahoo Finance chart JSON (`query2`, then `query1.finance.yahoo.com/v8/finance/chart`) | 2 years of daily bars and the latest price |
| Stooq daily CSV (`stooq.com/q/d/l/`) | Fallback for US tickers when Yahoo rate-limits |
| Yahoo Finance RSS (`feeds.finance.yahoo.com/rss/2.0/headline`) | Headlines |
| Nasdaq (`api.nasdaq.com/api/analyst/<T>/earnings-forecast`, `earnings-date`, `company/<T>/earnings-surprise`), data from Zacks | Earnings consensus, surprises and report date (stocks only) |

Browsers cannot call these sites directly (CORS), so the data is fetched by Node: by the build script, by the local server, or by an optional free Cloudflare Worker.

## Using the page

- Search, sort (score, change, A-Z) and filter the watchlist by verdict. Each row has a 30-day sparkline.
- Hover the chart for that day's open, high, low, close, volume and averages. Turn SMA 20/50/200, support/resistance and volume on or off.
- Switch the lower pane between RSI and MACD. It scrolls and zooms with the main chart.
- Click a reason in the verdict to jump to its panel. Click a support or resistance price to mark it on the chart.
- The Earnings panel shows the next report date, the consensus EPS and the last 4 quarters of beats and misses.
- Filter headlines by tone. Copy a link to any ticker (`#AAPL`).
- Theme button cycles auto, light and dark.
- Keys: up/down or J/K change ticker, / search, A add, 1-4 chart range, R refresh, T theme, ? help.

## Requirements

Node.js 18 or newer. There are no npm packages to install. The chart library (TradingView Lightweight Charts 4.2.0) loads from unpkg.

## Run locally (live data, any ticker)

```bash
cd D:\Projects\StockAnalyzer
```

```bash
npm run dev
```

Open http://localhost:8080. `npm run dev` builds the watchlist data, then starts the server. After the first build, `npm start` is enough.

In local mode the badge says **Live**. You can add any ticker (for example `NFLX`, `BRK.B`, `^GSPC`). The price refreshes every 60 seconds while the market is open. Results are cached for 60 seconds per ticker.

Use another port with `PORT=3000 npm start` (Git Bash) or `$env:PORT=3000; npm start` (PowerShell).

## Change the watchlist

Edit `watchlist.json`. It is a JSON list of tickers. Tickers you add in the page are saved in your browser only.

## How the daily refresh works

`scripts/build.js` fetches every watchlist ticker, runs the analysis and writes `public/data/<TICKER>.json` and `public/data/index.json`. The page shows the time in `index.json` as "Data updated".

On GitHub, `.github/workflows/deploy.yml` runs this build and publishes `public/` to GitHub Pages:

- Every weekday at 22:15 UTC, after the US close. This is the daily analysis.
- Every 30 minutes from 14:00 to 20:30 UTC on weekdays, for near-live prices. Delete that cron line to use fewer Actions minutes.
- On every push to `main`, and when you press **Run workflow**.

The data is not committed to git. Each run builds fresh data inside the deploy job, so the repository history stays clean. If every ticker fails, the run fails and the previous site stays online.

## Deploy free on GitHub Pages (recommended)

1. Create a free GitHub account and a new repository, for example `stock-analyzer`. Public repositories get unlimited Actions minutes. Private ones get 2,000 minutes a month, which covers the schedule above (about 350 minutes a month).
2. Push this folder:

   ```bash
   cd D:\Projects\StockAnalyzer
   ```

   ```bash
   git init -b main
   ```

   ```bash
   git add .
   ```

   ```bash
   git commit -m "Hai's Stock Analyzer"
   ```

   ```bash
   git remote add origin https://github.com/YOUR_NAME/stock-analyzer.git
   ```

   ```bash
   git push -u origin main
   ```

3. On GitHub, open the repository's **Settings > Pages**. Under **Build and deployment > Source**, choose **GitHub Actions**.
4. Open **Actions > Build data and deploy to GitHub Pages > Run workflow**.
5. When it finishes, the site is at `https://YOUR_NAME.github.io/stock-analyzer/`.

GitHub pauses scheduled workflows in a repository with no activity for 60 days. If that happens, press **Enable workflow** on the Actions tab.

The hosted site is in **Daily snapshot** mode: it shows the watchlist from the last build. To get live prices and any ticker on the hosted site, add the optional proxy below.

## Get it on Google search

Google finds new sites slowly on its own. Google Search Console (free) speeds this up.

1. Open https://search.google.com/search-console and sign in with a Google account.
2. Choose **Add property > URL prefix**. Enter the site URL, for example `https://YOUR_NAME.github.io/stock-analyzer/`.
3. Choose the **HTML tag** method. Google shows a tag like `<meta name="google-site-verification" content="...">`.
4. Paste that tag into `public/index.html`, in place of the line `<!-- Google Search Console verification tag goes here -->`. Commit and push, then wait for the Action to finish.
5. In Search Console, press **Verify**.
6. Open **Sitemaps** and submit `sitemap.xml`. The build writes it from the Pages URL on every run.
7. Open **URL inspection**, enter the site URL and press **Request indexing**.

The site usually appears in Google results within a few days to a few weeks. Search for `site:YOUR_NAME.github.io` to check.

The verification tag is not a secret. It only proves that you own the site.

Name the repository `YOUR_NAME.github.io` to serve the site at the domain root (`https://YOUR_NAME.github.io/`). Google reads `robots.txt` only at the domain root.

## Optional: live proxy on Cloudflare Workers (free)

The Worker in `worker/` gives the hosted site the same live API as the local server. The free plan allows 100,000 requests a day.

1. Create a free Cloudflare account.
2. Deploy the Worker:

   ```bash
   cd D:\Projects\StockAnalyzer\worker
   ```

   ```bash
   npx wrangler login
   ```

   ```bash
   npx wrangler deploy
   ```

   Wrangler prints a URL like `https://stock-analyzer-proxy.YOUR_SUBDOMAIN.workers.dev`.
3. In `worker/wrangler.toml`, set `ALLOWED_ORIGIN` to your site's origin, for example `https://YOUR_NAME.github.io`. Deploy again.
4. In `public/config.js`, set `proxyUrl` to the Worker URL. Commit and push.

The badge then says **Live** on the hosted site. If the Worker is down, the page falls back to the daily snapshot.

## Other free hosts

- **Cloudflare Pages:** connect the repository, set the build command to `node scripts/build.js` and the output folder to `public`. Cloudflare Pages has no cron, so the data updates only when you push. Keep the GitHub Action for the schedule, or add a Cloudflare Pages deploy hook and call it from a scheduled GitHub Action.
- **Vercel (Hobby):** import the repository, set the build command to `node scripts/build.js` and the output directory to `public`. Same limit: updates on push only.
- **Your own PC:** `npm run dev`. To rebuild the snapshot every weekday, add a Windows Task Scheduler task that runs `node scripts/build.js` in this folder.

## Rate limits

- The build waits 400 ms between tickers. Keep the watchlist under about 50 tickers.
- Yahoo sometimes answers HTTP 429 (too many requests). The code retries with backoff, switches from `query2` to `query1`, then falls back to Stooq for US tickers.
- Yahoo may block some cloud IP ranges at times. If a scheduled run fails, run it again later.

## Earnings and whisper numbers

A whisper number is the unofficial EPS estimate that traders expect, as opposed to the published analyst consensus. Sites like EarningsWhispers collect them, but there is no free feed, and scraping those sites breaks their terms. So this site does not show real whisper numbers.

The Earnings panel shows what is free instead:

- The consensus EPS for the next quarter, with the high and low estimates, the number of analysts and the revisions in the last 4 weeks.
- The next report date, before or after the market, when Nasdaq has it.
- The last 4 quarters: actual EPS, consensus and the % surprise.
- A **beat-adjusted estimate**: the consensus multiplied by (1 + the average surprise of the last 4 quarters). This is a rough stand-in for a whisper number. A company that keeps beating is usually expected to beat again, so the real bar is higher than the consensus.

If a report is due within 14 days, the verdict adds a note (no points): expect a big move either way. A stock can fall after a beat when the whisper was higher.

ETFs and indices have no earnings, so the panel is hidden for them. If Nasdaq does not answer within 8 seconds, the panel is hidden and the rest of the analysis still loads.

## How the verdict is scored

Each signal adds or subtracts points:

| Signal | Points |
| --- | --- |
| Price above or below the 200-day average | +1 / -1 |
| Price above or below the 50-day average | +1 / -1 |
| 50-day average above or below the 200-day | +1 / -1 |
| Price above or below the 20-day average | +0.5 / -0.5 |
| RSI 50-70 / 30-50 | +0.5 / -0.5 |
| RSI above 70 (overbought) / below 30 (oversold) | -1 / +1 |
| MACD above or below its signal line | +1 / -1 |
| Volume 1.5x average on an up or down day (closed session only) | +0.5 / -0.5 |
| Within 3% of the 52-week high / low | +0.5 / -0.5 |
| Headlines lean positive / negative | +0.5 / -0.5 |
| Beat EPS consensus in 3+ of the last 4 quarters / missed or met in 2+ | +0.5 / -0.5 |
| Next-quarter estimate revisions: 2+ more up than down / down than up | +0.5 / -0.5 |

A score of +2 or more is **bullish**. A score of -2 or less is **bearish**. Anything between is **neutral**. Support, resistance and normal volume are shown as notes with no points.

## Files

| Path | What it does |
| --- | --- |
| `src/analyze.js` | Indicators and verdict (pure functions) |
| `src/data.js` | Fetches Yahoo, Stooq, RSS and Nasdaq earnings data |
| `scripts/build.js` | Builds the static data for the watchlist |
| `server.js` | Local server with the live `/api/analyze` endpoint |
| `public/` | The website (`index.html`, `app.js`, `style.css`, `config.js`) |
| `worker/` | Optional Cloudflare Worker proxy |
| `.github/workflows/deploy.yml` | Scheduled build and GitHub Pages deploy |
| `watchlist.json` | Default tickers |
