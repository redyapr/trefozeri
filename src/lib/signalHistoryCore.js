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

// Mutates `records`: drops stale unfilled orders whose level moved on without them,
// then appends any newly-seen signal as a fresh 'pending' row. Returns just the
// records that were newly appended this call (e.g. so a caller can notify about them
// without re-notifying about ones that were already open). `currentPrice` is optional
// (see the fill-in-progress guard below) — omitting it just skips that guard.
export function recordSignals(records, symbolKey, tf, signals, currentPrice) {
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
    // A real production bug: a SELL sitting right at a resistance (or a BUY at a
    // support) can have its own fill and its own level's breakout be the very same
    // candle — price reaching the entry is often exactly what breaks the level, which
    // flips it to a different category next tick (Resistance -> RBS) and so no longer
    // matches `r.key` above. Without this guard the record would be dropped here,
    // before the caller's later evaluateSignals(...) call ever got a chance to mark it
    // filled — a signal that plainly did fill, silently vanishing with no
    // running/Telegram-fill ever recorded for it. So: don't drop a pending record that
    // currentPrice already shows has reached its own entry, even if its level didn't
    // survive the same tick — let evaluateSignals promote it normally afterward.
    const isBuy = r.direction === 'buy'
    const alreadyFilled = currentPrice != null && (isBuy ? currentPrice <= r.entry : currentPrice >= r.entry)
    if (!stillCurrent && !alreadyFilled) records.splice(i, 1)
  }

  const openKeys = new Set(records.filter(isOpen).map((r) => r.key))
  const added = []

  for (const signal of signals) {
    const key = keyFor(symbolKey, tf, signal)
    if (openKeys.has(key)) continue
    const record = {
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
    }
    records.push(record)
    added.push(record)
  }

  return added
}

// Advances every open record for this symbol: fills a 'pending' limit order once price
// reaches its entry, then (whether just filled or already running) closes it out as a
// 'win' or 'loss' once price plausibly hits its first take-profit or its stop-loss.
// Mutates `records` in place; returns `{ filled, closed }` — the records that changed
// state this call, e.g. so a caller can notify about them. A record that fills AND
// closes within the same call (a fast move a coarse ~15-minute poll can't see the
// middle of) only appears in `closed`, not `filled` — a "filled" notification would be
// redundant noise immediately followed by the close.
export function evaluateSignals(records, symbolKey, currentPrice) {
  if (currentPrice == null) return { filled: [], closed: [] }
  const filled = []
  const closed = []

  for (const r of records) {
    if (r.symbolKey !== symbolKey || !isOpen(r)) continue
    const isBuy = r.direction === 'buy'
    let justFilled = false

    if (r.status === 'pending') {
      // A fade-the-level limit order: buy fills on the way down to entry, sell fills
      // on the way up to it.
      const isFilled = isBuy ? currentPrice <= r.entry : currentPrice >= r.entry
      if (!isFilled) continue
      r.status = 'running'
      r.filledAt = Date.now()
      justFilled = true
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
      closed.push(r)
    } else if (hitTpIndex >= 0) {
      r.status = 'win'
      r.closedAt = Date.now()
      r.exitPrice = currentPrice
      r.hitTpIndex = hitTpIndex
      closed.push(r)
    } else if (justFilled) {
      filled.push(r)
    }
  }

  return { filled, closed }
}

// Caps each symbol's own history independently (oldest-first within each), rather than
// capping the whole array combined — otherwise a busier symbol (e.g. XAUUSD once
// Telegram made its H1 signals more visible) could crowd a quieter one's history out
// of the shared 300-record budget entirely.
export function trimRecords(records) {
  const bySymbol = new Map()
  for (const r of records) {
    if (!bySymbol.has(r.symbolKey)) bySymbol.set(r.symbolKey, [])
    bySymbol.get(r.symbolKey).push(r)
  }

  const trimmed = []
  for (const list of bySymbol.values()) trimmed.push(...list.slice(-MAX_RECORDS))
  return trimmed.sort((a, b) => a.openedAt - b.openedAt)
}

// `tf` is optional — omit it (or pass 'ALL') for every timeframe combined. Filtering by
// timeframe matters here specifically because Telegram only ever posts H1 signals (see
// TELEGRAM_TIMEFRAMES in fetch-data.mjs): the combined win rate can otherwise read
// differently than what the channel's own H1-only track record would show.
export function getHistory(records, symbolKey, tf) {
  return records
    .filter((r) => r.symbolKey === symbolKey && (tf == null || tf === 'ALL' || r.tf === tf))
    .sort((a, b) => b.openedAt - a.openedAt)
}

// Records closed (win or loss) within [startMs, endMs) — the daily/weekly Telegram
// report's building block (see scripts/fetch-data.mjs), sorted oldest-first within the
// window since a report reads naturally in the order things happened.
export function getClosedBetween(records, symbolKey, tf, startMs, endMs) {
  return getHistory(records, symbolKey, tf)
    .filter((r) => (r.status === 'win' || r.status === 'loss') && r.closedAt >= startMs && r.closedAt < endMs)
    .sort((a, b) => a.closedAt - b.closedAt)
}

export function getStats(records, symbolKey, tf) {
  const list = getHistory(records, symbolKey, tf)
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

// 0.1 is the common gold-CFD broker convention (4400.00 -> 4400.10 = 1 pip) — adjust if
// your broker quotes differently. null means "don't show pips": there's no standard pip
// convention for crypto, so BTCUSD's move is shown as a raw $ figure instead. This is
// the one source of truth for pip size — twelveData.js's SYMBOLS reads from here too,
// since this module (unlike twelveData.js) has no import.meta.env dependency and so is
// importable from both the browser and the Node cron script (scripts/fetch-data.mjs).
export const PIP_SIZES = { XAUUSD: 0.1, BTCUSD: null }

// How far price moved from entry to exit, in the trade's favor being positive — e.g. a
// sell's exit price is *below* entry on a win, so this flips the raw sign rather than
// just reporting exitPrice - entry verbatim. Returns a plain number (pip count if
// pipSize is set, otherwise a $ amount rounded to cents) rather than display text — the
// daily/weekly Telegram report (scripts/fetch-data.mjs) sums this raw across many
// records before formatting the aggregate, which formatAmount below then handles
// identically for a single trade's move or a summed total.
export function favorableMove(pipSize, entry, exitPrice, isBuy) {
  const raw = exitPrice - entry
  const favorable = isBuy ? raw : -raw
  return pipSize ? Math.round(favorable / pipSize) : Number(favorable.toFixed(2))
}

// Rounds to cents but drops a trailing ".00"/trailing zero the same way formatPrice
// does (850 instead of 850.00, 850.5 instead of 850.50) — Number(...toFixed(2)) (done
// in favorableMove already, for a $ amount) strips it via normal number-to-string
// conversion; pip counts are already whole numbers, nothing to strip.
export function formatAmount(pipSize, amount) {
  const sign = amount >= 0 ? '+' : ''
  return pipSize ? `${sign}${amount} pips` : `${sign}${amount}`
}

// Shared by the dashboard's track-record modal and the cron script's Telegram
// notifications so both report the same number for a single trade's result.
export function formatMove(pipSize, entry, exitPrice, isBuy) {
  return formatAmount(pipSize, favorableMove(pipSize, entry, exitPrice, isBuy))
}

// The one shared price display format — rounds to 1 decimal, but drops it entirely
// when it'd just be ".0" (4301 instead of 4301.0, 4307.8 stays 4307.8). Used
// everywhere a price is shown to a person: the dashboard (spot ticker, zone/signal
// cards, track record) and the cron script's Telegram messages, so they always agree.
export function formatPrice(n) {
  return String(Number(n.toFixed(1)))
}
