// Whitelisted so this proxy can't be used as an open relay for arbitrary upstream
// symbols under our API key.
const ALLOWED_SYMBOLS = new Set(['XAU/USD', 'BTC/USD'])

// BTC/USD is served from Binance.US instead of Twelve Data — it needs no API key,
// has a far more generous rate limit, and (being the US-compliant entity) doesn't
// hit the "restricted location" block that binance.com applies to US-hosted server
// traffic like Netlify Functions. This halves the load on our Twelve Data quota too,
// since crypto no longer competes with gold for the same per-minute allowance.
const BINANCE_INTERVAL = {
  '5min': '5m',
  '15min': '15m',
  '30min': '30m',
  '1h': '1h',
  '4h': '4h',
  '1day': '1d',
}

function toTwelveDataDatetime(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

async function fetchFromBinance(interval, outputsize) {
  const binanceInterval = BINANCE_INTERVAL[interval]
  if (!binanceInterval) {
    return new Response(JSON.stringify({ message: `Unsupported interval: ${interval}` }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const url = `https://api.binance.us/api/v3/klines?symbol=BTCUSD&interval=${binanceInterval}&limit=${encodeURIComponent(outputsize)}`
  const res = await fetch(url)

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return new Response(JSON.stringify({ message: `Binance.US error (${res.status}): ${body}` }), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    })
  }

  const klines = await res.json()
  // Normalized into Twelve Data's response shape so the client's parsing code
  // (twelveData.js) stays provider-agnostic and needs no changes either way.
  const values = klines.map(([openTime, open, high, low, close]) => ({
    datetime: toTwelveDataDatetime(openTime),
    open,
    high,
    low,
    close,
  }))

  return new Response(JSON.stringify({ status: 'ok', values }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// Proxies Twelve Data's time_series endpoint so TWELVE_DATA_API_KEY only ever lives
// server-side (Netlify environment variable) — the browser bundle never sees it.
async function fetchFromTwelveData(symbol, interval, outputsize) {
  const apiKey = process.env.TWELVE_DATA_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ message: 'TWELVE_DATA_API_KEY is not configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  const apiUrl =
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&order=ASC&timezone=UTC` +
    `&interval=${encodeURIComponent(interval)}&outputsize=${encodeURIComponent(outputsize)}&apikey=${apiKey}`

  const res = await fetch(apiUrl)
  const body = await res.text()

  return new Response(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}

export default async (req) => {
  const url = new URL(req.url)
  const interval = url.searchParams.get('interval')
  const outputsize = url.searchParams.get('outputsize') || '300'
  const symbol = url.searchParams.get('symbol') || 'XAU/USD'

  if (!interval) {
    return new Response(JSON.stringify({ message: 'Missing interval parameter' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  if (!ALLOWED_SYMBOLS.has(symbol)) {
    return new Response(JSON.stringify({ message: 'Unsupported symbol' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  return symbol === 'BTC/USD'
    ? fetchFromBinance(interval, outputsize)
    : fetchFromTwelveData(symbol, interval, outputsize)
}

export const config = {
  path: '/api/quote',
}
