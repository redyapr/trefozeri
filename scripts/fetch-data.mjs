#!/usr/bin/env node
// Pre-fetches the dashboard's price and calendar data so it can be shipped as static
// JSON. GitHub Pages only serves static files — there's no server to proxy this on
// request — so this script does the upstream fetch once per CI run (cron, see
// .github/workflows/deploy.yml) and writes the result into public/data/, which Vite
// then copies straight into dist/. TWELVE_DATA_API_KEY is only ever read here, inside
// the GitHub Actions runner or a developer's own shell; it's never bundled into the
// browser code.
//
// This run also maintains the shared signal track record (data/signal-history.json):
// it runs the same detection/signal logic the browser runs (srDetector.js is plain JS,
// portable to Node), updates the record with whatever fresh candles it just fetched,
// and writes it to a path that IS git-tracked (unlike public/data/, which is
// regenerated from scratch every run and never committed) — the workflow commits it
// back to the repo when it changes, so the record survives across these otherwise
// stateless CI runs and every visitor to the site fetches the same file.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { detectLevels, buildSignals, annotateGoldenZones, isPriceStagnant, computeTrend } from '../src/lib/srDetector.js'
import {
  recordSignals,
  evaluateSignals,
  trimRecords,
  keyFor,
  getClosedBetween,
  PIP_SIZES,
  favorableMove,
  formatMove,
  formatPrice,
} from '../src/lib/signalHistoryCore.js'
import { isGoldMarketClosed } from '../src/lib/marketHours.js'
import { computeWeeklyChartData, renderWeeklyReportImage, computeDailyChartData, renderDailyReportImage } from './weeklyChart.mjs'

const OUT_DIR = path.join(process.cwd(), 'public', 'data')
const HISTORY_PATH = path.join(process.cwd(), 'data', 'signal-history.json')
const ALERT_STATE_PATH = path.join(process.cwd(), 'data', 'last-alert.json')
const REPORT_STATE_PATH = path.join(process.cwd(), 'data', 'last-report.json')
// A persistent cause (an expired API key, say) would otherwise re-alert every single
// 15-minute cron tick forever — suppress a repeat of the exact same alert text until
// this long has passed since it was last actually sent. Overridable (hours, not ms)
// via ALERT_SUPPRESS_HOURS for anyone who wants alerts more/less often than the default.
const ALERT_SUPPRESS_MS = (Number(process.env.ALERT_SUPPRESS_HOURS) || 6) * 60 * 60 * 1000

// Telegram notifications are opt-in per symbol (XAUUSD and BTCUSD) and per timeframe
// (H1 only for now) — H4/D1 signals never post, even as part of a cross-timeframe
// confluence group. Silently a no-op (see sendTelegramMessage) if
// TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID aren't set, so local dev without them still works.
const TELEGRAM_SYMBOLS = new Set(['XAUUSD', 'BTCUSD'])
const TELEGRAM_TIMEFRAMES = new Set(['H1'])
const TF_ORDER = ['H1', 'H4', 'D1']

// Ops alerting: a *separate* chat from the public signals channel (TELEGRAM_CHAT_ID) —
// TELEGRAM_PERSONAL_CHAT_ID is a private DM with the bot, so run-health noise (a data
// source down, a fatal script error) never lands in front of channel subscribers. Also
// no-ops if unset, same as the public channel.
const FAILURES = []
// Parallel to FAILURES, but just the stable label (e.g. "XAUUSD H1"), not the full
// message — used to build sendAdminAlertDeduped's dedup key (see main()) instead of
// the full text, since the full text embeds each error's own .message and would
// otherwise defeat de-duplication if that varies at all run to run for what's really
// the same persistent cause.
const FAILURE_LABELS = []
function recordFailure(label, message) {
  FAILURES.push(`${label}: ${message}`)
  FAILURE_LABELS.push(label)
}
export function getFailures() {
  return FAILURES
}
export function resetFailures() {
  FAILURES.length = 0
  FAILURE_LABELS.length = 0
}

// SITE_URL is optional (defaults to this repo's own deployment) so a fork/rename/domain
// change is one env var, not a code edit that's easy to forget. Also used as-is as the
// dashboard link in every signal message's title (see buildNewSignalMessage).
const SITE_URL = process.env.SITE_URL || 'https://redyapr.github.io/trefozeri'
// If today's upstream fetch fails (rate limit, outage), fall back to whatever is
// already live rather than shipping a hole in the data — a stale snapshot beats a
// missing one, and the next successful cron run heals it anyway.
const LIVE_BASE = `${SITE_URL}/data`

// Kept as a local, minimal copy rather than importing src/lib/twelveData.js — that
// module reads import.meta.env (a Vite/browser concern), which plain Node doesn't have.
const TIMEFRAMES = [
  { key: 'H1', twelveDataInterval: '1h', binanceInterval: '1h', outputsize: 300 },
  { key: 'H4', twelveDataInterval: '4h', binanceInterval: '4h', outputsize: 300 },
  { key: 'D1', twelveDataInterval: '1day', binanceInterval: '1d', outputsize: 300 },
]

// Fetched separately from TIMEFRAMES and used for exactly one thing: checking an
// already-open (pending/running) record's fill/SL/TP against finer-grained intrabar
// movement than an H1 candle can show (see evaluateSignals' own call site below, and
// updateSignalHistoryForSymbol's explicit skip of this key in its zone-detection loop).
// Deliberately NOT part of S/R detection, trend, or higher-timeframe TP borrowing — a
// "support/resistance" read off 1-minute noise wouldn't mean anything. outputsize 1000
// (~16.7 hours) comfortably covers even a long gap between cron runs; evaluateSignals
// falls back to whatever's actually in the window regardless of how old a still-open
// record is, same as it always has.
const MONITOR_TF = { key: 'M1', twelveDataInterval: '1min', binanceInterval: '1m', outputsize: 1000 }

export function toTwelveDataDatetime(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

async function fetchTwelveData(apiSymbol, tf, apiKey) {
  const url =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(apiSymbol)}&order=ASC&timezone=UTC` +
    `&interval=${tf.twelveDataInterval}&outputsize=${tf.outputsize}&apikey=${apiKey}`
  const res = await fetch(url)
  const json = await res.json()
  if (!res.ok || json.status === 'error' || json.code || json.message || !Array.isArray(json.values)) {
    throw new Error(json.message || `Twelve Data error (${res.status})`)
  }
  return { status: 'ok', values: json.values }
}

// BTC/USD is served from Binance.US instead of Twelve Data — no key needed, a far more
// generous rate limit, and (being the US-compliant entity) no "restricted location"
// block on US-hosted CI runners the way binance.com applies to that same traffic. This
// also halves the load on the Twelve Data quota, since crypto no longer competes with
// gold for the same per-minute allowance.
async function fetchBinance(tf) {
  const url = `https://api.binance.us/api/v3/klines?symbol=BTCUSD&interval=${tf.binanceInterval}&limit=${tf.outputsize}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance.US error (${res.status})`)

  const klines = await res.json()
  // volume (kline index 5) is real traded-base-asset volume — kept through so
  // srDetector.js's breakout-quality check (see evaluateBreakoutQuality) can use it
  // directly for BTCUSD, rather than falling back to the body-ratio proxy it needs for
  // XAUUSD (Twelve Data's spot feed has no volume field at all).
  const values = klines.map(([openTime, open, high, low, close, volume]) => ({
    datetime: toTwelveDataDatetime(openTime),
    open,
    high,
    low,
    close,
    volume,
  }))
  return { status: 'ok', values }
}

async function fetchCalendar() {
  const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json')
  if (!res.ok) throw new Error(`Calendar feed error (${res.status})`)
  return res.json()
}

// A high-impact USD release is exactly the kind of event that produces the
// far-outsized-ATR spike candles found blowing through both entry and SL together in
// the 2026-08-17 win-rate review — hold back opening brand-new signals in a window
// straddling the release itself, the same way isGoldMarketClosed already holds back new
// XAUUSD signals outside gold's own trading week. Existing open positions still
// evaluate/close normally; this only withholds *new* signal formation. Checks both
// before and after `now` (not just upcoming) since the spike risk spans the release
// itself, not just its lead-up. Not imported from newsCalendar.js: that module reads
// import.meta.env at its top level for its own fetch endpoint, a Vite/browser concern
// this plain-Node script doesn't have — same reasoning parseUtc below is its own local
// copy rather than importing twelveData.js's.
const NEWS_GATE_MINUTES = 30

export function isNearHighImpactNews(calendar, now, windowMinutes = NEWS_GATE_MINUTES) {
  if (!Array.isArray(calendar)) return false
  const windowMs = windowMinutes * 60 * 1000
  return calendar.some((e) => {
    if (String(e.country).toUpperCase() !== 'USD' || String(e.impact).toLowerCase() !== 'high') return false
    const t = new Date(e.date).getTime()
    return Number.isFinite(t) && Math.abs(t - now) <= windowMs
  })
}

// A transient blip (rate limit, a momentary 5xx, a dropped connection) shouldn't
// immediately give up and serve stale data — retry a couple of times with backoff
// first. Only once retries are exhausted does fetchWithFallback fall back to the last
// published snapshot.
const RETRY_ATTEMPTS = 2 // 1 initial try + this many retries
const RETRY_BASE_DELAY_MS = 1000 // 1s, then 2s

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// attempts/baseDelayMs are overridable (rather than always reading the module
// constants) so tests can drive this with near-zero delay instead of eating the real
// backoff on every retry-path test case.
export async function withRetry(fn, label, { attempts = RETRY_ATTEMPTS, baseDelayMs = RETRY_BASE_DELAY_MS } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < attempts) {
        const backoff = baseDelayMs * 2 ** attempt
        console.warn(`[fetch-data] ${label} attempt ${attempt + 1} failed (${err.message}), retrying in ${backoff}ms`)
        await delay(backoff)
      }
    }
  }
  throw lastErr
}

export async function fetchWithFallback(label, primary, fallbackRelPath, retryOptions) {
  try {
    return await withRetry(primary, label, retryOptions)
  } catch (err) {
    console.warn(`[fetch-data] ${label} failed after retries (${err.message}) — falling back to last published snapshot`)
    try {
      const res = await fetch(`${LIVE_BASE}/${fallbackRelPath}`)
      if (!res.ok) throw new Error(`fallback fetch returned ${res.status}`)
      return await res.json()
    } catch (fallbackErr) {
      console.warn(`[fetch-data] ${label} fallback also failed (${fallbackErr.message}) — leaving this file unwritten`)
      recordFailure(label, `primary failed after retries (${err.message}); fallback also failed (${fallbackErr.message})`)
      return null
    }
  }
}

async function writeJson(relPath, data) {
  const full = path.join(OUT_DIR, relPath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, JSON.stringify(data))
  console.log(`[fetch-data] wrote ${relPath}`)
}

// Twelve Data (and our Binance mapping, see fetchBinance) both return naive
// "YYYY-MM-DD[ HH:mm:ss]" strings with no offset — kept as a local copy of
// src/lib/twelveData.js's parseUtc rather than importing it, since that module reads
// import.meta.env (a Vite/browser concern) that plain Node doesn't have.
export function parseUtc(datetime) {
  const iso = datetime.includes(' ') ? datetime.replace(' ', 'T') + 'Z' : `${datetime}T00:00:00Z`
  return new Date(iso).getTime()
}

export function toCandles(values) {
  return values.map((v) => ({
    time: parseUtc(v.datetime),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    // undefined (not NaN/0) when the source has no volume field at all (Twelve Data's
    // XAUUSD feed) — srDetector.js treats that as "no data" and falls back to a
    // volume-less proxy, rather than reading as a real, suspiciously-zero volume.
    volume: v.volume != null ? parseFloat(v.volume) : undefined,
  }))
}

// Real sends are opt-IN, not opt-out: allowed in CI (GitHub Actions sets CI=true on
// every job automatically — no workflow change needed) or when a developer explicitly
// sets ALLOW_TELEGRAM_SEND=true locally. `npm run fetch:data` has no dry-run mode of its
// own and .env carries the real bot token/chat id, so a plain local run — e.g. while
// verifying an unrelated UI change — silently posts to the real public channel as a
// side effect of whatever real market data it happens to fetch that moment. That's
// exactly what produced a confusing pair of stray messages in the channel during this
// project's own development (see the incident discussed around 2026-08-16/17) —
// reverting data/signal-history.json afterward undoes the local record of it, but
// can't un-send a message already posted. Forgetting to set anything now safely no-ops
// instead of risking that again.
export function telegramSendsAllowed() {
  return process.env.CI === 'true' || process.env.ALLOW_TELEGRAM_SEND === 'true'
}

// Posts one message to `chatId` (defaults to the public signals channel), optionally
// as a reply to an earlier message (used to thread a SL/TP result under the signal
// that opened it). Returns the sent message's id (so it can later be replied to), or
// null on any failure — notifications are best-effort and should never fail the whole
// cron run.
export async function sendTelegramMessage(text, replyToMessageId, chatId = process.env.TELEGRAM_CHAT_ID) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || !chatId || !telegramSendsAllowed()) return null

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        // The signal message's title links to the dashboard (see buildNewSignalMessage)
        // — without this, Telegram would attach a big preview card under every one of
        // them, dwarfing the actual <pre> content. Harmless when there's no link at all.
        link_preview_options: { is_disabled: true },
        // allow_sending_without_reply: false — the original message could in principle
        // have been deleted from the chat since (e.g. manually), in which case skip
        // this notification entirely (the call below fails, json.ok is false, and the
        // caller gets null) rather than posting it as a confusing orphaned standalone
        // message with no context.
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: false } : {}),
      }),
    })
    const json = await res.json()
    if (!json.ok) {
      console.warn(`[telegram] sendMessage failed: ${json.description}`)
      return null
    }
    return json.result.message_id
  } catch (err) {
    console.warn(`[telegram] sendMessage error: ${err.message}`)
    return null
  }
}

// Replaces an already-sent message's text in place — used to keep a still-pending
// signal's post in sync when its entry/SL/TP recalculate (see recordSignals in
// signalHistoryCore.js). Same best-effort contract as sendTelegramMessage: any failure
// (message deleted, too old, etc.) is logged and swallowed, never thrown.
export async function editTelegramMessage(text, messageId, chatId = process.env.TELEGRAM_CHAT_ID) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || !chatId || !messageId || !telegramSendsAllowed()) return false

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    })
    const json = await res.json()
    if (!json.ok) {
      console.warn(`[telegram] editMessageText failed: ${json.description}`)
      return false
    }
    return true
  } catch (err) {
    console.warn(`[telegram] editMessageText error: ${err.message}`)
    return false
  }
}

// Sends a PNG buffer as a Telegram *photo* — shows inline in-chat (tap to view
// full-screen) rather than as a generic file attachment. Telegram does re-compress to
// JPEG and downscale for its own preview sizes, but the 2x-scale "HD" render (see
// weeklyChart.mjs) — mostly flat colors, lines and text rather than photographic detail
// — holds up well under that compression, and this is the nicer in-chat experience.
// Same best-effort contract as sendTelegramMessage: never throws, returns null on any
// failure.
export async function sendTelegramPhoto(buffer, filename, caption, chatId = process.env.TELEGRAM_CHAT_ID) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || !chatId || !telegramSendsAllowed()) return null

  try {
    const form = new FormData()
    form.append('chat_id', chatId)
    // HTML parse_mode only matters when there's a caption to render — the weekly
    // report's own HTML (<b>...</b>) is passed as the caption here (see
    // sendWeeklyReport), same as sendTelegramMessage's own HTML captions elsewhere.
    if (caption) {
      form.append('caption', caption)
      form.append('parse_mode', 'HTML')
    }
    form.append('photo', new Blob([buffer], { type: 'image/png' }), filename)
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form })
    const json = await res.json()
    if (!json.ok) {
      console.warn(`[telegram] sendPhoto failed: ${json.description}`)
      return null
    }
    return json.result.message_id
  } catch (err) {
    console.warn(`[telegram] sendPhoto error: ${err.message}`)
    return null
  }
}

// Ops alert to the personal chat — never the public channel. Best-effort like
// sendTelegramMessage: a failure here is logged, not thrown, so it can never mask or
// replace the actual error/failure being reported.
export async function sendAdminAlert(text) {
  const chatId = process.env.TELEGRAM_PERSONAL_CHAT_ID
  if (!chatId) return
  await sendTelegramMessage(`⚠️ <b>trefozeri cron</b>\n${text}`, undefined, chatId)
}

async function loadAlertState() {
  try {
    return JSON.parse(await readFile(ALERT_STATE_PATH, 'utf8'))
  } catch {
    return null // never alerted before, or the file's missing/corrupt
  }
}

async function saveAlertState(state) {
  await mkdir(path.dirname(ALERT_STATE_PATH), { recursive: true })
  await writeFile(ALERT_STATE_PATH, JSON.stringify(state))
}

// Wraps sendAdminAlert with de-duplication, persisted across runs (data/last-alert.json
// is git-tracked the same way data/signal-history.json is — see the workflow's persist
// step) since every run is otherwise a fresh, stateless process. Only resends if
// `dedupKey` changed, or ALERT_SUPPRESS_MS has passed since this same key last actually
// sent — a transient blip that resolves itself never touches this at all, since
// FAILURES/fatal errors are the only callers. `dedupKey` defaults to `text` itself for
// a caller with no more stable identity to key off (e.g. a one-off fatal error), but
// callers whose alert text embeds something that can legitimately vary run-to-run for
// the *same* underlying cause (a data-source failure's own err.message, say) should
// pass a separate, stable key — otherwise de-dup can never actually trigger for what's
// really a persistent, already-alerted issue, defeating ALERT_SUPPRESS_HOURS entirely.
export async function sendAdminAlertDeduped(text, dedupKey = text) {
  const state = await loadAlertState()
  const now = Date.now()
  if (state && state.dedupKey === dedupKey && now - state.sentAt < ALERT_SUPPRESS_MS) {
    console.warn('[fetch-data] suppressing repeat admin alert (already sent recently):', text.split('\n')[0])
    return
  }
  await sendAdminAlert(text)
  await saveAlertState({ dedupKey, sentAt: now })
}

// group is almost always a single signal now that TELEGRAM_TIMEFRAMES filters down to
// H1 before grouping — kept as a group (rather than a single signal) so this still
// works unchanged if TELEGRAM_TIMEFRAMES is ever widened back out. The timeframe
// itself isn't printed: with only one timeframe ever reaching Telegram, naming it on
// every message is just noise.
// Shared primitive behind every column-alignment helper below (and buildNewSignalMessage's
// own TP price/rr columns): pads every string in `values` out to the width of the widest
// one — `'end'` (default) left-aligns the column with trailing spaces, `'start'`
// right-aligns it with leading spaces.
function padColumn(values, align = 'end') {
  const width = Math.max(...values.map((v) => v.length))
  return values.map((v) => (align === 'start' ? v.padStart(width) : v.padEnd(width)))
}

// Right-pads every row's label to the widest one in this message, so the ":"s all land
// in the same column — only readable as a fixed-width block, hence the <pre> wrapper
// below (Telegram's normal proportional font would make manual padding meaningless).
function alignRows(rows) {
  // Padding `label + ' '` (rather than the bare label) guarantees at least one space
  // before the ":" even for the widest label, which would otherwise butt right up
  // against it with zero padding.
  const padded = padColumn(rows.map(([label]) => `${label} `))
  return rows.map(([, value], i) => `${padded[i]}: ${value}`).join('\n')
}

export function buildNewSignalMessage(symbolKey, group) {
  group.sort((a, b) => TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(b.tf))
  const primary = group[0]
  const isBuy = primary.direction === 'buy'
  const isGolden = primary.strengthLabel === 'Strong'
  const title = `${isBuy ? '🔵' : '🔴'} ${isBuy ? 'BUY' : 'SELL'} LIMIT — ${symbolKey}${isGolden ? ' ⭐ Golden Zone' : ''}`
  // Each TP row has two independently-aligned columns: the price stays left-aligned
  // (padded out to the widest price with trailing spaces) and "(rr R)" is right-aligned
  // (padded to the widest one with leading spaces), the two joined by a single space.
  // Net effect: the price always starts right after "TPn   : " like every other row,
  // while "(...R)" always ENDS in the same column regardless of how many price/rr
  // digits it has (Zone/Price/SL have no "(...)" suffix, so they're not part of this).
  const tpPrices = padColumn(primary.tp.map((t) => formatPrice(t.price)))
  const tpParens = padColumn(
    primary.tp.map((t) => `(${formatPrice(t.rr)}R)`),
    'start'
  )
  const rows = [
    ['Zone', `${primary.category} (${primary.strengthLabel})`],
    ['Price', formatPrice(primary.entry)],
    ['SL', formatPrice(primary.sl)],
    ...tpPrices.map((p, i) => [`TP${i + 1}`, `${p} ${tpParens[i]}`]),
  ]
  // <code> (Telegram's "Monospace" formatting, plain fixed-width text), not <pre>
  // (a boxed "code snippet" with its own background and a copy button) — the goal is
  // a monospace *font*, not a code-block look. Both silently drop any tag nested
  // inside them (verified against the real Bot API), so the title link stays on its
  // own separate line outside this block rather than losing its clickability.
  return `<a href="${SITE_URL}">${title}</a>\n<code>${alignRows(rows)}</code>`
}

// No symbol/direction/price here either, same reasoning as buildCloseMessage — it's a
// reply to the signal that already states all of that.
export function buildFillMessage() {
  return '<code>🟡 ENTRY FILLED</code>'
}

// No exit price here — it's a reply to the signal that already states its SL/TP
// levels, so restating the price would just be redundant. Just which one it was and
// the pip/price result.
export function buildCloseMessage(symbolKey, record) {
  const isBuy = record.direction === 'buy'
  const isWin = record.status === 'win'
  const label = isWin ? `TP${(record.hitTpIndex ?? 0) + 1} HIT` : 'SL HIT'
  const move = formatMove(PIP_SIZES[symbolKey], record.entry, record.exitPrice, isBuy)
  return `<code>${isWin ? '✅' : '❌'} ${label} ${move}</code>`
}

// Reply to a signal whose own level got invalidated (or replaced by a different pivot)
// before it ever filled — see the `invalidated` array from recordSignals in
// signalHistoryCore.js. No price/move here, same reasoning as buildFillMessage: it's
// just marking the already-posted order as dead, not stating a result.
export function buildInvalidatedMessage() {
  return '<code>❌ INVALIDATED</code>'
}

// Sends one Telegram message per newly-added signal, EXCEPT when the same level also
// just appeared on another timeframe that ALSO reaches Telegram (cross-timeframe
// confluence, see annotateGoldenZones in srDetector.js) — those are folded into a
// single message naming every timeframe involved, rather than one message per
// timeframe. All records in a folded group get the same telegramMessageId so a SL/TP
// hit on any of them later replies to that one shared message. With
// TELEGRAM_TIMEFRAMES currently just {H1}, `added` is already filtered down to H1
// before this runs (see the call site), so in practice a group is always exactly one
// signal today — an H4/D1 confluence partner never even reaches `added` here, so it
// can't be folded in. This still does the right thing unchanged if TELEGRAM_TIMEFRAMES
// is ever widened to include more than one timeframe.
export async function notifyNewSignals(symbolKey, added, signalByKey) {
  const handled = new Set()

  for (const record of added) {
    if (handled.has(record.key)) continue
    const signal = signalByKey.get(record.key)
    const group = [{ ...signal, tf: record.tf }]
    const groupRecords = [record]
    handled.add(record.key)

    for (const otherTf of signal?.confluence ?? []) {
      const otherKey = keyFor(symbolKey, otherTf, signal)
      if (handled.has(otherKey)) continue
      const otherRecord = added.find((r) => r.key === otherKey)
      if (!otherRecord) continue // that timeframe's signal wasn't newly opened this tick
      group.push({ ...signalByKey.get(otherKey), tf: otherTf })
      groupRecords.push(otherRecord)
      handled.add(otherKey)
    }

    const messageId = await sendTelegramMessage(buildNewSignalMessage(symbolKey, group))
    if (messageId) for (const r of groupRecords) r.telegramMessageId = messageId
  }
}

// Edits a still-pending signal's own message when its entry/SL/TP recalculate (see
// `updated` from recordSignals) — keeps the public post honest about what the order
// would currently look like, rather than freezing it at whatever the first tick saw.
// A record with no telegramMessageId (never posted in the first place — e.g. a BTCUSD
// signal that formed on a weekday) has nothing to edit; skipped silently.
export async function notifyUpdatedSignals(symbolKey, updated, signalByKey) {
  for (const record of updated) {
    if (!record.telegramMessageId) continue
    const signal = signalByKey.get(record.key)
    if (!signal) continue
    await editTelegramMessage(buildNewSignalMessage(symbolKey, [{ ...signal, tf: record.tf }]), record.telegramMessageId)
  }
}

// Shared by every notifier below that just replies to a record's own message with a
// status update (filled/closed/invalidated) — same guard as notifyUpdatedSignals: a
// record with no telegramMessageId (never posted — e.g. it never survived long enough,
// or formed on a symbol/day new signals were withheld for) has nothing to reply to,
// skipped silently rather than posting an orphaned, contextless standalone message.
async function notifyByReply(records, buildMessage) {
  for (const record of records) {
    if (!record.telegramMessageId) continue
    await sendTelegramMessage(buildMessage(record), record.telegramMessageId)
  }
}

export async function notifyFilledSignals(filled) {
  await notifyByReply(filled, buildFillMessage)
}

// A 'win' record can pass through here more than once over its lifetime (see
// evaluateSignals in signalHistoryCore.js — reaching a farther TP than before keeps
// crediting the same win at the new level, right up until the very last rung), so this
// doesn't use the shared notifyByReply above: each such reply's own message id is
// stashed onto that specific tp[] entry, in case it's ever needed to edit that reply
// later (e.g. a manual correction after re-checking against finer-grained data).
export async function notifyClosedSignals(symbolKey, closed) {
  for (const record of closed) {
    if (!record.telegramMessageId) continue
    const messageId = await sendTelegramMessage(buildCloseMessage(symbolKey, record), record.telegramMessageId)
    if (messageId && record.status === 'win') record.tp[record.hitTpIndex].telegramMessageId = messageId
  }
}

export async function notifyInvalidatedSignals(invalidated) {
  await notifyByReply(invalidated, buildInvalidatedMessage)
}

// ---------------------------------------------------------------------------
// Daily / weekly Telegram report
// ---------------------------------------------------------------------------
// Recaps the H1 track record (the only timeframe Telegram ever sees, see
// TELEGRAM_TIMEFRAMES) to the same public channel as the signals themselves. Framed in
// WIB (UTC+7) since that's the audience's own clock — WIB never observes DST, so a flat
// +7h shift is exact and needs no timezone database.
const REPORT_TF = 'H1'
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

// The "borrow UTC field getters to read another fixed-offset timezone" trick: shifting
// the instant by the offset first, then reading its UTC fields, yields that other
// zone's local calendar fields without needing Intl/a tz database.
function wibParts(ms) {
  const shifted = new Date(ms + WIB_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(), // 0-indexed
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(), // 0 = Sunday ... 6 = Saturday
  }
}

// The UTC instant corresponding to 00:00 WIB on the given WIB calendar date.
function wibMidnightUtcMs(year, month, day) {
  return Date.UTC(year, month, day) - WIB_OFFSET_MS
}

function wibDateKey({ year, month, day }) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function formatWibDate(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(ms)
}

function formatWibDayShort(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(ms)
}

// Just "10" — the range header's start date only needs the day number (the month/year
// come from its end date, e.g. "10 – 16 Aug 2026").
function formatWibDayNum(ms) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', day: 'numeric' }).format(ms)
}

function formatWibDateNoWeekday(ms) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(ms)
}

async function loadReportState() {
  try {
    return JSON.parse(await readFile(REPORT_STATE_PATH, 'utf8'))
  } catch {
    return {} // first run ever, or the file's missing/corrupt
  }
}

async function saveReportState(state) {
  await mkdir(path.dirname(REPORT_STATE_PATH), { recursive: true })
  await writeFile(REPORT_STATE_PATH, JSON.stringify(state))
}

function directionLabel(record) {
  return record.direction === 'buy' ? 'BUY' : 'SELL'
}

// Padded to "SELL"'s own length (the longer of the only two possible values) so "@"
// lands in the same column whether a line says BUY or SELL.
function paddedDirectionLabel(record) {
  return directionLabel(record).padEnd(4)
}

// Report-only number formatting: always a whole number (Math.round — reports show
// consolidated PnL, not per-pip precision), no "pips"/unit suffix regardless of
// symbol, sign-prefixed. Distinct from formatAmount, which the standalone SL/TP-hit
// reply (buildCloseMessage) and the weekly chart image still use as-is.
function reportAmount(amount) {
  const rounded = Math.round(amount)
  return `${rounded >= 0 ? '+' : ''}${rounded}`
}

// One [left, label, number] triple per closed trade — split (rather than one string)
// so alignReportLines (below) can pad each column independently: left so "→" lines up,
// label so every number starts at the same offset, and the number itself right-aligned
// within its own column. No category (Support/Resistance/RBS/SBR) or "HIT" here —
// direction + price + which TP/SL + the result is enough to place the trade; both read
// as noise in the report specifically. A standalone rollup message has no earlier
// "signal opened" message to inherit context from the way a live SL/TP-hit reply does
// (see buildCloseMessage) — that reply still says "HIT", this report line doesn't.
function reportExitLine(symbolKey, record) {
  const label = record.status === 'win' ? `TP${(record.hitTpIndex ?? 0) + 1}` : 'SL'
  const number = reportAmount(favorableMove(PIP_SIZES[symbolKey], record.entry, record.exitPrice, record.direction === 'buy'))
  const left = `${record.status === 'win' ? '✅' : '❌'} ${paddedDirectionLabel(record)} @ ${Math.round(record.entry)}`
  return [left, label, number]
}

// Pads each column of a [left, label, number] triple so "→" lines up, every label
// starts at the same offset, and the number itself is right-aligned within its own
// column (a ledger-style look, easiest to scan down a list of results) — same
// per-column padding reasoning as alignRows above, just three columns instead of two.
function alignReportLines(rows) {
  const lefts = padColumn(rows.map(([left]) => left))
  const labels = padColumn(rows.map(([, label]) => label))
  const numbers = padColumn(rows.map(([, , number]) => number), 'start')
  return rows.map((_, i) => `${lefts[i]} → ${labels[i]} ${numbers[i]}`)
}

// Same idea as alignReportLines but for a [label, number] pair joined by ":" (the
// weekly report's per-day lines) instead of "→" — label padded so ":" lines up, number
// right-aligned within its own column.
function alignColonLines(rows) {
  const labels = padColumn(rows.map(([label]) => label))
  const numbers = padColumn(rows.map(([, number]) => number), 'start')
  return rows.map((_, i) => `${labels[i]}: ${numbers[i]}`)
}

// Returns null (rather than an empty-looking section) when this symbol had no closed
// trade that day — nothing to report, so it's omitted from the message entirely
// instead of padding it out with "No signals closed today." noise. Deliberately
// closed-trades-only: a still-open signal is already visible via its own live message
// in the channel, so it's not repeated here — this report recaps what actually
// finished, not what's still pending.
function buildSymbolDailySection(symbolKey, history, dayStartMs, dayEndMs) {
  const closedList = getClosedBetween(history, symbolKey, REPORT_TF, dayStartMs, dayEndMs)
  if (!closedList.length) return null

  // Symbol header stays bold on its own line (like buildNewSignalMessage's title) —
  // <code> silently drops any tag nested inside it, so the header can't live inside
  // the same block as the monospace body below and keep its bold.
  const lines = alignReportLines(closedList.map((r) => reportExitLine(symbolKey, r)))
  const wins = closedList.filter((r) => r.status === 'win').length
  const pipSize = PIP_SIZES[symbolKey]
  const net = closedList.reduce((sum, r) => sum + favorableMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy'), 0)
  const winRate = Math.round((wins / closedList.length) * 100)
  lines.push('', `Win rate: ${winRate}% · Net: ${reportAmount(net)}`)

  return `<b>${symbolKey}</b>\n<code>${lines.join('\n')}</code>`
}

// Builds the message for the WIB calendar day starting at dayStartMs (dayEndMs is
// exclusive, always dayStartMs + 24h) — pure and independently testable from the
// scheduling/dedup logic in maybeSendDailyReport below. Always covers both symbols —
// BTCUSD posts new signals every day now (see the skipNewSignals gating in
// updateSignalHistoryForSymbol), not just weekends, so there's no quiet day left to
// special-case out of this recap either. Returns null (send nothing) if truly neither
// symbol had any activity — a "here's your report: nothing happened" message every
// single quiet day is just noise.
export function buildDailyReportMessage(history, dayStartMs) {
  const dayEndMs = dayStartMs + DAY_MS
  const sections = ['XAUUSD', 'BTCUSD']
    .map((symbolKey) => buildSymbolDailySection(symbolKey, history, dayStartMs, dayEndMs))
    .filter(Boolean)
  if (!sections.length) return null
  return [`<b>Daily Performance (${formatWibDate(dayStartMs)})</b>`, '', sections.join('\n\n')].join('\n')
}

// Returns null when nothing closed for this symbol all week — omitted from the message
// entirely (see buildDailyReportMessage's identical reasoning above), rather than a
// section that just says "No trades closed this week."
function buildSymbolWeeklySection(symbolKey, history, weekStartMs) {
  const pipSize = PIP_SIZES[symbolKey]
  // Header stays bold and outside the <code> block below — same reasoning as
  // buildSymbolDailySection.
  const dayRows = []
  let totalNet = 0
  let totalWins = 0
  let totalLosses = 0

  for (let i = 0; i < 7; i++) {
    const dayStartMs = weekStartMs + i * DAY_MS
    const dayEndMs = dayStartMs + DAY_MS
    const closedList = getClosedBetween(history, symbolKey, REPORT_TF, dayStartMs, dayEndMs)
    if (!closedList.length) continue // a quiet day isn't listed at all, not even a placeholder line

    const dayLabel = formatWibDayShort(dayStartMs)
    const wins = closedList.filter((r) => r.status === 'win').length
    const losses = closedList.length - wins
    const net = closedList.reduce((sum, r) => sum + favorableMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy'), 0)
    totalNet += net
    totalWins += wins
    totalLosses += losses
    // No (NW / ML) here — same reasoning as the daily report's own Win rate line: the
    // net number and the week-level win rate below already say enough. The day's net
    // decides its icon (profit vs loss for the day as a whole), not each individual
    // trade's own result — a day can close net-positive despite a losing trade in it.
    const dayIcon = net >= 0 ? '✅' : '❌'
    dayRows.push([`${dayIcon} ${dayLabel}`, reportAmount(net)])
  }

  const totalClosed = totalWins + totalLosses
  if (!totalClosed) return null

  const lines = alignColonLines(dayRows)
  const winRate = Math.round((totalWins / totalClosed) * 100)
  // Win rate first, then Net — same order as the daily report's own summary line.
  lines.push('', `Win rate: ${winRate}% · Net: ${reportAmount(totalNet)}`)
  return `<b>${symbolKey}</b>\n<code>${lines.join('\n')}</code>`
}

// weekStartMs is the Monday 00:00 WIB that starts the week being recapped (the report
// itself is sent the *following* Monday, at 00:01 WIB — see maybeSendWeeklyReport).
// Returns null if neither symbol closed anything all week — see
// buildDailyReportMessage's identical reasoning.
export function buildWeeklyReportMessage(history, weekStartMs) {
  const weekEndMs = weekStartMs + 6 * DAY_MS // last day of the week, not the exclusive end
  const rangeLabel = `${formatWibDayNum(weekStartMs)} – ${formatWibDateNoWeekday(weekEndMs)}`
  const sections = ['XAUUSD', 'BTCUSD'].map((symbolKey) => buildSymbolWeeklySection(symbolKey, history, weekStartMs)).filter(Boolean)
  if (!sections.length) return null
  return [`<b>Weekly Performance (${rangeLabel})</b>`, '', sections.join('\n\n')].join('\n')
}

// Fires on the first cron tick that lands in the 00:00-00:59 WIB hour each day (the
// existing 15-minute cron already ticks 4 times inside that hour — :00, :15, :30,
// :45 — so no separate GitHub Actions schedule is needed). Reports on the WIB calendar
// day that just ended. The whole-hour window (rather than just the :00 tick) tolerates
// GitHub Actions' own scheduling jitter/delay: if the :00 tick itself runs late or gets
// skipped, a later tick in the same hour still catches it. lastDailyReportDate is what
// actually prevents a double-send once one tick in the window succeeds — not the
// window's width.
// Builds the daily performance image (one bar-chart panel per symbol that closed
// something that day — see renderDailyReportImage) and sends it, with reportText as
// its own caption, as ONE Telegram message — same "one photo, not a text message plus
// a separate image" reasoning as sendWeeklyReport below. Best-effort like every other
// Telegram notification here: a rendering or send failure is logged and swallowed,
// never allowed to fail the whole cron run.
async function sendDailyReport(reportText, history, dayStartMs) {
  try {
    const dayEndMs = dayStartMs + DAY_MS
    const data = computeDailyChartData(history, dayStartMs, dayEndMs)
    const buffer = renderDailyReportImage(data, formatWibDate(dayStartMs))
    await sendTelegramPhoto(buffer, 'daily-performance.png', reportText)
  } catch (err) {
    console.warn(`[fetch-data] daily performance chart generation failed: ${err.message}`)
  }
}

export async function maybeSendDailyReport(history, now, state) {
  const wib = wibParts(now)
  if (wib.hour !== 0) return false

  const todayKey = wibDateKey(wib)
  if (state.lastDailyReportDate === todayKey) return false

  const todayStartMs = wibMidnightUtcMs(wib.year, wib.month, wib.day)
  const yesterdayStartMs = todayStartMs - DAY_MS
  // null means neither symbol had any activity yesterday — skip sending a "nothing
  // happened" message every quiet day, but still remember today's date below so this
  // doesn't re-evaluate on every 15-minute tick within the same hour.
  const message = buildDailyReportMessage(history, yesterdayStartMs)
  if (message) await sendDailyReport(message, history, yesterdayStartMs)
  state.lastDailyReportDate = todayKey
  return true
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Builds the 7 day buckets (Monday..Sunday, WIB) the chart image is computed over,
// then sends the whole weekly report — reportText and the one combined chart image
// (bars + pies + trade log, see renderWeeklyReportImage) — as ONE Telegram message:
// reportText becomes the image's caption, rather than a separate text message followed
// by a separate image (two chat bubbles for what's conceptually one report). Best-effort
// like every other Telegram notification here: a rendering or send failure is logged
// and swallowed, never allowed to fail the whole cron run.
async function sendWeeklyReport(reportText, history, weekStartMs) {
  try {
    const days = Array.from({ length: 7 }, (_, i) => {
      const dayStartMs = weekStartMs + i * DAY_MS
      const wib = wibParts(dayStartMs)
      return { label: `${WEEKDAY_SHORT[wib.weekday]} ${wib.day}`, startMs: dayStartMs, endMs: dayStartMs + DAY_MS }
    })
    const weekEndMs = weekStartMs + 6 * DAY_MS
    const rangeLabel = `${formatWibDayNum(weekStartMs)} – ${formatWibDateNoWeekday(weekEndMs)}`

    const data = computeWeeklyChartData(history, days)
    const buffer = renderWeeklyReportImage(data, rangeLabel)
    await sendTelegramPhoto(buffer, 'weekly-performance.png', reportText)
  } catch (err) {
    console.warn(`[fetch-data] weekly performance chart generation failed: ${err.message}`)
  }
}

// Same trigger window as the daily report, but only on Monday (the day the report
// covering the just-finished Mon-Sun week goes out).
export async function maybeSendWeeklyReport(history, now, state) {
  const wib = wibParts(now)
  if (wib.hour !== 0 || wib.weekday !== 1) return false

  const todayKey = wibDateKey(wib)
  if (state.lastWeeklyReportDate === todayKey) return false

  const todayStartMs = wibMidnightUtcMs(wib.year, wib.month, wib.day)
  const weekStartMs = todayStartMs - 7 * DAY_MS // last Monday 00:00 WIB
  // null means neither symbol closed anything all week — skip sending (and the chart
  // images, which would just show an all-empty week) entirely, but still remember
  // today's date below.
  const message = buildWeeklyReportMessage(history, weekStartMs)
  if (message) await sendWeeklyReport(message, history, weekStartMs)
  state.lastWeeklyReportDate = todayKey
  return true
}

async function loadSignalHistory() {
  try {
    const json = JSON.parse(await readFile(HISTORY_PATH, 'utf8'))
    return Array.isArray(json) ? json : []
  } catch {
    return [] // first run ever, or the file's missing/corrupt — start fresh rather than fail the build
  }
}

// Mirrors exactly what main.js does per refresh: build zones per timeframe, cross-link
// Golden Zones once every timeframe's in, turn each timeframe's zones into signals,
// then fold those into the shared history. Mutates `history` in place, and (for
// TELEGRAM_SYMBOLS) sends notifications for newly-opened, newly-filled, and
// newly-closed signals. `calendar` (optional — the upstream economic calendar feed, see
// fetchCalendar) gates *new* signal formation around high-impact USD news, same
// reasoning as isNearHighImpactNews above; omitting it just skips that gate.
export async function updateSignalHistoryForSymbol(history, symbolKey, seriesByTf, calendar = null) {
  const currentPrice = seriesByTf.H1?.at(-1)?.close
  // The data's own timestamp, not wall-clock now — normally the same thing (this runs
  // every ~15 minutes), but ties "is the market closed" to what the candles actually
  // show rather than whenever the script happens to execute, and makes it deterministic
  // to test.
  const currentTime = seriesByTf.H1?.at(-1)?.time
  // H4 (falling back to D1) rather than H1 itself — a trend read off the same
  // fine-grained series a fade signal is generated from would just describe the most
  // recent few candles' own noise, not an actual higher-timeframe direction to fade (or
  // not fade) against. See computeTrend in srDetector.js.
  const trend = computeTrend(seriesByTf.H4?.length ? seriesByTf.H4 : seriesByTf.D1 ?? [])
  const zonesByTimeframe = {}

  for (const [tfKey, series] of Object.entries(seriesByTf)) {
    // MONITOR_TF (M1) lives in this same seriesByTf object for convenience (fetch/
    // fallback plumbing in main() is identical either way), but never participates in
    // zone detection — see MONITOR_TF's own comment for why.
    if (tfKey === 'M1') continue
    if (!series?.length) continue
    const last = series.at(-1)
    zonesByTimeframe[tfKey] = { zones: detectLevels(series, currentPrice ?? last.close) }
  }

  annotateGoldenZones(zonesByTimeframe)

  // Keep the freshly-built signals (and their .confluence) around by key, so a
  // newly-added record can be matched back to the signal that produced it — records
  // themselves don't carry .confluence, only signals do.
  const signalByKey = new Map()
  const added = []
  const updated = []
  const invalidated = []
  for (const [tfKey, result] of Object.entries(zonesByTimeframe)) {
    // TIMEFRAMES is ordered finest-to-broadest (H1, H4, D1) — everything after this
    // timeframe's own index is "higher" and gets offered as extra TP candidates (see
    // buildSignals in srDetector.js). Kept in sync with the same logic in main.js.
    const tfIndex = TIMEFRAMES.findIndex((tf) => tf.key === tfKey)
    const higherTfZones = TIMEFRAMES.slice(tfIndex + 1).flatMap((tf) => zonesByTimeframe[tf.key]?.zones ?? [])
    // Signals (actionable BUY/SELL LIMIT ideas, and so the shared track record) are
    // H1-only — the dashboard shows H4/D1 zones purely for context (and H1 still
    // borrows them as extra TP candidates, see higherTfZones above), they just never
    // become tradeable ideas of their own. Still runs recordSignals with an empty
    // signal list for H4/D1 (rather than skipping the call outright) so any
    // still-pending H4/D1 row from before this policy gets cleanly dropped instead of
    // lingering forever — same reasoning as isPriceStagnant's own empty-signals path.
    // Also empty in a window straddling a high-impact USD release (see
    // isNearHighImpactNews) — same "shows zones, withholds new tradeable ideas"
    // treatment as a stagnant timeframe.
    const signals =
      tfKey === 'H1' && !isPriceStagnant(seriesByTf[tfKey]) && !isNearHighImpactNews(calendar, currentTime ?? Date.now())
        ? buildSignals(result.zones, currentPrice, higherTfZones, trend)
        : []
    for (const s of signals) signalByKey.set(keyFor(symbolKey, tfKey, s), s)
    const forTf = recordSignals(history, symbolKey, tfKey, signals, currentPrice, currentTime)
    added.push(...forTf.added)
    updated.push(...forTf.updated)
    invalidated.push(...forTf.invalidated)
  }

  // MONITOR_TF (M1), not just its latest close — evaluateSignals scans every candle's
  // actual high/low since a record's own openedAt/filledAt, not just a single
  // snapshotted price, so a genuine intra-candle TP touch is no longer missed just
  // because price later reversed past SL before the next ~15-minute poll (see
  // evaluateSignals' own comment in signalHistoryCore.js for the production bug this
  // fixes). M1 sharpens that further — an SL/TP touch-and-reverse that happens and
  // undoes itself within a single H1 candle is invisible to H1 candles but still shows
  // up in M1's own high/low. Used regardless of which timeframe a record's own signal
  // came from — same reasoning H1 used to have. Falls back to H1 if M1 isn't available
  // yet (e.g. its first-ever fetch failed with no prior snapshot to fall back to).
  const { filled, closed } = evaluateSignals(history, symbolKey, seriesByTf.M1 ?? seriesByTf.H1 ?? [])

  if (TELEGRAM_SYMBOLS.has(symbolKey)) {
    // Filtered to H1 before grouping, not after — an H4/D1 confluence partner should
    // never even be mentioned in an H1 message's timeframe list, the same as if it
    // didn't exist.
    const onlyH1 = (r) => TELEGRAM_TIMEFRAMES.has(r.tf)
    // New signals only — not fills/closes, which are for trades already live and
    // shouldn't go silent just because a symbol's own gating window has passed. This
    // is specifically about not opening brand-new "signals" at the wrong time, not
    // about following up on ones already posted.
    const currentDate = currentTime != null ? new Date(currentTime) : new Date()
    const skipNewSignals =
      // XAUUSD: don't open new signals off stale weekend candles while gold's own
      // market is actually closed (Fri 22:00 UTC -> Sun 22:00 UTC). A holiday closure
      // on an otherwise normal weekday isn't covered by this calendar rule, but doesn't
      // need its own check here either — `added` above is already empty for a stagnant
      // timeframe (see the isPriceStagnant gate on buildSignals), so there's nothing
      // for notifyNewSignals to send in that case regardless of this flag.
      symbolKey === 'XAUUSD' && isGoldMarketClosed(currentDate)
      // BTCUSD trades 24/7 and now posts new signals every day, not just weekends —
      // nothing else to gate on for this symbol.
    // Invalidated first, before any new signal: keyFor has no price component, so a
    // pending record whose pivot drifted outside tolerance is dropped into
    // `invalidated` AND a fresh record under that same key opens into `added` in the
    // very same recordSignals call (the old one effectively replaced by the new one).
    // Sending the INVALIDATED reply first means subscribers see "this one's dead" on
    // the old message before the new BUY/SELL LIMIT post lands — the reverse order
    // reads as if the signal that was just posted is the one that died.
    // Not gated by skipNewSignals — this isn't opening a new signal, just closing out
    // one already posted, same reasoning as fills/closes always posting regardless of
    // the day.
    await notifyInvalidatedSignals(invalidated.filter(onlyH1))
    // Must complete before the Promise.all below: a record can be both newly added AND
    // filled/closed within this same tick (entry reached the instant the signal forms),
    // and notifyFilledSignals/notifyClosedSignals need `telegramMessageId` already set
    // by notifyNewSignals to reply to the right message.
    if (!skipNewSignals) await notifyNewSignals(symbolKey, added.filter(onlyH1), signalByKey)
    // Independent of each other and of the above (updated/filled/closed records are
    // never also in `added`, except for the same-tick case already covered by the
    // await above) — run concurrently rather than one Telegram round-trip at a time.
    await Promise.all([
      // Excludes a record that also filled this same tick (evaluateSignals above
      // already flipped its status to 'running') — that gets a FILLED reply instead;
      // editing the original right before replying FILLED to it would just be
      // redundant. Not gated by skipNewSignals — same reasoning as fills/closes.
      notifyUpdatedSignals(symbolKey, updated.filter(onlyH1).filter((r) => r.status === 'pending'), signalByKey),
      notifyFilledSignals(filled.filter(onlyH1)),
      notifyClosedSignals(symbolKey, closed.filter(onlyH1)),
    ])
  }
}

export async function main() {
  const apiKey = process.env.TWELVE_DATA_API_KEY
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY is not set')

  const history = await loadSignalHistory()
  const seriesByTfBySymbol = { XAUUSD: {}, BTCUSD: {} }

  for (const tf of TIMEFRAMES) {
    const gold = await fetchWithFallback(
      `XAUUSD ${tf.key}`,
      () => fetchTwelveData('XAU/USD', tf, apiKey),
      `quote/XAUUSD-${tf.key}.json`
    )
    if (gold) {
      await writeJson(`quote/XAUUSD-${tf.key}.json`, gold)
      seriesByTfBySymbol.XAUUSD[tf.key] = toCandles(gold.values)
    }

    const btc = await fetchWithFallback(`BTCUSD ${tf.key}`, () => fetchBinance(tf), `quote/BTCUSD-${tf.key}.json`)
    if (btc) {
      await writeJson(`quote/BTCUSD-${tf.key}.json`, btc)
      seriesByTfBySymbol.BTCUSD[tf.key] = toCandles(btc.values)
    }
  }

  // See MONITOR_TF's own comment — fetched outside the TIMEFRAMES loop since it never
  // participates in zone detection, only in evaluateSignals' fill/SL/TP check below.
  const goldM1 = await fetchWithFallback(
    'XAUUSD M1',
    () => fetchTwelveData('XAU/USD', MONITOR_TF, apiKey),
    'quote/XAUUSD-M1.json'
  )
  if (goldM1) {
    await writeJson('quote/XAUUSD-M1.json', goldM1)
    seriesByTfBySymbol.XAUUSD.M1 = toCandles(goldM1.values)
  }

  const btcM1 = await fetchWithFallback('BTCUSD M1', () => fetchBinance(MONITOR_TF), 'quote/BTCUSD-M1.json')
  if (btcM1) {
    await writeJson('quote/BTCUSD-M1.json', btcM1)
    seriesByTfBySymbol.BTCUSD.M1 = toCandles(btcM1.values)
  }

  // Fetched before the signal-history loop below (not after, as it used to be) so
  // updateSignalHistoryForSymbol can gate *new* signal formation on it (see
  // isNearHighImpactNews) — the write to public/data/calendar.json itself doesn't care
  // about ordering, only the gating does.
  const calendar = await fetchWithFallback('calendar', fetchCalendar, 'calendar.json')
  if (calendar) await writeJson('calendar.json', calendar)

  for (const [symbolKey, seriesByTf] of Object.entries(seriesByTfBySymbol)) {
    await updateSignalHistoryForSymbol(history, symbolKey, seriesByTf, calendar)
  }
  const trimmed = trimRecords(history)

  // Two writes: the git-tracked canonical copy (survives to the next CI run) and the
  // public/data copy (gitignored, but what the deployed site's browser actually fetches).
  await mkdir(path.dirname(HISTORY_PATH), { recursive: true })
  await writeFile(HISTORY_PATH, JSON.stringify(trimmed))
  await writeJson('signal-history.json', trimmed)

  // Best-effort like every other Telegram notification here — a failure sending either
  // report should never fail the whole run. State is only persisted (and so only
  // committed back to the repo) if something actually sent, same reasoning as the
  // alert-state file below.
  const reportState = await loadReportState()
  const dailySent = await maybeSendDailyReport(trimmed, Date.now(), reportState)
  const weeklySent = await maybeSendWeeklyReport(trimmed, Date.now(), reportState)
  if (dailySent || weeklySent) await saveReportState(reportState)

  if (FAILURES.length) {
    // Keyed on which sources are failing, not the full message text — a persistent
    // cause (e.g. an expired API key) can still vary its exact error text run to run
    // (a different retry count, a slightly different upstream response), which would
    // otherwise never match state.dedupKey and defeat ALERT_SUPPRESS_HOURS entirely.
    const dedupKey = `data-source-failure:${[...FAILURE_LABELS].sort().join(',')}`
    await sendAdminAlertDeduped(
      `${FAILURES.length} data source(s) failed this run (retries + fallback both exhausted):\n${FAILURES.join('\n')}`,
      dedupKey
    )
  }
}

// Only auto-run when executed directly (`node scripts/fetch-data.mjs`), not when
// imported — lets the exported pieces above be exercised directly (e.g. in tests)
// without triggering a real network run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (err) => {
    console.error('[fetch-data] fatal:', err)
    // A fixed key, not the message itself — a fatal crash recurring for any reason
    // within the suppress window is already noise worth deduping uniformly, same
    // reasoning as the data-source-failure key above.
    await sendAdminAlertDeduped(`Fatal error, run aborted:\n${err.message}`, 'fatal-error')
    process.exit(1)
  })
}
