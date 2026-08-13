// Track record for generated signals: logs each one as 'pending' the first time it's
// seen, then closes it out as a 'win' or 'loss' once price plausibly reaches its first
// take-profit or its stop-loss. Persisted to localStorage so the record survives
// reloads — the whole point is judging the detector over time, not just this session.
const STORAGE_KEY = 'gold-sr-signal-history-v1'
// Caps localStorage growth — old records are dropped oldest-first once this many
// have accumulated across all symbols.
const MAX_RECORDS = 300

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch {
    return []
  }
}

function save(records) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS)))
  } catch {
    // Storage full/unavailable — history just stops growing from here.
  }
}

// Identifies a signal by the level that produced it, not its exact entry price (which
// can drift slightly bar-to-bar as the underlying pivot recalculates) — so a signal
// that's still standing on the next refresh finds its existing 'pending' row instead
// of spawning a duplicate. A level whose category changes (e.g. Support -> RBS after
// a breakout) intentionally opens a fresh row: that's a real change in setup, not the
// same trade continuing.
const keyFor = (symbolKey, tf, signal) => `${symbolKey}-${tf}-${signal.category}-${signal.direction}`

// Called after every refreshData() with that timeframe's freshly-built signals.
export function recordSignals(symbolKey, tf, signals) {
  const records = load()
  const openKeys = new Set(records.filter((r) => r.status === 'pending').map((r) => r.key))

  for (const signal of signals) {
    const key = keyFor(symbolKey, tf, signal)
    if (openKeys.has(key)) continue
    records.push({
      key,
      symbolKey,
      tf,
      category: signal.category,
      direction: signal.direction,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      openedAt: Date.now(),
      status: 'pending',
    })
  }

  save(records)
}

// Closes out every open record for this symbol once price has plausibly hit its SL or
// first take-profit. This only sees the latest polled price (every ~5 minutes), not a
// full tick-by-tick feed, so a fast wick through a level between polls can be missed —
// an accepted approximation, same staleness tolerance as the rest of the app.
export function evaluateSignals(symbolKey, currentPrice) {
  if (currentPrice == null) return
  const records = load()
  let changed = false

  for (const r of records) {
    if (r.status !== 'pending' || r.symbolKey !== symbolKey) continue

    const isBuy = r.direction === 'buy'
    const hitSl = isBuy ? currentPrice <= r.sl : currentPrice >= r.sl
    const firstTp = r.tp[0]?.price
    const hitTp = firstTp != null && (isBuy ? currentPrice >= firstTp : currentPrice <= firstTp)

    // Checked in this order so an unseen path that plausibly crossed both between
    // polls is scored as a loss rather than assuming the better outcome.
    if (hitSl) {
      r.status = 'loss'
      r.closedAt = Date.now()
      r.exitPrice = currentPrice
      changed = true
    } else if (hitTp) {
      r.status = 'win'
      r.closedAt = Date.now()
      r.exitPrice = currentPrice
      changed = true
    }
  }

  if (changed) save(records)
}

export function getHistory(symbolKey) {
  return load()
    .filter((r) => r.symbolKey === symbolKey)
    .sort((a, b) => b.openedAt - a.openedAt)
}

export function getStats(symbolKey) {
  const records = getHistory(symbolKey)
  const wins = records.filter((r) => r.status === 'win').length
  const losses = records.filter((r) => r.status === 'loss').length
  const pending = records.filter((r) => r.status === 'pending').length
  const closed = wins + losses
  return {
    total: records.length,
    wins,
    losses,
    pending,
    winRate: closed ? Math.round((wins / closed) * 100) : null,
  }
}
