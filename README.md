# TREFOZERI S/R Dashboard

Multi-timeframe support & resistance dashboard for XAU/USD (Gold) and BTC/USD
(Bitcoin) — a JavaScript port of the **Golden Fairy** TradingView indicator, plus
entry/SL/TP signal cards and a high-impact USD news banner.

**Live:** https://redyapr.github.io/trefozeri/

## How it works

- **Levels**: `src/lib/srDetector.js` ports Golden Fairy's pivot + 3-state machine
  (pure Support/Resistance → broken-once SBR/RBS → invalidated) independently per
  timeframe, and flags cross-timeframe confluence as "Golden Zones."
- **Timeframes**: H1, H4, D1 only (see `TIMEFRAMES` in `src/lib/twelveData.js`) —
  Golden Fairy's logic is pivot-based, not meant for sub-hourly noise.
- **Chart**: [lightweight-charts](https://github.com/tradingview/lightweight-charts)
  renders candles with the detected zones as shaded, labeled bands.
- **Data**: gold candles come from Twelve Data, BTC candles from Binance.US (no key
  needed, more generous rate limit), and the news banner from a free ForexFactory-style
  calendar feed. See [Data & deployment](#data--deployment) below for how these reach
  the browser without exposing the Twelve Data API key.
- **Offline-friendly**: last-known-good zones/price are cached to `localStorage`
  (`src/lib/offlineCache.js`) and a PWA service worker precaches the app shell, so a
  repeat visit still shows something useful without a network round-trip.

## Local development

```bash
npm install
cp .env.example .env   # fill in TWELVE_DATA_API_KEY (twelvedata.com, free tier)
npm run fetch:data     # writes public/data/*.json — the app reads these as static files
npm run dev
```

`npm run fetch:data` has to be re-run manually to refresh the local snapshot (there's
no dev-time proxy) — data won't go stale during a single dev session, since it's just
fetched once into `public/data/`, which is gitignored.

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run fetch:data` | Fetch quote + calendar data into `public/data/` (reads `.env`) |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run dev:netlify` | Legacy: run via `netlify dev` (see [Netlify (legacy)](#netlify-legacy)) |

## Data & deployment

The app is deployed to **GitHub Pages**, which only serves static files — there's no
server to proxy API requests on demand. Instead, `scripts/fetch-data.mjs` fetches
Twelve Data / Binance.US / the calendar feed once per run and writes the result as
static JSON into `public/data/`, which `vite build` copies straight into `dist/`. The
`TWELVE_DATA_API_KEY` secret is only ever read inside that script — it's never bundled
into browser code.

`.github/workflows/deploy.yml` runs this fetch-then-build-then-deploy pipeline:

- on every push to `master`,
- on a **15-minute cron** (matches the app's own refresh throttling — H1 candles are
  only refetched every 20 minutes even on a manual click, see `minRefetchMs` in
  `src/lib/twelveData.js` — so the cadence never leaves data staler than the app
  already tolerates),
- and on manual `workflow_dispatch`.

One-time setup for a fork or a new deploy target (the workflow's default
`GITHUB_TOKEN` can't do either of these via API — both need repo-admin access):

1. **Settings → Secrets and variables → Actions → New repository secret** — add
   `TWELVE_DATA_API_KEY`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.

`vite.config.js` bases the build at `/trefozeri/` (this repo's GitHub Pages project
path) only when the workflow sets `GH_PAGES=true`; local dev and any other deploy
target still base at `/`.

### Netlify (legacy)

The app used to run on Netlify, with `netlify/functions/quote.js` and `calendar.js`
proxying the same upstream APIs on demand instead of pre-fetching them. Those files
and `netlify.toml` are still in the repo but unused by the GitHub Pages deploy — kept
around in case of a rollback. To use them again: `npm run dev:netlify` locally, or
reconnect the repo on Netlify (it reads `netlify.toml` automatically) and set
`TWELVE_DATA_API_KEY` in Netlify's own environment variables.

## Project structure

```
src/
  main.js              UI wiring, render loop, refresh/cache orchestration
  lib/
    twelveData.js      Timeframe/symbol config + static-JSON quote fetching
    srDetector.js       Golden Fairy port: pivot detection, zones, signals
    priceChart.js       lightweight-charts candle + zone rendering
    newsCalendar.js     Static-JSON calendar fetching + high-impact filtering
    offlineCache.js     localStorage last-known-good snapshot
    uiState.js          Persisted tab/theme/symbol selection
scripts/
  fetch-data.mjs        Pre-fetches quote + calendar data into public/data/
netlify/functions/       Legacy on-demand proxies (unused by the GH Pages deploy)
.github/workflows/
  deploy.yml            Cron fetch → build → deploy to GitHub Pages
```
