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
import { detectLevels, buildSignals, annotateGoldenZones } from '../src/lib/srDetector.js'
import { recordSignals, evaluateSignals, trimRecords, keyFor, PIP_SIZES, formatMove, formatPrice } from '../src/lib/signalHistoryCore.js'
import { isGoldMarketClosed, isWeekendUtc } from '../src/lib/marketHours.js'

const OUT_DIR = path.join(process.cwd(), 'public', 'data')
const HISTORY_PATH = path.join(process.cwd(), 'data', 'signal-history.json')
const ALERT_STATE_PATH = path.join(process.cwd(), 'data', 'last-alert.json')
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
function recordFailure(message) {
  FAILURES.push(message)
}
export function getFailures() {
  return FAILURES
}
export function resetFailures() {
  FAILURES.length = 0
}

// If today's upstream fetch fails (rate limit, outage), fall back to whatever is
// already live rather than shipping a hole in the data — a stale snapshot beats a
// missing one, and the next successful cron run heals it anyway. SITE_URL is optional
// (defaults to this repo's own deployment) so a fork/rename/domain change is one env
// var, not a code edit that's easy to forget.
const LIVE_BASE = `${process.env.SITE_URL || 'https://redyapr.github.io/trefozeri'}/data`

// Kept as a local, minimal copy rather than importing src/lib/twelveData.js — that
// module reads import.meta.env (a Vite/browser concern), which plain Node doesn't have.
const TIMEFRAMES = [
  { key: 'H1', twelveDataInterval: '1h', binanceInterval: '1h', outputsize: 300 },
  { key: 'H4', twelveDataInterval: '4h', binanceInterval: '4h', outputsize: 300 },
  { key: 'D1', twelveDataInterval: '1day', binanceInterval: '1d', outputsize: 300 },
]

function toTwelveDataDatetime(ms) {
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
  const values = klines.map(([openTime, open, high, low, close]) => ({
    datetime: toTwelveDataDatetime(openTime),
    open,
    high,
    low,
    close,
  }))
  return { status: 'ok', values }
}

async function fetchCalendar() {
  const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json')
  if (!res.ok) throw new Error(`Calendar feed error (${res.status})`)
  return res.json()
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
      recordFailure(`${label}: primary failed after retries (${err.message}); fallback also failed (${fallbackErr.message})`)
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
function parseUtc(datetime) {
  const iso = datetime.includes(' ') ? datetime.replace(' ', 'T') + 'Z' : `${datetime}T00:00:00Z`
  return new Date(iso).getTime()
}

function toCandles(values) {
  return values.map((v) => ({
    time: parseUtc(v.datetime),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }))
}

// Posts one message to `chatId` (defaults to the public signals channel), optionally
// as a reply to an earlier message (used to thread a SL/TP result under the signal
// that opened it). Returns the sent message's id (so it can later be replied to), or
// null on any failure — notifications are best-effort and should never fail the whole
// cron run.
export async function sendTelegramMessage(text, replyToMessageId, chatId = process.env.TELEGRAM_CHAT_ID) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token || !chatId) return null

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        // allow_sending_without_reply: the original message could in principle have
        // been deleted from the chat since — fall back to a plain message rather than
        // failing the notification outright.
        ...(replyToMessageId ? { reply_to_message_id: replyToMessageId, allow_sending_without_reply: true } : {}),
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
// step) since every run is otherwise a fresh, stateless process. Only resends if the
// alert text changed, or ALERT_SUPPRESS_MS has passed since this same text last
// actually sent — a transient blip that resolves itself never touches this at all,
// since FAILURES/fatal errors are the only callers.
export async function sendAdminAlertDeduped(text) {
  const state = await loadAlertState()
  const now = Date.now()
  if (state && state.text === text && now - state.sentAt < ALERT_SUPPRESS_MS) {
    console.warn('[fetch-data] suppressing repeat admin alert (already sent recently):', text.split('\n')[0])
    return
  }
  await sendAdminAlert(text)
  await saveAlertState({ text, sentAt: now })
}

// group is almost always a single signal now that TELEGRAM_TIMEFRAMES filters down to
// H1 before grouping — kept as a group (rather than a single signal) so this still
// works unchanged if TELEGRAM_TIMEFRAMES is ever widened back out. The timeframe
// itself isn't printed: with only one timeframe ever reaching Telegram, naming it on
// every message is just noise.
export function buildNewSignalMessage(symbolKey, group) {
  group.sort((a, b) => TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(b.tf))
  const primary = group[0]
  const isBuy = primary.direction === 'buy'
  const isGolden = primary.strengthLabel === 'Strong'
  const lines = [
    `${isBuy ? '🔵' : '🔴'} ${isBuy ? 'BUY' : 'SELL'} LIMIT — ${symbolKey}${isGolden ? ' ⭐ Golden Zone' : ''}`,
    `Zone: ${primary.category} (${primary.strengthLabel})`,
    `Price: ${formatPrice(primary.entry)}`,
    `SL: ${formatPrice(primary.sl)}`,
    ...primary.tp.map((t, i) => `TP${i + 1}: ${formatPrice(t.price)} (${formatPrice(t.rr)}R)`),
  ]
  return lines.join('\n')
}

// No symbol/direction/price here either, same reasoning as buildCloseMessage — it's a
// reply to the signal that already states all of that.
export function buildFillMessage() {
  return '🟡 ENTRY FILLED'
}

// No exit price here — it's a reply to the signal that already states its SL/TP
// levels, so restating the price would just be redundant. Just which one it was and
// the pip/price result.
export function buildCloseMessage(symbolKey, record) {
  const isBuy = record.direction === 'buy'
  const isWin = record.status === 'win'
  const label = isWin ? `TP${(record.hitTpIndex ?? 0) + 1} HIT` : 'SL HIT'
  const move = formatMove(PIP_SIZES[symbolKey], record.entry, record.exitPrice, isBuy)
  return `${isWin ? '✅' : '❌'} ${label} ${move}`
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

export async function notifyFilledSignals(filled) {
  for (const record of filled) {
    await sendTelegramMessage(buildFillMessage(), record.telegramMessageId)
  }
}

export async function notifyClosedSignals(symbolKey, closed) {
  for (const record of closed) {
    await sendTelegramMessage(buildCloseMessage(symbolKey, record), record.telegramMessageId)
  }
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
// newly-closed signals.
export async function updateSignalHistoryForSymbol(history, symbolKey, seriesByTf) {
  const currentPrice = seriesByTf.H1?.at(-1)?.close
  // The data's own timestamp, not wall-clock now — normally the same thing (this runs
  // every ~15 minutes), but ties "is the market closed" to what the candles actually
  // show rather than whenever the script happens to execute, and makes it deterministic
  // to test.
  const currentTime = seriesByTf.H1?.at(-1)?.time
  const zonesByTimeframe = {}

  for (const [tfKey, series] of Object.entries(seriesByTf)) {
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
  for (const [tfKey, result] of Object.entries(zonesByTimeframe)) {
    // TIMEFRAMES is ordered finest-to-broadest (H1, H4, D1) — everything after this
    // timeframe's own index is "higher" and gets offered as extra TP candidates (see
    // buildSignals in srDetector.js). Kept in sync with the same logic in main.js.
    const tfIndex = TIMEFRAMES.findIndex((tf) => tf.key === tfKey)
    const higherTfZones = TIMEFRAMES.slice(tfIndex + 1).flatMap((tf) => zonesByTimeframe[tf.key]?.zones ?? [])
    const signals = buildSignals(result.zones, currentPrice, higherTfZones)
    for (const s of signals) signalByKey.set(keyFor(symbolKey, tfKey, s), s)
    added.push(...recordSignals(history, symbolKey, tfKey, signals, currentPrice))
  }

  const { filled, closed } = evaluateSignals(history, symbolKey, currentPrice)

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
      // market is actually closed (Fri 22:00 UTC -> Sun 22:00 UTC).
      (symbolKey === 'XAUUSD' && isGoldMarketClosed(currentDate)) ||
      // BTCUSD trades 24/7, so there's nothing to gate on market hours — instead it's
      // deliberately weekend-only (Sat/Sun), the two days gold's own channel is quiet.
      (symbolKey === 'BTCUSD' && !isWeekendUtc(currentDate))
    if (!skipNewSignals) await notifyNewSignals(symbolKey, added.filter(onlyH1), signalByKey)
    await notifyFilledSignals(filled.filter(onlyH1))
    await notifyClosedSignals(symbolKey, closed.filter(onlyH1))
  }
}

async function main() {
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

  for (const [symbolKey, seriesByTf] of Object.entries(seriesByTfBySymbol)) {
    await updateSignalHistoryForSymbol(history, symbolKey, seriesByTf)
  }
  const trimmed = trimRecords(history)

  // Two writes: the git-tracked canonical copy (survives to the next CI run) and the
  // public/data copy (gitignored, but what the deployed site's browser actually fetches).
  await mkdir(path.dirname(HISTORY_PATH), { recursive: true })
  await writeFile(HISTORY_PATH, JSON.stringify(trimmed))
  await writeJson('signal-history.json', trimmed)

  const calendar = await fetchWithFallback('calendar', fetchCalendar, 'calendar.json')
  if (calendar) await writeJson('calendar.json', calendar)

  if (FAILURES.length) {
    await sendAdminAlertDeduped(`${FAILURES.length} data source(s) failed this run (retries + fallback both exhausted):\n${FAILURES.join('\n')}`)
  }
}

// Only auto-run when executed directly (`node scripts/fetch-data.mjs`), not when
// imported — lets the exported pieces above be exercised directly (e.g. in tests)
// without triggering a real network run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (err) => {
    console.error('[fetch-data] fatal:', err)
    await sendAdminAlertDeduped(`Fatal error, run aborted:\n${err.message}`)
    process.exit(1)
  })
}
