# TREFOZERI — Trend Following Zero Risk

A single Python engine that fuses **4 components** into **one confidence-scored signal** for trading. The decision is deterministic and transparent (backtestable); the AI layer only narrates, it does not decide.

> ⚠️ **A decision-support tool — NOT financial advice and NOT a profit guarantee.** "Zero Risk" is the product name, not a promise: every trade carries risk. Backtest before using real money.

**Author:** Redy Apriyadi · **Email:** redy.apriyadi@gmail.com · **Link:** https://bit.ly/trefozeri

---

## The four components

| Component | Role | Data source | Key required? |
|---|---|---|---|
| **Dark Point** | Trend + SL/TP levels | OHLC price (TwelveData) | Yes (price) |
| **Homma** | Candlestick patterns / price action | OHLC price | — |
| **COT** | Institutional positioning bias (gold COMEX) | CFTC via `cot_reports` | No (free) |
| **MDP-proxy** | Liquidity/sentiment proxy | OANDA position book (optional) | Optional |

### An honest note on "MDP"
Real **Multi-Dealer Platform** data (FXall, 360T, Bloomberg FXGO, prime-of-prime) is an **institutional** venue — it requires *Eligible Contract Participant* status, a prime-broker relationship, and large capital. **Not accessible to a solo developer.** So here "MDP" is represented by an accessible **contrarian retail-sentiment proxy**. This is the easiest component to swap: it can be replaced with the OANDA order book, FXSSI, Myfxbook, or COMEX futures volume data.

### Dark Point is a reconstruction
The original Dark Point is closed-source. What is implemented here is a **transparent reconstruction** of the publicly described behavior (MA + ATR trend-following, non-repaint, direction flips, ATR-derived SL/TP levels) — technically similar to **Supertrend**. If you have the exact formula/rules, just replace the `dark_point()` function.

---

## Usage

```bash
pip install -r requirements.txt

# 1) DEMO — runs without any API key; synthetic data is randomized each run,
#    so it can yield BUY, SELL, or NEUTRAL
python trefozeri.py --demo

# reproduce a specific demo scenario with a fixed seed
python trefozeri.py --demo --seed 1

# 2) LIVE — real data (requires keys, see below)
python trefozeri.py --live

# send the result to Telegram
python trefozeri.py --live --telegram
```

### Credentials (`.env`)
Copy `.env.example` to `.env` and fill in your keys — `python-dotenv` loads it
automatically on every run, so there is **no need to `export` anything**:

```bash
cp .env.example .env
# then edit .env:
TWELVEDATA_API_KEY=...      # price data (required for --live)
OANDA_TOKEN=...             # sentiment proxy (optional)
AI_PROVIDER=none            # "claude" | "gemini" | "none"
CLAUDE_API_KEY=...          # if AI_PROVIDER=claude
GEMINI_API_KEY=...          # if AI_PROVIDER=gemini
TELEGRAM_BOT_TOKEN=...      # optional (for --telegram)
TELEGRAM_CHAT_ID=...        # optional (for --telegram)
```
`.env` is git-ignored. Plain `export VAR=...` still works as an alternative (handy for one-offs or CI), and real environment variables take precedence over `.env`. COT (CFTC) and the ForexFactory calendar **require no key**.

### Instrument: gold on weekdays, crypto on weekends
The pair is selected automatically by day of week (UTC): **XAU/USD on weekdays**, **BTC/USD on the weekend** — the gold/forex market closes on weekends while crypto trades 24/7. Override anytime with `--symbol`:

```bash
python trefozeri.py --demo --symbol "BTC/USD"
```
Each profile in `CONFIG["instruments"]` carries its own TwelveData symbol, COT filter (gold COMEX vs. CME Bitcoin), OANDA sentiment instrument, and demo price level. Add more pairs by extending that dict.

---

## Output

A summary printed to the screen + a `signal.json` file. Example:

```
  SIGNAL     : 🟢 BUY   (confidence 73.2%)
  Score      : +0.465   |  Price: 3320.10
  Entry zone : 3315.10 - 3320.10   (mid 3317.60)
      50% market @ 3320.10
      50% limit  @ 3315.10
  SL         : 3312.60   (invalidation)
  TP1 / TP2  : 3325.10 / 3332.60   (R:R 1.5 / 3.0)
  Valid      : ~8 bars (limit order)
  Components:
    dark_point : +0.50  [BUY]   q=0.50
    homma      : +0.40  [BUY]   q=0.60
    cot        : +0.50  [BUY]   q=0.60
    mdp_proxy  : +0.30  [BUY]   q=0.60
```

The engine chooses **NEUTRAL** (stand aside) when the combined score is weak, the components don't agree enough, or there is high-impact USD news within the time window (default 30 minutes). NEUTRAL produces no entry zone.

### Entry zone (instead of a single price)
Rather than entering at the exact close, the engine outputs a **price range** anchored to the Dark Point line — a trend-following idea: buy the pullback toward the trend line (uptrend) or sell the rally toward it (downtrend), instead of chasing.

- One edge of the zone is the **current price** (the "market" half); the other is a **pullback toward the Dark Point line**, capped at `zone_pullback_atr` (in ATR units).
- The position is **scaled in 50/50**: a market order at the near edge + a limit order at the pullback edge.
- The **stop-loss sits just beyond the far edge** (`zone_sl_buffer_atr`), which is essentially the level where the trend itself would flip — so the SL is structural, not arbitrary.
- **R:R is blended**, measured from the zone's mid (average fill), so the reported reward:risk is honest regardless of which order fills.
- The pullback limit order is valid for `entry_valid_bars`; the `invalidation` price (= SL) cancels the pending order if it trades first. If price never pulls back, only the market half fills.

---

## Backtester
`backtest.py` walks the series bar-by-bar (no look-ahead) and simulates the entry zone **realistically**: a market leg fills at the signal bar, and a limit leg fills only if price pulls back to the zone edge within `entry_valid_bars` (otherwise the trade runs at half size). Each leg is managed **TP1 → breakeven → TP2**, with a hard stop and a time stop. Results are in **R** (risk units; a full stop = −1R), **net of costs**.

```bash
# price-only (Dark Point + Homma), per-instrument spread applied
python backtest.py --demo --symbol "XAU/USD" --seed 42 --bars 1500

# full confluence: feed historical COT (MDP stays neutral — no historical feed)
python backtest.py --live --symbol "XAU/USD" --bars 5000 --cot

# costs: bid/ask spread (price units) + optional commission (bps of price)
python backtest.py --demo --spread 0.30 --cost-bps 2

# robustness sweep: vary one parameter and watch the metric across the range
python backtest.py --live --bars 5000 --sweep dp_multiplier:2:4:0.25

# walk-forward: optimize a param in-sample, test it out-of-sample, roll forward
python backtest.py --live --bars 5000 --walkforward dp_multiplier:2:4:0.5 --is-bars 1500 --oos-bars 400
```

`--sweep NAME:START:STOP:STEP` re-runs the backtest across a parameter range and flags whether results form a stable **plateau** (robust) or a lone spike (overfit). `--walkforward NAME:START:STOP:STEP` optimizes the parameter on each in-sample window, trades it on the next **unseen** out-of-sample window, rolls forward, and reports the aggregate OOS result plus a **walk-forward efficiency** (OOS ÷ IS); near/above 1 is robust, well below means overfit. Both write a `*_summary.json`. Run them on `--live` data — the synthetic demo flatters any trend-follower.

It reports trades, win rate, expectancy (R/trade), **net vs gross R and cost drag**, profit factor, max drawdown (R), the **both-legs-filled rate**, and a BUY/SELL split, then writes `backtest_trades.csv` + `backtest_summary.json`.

Honest scope & caveats:
- **Fills**: realistic two-leg model — if the pullback never triggers, only the market half trades (so position size is halved). R is normalized to the planned full-size risk.
- **Costs**: `--spread` (per-instrument by default) + `--cost-bps` are charged round-trip per filled leg. For a frequent intraday strategy, costs dominate and can turn a gross-positive result negative.
- **Confluence**: `--cot` adds the real COT component mapped to the last *completed* COT week; **MDP-proxy stays neutral** (no historical retail-sentiment feed), so it is a 3-of-4 confluence.
- **Data**: demo data is synthetic and trend-rich, flattering a trend-follower. **Validate on `--live` data before trusting any number.** Not financial advice.

---

## Run it automatically (macOS, launchd)
The included `com.trefozeri.signal.plist` LaunchAgent runs the engine **live every minute** (matching `entry_tf` = M1) and survives reboot/login. With the confidence gate + `--telegram`, you are only pinged on strong signals. Note: this calls TwelveData ~1440x/day instead of ~288x/day — check your plan's rate/credit limit before relying on it.

```bash
cp com.trefozeri.signal.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.trefozeri.signal.plist
launchctl enable gui/$(id -u)/com.trefozeri.signal
launchctl kickstart -k gui/$(id -u)/com.trefozeri.signal   # run once now to test
tail -f run.log run.err.log                                # watch output
```

Stop/remove: `launchctl bootout gui/$(id -u)/com.trefozeri.signal && rm ~/Library/LaunchAgents/com.trefozeri.signal.plist`.

Caveats: the Mac must be awake (sleep coalesces missed runs — use `caffeinate -dimsu` or a server for true 24/7); `.env` must hold live keys (the agent `cd`s into the folder so `.env` loads); if `run.err.log` shows permission errors, grant the venv `python` Full Disk Access in System Settings → Privacy & Security (macOS protects `~/Documents`). For real 24/7, host on a small Linux VPS with `cron`/systemd instead.

---

## Auto-execution (MT5 bridge)
The engine can hand signals to MetaTrader 5 for automatic execution. It emits two ways at once — `--mt5-file` writes a file the EA reads, `--webhook` POSTs the JSON for other consumers (dashboard/relay):

```bash
python trefozeri.py --live \
  --mt5-file "/path/to/MT5/MQL5/Files/trefozeri_signal.txt" \
  --webhook "https://your-endpoint/hook"
```

(Or set `MT5_SIGNAL_FILE` / `WEBHOOK_URL` in `.env`.) Find the folder in MT5: File → Open Data Folder → `MQL5\Files`. The file is one atomic line:

```
schema;id;symbol;direction;confidence;market;limit;sl;tp1;tp2;tp3;valid_bars;tg_msg_id
```

Attach the EA:
1. Copy `TrefozeriBridge.mq5` into `MQL5/Experts`, open MetaEditor, compile (F7).
2. Attach it to a chart of the matching symbol and enable **AutoTrading**.
3. Key inputs: `DryRun` (logs intended orders without trading when true; set false to go live), `MinConfidence` (60), `RiskMode` + `RiskPercent`/`FixedLots`, `MaxMarginPercent` (lot cap), `SymbolSuffix` (if your broker appends e.g. `.r`), `MagicNumber`, `ManagePartials`, `TP1ClosePercent`/`TP2ClosePercent`, `AllowSameDirStack`.

What the EA does: reads the file on a timer, acts on each `id` once, skips low-confidence/NEUTRAL, sizes lots from the SL distance (capped at `MaxMarginPercent` of free margin), and places the market half + (optional) pullback limit half with SL and the final target **TP3**. It then ladders: at **TP1** it closes `TP1ClosePercent` (default 50%) and moves the stop to the midpoint of entry↔TP1; at **TP2** it closes `TP2ClosePercent` of the remainder and moves the stop to the midpoint of TP1↔TP2; past the **midpoint of TP2↔TP3** it trails the stop up to TP2 (no partial); the runner exits at **TP3**. If a partial would breach the broker's minimum lot, it **full-closes** at that target instead. Same-direction signals are ignored while a trade is open unless `AllowSameDirStack = true` (then each entry is tracked independently); an opposite signal closes the current position and reverses.

**Telegram trade alerts:** the engine's `--telegram` announces *new signals*; the EA notifies on *fills/exits*. Set `EnableTelegram = true`, fill `TelegramToken` / `TelegramChatId` (**same chat as the engine** so alerts thread), and **whitelist the URL**: MT5 → Tools → Options → Expert Advisors → "Allow WebRequest for listed URL" → add `https://api.telegram.org`. It pings 🟢 TP1 / TP2 / TP3 and a clean 🔴 SL, each as a **reply to the originating signal** — the message_id travels in the order comment, so replies survive an EA restart and multiple concurrent trades. Stop-outs and an SL-after-a-partial (locked profit) are silent, and each event pings once even with two legs.

> ⚠️ Auto-execution risks real money. Keep `DryRun = true` until you've watched the logs, then test on a **demo** account before going live. Not investment advice.

---

## Dashboard (cockpit)
`dashboard.html` is a self-contained web cockpit (plain HTML + JS, no backend). It reads `signal.json` every 15 s and shows the live signal — direction, confidence, entry zone, SL/TP1/TP2/TP3 with R:R, the four confluence bars, the AI narrative, data freshness, and a backtest snapshot (from `backtest_summary.json` if present).

Browsers block `fetch` over `file://`, so serve the folder over HTTP:

```bash
cd ~/Documents/projects/trefozeri/AI
python3 -m http.server 8000
# then open http://localhost:8000/dashboard.html
```

Paired with the launchd agent (which refreshes `signal.json` every 5 min) the page updates on its own. Opened directly as a file it falls back to sample data so you can still preview the layout.

---

## Configuration
Everything lives in `CONFIG` (top of `trefozeri.py`): timeframes (`entry_tf` + the `mtf_tfs`/`mtf_weights` stack), ATR period/multiplier, per-component weights, signal thresholds, news-filter window, AI narration language, etc.

Default weights: Dark Point 0.30 · Homma 0.25 · COT 0.25 · MDP-proxy 0.20.
Default AI narration language: `en` (set `ai_language` to `id` for Indonesian).

Entry-zone knobs: `zone_pullback_atr` (max pullback depth from market, in ATR; default 1.0), `zone_sl_buffer_atr` (SL distance beyond the far edge, in ATR; default 0.5), `entry_valid_bars` (how long the pullback limit stays valid; default 8).

Alerts: the Analysis runs and Telegram is sent **only when the signal is BUY/SELL and confidence > `alert_min_confidence`** (default 60).

Position-state dedup: a BUY/SELL only re-alerts (Telegram/MT5/webhook) once the current setup resolves — SL hit, TP1 hit, the trend flips, or `max_hold_minutes` elapses (disabled by default). While unresolved, `signal.json` still updates every run (with a `position_state` block) but no new alert/EA trigger fires. State lives in `position_state_file` (default `position_state.json`, gitignored).

---

## Technical notes
- **Multi-timeframe**: Dark Point is computed on 5 timeframes — H1, M30, M15, M5, M1 — resampled from a single M1 fetch (`resample_htf`), then combined with H1-dominant weights (`mtf_weights`: H1 0.35 · M30 0.25 · M15 0.20 · M5 0.12 · M1 0.08). H1 drives the overall bias; M1 sharpens the entry price and also anchors ATR/SL/TP/entry-zone (the execution timeframe, `entry_tf`). Homma's candlestick patterns now read M1 directly too — `homma_lookback` (5→25) and `trend_ema` (50→250) were scaled 5x so the real-time window they cover (~25 min pattern lookback, ~4.2h trend context) stays equivalent to the old M5 setup. Single-candle noise is still higher on M1 than M5, so Homma's confidence is worth watching in live use.
- **Orchestration**: Runs on-demand. For automatic scheduling, wrap it with `cron`/Task Scheduler or add `APScheduler` inside the application.
- **Backtest**: see `backtest.py` (bar-by-bar, no look-ahead, R-based metrics).

## Next steps (if you want to continue)
1. Live positions / P&L panel in the dashboard (export open trades from the EA to a file the page reads).
2. Broaden the instrument set with portfolio-level risk caps.
