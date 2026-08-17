// Pre-fetched by scripts/fetch-data.mjs (see .github/workflows/deploy.yml) rather than
// proxied on-demand — GitHub Pages has no server to proxy this on request, so a cron
// job writes these as static JSON ahead of time instead. The real Twelve Data API key
// only ever lives in that CI job; the browser never sees it. import.meta.env.BASE_URL
// respects vite.config.js's `base`, so this still resolves correctly when the site is
// served from a GitHub Pages project subpath.
import { PIP_SIZES } from './signalHistoryCore.js'

// import.meta.env is undefined outside a Vite build (e.g. this module loaded directly
// under plain Node, as the test suite does) — without the fallback, merely importing
// this module would throw before any test ever got to run.
const DATA_ENDPOINT = `${import.meta.env?.BASE_URL ?? '/'}data`
// Cache-busts the static JSON so the browser doesn't keep serving a snapshot from
// before the last cron refresh — these files are small and change every ~15 minutes.
const cacheBust = () => `?v=${Date.now()}`

// This pivot-based state machine runs on D1/H4/H1 only — the lower timeframes were
// dropped rather than adapted, since sub-hourly noise is exactly what it isn't meant
// to be run on.
//
// minRefetchMs caps how often each timeframe is allowed to hit the API again —
// roughly proportional to how often its own bars actually change, so refreshData()
// (run on startup and on every symbol switch) doesn't re-fetch data that can't
// plausibly have moved yet.
export const TIMEFRAMES = [
  { key: 'H1', interval: '1h', outputsize: 300, label: 'H1', minRefetchMs: 20 * 60 * 1000 },
  { key: 'H4', interval: '4h', outputsize: 300, label: 'H4', minRefetchMs: 60 * 60 * 1000 },
  { key: 'D1', interval: '1day', outputsize: 300, label: 'D1', minRefetchMs: 4 * 60 * 60 * 1000 },
]

// pipSize (used for the track record's win/loss pip readout) comes from
// signalHistoryCore.js's PIP_SIZES — the one source of truth, since the cron script
// that sends Telegram notifications needs the same value and can't import this module
// (it reads import.meta.env, a Vite/browser-only API).
export const SYMBOLS = [
  { key: 'XAUUSD', apiSymbol: 'XAU/USD', label: 'XAUUSD', eyebrow: 'Gold', pipSize: PIP_SIZES.XAUUSD },
  { key: 'BTCUSD', apiSymbol: 'BTC/USD', label: 'BTCUSD', eyebrow: 'Bitcoin', pipSize: PIP_SIZES.BTCUSD },
]

// Twelve Data returns naive "YYYY-MM-DD[ HH:mm:ss]" strings with no offset. We request
// them as UTC explicitly (below) but `new Date(...)` still parses a string with no 'Z'
// as local time, so we have to mark it as UTC ourselves before parsing — otherwise every
// timestamp silently shifts by the host machine's UTC offset (and "ago" math can even
// come out negative).
function parseUtc(datetime) {
  const iso = datetime.includes(' ') ? datetime.replace(' ', 'T') + 'Z' : `${datetime}T00:00:00Z`
  return new Date(iso).getTime()
}

async function fetchSeries(apiSymbol, tf) {
  const symbolKey = SYMBOLS.find((s) => s.apiSymbol === apiSymbol)?.key
  const url = `${DATA_ENDPOINT}/quote/${symbolKey}-${tf.key}.json${cacheBust()}`
  const res = await fetch(url)
  // A missing static file (a symbol/timeframe combo that was never generated, or a
  // stale deploy) serves GitHub Pages' HTML 404 page — without this check that gets
  // handed to res.json() below and throws a cryptic "Unexpected token '<'" instead of
  // a clear, loggable "fetch failed (404)".
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status})`)
  }
  const json = await res.json()

  if (json.status === 'error' || json.code || json.message) {
    throw new Error(json.message || 'Failed to fetch data from Twelve Data')
  }
  // A valid-but-empty `values: []` (a provider/cron hiccup that still writes valid
  // JSON) would otherwise pass through as "success" with zero candles — main.js reads
  // series[series.length - 1] right after a successful fetch and crashes on undefined.
  // Treating it as a fetch error here means it's handled the same way any other
  // failure already is (kept as {error}, previous data left on screen, retried next
  // cycle) instead of silently corrupting that refresh.
  if (!Array.isArray(json.values) || json.values.length === 0) {
    throw new Error('Unrecognized data format from Twelve Data')
  }

  return json.values.map((v) => ({
    time: parseUtc(v.datetime),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
    // undefined (not NaN/0) when the source has none at all (Twelve Data's XAUUSD feed
    // never carries one; BTCUSD's does, see scripts/fetch-data.mjs's own toCandles) —
    // srDetector.js treats that as "no data" and falls back to a volume-less proxy.
    volume: v.volume != null ? parseFloat(v.volume) : undefined,
  }))
}

export async function fetchAllTimeframes(apiSymbol, timeframes = TIMEFRAMES) {
  const results = {}
  for (const tf of timeframes) {
    try {
      results[tf.key] = await fetchSeries(apiSymbol, tf)
    } catch (err) {
      // Logged here, not just carried as {error} — a permanently broken endpoint
      // otherwise fails completely silently forever (main.js just does
      // `if (series?.error) continue`, with no trace of *why* left anywhere).
      console.error(`[twelveData] ${apiSymbol} ${tf.key} fetch failed: ${err.message}`)
      results[tf.key] = { error: err.message }
    }
  }
  return results
}
