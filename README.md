# TREFOZERI S/R Dashboard

Multi-timeframe support & resistance dashboard for XAUUSD (Gold) and BTCUSD
(Bitcoin) — entry/SL/TP signal cards, plus a high-impact USD news banner.

**Live:** https://redyapr.github.io/trefozeri/

**Telegram:** https://t.me/trefozeri — signals, fills, and results pushed live.

## <img src="https://readme-typing-svg.demolab.com?lines=Features" alt="Typing Features" />

- **Levels** — `srDetector.js` detects pivots per timeframe and tracks each through 3
  states: Support/Resistance → broken-once SBR/RBS → invalidated. A single confirming
  close flips a level immediately — no second bar needed. Cross-timeframe confluence is
  flagged as a "Golden Zone" (independent of the strength badge below — a level can be
  both, either, or neither). A level tested 3+ times without breaking downgrades to
  "Weak"; otherwise it's "Strong" once it's proven itself on at least 3 of 5 signals off
  its own track record — tested at least once but not yet fatigued, old enough to have
  mattered for a while, formed on a candle with real conviction, rejected sharply right
  after forming, and defended tightly ever since — or "Medium" otherwise. A broken level
  (RBS/SBR) becomes a tradeable idea only once its breakout candle shows real conviction
  (volume for BTCUSD, body-to-range ratio for XAUUSD) and price has run far enough past
  it for a retest to matter. Until then it's shown on the chart but not offered as a
  signal.
- **Trend filter** — a fade strategy that takes both directions symmetrically fights
  itself against the prevailing trend. A confirmed H4 (falling back to D1) trend offers
  only the aligned side: buy in an uptrend, sell in a downtrend. A range-bound read
  still offers both. See `computeTrend` in `srDetector.js`.
- **Take-profits** — TPs come from opposite-side levels on the signal's own timeframe,
  plus qualifying levels from *higher* timeframes only. Shown between 0.5R–50R;
  near-duplicates merged. Falls back to fixed 1.5R/2.5R/3.5R if no structural level
  qualifies. If even the *nearest* structural target is beyond 3R (a tight, correctly
  sized SL with sparse opposing structure — common in a trending market), a reachable
  1R checkpoint is inserted ahead of it as TP1 instead; the real level isn't dropped,
  just demoted a rung. A 2026-08-26 walk-forward simulation found trades routinely
  running several R in the right direction and still recording as losses purely
  because the original TP1 sat 5-10R+ away — win rate went 54%→74% (XAUUSD) and
  69%→82% (BTCUSD) with this change, on essentially the same trade count either way.
  Each TP row on the signal card also shows its pip/$ distance from entry and which
  level it's based on (e.g. "H4 Resist.", or "Checkpoint"/"No structural level" for the
  synthetic ones).
- **Timeframes** — H1, H4, D1, shown combined (no per-timeframe tab). Signals — the
  actionable BUY/SELL LIMIT cards — are H1 only; H4/D1 zones are shown for context and
  still lend H1 extra TP targets (see Take-profits above), but never become tradeable
  ideas of their own. A checkbox per timeframe (H1/H4/D1, all on by default, persisted
  locally) controls which ones' zone cards and chart bands are actually shown — a pure
  display filter: signal generation, TP borrowing, trend, and the shared track record
  are unaffected regardless of what's checked.
- **Chart** — [lightweight-charts](https://github.com/tradingview/lightweight-charts):
  H1 candles with every timeframe's zones drawn together as shaded, labeled bands.
- **Data** — Gold from Twelve Data, BTC from Binance.US, news from a free
  ForexFactory-style feed. See [Data & deployment](#data--deployment). The header's spot
  price and the chart's own price marker track the single freshest tick available
  (`/quote/{SYMBOL}-latest.json`, derived from M1 — fetched every cron run, unthrottled)
  rather than H1's own close, which only refreshes every 15 minutes; zone detection and
  signals still use H1 regardless — see `spotPrice`/`currentPrice` in `main.js`.
- **PWA** — a service worker precaches the app shell; price/signal data always fetches
  fresh, never from a stale cache.
- **Alerts** — opt-in browser notifications (bell icon) when price nears a zone or a
  new signal forms.
- **Track record** — shared across every visitor. Each signal goes `pending` →
  `running` (filled) → `win`/`loss`, stored in `data/signal-history.json` and
  committed by CI. View it via the chart-icon button. Capped at 300 records per symbol.
  SL/TP are checked against M1 (1-minute) candles, not H1 or a single snapshotted
  price — an hourly candle can't tell whether TP or SL came first when both fall inside
  the same hour, so a fill/SL/TP touch is never missed or mis-ordered just because price
  reversed before the next ~5-minute poll. A fill needs more than a wick touch: the
  candle must also close back on the favorable side of entry, confirming the retest
  actually held. A `win` is credited the instant ANY take-profit is touched, and can
  never turn back into a loss after that (an explicit "let it ride, worst case it still
  counts" product choice) — even if price later round-trips all the way back through
  the original SL. A record short of its own ladder's last TP keeps being watched
  afterwards: reaching a farther TP upgrades `closedAt`/`exitPrice`/`hitTpIndex` to that
  new level, and each TP gets its own `reachedAt` timestamp once first touched. The SL
  still ends the chase, though — hitting it after a win just stops watching for a
  farther TP (no point re-scanning forever), without undoing the win already credited.
  A record is permanently done once it reaches its very last TP, hits the SL before any
  TP was ever reached (a genuine loss), or hits the SL after a win (chase over, win
  stands). See `evaluateSignals` in `src/lib/signalHistoryCore.js`. New signals are also
  withheld around high-impact USD news releases, since those tend to spike straight
  through a level with no real retest.
- **Telegram notifications** — public channel, H1 only. Posts new signals, fills, and
  SL/TP results automatically. A still-pending signal's own message is edited in place
  whenever its entry/SL/TP recalculate, so it never shows stale numbers — once filled,
  it's a live position and stops changing. A pending signal that's dropped before ever
  filling (its level moved on or was invalidated) gets a "❌ INVALIDATED" reply instead
  of being silently deleted from the track record with no trace. A win reply lands the
  instant any TP is touched, then again each time price reaches a farther TP on the
  same ladder (see Track record above) — each such reply's own message id is kept on
  that TP entry, in case a later correction ever needs to edit it directly. XAUUSD
  skips new signals while gold's market is closed; BTCUSD posts new signals every day
  (trades 24/7, no market-hours gate).
  Optional — no-ops without `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`. Real sends are also
  opt-in: only CI (`CI=true`, set automatically) or an explicit local
  `ALLOW_TELEGRAM_SEND=true` actually posts — see [Local development](#local-development).
- **Daily/weekly report** — same channel, H1-only, closed trades only: a still-open
  signal already has its own live message, so it isn't repeated here. Daily sends just
  after midnight WIB for the day just ended; weekly sends every Monday. A quiet symbol,
  a quiet day, or an entirely quiet report is skipped rather than padded out with "No
  signals closed" placeholder lines. De-duplicated via `data/last-report.json`.
- **Performance charts** — both reports go out as one Telegram photo message, with the
  report text as the caption, not a separate text and image. Rendered at 2x scale with
  [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas), sent via `sendPhoto`.
  Daily: one horizontal-bar panel per symbol that closed a trade that day, one bar per
  trade (red = loss), labeled by entry price. Weekly: per-day P/L bars, TP-success-rate
  pie charts (as many rungs as any trade that week reached — a TP2 hit counts toward
  TP1 too), and a trade-log table of every closed trade's date, side, symbol, result,
  and P/L. Whole numbers throughout; a footnote notes P/L is in pips. See
  `scripts/weeklyChart.mjs`.
- **Market status** — a banner during gold's closed hours (Fri 22:00 UTC → Sun 22:00
  UTC); also gates new XAUUSD signals during that window.
- **Install prompt** — a custom "add to home screen" button in the header, in place of
  the browser's own inconsistent UI.

## <img src="https://readme-typing-svg.demolab.com?lines=Local+development" alt="Typing Local Development" />

```bash
npm install
cp .env.example .env   # add TWELVE_DATA_API_KEY (twelvedata.com, free tier)
npm run fetch:data     # writes public/data/*.json
npm run dev
```

Re-run `npm run fetch:data` manually to refresh local data — there's no dev-time
proxy. It also updates the real `data/signal-history.json` and `data/last-fetch.json`
in place; check `git diff` (or `git checkout -- data/signal-history.json
data/last-fetch.json`) before committing anything else.
Telegram sends stay off during this either way (see the notifications feature above) —
reverting the JSON file cannot un-send a real message, so don't set
`ALLOW_TELEGRAM_SEND=true` unless you actually mean to test the real send path.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run fetch:data` | Fetch quote + calendar data into `public/data/` (reads `.env`) |
| `npm test` | Run the test suite ([Node's built-in test runner](https://nodejs.org/api/test.html)) |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Serve the built `dist/` locally |

`test/` covers the pure logic modules (`srDetector.js`, `signalHistoryCore.js`,
`marketHours.js`, `fetch-data.mjs`'s Telegram/retry/alert wiring, `fetch` mocked
throughout) plus the DOM-coupled browser modules (`notifications.js`, `uiState.js`)
via `jsdom` — see `test-helpers/setupDom.mjs`.

## <img src="https://readme-typing-svg.demolab.com?lines=Data+and+deployment" alt="Typing Data and deployment" />

GitHub Pages only serves static files, so `scripts/fetch-data.mjs` fetches Twelve
Data / Binance.US / the calendar feed once per run and writes static JSON into
`public/data/` — retrying on failure, then falling back to the last published
snapshot. Secrets are only ever read inside that script, never bundled into browser
code. XAUUSD's H1/H4/D1 (Twelve Data) are throttled to their own slower cadence —
15/60/360 minutes — reusing the last published snapshot on a run where they're not due
yet, so the free tier's 800-request/day cap survives a 5-minute cron; only M1 (fill/SL/TP
detection) and all of BTCUSD (Binance.US, a far more generous limit) fetch fresh every
run. "Due" is tracked as actual elapsed time since the last successful fetch
(`data/last-fetch.json`, git-tracked — see below), not the cron's own nominal schedule:
GitHub Actions' scheduler routinely fires minutes off-schedule, so checking against the
nominal schedule instead once left every throttled endpoint frozen on stale weekend
candles for hours, several cron ticks after the market had already reopened. See
`fetchThrottled`/`isFetchDue` in `scripts/fetch-data.mjs`.

`.github/workflows/deploy.yml` runs test → fetch → build → deploy:

- on every push to `master`
- hourly (cron — a fallback safety net only, see below)
- on `workflow_dispatch` — the real 5-minute cadence, driven by
  `cloudflare/cron-trigger`, a small external Worker that calls this instead of relying
  on GitHub's own `schedule:` trigger. GitHub's `schedule:` event is documented as
  best-effort and was observed silently throttling this repo's ticks (gaps growing from
  ~20 minutes to 10+ hours over a few days) even though every run that fired succeeded
  in under 2 minutes — `workflow_dispatch`, invoked externally, isn't covered by that
  caveat. See `cloudflare/cron-trigger/README.md` for setup.

A failing test stops the run before anything else happens. CI is otherwise stateless.
`data/signal-history.json`, `data/last-alert.json`, `data/last-report.json` and
`data/last-fetch.json` are the exceptions — updated every run, committed back to
`master` only when they change (most ticks commit nothing). A rejected push (something
else landed on `master` mid-run) rebases and retries up to 3 times. The `deploy` job
itself retries up to 3 times on a transient `actions/deploy-pages` failure.

**Ops alerting** — a data-source or fatal failure alerts `TELEGRAM_PERSONAL_CHAT_ID`
(a private DM, separate from the public channel). De-duplicated via
`data/last-alert.json`; the same failure re-alerts only after `ALERT_SUPPRESS_HOURS`
(default 6) have passed.

**Dependency updates** — `.github/dependabot.yml` opens a weekly PR for outdated or
vulnerable packages.

One-time setup for a fork or new deploy target:

1. **Settings → Secrets and variables → Actions** — add `TWELVE_DATA_API_KEY`, and
   optionally `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (public channel) /
   `TELEGRAM_PERSONAL_CHAT_ID` (ops alerts).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. On a fork/rename/domain change only — add the `SITE_URL` repository **variable**
   (e.g. `https://you.github.io/your-repo`).

`vite.config.js` bases the build at `/trefozeri/` only when `GH_PAGES=true` (local dev
stays at `/`), and also builds `id/index.html` — a static Indonesian-language SEO
landing page at `/id/`, cross-linked with the root page via `hreflang`.

## <img src="https://readme-typing-svg.demolab.com?lines=Project+structure" alt="Typing Project structure" />

```
index.html  English dashboard entry point (loads src/main.js)
id/
  index.html  Indonesian-language static SEO landing page
src/
  main.js    UI wiring, render loop, refresh/cache orchestration
  style.css  All styling (theme via CSS custom properties)
  lib/
    twelveData.js         Timeframe/symbol config + static-JSON quote fetching
    srDetector.js         Pivot detection, zones, signals
    priceChart.js         lightweight-charts candle + zone rendering
    newsCalendar.js       Static-JSON calendar fetching + high-impact filtering
    notifications.js      Opt-in browser notifications for zone/signal alerts
    uiState.js            Persisted tab/symbol selection
    signalHistoryCore.js  Record lifecycle + pip/price formatting, shared by browser + cron
    signalHistory.js      Browser-side: reads the shared signal-history.json
    marketHours.js        Gold's trading week + weekend detection
scripts/
  fetch-data.mjs   Fetches quote/calendar data, maintains the track record, sends
                   Telegram notifications + reports, alerts on failures
  weeklyChart.mjs  Renders the weekly report's HD chart images (@napi-rs/canvas)
assets/
  fonts/  JetBrains Mono TTFs, bundled so chart-image text renders identically on
          any machine (dev laptop or CI runner) instead of depending on whatever
          fonts happen to be preinstalled
test/
  *.test.mjs  node --test suite — see Local development above
test-helpers/
  setupDom.mjs  jsdom + Notification-API mock for the DOM-coupled tests
data/
  signal-history.json  Git-tracked shared signal track record — committed by CI
  last-alert.json      Git-tracked admin-alert de-dup state — committed by CI
  last-report.json     Git-tracked daily/weekly report de-dup state — committed by CI
  last-fetch.json      Git-tracked last-successful-fetch timestamps — committed by CI,
                       used to throttle XAUUSD's H1/H4/D1 (see isFetchDue above)
.github/workflows/
  deploy.yml  Test → cron fetch → persist track record → build → deploy
.github/
  dependabot.yml  Weekly PRs for outdated/vulnerable npm + Actions deps
cloudflare/cron-trigger/
  worker.js      Calls deploy.yml's workflow_dispatch every 5 min (see Data and
                 deployment above) — deployed separately via Wrangler, not by this repo's CI
  wrangler.toml  Worker + Cron Trigger config
  README.md      Setup steps
```
