const STORAGE_KEY = 'gold-sr-journal'
const MAX_ENTRIES = 200

export function loadJournal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveJournal(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)))
}

// Rounded entry price is close enough to identify "the same still-active signal"
// across refresh cycles without re-logging it every 3 minutes.
function signalKey(tfKey, signal) {
  return `${tfKey}:${signal.zoneType}:${signal.direction}:${signal.orderType}:${Math.round(signal.entry)}`
}

// Logs newly-seen signals, then walks each open entry's candles (from the moment it
// was logged onward) looking for the first candle that touches SL or TP1 — whichever
// comes first wins, and if a single candle's range spans both, SL is assumed to have
// been hit first (the conservative assumption used in backtesting).
export function updateJournal(zonesByTimeframe) {
  const journal = loadJournal()
  const seen = new Set(journal.map((e) => e.key))

  for (const [tfKey, result] of Object.entries(zonesByTimeframe)) {
    for (const signal of result.signals ?? []) {
      const key = signalKey(tfKey, signal)
      if (seen.has(key)) continue
      seen.add(key)
      journal.push({
        key,
        timeframe: tfKey,
        direction: signal.direction,
        orderType: signal.orderType,
        zoneType: signal.zoneType,
        entry: signal.entry,
        sl: signal.sl,
        tp: signal.tp.map((t) => t.price),
        loggedAt: Date.now(),
        outcome: 'open',
        closedAt: null,
      })
    }
  }

  for (const entry of journal) {
    if (entry.outcome !== 'open') continue
    const series = zonesByTimeframe[entry.timeframe]?.series
    if (!series) continue

    const isBuy = entry.direction === 'buy'
    for (const c of series) {
      if (c.time < entry.loggedAt) continue
      const hitSl = isBuy ? c.low <= entry.sl : c.high >= entry.sl
      const hitTp = isBuy ? c.high >= entry.tp[0] : c.low <= entry.tp[0]
      if (hitSl) {
        entry.outcome = 'loss'
        entry.closedAt = c.time
        break
      }
      if (hitTp) {
        entry.outcome = 'win'
        entry.closedAt = c.time
        break
      }
    }
  }

  saveJournal(journal)
  return journal
}
