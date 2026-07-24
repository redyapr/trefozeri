const CALENDAR_ENDPOINT = '/api/calendar'

let cache = []

export async function fetchNewsCalendar() {
  try {
    const res = await fetch(CALENDAR_ENDPOINT)
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
