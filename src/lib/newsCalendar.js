// Pre-fetched by scripts/fetch-data.mjs (see .github/workflows/deploy.yml) into a
// static file instead of proxied on-demand — GitHub Pages has no server to proxy this
// on request. import.meta.env.BASE_URL respects vite.config.js's `base`, so this still
// resolves under a GitHub Pages project subpath.
// import.meta.env is undefined outside a Vite build (e.g. this module loaded directly
// under plain Node, as the test suite does) — without the fallback, merely importing
// this module would throw before any test ever got to run.
const CALENDAR_ENDPOINT = `${import.meta.env?.BASE_URL ?? '/'}data/calendar.json`

let cache = []

export async function fetchNewsCalendar() {
  try {
    // Cache-busts so the browser doesn't keep serving a snapshot from before the
    // last cron refresh — this file is small and changes every ~5 minutes.
    const res = await fetch(`${CALENDAR_ENDPOINT}?v=${Date.now()}`)
    // Without this, a missing static file (404 -> GitHub Pages' HTML error page)
    // would hit res.json() below and throw a cryptic JSON-parse error instead of a
    // clear, loggable "fetch failed" one.
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`)
    const events = await res.json()
    if (!Array.isArray(events)) {
      console.error('[newsCalendar] unexpected response shape (not an array) — keeping last good calendar')
      return cache
    }
    cache = events
    return events
  } catch (err) {
    // Logged, not just swallowed — a permanently broken calendar endpoint otherwise
    // fails completely silently forever, with no trace of *why* left anywhere.
    console.error(`[newsCalendar] fetch failed: ${err.message} — keeping last good calendar`)
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
    // Case-insensitive on purpose: harmless while the upstream feed keeps its current
    // exact "USD"/"High" casing, and stays correct if that ever drifts (e.g. "high")
    // instead of silently filtering every event out with no error anywhere.
    .filter((e) => String(e.country).toUpperCase() === 'USD' && String(e.impact).toLowerCase() === 'high')
    .map((e) => ({ ...e, timestamp: new Date(e.date).getTime() }))
    // A malformed e.date parses to NaN; NaN >= now is always false, so this already
    // safely drops it rather than crashing — just worth a trace instead of vanishing
    // with zero indication why an event that should have shown up didn't.
    .filter((e) => {
      if (Number.isNaN(e.timestamp)) {
        console.error(`[newsCalendar] event with unparseable date, skipping: ${JSON.stringify(e.date)}`)
        return false
      }
      return e.timestamp >= now && e.timestamp <= horizon
    })
    .sort((a, b) => a.timestamp - b.timestamp)
}

// 2026-08-31 dashboard-improvement pass: mirrors isNearHighImpactNews in
// scripts/fetch-data.mjs exactly (same USD/high filter, same ±30-minute window) — a
// deliberate copy of that pure function's logic, not an import of it, for the same
// reason findUpcomingHighImpact above already lives in this browser-facing module
// separately from that plain-Node script (see that script's own comment on
// isNearHighImpactNews: importing this module into it would pull in
// import.meta.env, which throws outside a Vite build).
//
// Used to gate the *live-display* signal cards on main.js's dashboard the same way
// the persisted/Telegram-posted track record already gates new signals server-side —
// before this existed, a visitor could see a BUY/SELL LIMIT card during a news window
// that the shared track record would never actually open/count, a real
// display-vs-reality mismatch.
const NEWS_GATE_MINUTES = 30

export function isNearHighImpactNews(events, now = Date.now(), windowMinutes = NEWS_GATE_MINUTES) {
  if (!Array.isArray(events)) return false
  const windowMs = windowMinutes * 60 * 1000
  return events.some((e) => {
    if (String(e.country).toUpperCase() !== 'USD' || String(e.impact).toLowerCase() !== 'high') return false
    const t = new Date(e.date).getTime()
    return Number.isFinite(t) && Math.abs(t - now) <= windowMs
  })
}
