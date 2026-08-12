#!/usr/bin/env node
// Pre-fetches the dashboard's price and calendar data so it can be shipped as static
// JSON. GitHub Pages only serves static files — there's no server to proxy this on
// request — so this script does the upstream fetch once per CI run (cron, see
// .github/workflows/deploy.yml) and writes the result into public/data/, which Vite
// then copies straight into dist/. TWELVE_DATA_API_KEY is only ever read here, inside
// the GitHub Actions runner or a developer's own shell; it's never bundled into the
// browser code.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUT_DIR = path.join(process.cwd(), 'public', 'data')

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

async function main() {
  const apiKey = process.env.TWELVE_DATA_API_KEY
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY is not set')

  for (const tf of TIMEFRAMES) {
    const gold = await fetchWithFallback(
      `XAUUSD ${tf.key}`,
      () => fetchTwelveData('XAU/USD', tf, apiKey),
      `quote/XAUUSD-${tf.key}.json`
    )
    if (gold) await writeJson(`quote/XAUUSD-${tf.key}.json`, gold)

    const btc = await fetchWithFallback(`BTCUSD ${tf.key}`, () => fetchBinance(tf), `quote/BTCUSD-${tf.key}.json`)
    if (btc) await writeJson(`quote/BTCUSD-${tf.key}.json`, btc)
  }

  const calendar = await fetchWithFallback('calendar', fetchCalendar, 'calendar.json')
  if (calendar) await writeJson('calendar.json', calendar)
}

main().catch((err) => {
  console.error('[fetch-data] fatal:', err)
  process.exit(1)
})
