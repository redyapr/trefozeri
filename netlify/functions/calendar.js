// Proxies a free, keyless economic-calendar feed (the one many public ForexFactory-
// style calendar widgets embed) so the client doesn't depend on that third party's
// CORS policy. This feed rate-limits fairly aggressively on its own, so responses
// are cacheable for a while — the calendar only changes a handful of times a day —
// letting Netlify's CDN and the browser both absorb repeat requests without
// hitting the upstream (or our own rate limit) on every page load.
export default async () => {
  const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json')
  const body = await res.text()

  return new Response(body, {
    status: res.status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=1800',
    },
  })
}

export const config = {
  path: '/api/calendar',
}
