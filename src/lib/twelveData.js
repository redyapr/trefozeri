// Served by netlify/functions/quote.js, which holds the real Twelve Data API key
// server-side — the browser never sees it.
const QUOTE_ENDPOINT = '/api/quote'

// Golden Fairy's logic runs on D1/H4/H1 only (see GoldenFairy.pine) — the lower
// timeframes were dropped rather than adapted, since sub-hourly noise is exactly what
// that pivot-based state machine isn't meant to be run on.
//
// minRefetchMs caps how often each timeframe is allowed to hit the API again on a
// manual refresh — roughly proportional to how often its own bars actually change,
// so clicking refresh repeatedly doesn't burn API calls re-fetching data that can't
// plausibly have moved yet.
export const TIMEFRAMES = [
  { key: 'H1', interval: '1h', outputsize: 300, label: 'H1', minRefetchMs: 20 * 60 * 1000 },
  { key: 'H4', interval: '4h', outputsize: 300, label: 'H4', minRefetchMs: 60 * 60 * 1000 },
  { key: 'D1', interval: '1day', outputsize: 300, label: 'D1', minRefetchMs: 4 * 60 * 60 * 1000 },
]

// unitsPerLot is just the position-size calculator's starting point — gold CFDs
// commonly use 100oz/lot, crypto CFDs commonly use 1 BTC/lot; either is editable.
export const SYMBOLS = [
  { key: 'XAUUSD', apiSymbol: 'XAU/USD', label: 'XAU/USD', eyebrow: 'Gold', unitsPerLot: 100 },
  { key: 'BTCUSD', apiSymbol: 'BTC/USD', label: 'BTC/USD', eyebrow: 'Bitcoin', unitsPerLot: 1 },
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

async function fetchSeries(apiSymbol, interval, outputsize) {
  const url = `${QUOTE_ENDPOINT}?symbol=${encodeURIComponent(apiSymbol)}&interval=${interval}&outputsize=${outputsize}`
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
      results[tf.key] = await fetchSeries(apiSymbol, tf.interval, tf.outputsize)
    } catch (err) {
      results[tf.key] = { error: err.message }
    }
    onProgress?.(tf.key)
  }
  return results
}
