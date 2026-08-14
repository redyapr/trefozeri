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
import { recordSignals, evaluateSignals, trimRecords, keyFor, PIP_SIZES, formatMove } from '../src/lib/signalHistoryCore.js'

const OUT_DIR = path.join(process.cwd(), 'public', 'data')
const HISTORY_PATH = path.join(process.cwd(), 'data', 'signal-history.json')

// Telegram notifications are opt-in per symbol (XAUUSD only for now) and per
// timeframe (H1 only for now) — H4/D1 signals never post, even as part of a
// cross-timeframe confluence group. Silently a no-op (see sendTelegramMessage) if
// TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID aren't set, so local dev without them still works.
const TELEGRAM_SYMBOLS = new Set(['XAUUSD'])
const TELEGRAM_TIMEFRAMES = new Set(['H1'])
const TF_ORDER = ['H1', 'H4', 'D1']

// If today's upstream fetch fails (rate limit, outage), fall back to whatever is
// already live rather than shipping a hole in the data — a stale snapshot beats a
// missing one, and the next successful cron run heals it anyway.
const LIVE_BASE = 'https://redyapr.github.io/trefozeri/data'

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

async function fetchWithFallback(label, primary, fallbackRelPath) {
  try {
    return await primary()
  } catch (err) {
    console.warn(`[fetch-data] ${label} failed (${err.message}) — falling back to last published snapshot`)
    try {
      const res = await fetch(`${LIVE_BASE}/${fallbackRelPath}`)
      if (!res.ok) throw new Error(`fallback fetch returned ${res.status}`)
      return await res.json()
    } catch (fallbackErr) {
      console.warn(`[fetch-data] ${label} fallback also failed (${fallbackErr.message}) — leaving this file unwritten`)
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

// Posts one message to the configured chat, optionally as a reply to an earlier
// message (used to thread a SL/TP result under the signal that opened it). Returns
// the sent message's id (so it can later be replied to), or null on any failure —
// notifications are best-effort and should never fail the whole cron run.
async function sendTelegramMessage(text, replyToMessageId) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
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

// group is almost always a single signal now that TELEGRAM_TIMEFRAMES filters down to
// H1 before grouping — kept as a group (rather than a single signal) so this still
// works unchanged if TELEGRAM_TIMEFRAMES is ever widened back out. The timeframe
// itself isn't printed: with only one timeframe ever reaching Telegram, naming it on
// every message is just noise.
export function buildNewSignalMessage(symbolKey, group) {
  group.sort((a, b) => TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(b.tf))
  const primary = group[0]
  const isBuy = primary.direction === 'buy'
  const lines = [
    `🆕 <b>${isBuy ? 'BUY' : 'SELL'} LIMIT</b> — ${symbolKey}`,
    `Zone: ${primary.category}`,
    `Entry: ${primary.entry.toFixed(2)}`,
    `SL: ${primary.sl.toFixed(2)}`,
    ...primary.tp.map((t, i) => `TP${i + 1}: ${t.price.toFixed(2)} (${t.rr.toFixed(1)}R)`),
  ]
  return lines.join('\n')
}

export function buildFillMessage(symbolKey, record) {
  const isBuy = record.direction === 'buy'
  const lines = [
    `🟡 <b>ENTRY FILLED</b> — ${symbolKey} ${isBuy ? 'BUY' : 'SELL'}`,
    `Entry: ${record.entry.toFixed(2)}`,
  ]
  return lines.join('\n')
}

export function buildCloseMessage(symbolKey, record) {
  const isBuy = record.direction === 'buy'
  const isWin = record.status === 'win'
  const label = isWin ? `TP${(record.hitTpIndex ?? 0) + 1} HIT` : 'SL HIT'
  const move = formatMove(PIP_SIZES[symbolKey], record.entry, record.exitPrice, isBuy)
  const lines = [
    `${isWin ? '🟢' : '🔴'} <b>${label}</b> — ${symbolKey} ${isBuy ? 'BUY' : 'SELL'}`,
    `Exit: ${record.exitPrice.toFixed(2)}`,
    `Result: ${move}`,
  ]
  return lines.join('\n')
}

// Sends one Telegram message per newly-added signal, EXCEPT when the same level also
// just appeared on another timeframe (cross-timeframe confluence, see
// annotateGoldenZones in srDetector.js) — those are folded into a single message
// naming every timeframe involved, rather than one message per timeframe. All records
// in a folded group get the same telegramMessageId so a SL/TP hit on any of them later
// replies to that one shared message.
async function notifyNewSignals(symbolKey, added, signalByKey) {
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

async function notifyFilledSignals(symbolKey, filled) {
  for (const record of filled) {
    await sendTelegramMessage(buildFillMessage(symbolKey, record), record.telegramMessageId)
  }
}

async function notifyClosedSignals(symbolKey, closed) {
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
    const signals = buildSignals(result.zones, currentPrice)
    for (const s of signals) signalByKey.set(keyFor(symbolKey, tfKey, s), s)
    added.push(...recordSignals(history, symbolKey, tfKey, signals))
  }

  const { filled, closed } = evaluateSignals(history, symbolKey, currentPrice)

  if (TELEGRAM_SYMBOLS.has(symbolKey)) {
    // Filtered to H1 before grouping, not after — an H4/D1 confluence partner should
    // never even be mentioned in an H1 message's timeframe list, the same as if it
    // didn't exist.
    const onlyH1 = (r) => TELEGRAM_TIMEFRAMES.has(r.tf)
    await notifyNewSignals(symbolKey, added.filter(onlyH1), signalByKey)
    await notifyFilledSignals(symbolKey, filled.filter(onlyH1))
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
}

// Only auto-run when executed directly (`node scripts/fetch-data.mjs`), not when
// imported — lets the exported pieces above be exercised directly (e.g. in tests)
// without triggering a real network run.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[fetch-data] fatal:', err)
    process.exit(1)
  })
}
