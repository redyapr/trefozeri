// Pure record-keeping logic for the signal track record — no localStorage, no fetch,
// just plain array-in/array-out functions. This is the one copy shared between the
// browser (read-only display, via signalHistory.js) and the Node cron script that
// actually maintains the record (scripts/fetch-data.mjs), so the two never drift.
//
// Every signal is a LIMIT order (see srDetector.js), so a record's life is:
//   'pending' -> price hasn't reached the entry price yet, order unfilled
//   'running' -> entry was reached (filled), now live and tracked against SL/TP
//   'win' / 'loss' -> closed once price plausibly reached its first take-profit or SL
// There's no 'invalidated' status: if a still-'pending' (unfilled) record's underlying
// level disappears or gets replaced by a different pivot before ever filling, it's
// simply dropped — it was never a real trade, just an order that never triggered. A
// 'running' record is never dropped this way; once filled it's a real trade and stays
// until SL/TP closes it, the same way price crossing the zone's own invalidation
// threshold naturally becomes the eventual loss.

// Caps growth — old records are dropped oldest-first once this many have accumulated
// across all symbols.
export const MAX_RECORDS = 300

// Identifies a signal by the level that produced it, not its exact entry price (which
// can drift slightly bar-to-bar as the underlying pivot recalculates) — so a signal
// that's still standing on the next refresh finds its existing open row instead of
// spawning a duplicate. A level whose category changes (e.g. Support -> RBS after a
// breakout) intentionally opens a fresh row: that's a real change in setup, not the
// same trade continuing.
export const keyFor = (symbolKey, tf, signal) => `${symbolKey}-${tf}-${signal.category}-${signal.direction}`

const isOpen = (r) => r.status === 'pending' || r.status === 'running'

// Mutates and returns `records`: drops stale unfilled orders whose level moved on
// without them, then appends any newly-seen signal as a fresh 'pending' row.
export function recordSignals(records, symbolKey, tf, signals) {
  // A 'pending' (still unfilled) record whose key+price no longer matches any of this
  // tick's fresh signals had its level either fully invalidated or replaced by a
  // different pivot at a materially different price — either way the order it
  // represented never filled and never will, so it's discarded rather than left
  // stuck as pending forever. `signal.threshold` (the level's own breakout threshold)
  // is the tolerance for "still the same pivot, just recalculated slightly".
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.symbolKey !== symbolKey || r.tf !== tf || r.status !== 'pending') continue
    const stillCurrent = signals.some(
      (s) => keyFor(symbolKey, tf, s) === r.key && Math.abs(s.entry - r.entry) <= (s.threshold ?? Infinity)
    )
    if (!stillCurrent) records.splice(i, 1)
  }

  const openKeys = new Set(records.filter(isOpen).map((r) => r.key))

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

  return records
}

// Advances every open record for this symbol: fills a 'pending' limit order once price
// reaches its entry, then (whether just filled or already running) closes it out as a
// 'win' or 'loss' once price plausibly hits its first take-profit or its stop-loss.
// Mutates `records` in place; returns whether anything changed.
export function evaluateSignals(records, symbolKey, currentPrice) {
  if (currentPrice == null) return false
  let changed = false

  for (const r of records) {
    if (r.symbolKey !== symbolKey || !isOpen(r)) continue
    const isBuy = r.direction === 'buy'

    if (r.status === 'pending') {
      // A fade-the-level limit order: buy fills on the way down to entry, sell fills
      // on the way up to it.
      const filled = isBuy ? currentPrice <= r.entry : currentPrice >= r.entry
      if (!filled) continue
      r.status = 'running'
      r.filledAt = Date.now()
      changed = true
      // Fall through to check SL/TP the same tick — a coarse ~15-minute poll can
      // otherwise miss a fill-and-close that both happened between two checks.
    }

    const hitSl = isBuy ? currentPrice <= r.sl : currentPrice >= r.sl

    // Find the farthest TP price has already reached, not just the first — the same
    // poll gap can miss a fast move that blew through more than one target, so a win
    // gets credit for whichever level it actually reached.
    let hitTpIndex = -1
    for (let i = 0; i < r.tp.length; i++) {
      const reached = isBuy ? currentPrice >= r.tp[i].price : currentPrice <= r.tp[i].price
      if (reached) hitTpIndex = i
    }

    // Checked in this order so an unseen path that plausibly crossed both between
    // polls is scored as a loss rather than assuming the better outcome.
    if (hitSl) {
      r.status = 'loss'
      r.closedAt = Date.now()
      r.exitPrice = currentPrice
      changed = true
    } else if (hitTpIndex >= 0) {
      r.status = 'win'
      r.closedAt = Date.now()
      r.exitPrice = currentPrice
      r.hitTpIndex = hitTpIndex
      changed = true
    }
  }

  return changed
}

export function trimRecords(records) {
  return records.slice(-MAX_RECORDS)
}

export function getHistory(records, symbolKey) {
  return records.filter((r) => r.symbolKey === symbolKey).sort((a, b) => b.openedAt - a.openedAt)
}

export function getStats(records, symbolKey) {
  const list = getHistory(records, symbolKey)
  const wins = list.filter((r) => r.status === 'win').length
  const losses = list.filter((r) => r.status === 'loss').length
  const running = list.filter((r) => r.status === 'running').length
  const pending = list.filter((r) => r.status === 'pending').length
  const closed = wins + losses
  return {
    total: list.length,
    wins,
    losses,
    running,
    pending,
    winRate: closed ? Math.round((wins / closed) * 100) : null,
  }
}
