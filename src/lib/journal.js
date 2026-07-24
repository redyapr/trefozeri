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
function signalKey(symbolKey, tfKey, signal) {
  return `${symbolKey}:${tfKey}:${signal.zoneType}:${signal.direction}:${signal.orderType}:${Math.round(signal.entry)}`
}

// Logs newly-seen signals, then walks each open entry's candles (from the moment it
// was logged onward) looking for the first candle that touches SL or TP1 — whichever
// comes first wins, and if a single candle's range spans both, SL is assumed to have
// been hit first (the conservative assumption used in backtesting).
export function updateJournal(symbolKey, zonesByTimeframe) {
  const journal = loadJournal()
  const seen = new Set(journal.map((e) => e.key))

  for (const [tfKey, result] of Object.entries(zonesByTimeframe)) {
    for (const signal of result.signals ?? []) {
      const key = signalKey(symbolKey, tfKey, signal)
      if (seen.has(key)) continue
      seen.add(key)
      journal.push({
        key,
        symbol: symbolKey,
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
    // Only resolve entries for the symbol these zones/series actually belong to —
    // zonesByTimeframe here is scoped to one symbol at a time.
    if ((entry.symbol ?? 'XAUUSD') !== symbolKey) continue
    const series = zonesByTimeframe[entry.timeframe]?.series
    if (!series) continue

    const isBuy = entry.direction === 'buy'
    const risk = Math.abs(entry.entry - entry.sl)
    for (const c of series) {
      if (c.time < entry.loggedAt) continue
      const hitSl = isBuy ? c.low <= entry.sl : c.high >= entry.sl
      const hitTp = isBuy ? c.high >= entry.tp[0] : c.low <= entry.tp[0]
      // A loss is always -1R by definition (that's what "risk" means); a win's R
      // is however many multiples of that risk the first TP actually banked.
      if (hitSl) {
        entry.outcome = 'loss'
        entry.closedAt = c.time
        entry.rMultiple = -1
        break
      }
      if (hitTp) {
        entry.outcome = 'win'
        entry.closedAt = c.time
        entry.rMultiple = risk ? Math.abs(entry.tp[0] - entry.entry) / risk : 0
        break
      }
    }
  }

  saveJournal(journal)
  return journal
}

// Turns the raw win/loss log into performance metrics a trader actually cares about:
// expectancy (average R banked per trade, the number that tells you if the edge is
// real) and an equity curve (cumulative R over time, ordered by when trades closed).
export function computeJournalStats(journal) {
  const closed = journal
    .filter((e) => e.outcome !== 'open')
    .sort((a, b) => a.closedAt - b.closedAt)

  const wins = closed.filter((e) => e.outcome === 'win')
  const losses = closed.filter((e) => e.outcome === 'loss')

  const avg = (entries) => (entries.length ? entries.reduce((sum, e) => sum + e.rMultiple, 0) / entries.length : 0)
  const avgWinR = avg(wins)
  const avgLossR = avg(losses)
  const winRate = closed.length ? wins.length / closed.length : 0
  const expectancy = winRate * avgWinR + (1 - winRate) * avgLossR

  let running = 0
  const equityCurve = closed.map((e) => (running += e.rMultiple))

  return {
    closedCount: closed.length,
    openCount: journal.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWinR,
    avgLossR,
    expectancy,
    equityCurve,
  }
}
