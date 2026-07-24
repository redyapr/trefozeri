// Proxies Twelve Data's time_series endpoint so TWELVE_DATA_API_KEY only ever lives
// server-side (Netlify environment variable) — the browser bundle never sees it.
export default async (req) => {
  const url = new URL(req.url)
  const interval = url.searchParams.get('interval')
  const outputsize = url.searchParams.get('outputsize') || '300'

  if (!interval) {
    return new Response(JSON.stringify({ message: 'Missing interval parameter' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const apiKey = process.env.TWELVE_DATA_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ message: 'TWELVE_DATA_API_KEY is not configured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  const apiUrl =
    `https://api.twelvedata.com/time_series?symbol=XAU/USD&order=ASC&timezone=UTC` +
    `&interval=${encodeURIComponent(interval)}&outputsize=${encodeURIComponent(outputsize)}&apikey=${apiKey}`

  const res = await fetch(apiUrl)
  const body = await res.text()

  return new Response(body, {
    status: res.status,
    headers: { 'content-type': 'application/json' },
  })
}

export const config = {
  path: '/api/quote',
}
