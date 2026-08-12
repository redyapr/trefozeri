// Pre-fetched by scripts/fetch-data.mjs (see .github/workflows/deploy.yml) into a
// static file instead of proxied on-demand — GitHub Pages has no server to run
// netlify/functions/calendar.js's proxy on. import.meta.env.BASE_URL respects
// vite.config.js's `base`, so this still resolves under a GitHub Pages project subpath.
const CALENDAR_ENDPOINT = `${import.meta.env.BASE_URL}data/calendar.json`

let cache = []

export async function fetchNewsCalendar() {
  try {
    // Cache-busts so the browser doesn't keep serving a snapshot from before the
    // last cron refresh — this file is small and changes every ~15 minutes.
    const res = await fetch(`${CALENDAR_ENDPOINT}?v=${Date.now()}`)
    const events = await res.json()
    if (!Array.isArray(events)) return cache
    cache = events
    return events
  } catch {
    return cache // keep showing the last good calendar rather than clearing it out
  }
}

// Both gold and BTC trade primarily off USD macro risk (rate decisions, inflation,
// employment data) — a technically clean signal sitting right before one of these
// is a trap, so only USD-denominated high-impact events are worth flagging.
export function findUpcomingHighImpact(events, withinHours = 12) {
  const now = Date.now()
  const horizon = now + withinHours * 60 * 60 * 1000

  return events
    .filter((e) => e.country === 'USD' && e.impact === 'High')
    .map((e) => ({ ...e, timestamp: new Date(e.date).getTime() }))
    .filter((e) => e.timestamp >= now && e.timestamp <= horizon)
    .sort((a, b) => a.timestamp - b.timestamp)
}
