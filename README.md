# TREFOZERI S/R Dashboard

Multi-timeframe support & resistance dashboard for XAUUSD (Gold) and BTCUSD
(Bitcoin), with entry/SL/TP signal cards and a high-impact USD news banner.

**Live:** https://redyapr.github.io/trefozeri/

**Telegram:** https://t.me/trefozeri — new signals, fills, and SL/TP results pushed as
they happen.

## How it works

- **Levels**: `src/lib/srDetector.js` runs a pivot + 3-state machine (pure
  Support/Resistance → broken-once SBR/RBS → invalidated) independently per timeframe,
  and flags cross-timeframe confluence as "Golden Zones."
- **Timeframes**: H1, H4, D1 only (see `TIMEFRAMES` in `src/lib/twelveData.js`) — this
  pivot-based logic isn't meant for sub-hourly noise.
- **Chart**: [lightweight-charts](https://github.com/tradingview/lightweight-charts)
  renders candles with the detected zones as shaded, labeled bands.
- **Data**: gold candles come from Twelve Data, BTC candles from Binance.US (no key
  needed, more generous rate limit), and the news banner from a free ForexFactory-style
  calendar feed. See [Data & deployment](#data--deployment) below for how these reach
  the browser without exposing the Twelve Data API key.
- **Offline-friendly**: last-known-good zones/price are cached to `localStorage`
  (`src/lib/offlineCache.js`) and a PWA service worker precaches the app shell, so a
  repeat visit still shows something useful without a network round-trip.
- **Alerts**: `src/lib/notifications.js` fires a browser notification when price closes
  in on a zone or a new signal forms — opt-in via the bell icon (requests Notification
  permission, then toggles on/off without needing to touch browser settings again).
- **Track record**: shared across every visitor, not per-browser. `scripts/fetch-data.mjs`
  logs each signal to `data/signal-history.json` as `pending` during the cron run
  (every signal is a LIMIT order — see `srDetector.js`), flips it to `running` once
  price actually reaches the entry, then scores it `win`/`loss` once price plausibly
  hits its first take-profit or stop-loss. A still-`pending` order whose level gets
  invalidated or replaced before ever filling is dropped rather than kept around
  forever. The workflow commits the file back to the repo when it changes (see
  [Data & deployment](#data--deployment)), so it survives across CI runs and everyone
  sees the same record. The browser (`src/lib/signalHistory.js`) only ever reads it.
  View it via the chart-icon button in the header — `pending` signals aren't repeated
  there since they're already visible as live cards on the dashboard.
- **Telegram notifications** — public channel: **https://t.me/trefozeri** (XAUUSD H1
  only for now — see `TELEGRAM_SYMBOLS`/`TELEGRAM_TIMEFRAMES` in
  `scripts/fetch-data.mjs`; H4/D1 signals never post, even as part of a confluence
  group). The cron run posts a message for every newly-opened signal — direction,
  zone, price, SL, and every TP, with a ⭐ Golden Zone flag when it's a cross-timeframe
  confluence level (new signals are skipped entirely while the gold market's closed —
  see Market status below). Once price reaches the entry (the order "fills") and again
  once it closes on a SL/TP hit, a short reply posts under that same message (no price
  restated — it's already in the opening message — just which target and the move in
  pips, or raw $ for symbols with no pip convention); those still post even while the
  market's closed, since a trade already running shouldn't go silent. A fill that
  closes within the same ~15-minute poll (a fast move skipping past the entry and
  straight through the stop) only posts the close, not a separate fill message first.
  Optional — no-ops if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` aren't set (see
  [Data & deployment](#data--deployment)).
- **Market status**: `src/lib/marketHours.js` knows gold's ~23/5 trading week (closed
  Friday 22:00 UTC → Sunday 22:00 UTC) — the dashboard shows a banner during that
  window (XAUUSD tab only), and the cron job uses it to skip opening brand-new signals
  off stale weekend candles (see above).
- **Install prompt**: the browser's own "add to home screen" UI is inconsistent across
  browsers — `src/main.js` captures `beforeinstallprompt` itself and shows one obvious
  button in the header instead, hidden again once installed.

## Local development

```bash
npm install
cp .env.example .env   # fill in TWELVE_DATA_API_KEY (twelvedata.com, free tier)
npm run fetch:data     # writes public/data/*.json — the app reads these as static files
npm run dev
```

`npm run fetch:data` has to be re-run manually to refresh the local snapshot (there's
no dev-time proxy) — data won't go stale during a single dev session, since it's just
fetched once into `public/data/`, which is gitignored. It also updates the git-tracked
`data/signal-history.json` in place (same as the CI cron job does) — check `git diff`
before committing anything else if you don't want to also commit a local test run's
track-record changes.

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run fetch:data` | Fetch quote + calendar data into `public/data/` (reads `.env`) |
| `npm test` | Run the test suite ([Node's built-in test runner](https://nodejs.org/api/test.html), no extra dependency) |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Serve the built `dist/` locally |

`test/` covers the pure logic modules — `srDetector.js` (pivot state machine, SL
sizing, TP dedup), `signalHistoryCore.js` (record lifecycle, pip formatting),
`marketHours.js`, and `fetch-data.mjs`'s Telegram message building / grouping /
retry / admin-alert wiring (with `fetch` mocked, so it never touches the real network
or a real chat) — not the DOM-coupled browser files (`main.js`, `notifications.js`,
etc.), which would need a jsdom-style environment to test meaningfully.

## Data & deployment

The app is deployed to **GitHub Pages**, which only serves static files — there's no
server to proxy API requests on demand. Instead, `scripts/fetch-data.mjs` fetches
Twelve Data / Binance.US / the calendar feed once per run — retrying a couple of times
with backoff on a transient failure before falling back to the last published snapshot
— and writes the result as static JSON into `public/data/`, which `vite build` copies
straight into `dist/`. All secrets (`TWELVE_DATA_API_KEY`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `TELEGRAM_PERSONAL_CHAT_ID`) are only ever read inside that same
script — none of them are ever bundled into browser code.

`.github/workflows/deploy.yml` runs this test-then-fetch-then-build-then-deploy
pipeline:

- on every push to `master`,
- on a **15-minute cron** (matches the app's own refresh throttling — the dashboard
  polls every 5 minutes but each timeframe only actually refetches on its own cadence,
  e.g. H1 every 20 minutes, H4 every hour, D1 every 4 hours, see `minRefetchMs` in
  `src/lib/twelveData.js` — so the cadence never leaves data staler than the app
  already tolerates),
- and on manual `workflow_dispatch`.

The very first step is `npm test` — a failing test stops the run before it can fetch,
commit, build, or deploy anything.

Every CI run is otherwise stateless (fresh checkout, `public/data/` is gitignored and
rebuilt from scratch each time) — `data/signal-history.json` is the one exception. The
fetch step updates it in place, then a dedicated workflow step commits it back to
`master` with the default `GITHUB_TOKEN`, but only when it actually changed (a new
signal opened, or one hit its SL/TP) — most 15-minute ticks commit nothing. Pushing
with that token doesn't re-trigger the `on: push` rule, so this can't loop.

**Ops alerting**: if a data source fails even after retries and the fallback snapshot,
or the whole run hits a fatal error, `scripts/fetch-data.mjs` sends an alert to
`TELEGRAM_PERSONAL_CHAT_ID` — a private DM with the bot, deliberately kept separate
from `TELEGRAM_CHAT_ID` (the public signals channel), so run-health noise never lands
in front of channel subscribers.

One-time setup for a fork or a new deploy target (the workflow's default
`GITHUB_TOKEN` can't do either of these via API — both need repo-admin access):

1. **Settings → Secrets and variables → Actions → New repository secret** — add
   `TWELVE_DATA_API_KEY`, and optionally `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` for
   Telegram notifications (create a bot via [@BotFather](https://t.me/BotFather), add
   it to the target chat, and use that chat's numeric id — negative for a group) plus
   `TELEGRAM_PERSONAL_CHAT_ID` (the same bot, but a private DM chat id) for ops alerts.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.

`vite.config.js` bases the build at `/trefozeri/` (this repo's GitHub Pages project
path) only when the workflow sets `GH_PAGES=true`; local dev still bases at `/`.

## Project structure

```
src/
  main.js                UI wiring, render loop, refresh/cache orchestration
  style.css              All styling (light/dark theme via CSS custom properties)
  lib/
    twelveData.js        Timeframe/symbol config + static-JSON quote fetching
    srDetector.js        Pivot detection, zones, signals
    priceChart.js        lightweight-charts candle + zone rendering
    newsCalendar.js      Static-JSON calendar fetching + high-impact filtering
    notifications.js     Opt-in browser notifications for zone/signal alerts
    offlineCache.js      localStorage last-known-good snapshot
    uiState.js           Persisted tab/theme/symbol selection
    signalHistoryCore.js Pure record-keeping + pip/price-formatting logic, shared by
                         the browser and the cron script (also the source of PIP_SIZES)
    signalHistory.js     Browser-side: fetches the shared signal-history.json (read-only)
    marketHours.js       Gold's ~23/5 trading week — shared by the dashboard banner
                         and the cron job's weekend-signal gating
scripts/
  fetch-data.mjs          Pre-fetches quote + calendar data into public/data/,
                          maintains data/signal-history.json (the shared track record),
                          sends Telegram notifications for XAUUSD signals, and alerts
                          TELEGRAM_PERSONAL_CHAT_ID on data/run failures
test/
  *.test.mjs              node --test suite — see Local development above
data/
  signal-history.json     Git-tracked shared signal track record — committed by CI
.github/workflows/
  deploy.yml              Test → cron fetch → persist track record → build → deploy
```
