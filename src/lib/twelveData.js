// Pre-fetched by scripts/fetch-data.mjs (see .github/workflows/deploy.yml) rather than
// proxied on-demand — GitHub Pages has no server to proxy this on request, so a cron
// job writes these as static JSON ahead of time instead. The real Twelve Data API key
// only ever lives in that CI job; the browser never sees it. import.meta.env.BASE_URL
// respects vite.config.js's `base`, so this still resolves correctly when the site is
// served from a GitHub Pages project subpath.
const DATA_ENDPOINT = `${import.meta.env.BASE_URL}data`
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

// unitsPerLot is just the position-size calculator's starting point — gold CFDs
// commonly use 100oz/lot, crypto CFDs commonly use 1 BTC/lot; either is editable.
//
// pipSize is only used for the track record's win/loss pip readout: 0.1 is the common
// gold-CFD broker convention (4400.00 -> 4400.10 = 1 pip) — adjust if your broker
// quotes differently. null means "don't show pips" — there's no standard pip
// convention for crypto, so BTCUSD's track record just shows the raw $ move instead.
export const SYMBOLS = [
  { key: 'XAUUSD', apiSymbol: 'XAU/USD', label: 'XAUUSD', eyebrow: 'Gold', unitsPerLot: 100, pipSize: 0.1 },
  { key: 'BTCUSD', apiSymbol: 'BTC/USD', label: 'BTCUSD', eyebrow: 'Bitcoin', unitsPerLot: 1, pipSize: null },
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
  const json = await res.json()

  if (json.status === 'error' || json.code || json.message) {
    throw new Error(json.message || 'Failed to fetch data from Twelve Data')
  }
  if (!json.values || !Array.isArray(json.values)) {
    throw new Error('Unrecognized data format from Twelve Data')
  }

  return json.values.map((v) => ({
    time: parseUtc(v.datetime),
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }))
}

export async function fetchAllTimeframes(apiSymbol, timeframes = TIMEFRAMES, onProgress) {
  const results = {}
  for (const tf of timeframes) {
    try {
      results[tf.key] = await fetchSeries(apiSymbol, tf)
    } catch (err) {
      results[tf.key] = { error: err.message }
    }
    onProgress?.(tf.key)
  }
  return results
}
