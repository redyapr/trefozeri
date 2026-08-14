// Gold (XAUUSD) trades on the same ~23/5 schedule as the broader forex market: closed
// from Friday 22:00 UTC (5pm ET, the standard week-close) until Sunday 22:00 UTC (5pm
// ET, week-open) — all of Saturday and most of Sunday. BTCUSD trades 24/7, so this only
// ever matters for XAUUSD. Pure UTC day-of-week/hour arithmetic is close enough for a
// dashboard banner and for not trusting brand-new candles right after a multi-day gap
// (see structuralSlDistance in srDetector.js — a stretch of flat/stale weekend candles
// was the suspected root cause of an ATR-collapsing-to-0 bug found this session) — no
// need for an actual market-calendar data source for something this coarse.
export function isGoldMarketClosed(date = new Date()) {
  const day = date.getUTCDay() // 0 = Sunday .. 6 = Saturday
  const hour = date.getUTCHours()
  if (day === 6) return true // all of Saturday
  if (day === 0) return hour < 22 // Sunday before the 22:00 UTC reopen
  if (day === 5) return hour >= 22 // Friday from the 22:00 UTC close
  return false
}
