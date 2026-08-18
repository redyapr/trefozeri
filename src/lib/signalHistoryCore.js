import { BREAKOUT_ATR_MULT } from './srDetector.js'

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
// simply dropped — it was never a real trade, just an order that never triggered.
// recordSignals still hands the dropped record back to the caller (see `invalidated`
// below) so a Telegram reply can be sent before it's gone. A 'running' record is never
// dropped this way; once filled it's a real trade and stays until SL/TP closes it, the
// same way price crossing the zone's own invalidation threshold naturally becomes the
// eventual loss.

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

// 2026-08-17 win-rate review (see the matching comments in srDetector.js): a bare wick
// touch used to be enough to fill a limit order. A disciplined S/R trader instead waits
// for the retest candle to actually *close* holding the level before entering — not
// just wick through it on the way to somewhere else — so a fill now requires both.
// Also skips a candle whose own range is already an outsized volatility spike (see
// FILL_CANDLE_SKIP_ATR_MULT below): that's a violent move already in progress, not a
// controlled retest touch, and is exactly the shape of candle found blowing through
// both entry and SL together in the same motion during the review.
const FILL_CANDLE_SKIP_ATR_MULT = 2

// Mutates `records`: drops stale unfilled orders whose level moved on without them,
// syncs a still-open pending order's entry/SL/TP to the freshest recalculation, then
// appends any newly-seen signal as a fresh 'pending' row. Returns
// `{ added, updated, invalidated }` — the records newly appended, the already-open
// pending ones whose numbers just changed this call, and the ones just dropped as
// stale — so a caller can notify about each without re-notifying about ones that didn't
// actually change. `currentPrice` is optional (see the
// fill-in-progress guard below) — omitting it just skips that guard. `currentTime`
// (the data's own latest-candle time, not wall-clock Date.now()) becomes the new
// record's `openedAt` — matters because evaluateSignals now scans actual candles from
// openedAt forward to detect fills, so if openedAt used wall-clock time instead, it
// would almost always land slightly *after* the very candle that just produced this
// signal (that candle was already fetched and read before this call ran), excluding it
// from the scan and delaying a genuine same-candle fill by a full tick. Defaults to
// Date.now() so existing direct callers/tests that don't pass it keep working.
export function recordSignals(records, symbolKey, tf, signals, currentPrice, currentTime = Date.now()) {
  const updated = []
  const invalidated = []

  // A 'pending' (still unfilled) record whose key+price no longer matches any of this
  // tick's fresh signals had its level either fully invalidated or replaced by a
  // different pivot at a materially different price — either way the order it
  // represented never filled and never will, so it's discarded rather than left
  // stuck as pending forever. `signal.threshold` (the level's own breakout threshold)
  // is the tolerance for "still the same pivot, just recalculated slightly".
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.symbolKey !== symbolKey || r.tf !== tf || r.status !== 'pending') continue
    const match = signals.find(
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
    //
    // A second real production bug this guard used to cause: it had no upper bound, so
    // a price that blew straight through entry AND kept going past SL — without ever
    // closing back on the favorable side (evaluateSignals' own fill requirement, see
    // its comment) — stayed "already filled" forever, since currentPrice remains on the
    // entry side of a falling/rising market indefinitely. evaluateSignals never fills
    // it (no confirmed retest close) and this guard never lets go of it either: a stale
    // pending order sits in the track record permanently, quoting an entry the market
    // left behind bars ago. Once price has also passed the record's own SL without ever
    // confirming a fill, the order is unambiguously dead — same as if it had simply
    // never triggered — so the guard now stops protecting it there.
    const isBuy = r.direction === 'buy'
    const alreadyFilled =
      currentPrice != null &&
      (isBuy ? currentPrice <= r.entry && currentPrice > r.sl : currentPrice >= r.entry && currentPrice < r.sl)
    if (!match && !alreadyFilled) {
      invalidated.push(r)
      records.splice(i, 1)
      continue
    }
    // Still just a projection of an order that hasn't triggered yet — not a locked-in
    // position — so keep its entry/SL/TP synced to the latest recalculation instead of
    // freezing it at whatever the first tick happened to see. Once it fills (status
    // flips to 'running' via evaluateSignals), this loop's own `r.status !== 'pending'`
    // guard above means it's never touched again: a live position's risk shouldn't
    // silently move around underneath it.
    if (match) {
      const changed = r.entry !== match.entry || r.sl !== match.sl || JSON.stringify(r.tp) !== JSON.stringify(match.tp)
      r.entry = match.entry
      r.sl = match.sl
      r.tp = match.tp
      r.threshold = match.threshold
      if (changed) updated.push(r)
    }
  }

  const openKeys = new Set(records.filter(isOpen).map((r) => r.key))
  const added = []

  for (const signal of signals) {
    const key = keyFor(symbolKey, tf, signal)
    if (openKeys.has(key)) continue
    // trendAligned (see buildSignals in srDetector.js) only gates *opening a brand-new*
    // record — an already-open one is kept alive regardless (the `openKeys.has` guard
    // above already returned before reaching here for those). This is intentionally
    // NOT applied to the stale-pending-drop loop above: dropping this check there
    // instead would mean an already-open pending record gets silently dropped the
    // moment trend flips against it, then recreated as a "new" signal the next time
    // trend flips back — exactly the repeated-near-duplicate-post bug this fixes.
    if (signal.trendAligned === false) continue
    const record = {
      key,
      symbolKey,
      tf,
      category: signal.category,
      // 'Strong' (Golden/Diamond Zone) or 'Medium' — captured at signal-creation time
      // (see annotateGoldenZones/buildSignals in srDetector.js) so the per-strength
      // breakdown below can compare reliability without re-deriving it later, after the
      // zone that produced it may no longer even exist. Records from before this field
      // existed simply have it undefined — getBreakdown excludes those from the
      // strength breakdown rather than guessing.
      strengthLabel: signal.strengthLabel,
      direction: signal.direction,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      // A real pre-existing gap this uncovered: previously only ever set on a later
      // sync tick (see `r.threshold = match.threshold` above), never at creation — a
      // record that filled on its very first tick could reach evaluateSignals with no
      // threshold at all, silently skipping the oversized-candle fill check below
      // (which backs its effective ATR out of this field) for exactly the trades most
      // likely to need it.
      threshold: signal.threshold,
      openedAt: currentTime,
      status: 'pending',
    }
    records.push(record)
    added.push(record)
  }

  return { added, updated, invalidated }
}

// Advances every open record for this symbol: fills a 'pending' limit order once price
// reaches its entry *and* the same candle closes back confirming the retest held (see
// FILL_CANDLE_SKIP_ATR_MULT above), then (whether just filled or already running)
// closes it out as a 'win' or 'loss' once price plausibly hits its first take-profit or
// its stop-loss. Mutates `records` in place; returns `{ filled, closed }` — the records
// that changed state this call, e.g. so a caller can notify about them. A record that
// fills AND closes within the same call (a fast move a coarse ~15-minute poll can't see
// the middle of) only appears in `closed`, not `filled` — a "filled" notification would
// be redundant noise immediately followed by the close.
//
// `candles` is the price series (ascending by time, full OHLC) fill/SL/TP are checked
// against — NOT just the latest close. A real production bug: checking only the most
// recent close price meant a genuine TP touch (S/R levels are "wick and reverse" points
// almost by definition — price touches, then reverses) went completely undetected
// whenever price had already moved back past SL by the time the next ~15-minute poll
// ran, mis-recording a real win as a loss. Every candle since the record's own
// openedAt/filledAt is scanned (not just the latest one) so a gap of more than one poll
// — a skipped cron tick, a slow run — still can't hide a touch that happened in between.
//
// SL/TP themselves are still checked against a bare intrabar touch, deliberately not
// close-confirmed the way the fill above is: once actually in a trade, a real stop/limit
// order fires the instant price trades there regardless of where that candle later
// closes. Only the *entry* is a discretionary "did the retest actually hold" decision.
export function evaluateSignals(records, symbolKey, candles) {
  if (!candles?.length) return { filled: [], closed: [] }
  const filled = []
  const closed = []

  for (const r of records) {
    if (r.symbolKey !== symbolKey || !isOpen(r)) continue
    const isBuy = r.direction === 'buy'

    // A still-pending order can't have filled on a candle from before it even existed;
    // a running position's SL/TP can't have been touched before its own fill.
    const sinceMs = r.status === 'pending' ? r.openedAt : r.filledAt
    const relevant = candles.filter((c) => c.time >= sinceMs)

    let searchFrom = 0
    let justFilled = false

    if (r.status === 'pending') {
      // effectiveAtr backs out of the level's own stored threshold (= atr *
      // BREAKOUT_ATR_MULT, see srDetector.js) rather than needing the raw ATR passed
      // through separately. Missing on very old records (from before `threshold` was
      // recorded) — the oversized-candle check below simply doesn't apply to those.
      const effectiveAtr = r.threshold ? r.threshold / BREAKOUT_ATR_MULT : null
      const fillIndex = relevant.findIndex((c) => {
        // A fade-the-level limit order: buy fills once price *trades* at or through
        // entry (candle low reaches it), sell fills once price trades up to it (candle
        // high reaches it).
        const touched = isBuy ? c.low <= r.entry : c.high >= r.entry
        if (!touched) return false
        // Skip a candle that's already an outsized volatility spike relative to this
        // level's own ATR — a violent move already in progress, not a controlled retest
        // touch (see FILL_CANDLE_SKIP_ATR_MULT above). Wait for a calmer candle instead.
        if (effectiveAtr && c.high - c.low > effectiveAtr * FILL_CANDLE_SKIP_ATR_MULT) return false
        // A bare touch isn't enough — require this same candle to also *close* back on
        // the favorable side of entry, confirming the retest actually held (support
        // bought back up, resistance sold back down) rather than just wicking through.
        return isBuy ? c.close >= r.entry : c.close <= r.entry
      })
      if (fillIndex === -1) continue
      r.status = 'running'
      r.filledAt = relevant[fillIndex].time
      justFilled = true
      // Starts checking SL/TP from the *next* candle, not this one: the confirming
      // candle's own already-past range isn't live risk — a discretionary trader only
      // actually enters once it closes, so its intrabar action before that close
      // couldn't have stopped a position out that didn't exist yet.
      searchFrom = fillIndex + 1
    }

    // Scan forward from the fill (or from the start of `relevant` if already running)
    // for the first candle whose actual high/low range touches SL or TP — stops at the
    // first one found, since the position is closed from that point on and anything
    // later in the series no longer applies to it.
    for (let i = searchFrom; i < relevant.length; i++) {
      const c = relevant[i]
      const hitSl = isBuy ? c.low <= r.sl : c.high >= r.sl

      // Find the farthest TP this single candle's own range reached, not just the
      // first — a fast candle can blow through more than one target, so a win gets
      // credit for whichever level it actually reached.
      let hitTpIndex = -1
      for (let j = 0; j < r.tp.length; j++) {
        const reached = isBuy ? c.high >= r.tp[j].price : c.low <= r.tp[j].price
        if (reached) hitTpIndex = j
      }

      // Checked in this order so a single candle whose range plausibly covers both
      // (an unusually large-range candle) is scored as a loss rather than assuming the
      // better outcome — same conservative tie-break as before, just per-candle now
      // instead of per-poll.
      if (hitSl) {
        r.status = 'loss'
        r.closedAt = c.time
        r.exitPrice = r.sl
        closed.push(r)
        break
      } else if (hitTpIndex >= 0) {
        r.status = 'win'
        r.closedAt = c.time
        r.exitPrice = r.tp[hitTpIndex].price
        r.hitTpIndex = hitTpIndex
        closed.push(r)
        break
      }
    }

    if (justFilled && r.status === 'running') filled.push(r)
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

// Cumulative P&L over time, one point per closed (win/loss) trade, oldest first — the
// data behind the track record modal's equity-curve chart (the one visual trend view;
// getStats above is just a static snapshot). `value` is in pips for a symbol with a pip
// convention (XAUUSD), a raw $ amount otherwise (BTCUSD) — same convention as
// favorableMove/formatMove elsewhere in this file.
export function getEquityCurve(records, symbolKey, tf) {
  const pipSize = PIP_SIZES[symbolKey]
  const list = getHistory(records, symbolKey, tf)
    .filter((r) => r.status === 'win' || r.status === 'loss')
    .sort((a, b) => a.closedAt - b.closedAt)
  let cumulative = 0
  return list.map((r) => {
    cumulative += favorableMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy')
    return { time: r.closedAt, value: cumulative }
  })
}

// Shared grouping helper for getBreakdown below — buckets closed records by whatever
// `keyFn` returns, skipping a record entirely if it returns null/undefined (a group we
// have no real label for, rather than lumping those into a misleading "Unknown" entry).
function groupWinRate(list, keyFn) {
  const groups = new Map()
  for (const r of list) {
    const key = keyFn(r)
    if (key == null) continue
    if (!groups.has(key)) groups.set(key, { key, wins: 0, losses: 0 })
    const g = groups.get(key)
    if (r.status === 'win') g.wins += 1
    else g.losses += 1
  }
  return [...groups.values()]
    .map((g) => ({ ...g, total: g.wins + g.losses, winRate: Math.round((g.wins / (g.wins + g.losses)) * 100) }))
    .sort((a, b) => b.total - a.total)
}

// Win-rate breakdown by zone category (Support/Resistance/SBR/RBS) and by zone strength
// (Strong = Golden/Diamond Zone, Medium = everything else) — surfaces which *kind* of
// setup is actually reliable, rather than only ever seeing one aggregate win rate (see
// getStats). Only closed (win/loss) records count; pending/running have no result yet.
export function getBreakdown(records, symbolKey, tf) {
  const list = getHistory(records, symbolKey, tf).filter((r) => r.status === 'win' || r.status === 'loss')
  return {
    byCategory: groupWinRate(list, (r) => r.category),
    // strengthLabel is only present on records opened after that field was added (see
    // recordSignals) — older records are silently excluded here, not miscounted.
    byStrength: groupWinRate(list, (r) => r.strengthLabel ?? null),
  }
}

// A field containing a comma, quote, or newline must be quoted (with internal quotes
// doubled) per the CSV convention — none of our own fields are ever expected to
// actually contain one, but escaping unconditionally is one line and never wrong.
function csvField(value) {
  const str = String(value ?? '')
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

// Builds a CSV export of one symbol's track record for offline analysis (Excel/Sheets)
// — every non-pending record (pending/unfilled orders aren't "trades" yet, same filter
// the history modal itself uses), most-recent-first. Pure string building — the actual
// download (Blob + object URL) is a browser concern, left to the caller (main.js).
export function buildHistoryCsv(records, symbolKey) {
  const pipSize = PIP_SIZES[symbolKey]
  const list = getHistory(records, symbolKey).filter((r) => r.status !== 'pending')
  const header = [
    'Opened',
    'Filled',
    'Closed',
    'Timeframe',
    'Category',
    'Strength',
    'Direction',
    'Entry',
    'SL',
    'TP',
    'Status',
    'Exit Price',
    'Result',
  ]
  const rows = list.map((r) => [
    new Date(r.openedAt).toISOString(),
    r.filledAt ? new Date(r.filledAt).toISOString() : '',
    r.closedAt ? new Date(r.closedAt).toISOString() : '',
    r.tf,
    r.category,
    r.strengthLabel ?? '',
    r.direction === 'buy' ? 'BUY' : 'SELL',
    formatPrice(r.entry),
    formatPrice(r.sl),
    r.tp.map((t) => formatPrice(t.price)).join(';'),
    r.status,
    r.exitPrice != null ? formatPrice(r.exitPrice) : '',
    r.exitPrice != null ? formatMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy') : '',
  ])
  return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\n')
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
