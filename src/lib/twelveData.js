// Served by netlify/functions/quote.js, which holds the real Twelve Data API key
// server-side — the browser never sees it.
const QUOTE_ENDPOINT = '/api/quote'

export const TIMEFRAMES = [
  { key: 'M5', interval: '5min', outputsize: 300, label: 'M5' },
  { key: 'M15', interval: '15min', outputsize: 300, label: 'M15' },
  { key: 'M30', interval: '30min', outputsize: 300, label: 'M30' },
  { key: 'H1', interval: '1h', outputsize: 300, label: 'H1' },
  { key: 'H4', interval: '4h', outputsize: 300, label: 'H4' },
  { key: 'D1', interval: '1day', outputsize: 300, label: 'D1' },
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

async function fetchSeries(interval, outputsize) {
  const url = `${QUOTE_ENDPOINT}?interval=${interval}&outputsize=${outputsize}`
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

export async function fetchAllTimeframes(onProgress) {
  const results = {}
  for (const tf of TIMEFRAMES) {
    try {
      results[tf.key] = await fetchSeries(tf.interval, tf.outputsize)
    } catch (err) {
      results[tf.key] = { error: err.message }
    }
    onProgress?.(tf.key)
  }
  return results
}
