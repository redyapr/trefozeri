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
import { recordSignals, evaluateSignals, trimRecords } from '../src/lib/signalHistoryCore.js'

const OUT_DIR = path.join(process.cwd(), 'public', 'data')
const HISTORY_PATH = path.join(process.cwd(), 'data', 'signal-history.json')

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
// then fold those into the shared history. Mutates `history` in place.
function updateSignalHistoryForSymbol(history, symbolKey, seriesByTf) {
  const currentPrice = seriesByTf.H1?.at(-1)?.close
  const zonesByTimeframe = {}

  for (const [tfKey, series] of Object.entries(seriesByTf)) {
    if (!series?.length) continue
    const last = series.at(-1)
    zonesByTimeframe[tfKey] = { zones: detectLevels(series, currentPrice ?? last.close) }
  }

  annotateGoldenZones(zonesByTimeframe)

  for (const [tfKey, result] of Object.entries(zonesByTimeframe)) {
    recordSignals(history, symbolKey, tfKey, buildSignals(result.zones))
  }
  evaluateSignals(history, symbolKey, currentPrice)
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
    updateSignalHistoryForSymbol(history, symbolKey, seriesByTf)
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

main().catch((err) => {
  console.error('[fetch-data] fatal:', err)
  process.exit(1)
})
