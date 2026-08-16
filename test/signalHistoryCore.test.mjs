import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  keyFor,
  recordSignals,
  evaluateSignals,
  trimRecords,
  getHistory,
  getClosedBetween,
  getStats,
  getBreakdown,
  buildHistoryCsv,
  getEquityCurve,
  favorableMove,
  formatAmount,
  formatMove,
  formatPrice,
  PIP_SIZES,
  MAX_RECORDS,
} from '../src/lib/signalHistoryCore.js'

function buySignal(overrides) {
  return {
    category: 'Support',
    direction: 'buy',
    entry: 100,
    sl: 95,
    tp: [{ price: 110, rr: 2 }],
    threshold: 2,
    ...overrides,
  }
}

test('keyFor', () => {
  assert.equal(keyFor('XAUUSD', 'H1', { category: 'Support', direction: 'buy' }), 'XAUUSD-H1-Support-buy')
})

test('recordSignals', async (t) => {
  await t.test('opens a fresh pending row for a brand-new signal', () => {
    const history = []
    const { added } = recordSignals(history, 'XAUUSD', 'H1', [buySignal()])
    assert.equal(added.length, 1)
    assert.equal(history.length, 1)
    assert.equal(history[0].status, 'pending')
    assert.equal(history[0].key, 'XAUUSD-H1-Support-buy')
  })

  await t.test('captures the signal\'s strengthLabel onto the new record, for the win-rate-by-strength breakdown', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ strengthLabel: 'Strong' })])
    assert.equal(history[0].strengthLabel, 'Strong')
  })

  await t.test('does not duplicate an already-open signal on the next tick, but syncs its entry/SL/TP to the recalculation', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal()])
    const { added, updated } = recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 101 })]) // slight recalculation drift
    assert.equal(added.length, 0, 'no new record should be added')
    assert.equal(history.length, 1)
    assert.equal(history[0].entry, 101, 'still just an unfilled projection — synced to the freshest recalculation')
    assert.equal(updated.length, 1, 'reported as updated so the caller can edit its Telegram post')
    assert.equal(updated[0], history[0])
  })

  await t.test('does not report an update when nothing about the signal actually changed', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal()])
    const { updated } = recordSignals(history, 'XAUUSD', 'H1', [buySignal()]) // identical signal, same tick shape
    assert.equal(updated.length, 0)
  })

  await t.test('stops syncing once the record fills — a live position\'s risk stays fixed', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal()])
    evaluateSignals(history, 'XAUUSD', 100) // fills it -> running
    const { updated } = recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 101, sl: 90 })])
    assert.equal(updated.length, 0, 'a running record is never among the updated ones')
    assert.equal(history[0].entry, 100, 'its entry/SL stay exactly what they were at fill time')
    assert.equal(history[0].sl, 95)
  })

  await t.test('drops a still-pending signal whose level got replaced by a materially different pivot', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 100, threshold: 2 })])
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 80, threshold: 2 })]) // way outside tolerance
    assert.equal(history.length, 1)
    assert.equal(history[0].entry, 80, 'old one discarded, new one opened in its place')
  })

  await t.test('drops a still-pending signal whose category vanished entirely', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal()])
    recordSignals(history, 'XAUUSD', 'H1', [])
    assert.deepEqual(history, [])
  })

  await t.test('never drops a running (already-filled) record this way', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal()])
    evaluateSignals(history, 'XAUUSD', 100) // fills it -> running
    assert.equal(history[0].status, 'running')
    recordSignals(history, 'XAUUSD', 'H1', []) // category vanishes entirely
    assert.equal(history.length, 1)
    assert.equal(history[0].status, 'running', 'running records survive even when the signal disappears')
  })

  await t.test('a category change (e.g. Support -> RBS) opens a fresh row instead of reusing the old one', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ category: 'Support' })])
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ category: 'RBS', entry: 100 })])
    assert.equal(history.length, 1)
    assert.equal(history[0].category, 'RBS')
  })

  await t.test('a fresh signal missing threshold gets infinite drift tolerance — never dropped as stale on price alone', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 100 })])
    // No `threshold` on this tick's signal — `s.threshold ?? Infinity` means *any*
    // entry, however far the pivot recalculated, still counts as "the same" pivot (and,
    // same as any other still-pending match, gets synced to it).
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 100000, threshold: undefined })])
    assert.equal(history.length, 1, 'still recognized as the same still-current signal, not dropped')
    assert.equal(history[0].entry, 100000, 'synced to the (however extreme) recalculation, same as any other pending match')
  })

  await t.test('does not drop a pending record whose own entry currentPrice already shows was reached, even if its level vanished', () => {
    // Reproduces a real production bug: a SELL entry sits right at a resistance level,
    // so price reaching that entry (rallying up to it) and price breaking that same
    // resistance (which flips its category next tick, e.g. to RBS) are, right at the
    // fill point, often the very same candle — without this guard the pending record
    // would be dropped here before evaluateSignals ever got a chance to mark it filled.
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [
      { category: 'Resistance', direction: 'sell', entry: 100, sl: 105, tp: [], threshold: 2 },
    ])
    // This tick's fresh signals no longer include a Resistance near 100 at all (the
    // level broke) — normally this would drop the pending record.
    recordSignals(history, 'XAUUSD', 'H1', [], 100) // currentPrice has reached the sell's entry
    assert.equal(history.length, 1, 'kept alive since currentPrice shows it already reached its entry')
    assert.equal(history[0].status, 'pending', 'still pending — promoting it is evaluateSignals\' job, not recordSignals\'')
  })

  await t.test('still drops a pending record whose level vanished AND currentPrice has not reached its entry', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [
      { category: 'Resistance', direction: 'sell', entry: 100, sl: 105, tp: [], threshold: 2 },
    ])
    recordSignals(history, 'XAUUSD', 'H1', [], 90) // level gone, price nowhere near the entry
    assert.deepEqual(history, [])
  })

  await t.test('the currentPrice guard is opt-in — omitting it behaves exactly as before (drops on any level change)', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [
      { category: 'Resistance', direction: 'sell', entry: 100, sl: 105, tp: [], threshold: 2 },
    ])
    recordSignals(history, 'XAUUSD', 'H1', []) // no currentPrice passed at all
    assert.deepEqual(history, [])
  })
})

test('evaluateSignals', async (t) => {
  await t.test('returns empty result and changes nothing when currentPrice is null', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal()])
    const result = evaluateSignals(history, 'XAUUSD', null)
    assert.deepEqual(result, { filled: [], closed: [] })
    assert.equal(history[0].status, 'pending')
  })

  await t.test('a buy fills when price drops to or below entry', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 100 })])
    let result = evaluateSignals(history, 'XAUUSD', 105)
    assert.equal(history[0].status, 'pending', 'not filled yet — price is still above entry')
    assert.equal(result.filled.length, 0)

    result = evaluateSignals(history, 'XAUUSD', 100)
    assert.equal(history[0].status, 'running')
    assert.equal(result.filled.length, 1)
  })

  await t.test('a sell fills when price rises to or above entry', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [
      { category: 'Resistance', direction: 'sell', entry: 100, sl: 105, tp: [{ price: 90, rr: 2 }], threshold: 2 },
    ])
    evaluateSignals(history, 'XAUUSD', 95)
    assert.equal(history[0].status, 'pending')
    evaluateSignals(history, 'XAUUSD', 100)
    assert.equal(history[0].status, 'running')
  })

  await t.test('closes as a loss when price hits SL', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 100, sl: 95 })])
    evaluateSignals(history, 'XAUUSD', 100) // fill
    const { closed } = evaluateSignals(history, 'XAUUSD', 94)
    assert.equal(closed.length, 1)
    assert.equal(history[0].status, 'loss')
    assert.equal(history[0].exitPrice, 94)
  })

  await t.test('closes as a win at the farthest TP already reached, not just the first', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [
      buySignal({
        entry: 100,
        sl: 95,
        tp: [
          { price: 110, rr: 2 },
          { price: 120, rr: 4 },
        ],
      }),
    ])
    evaluateSignals(history, 'XAUUSD', 100) // fill
    const { closed } = evaluateSignals(history, 'XAUUSD', 125) // blew straight through both targets
    assert.equal(closed.length, 1)
    assert.equal(history[0].status, 'win')
    assert.equal(history[0].hitTpIndex, 1, 'credited with TP2, the farthest one reached')
  })

  await t.test('a fill-and-close within the same tick reports only as closed, not also as filled', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 100, sl: 95 })])
    // Price gaps straight down through entry AND stop-loss in one poll.
    const result = evaluateSignals(history, 'XAUUSD', 94)
    assert.equal(result.filled.length, 0, 'no separate fill notification for a trade that already closed')
    assert.equal(result.closed.length, 1)
    assert.equal(history[0].status, 'loss')
  })

  await t.test('a closed record is never re-evaluated', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 100, sl: 95 })])
    evaluateSignals(history, 'XAUUSD', 100)
    evaluateSignals(history, 'XAUUSD', 94) // -> loss
    const result = evaluateSignals(history, 'XAUUSD', 200) // would "win" if still open
    assert.equal(result.filled.length, 0)
    assert.equal(result.closed.length, 0)
    assert.equal(history[0].status, 'loss')
  })

  await t.test('only evaluates records for the given symbol', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 100 })])
    recordSignals(history, 'BTCUSD', 'H1', [buySignal({ entry: 100 })])
    evaluateSignals(history, 'XAUUSD', 100)
    assert.equal(history.find((r) => r.symbolKey === 'XAUUSD').status, 'running')
    assert.equal(history.find((r) => r.symbolKey === 'BTCUSD').status, 'pending')
  })
})

test('trimRecords', async (t) => {
  await t.test('caps a single symbol at MAX_RECORDS, oldest first', () => {
    const history = Array.from({ length: MAX_RECORDS + 10 }, (_, i) => ({ key: `k${i}`, symbolKey: 'XAUUSD', openedAt: i }))
    const trimmed = trimRecords(history)
    assert.equal(trimmed.length, MAX_RECORDS)
    assert.equal(trimmed[0].key, 'k10', 'the oldest 10 were dropped')
  })

  await t.test('caps each symbol independently — a busy symbol cannot crowd out a quiet one', () => {
    const busy = Array.from({ length: MAX_RECORDS + 10 }, (_, i) => ({ key: `busy${i}`, symbolKey: 'XAUUSD', openedAt: i }))
    const quiet = Array.from({ length: 5 }, (_, i) => ({ key: `quiet${i}`, symbolKey: 'BTCUSD', openedAt: i }))
    const trimmed = trimRecords([...busy, ...quiet])
    assert.equal(trimmed.filter((r) => r.symbolKey === 'XAUUSD').length, MAX_RECORDS)
    assert.equal(trimmed.filter((r) => r.symbolKey === 'BTCUSD').length, 5, 'none of the quiet symbol dropped')
  })

  await t.test('returns records sorted oldest-first overall, symbols interleaved', () => {
    const records = [
      { key: 'a', symbolKey: 'XAUUSD', openedAt: 3 },
      { key: 'b', symbolKey: 'BTCUSD', openedAt: 1 },
      { key: 'c', symbolKey: 'XAUUSD', openedAt: 2 },
    ]
    const trimmed = trimRecords(records)
    assert.deepEqual(trimmed.map((r) => r.key), ['b', 'c', 'a'])
  })
})

test('getHistory / getStats', async (t) => {
  await t.test('filters by symbol and sorts newest-first', () => {
    const history = [
      { symbolKey: 'XAUUSD', openedAt: 1, status: 'win' },
      { symbolKey: 'BTCUSD', openedAt: 2, status: 'win' },
      { symbolKey: 'XAUUSD', openedAt: 3, status: 'loss' },
    ]
    const result = getHistory(history, 'XAUUSD')
    assert.equal(result.length, 2)
    assert.equal(result[0].openedAt, 3, 'newest first')
  })

  await t.test('computes win rate only over closed (win+loss) trades', () => {
    const history = [
      { symbolKey: 'XAUUSD', openedAt: 1, status: 'win' },
      { symbolKey: 'XAUUSD', openedAt: 2, status: 'loss' },
      { symbolKey: 'XAUUSD', openedAt: 3, status: 'pending' },
      { symbolKey: 'XAUUSD', openedAt: 4, status: 'running' },
    ]
    const stats = getStats(history, 'XAUUSD')
    assert.equal(stats.total, 4)
    assert.equal(stats.wins, 1)
    assert.equal(stats.losses, 1)
    assert.equal(stats.pending, 1)
    assert.equal(stats.running, 1)
    assert.equal(stats.winRate, 50)
  })

  await t.test('win rate is null when nothing has closed yet', () => {
    const stats = getStats([{ symbolKey: 'XAUUSD', openedAt: 1, status: 'pending' }], 'XAUUSD')
    assert.equal(stats.winRate, null)
  })

  await t.test('an optional tf filters down to just that timeframe', () => {
    const history = [
      { symbolKey: 'XAUUSD', tf: 'H1', openedAt: 1, status: 'win' },
      { symbolKey: 'XAUUSD', tf: 'H4', openedAt: 2, status: 'loss' },
      { symbolKey: 'XAUUSD', tf: 'D1', openedAt: 3, status: 'win' },
    ]
    assert.equal(getHistory(history, 'XAUUSD', 'H1').length, 1)
    assert.equal(getHistory(history, 'XAUUSD', 'H1')[0].tf, 'H1')

    const h1Stats = getStats(history, 'XAUUSD', 'H1')
    assert.equal(h1Stats.total, 1)
    assert.equal(h1Stats.winRate, 100)
  })

  await t.test('omitting tf (or passing "ALL") combines every timeframe, matching the pre-filter default', () => {
    const history = [
      { symbolKey: 'XAUUSD', tf: 'H1', openedAt: 1, status: 'win' },
      { symbolKey: 'XAUUSD', tf: 'H4', openedAt: 2, status: 'loss' },
    ]
    assert.equal(getHistory(history, 'XAUUSD').length, 2)
    assert.equal(getHistory(history, 'XAUUSD', 'ALL').length, 2)
    assert.equal(getStats(history, 'XAUUSD').total, 2)
  })
})

test('getClosedBetween', async (t) => {
  await t.test('only returns win/loss records with closedAt inside [start, end)', () => {
    const history = [
      { symbolKey: 'XAUUSD', tf: 'H1', status: 'win', closedAt: 100 },
      { symbolKey: 'XAUUSD', tf: 'H1', status: 'loss', closedAt: 150 },
      { symbolKey: 'XAUUSD', tf: 'H1', status: 'win', closedAt: 200 }, // outside the end (exclusive)
      { symbolKey: 'XAUUSD', tf: 'H1', status: 'running', closedAt: undefined },
      { symbolKey: 'XAUUSD', tf: 'H1', status: 'pending', closedAt: undefined },
    ]
    const result = getClosedBetween(history, 'XAUUSD', 'H1', 100, 200)
    assert.equal(result.length, 2)
    assert.deepEqual(
      result.map((r) => r.closedAt),
      [100, 150]
    )
  })

  await t.test('sorts oldest-first, unlike getHistory', () => {
    const history = [
      { symbolKey: 'XAUUSD', tf: 'H1', status: 'win', closedAt: 300 },
      { symbolKey: 'XAUUSD', tf: 'H1', status: 'loss', closedAt: 100 },
    ]
    const result = getClosedBetween(history, 'XAUUSD', 'H1', 0, 1000)
    assert.deepEqual(
      result.map((r) => r.closedAt),
      [100, 300]
    )
  })

  await t.test('filters by symbol and tf like getHistory', () => {
    const history = [
      { symbolKey: 'XAUUSD', tf: 'H1', status: 'win', closedAt: 100 },
      { symbolKey: 'BTCUSD', tf: 'H1', status: 'win', closedAt: 100 },
      { symbolKey: 'XAUUSD', tf: 'H4', status: 'win', closedAt: 100 },
    ]
    assert.equal(getClosedBetween(history, 'XAUUSD', 'H1', 0, 1000).length, 1)
  })
})

function closedRecord(overrides) {
  return {
    symbolKey: 'XAUUSD',
    tf: 'H1',
    category: 'Support',
    strengthLabel: 'Medium',
    direction: 'buy',
    entry: 100,
    sl: 95,
    tp: [{ price: 110, rr: 2 }],
    openedAt: 0,
    filledAt: 0,
    status: 'win',
    exitPrice: 110,
    hitTpIndex: 0,
    closedAt: 0,
    ...overrides,
  }
}

test('getBreakdown', async (t) => {
  await t.test('groups win/loss by category, with a win rate per group', () => {
    const history = [
      closedRecord({ category: 'Support', status: 'win' }),
      closedRecord({ category: 'Support', status: 'win' }),
      closedRecord({ category: 'Support', status: 'loss' }),
      closedRecord({ category: 'Resistance', status: 'loss' }),
    ]
    const { byCategory } = getBreakdown(history, 'XAUUSD')
    const support = byCategory.find((g) => g.key === 'Support')
    const resistance = byCategory.find((g) => g.key === 'Resistance')
    assert.deepEqual(support, { key: 'Support', wins: 2, losses: 1, total: 3, winRate: 67 })
    assert.deepEqual(resistance, { key: 'Resistance', wins: 0, losses: 1, total: 1, winRate: 0 })
  })

  await t.test('sorts groups by total closed trades, most first', () => {
    const history = [
      closedRecord({ category: 'RBS', status: 'win' }),
      closedRecord({ category: 'Support', status: 'win' }),
      closedRecord({ category: 'Support', status: 'loss' }),
    ]
    const { byCategory } = getBreakdown(history, 'XAUUSD')
    assert.deepEqual(byCategory.map((g) => g.key), ['Support', 'RBS'])
  })

  await t.test('groups win/loss by strength label (Strong = Golden/Diamond Zone, Medium = everything else)', () => {
    const history = [
      closedRecord({ strengthLabel: 'Strong', status: 'win' }),
      closedRecord({ strengthLabel: 'Strong', status: 'win' }),
      closedRecord({ strengthLabel: 'Medium', status: 'loss' }),
    ]
    const { byStrength } = getBreakdown(history, 'XAUUSD')
    const strong = byStrength.find((g) => g.key === 'Strong')
    assert.equal(strong.winRate, 100)
    assert.equal(strong.total, 2)
  })

  await t.test('excludes records with no strengthLabel from the strength breakdown, without miscounting them as a group', () => {
    const history = [
      closedRecord({ strengthLabel: undefined, status: 'win' }),
      closedRecord({ strengthLabel: 'Strong', status: 'win' }),
    ]
    const { byStrength, byCategory } = getBreakdown(history, 'XAUUSD')
    assert.equal(byStrength.reduce((sum, g) => sum + g.total, 0), 1, 'only the Strong-labeled record counts')
    assert.equal(byCategory[0].total, 2, 'category breakdown is unaffected — every record has a category')
  })

  await t.test('ignores pending/running records — only closed trades have a result to break down', () => {
    const history = [closedRecord({ status: 'pending' }), closedRecord({ status: 'running' })]
    const { byCategory, byStrength } = getBreakdown(history, 'XAUUSD')
    assert.deepEqual(byCategory, [])
    assert.deepEqual(byStrength, [])
  })

  await t.test('filters by symbol and (optional) timeframe like getHistory/getStats', () => {
    const history = [closedRecord({ symbolKey: 'XAUUSD' }), closedRecord({ symbolKey: 'BTCUSD' })]
    const { byCategory } = getBreakdown(history, 'XAUUSD')
    assert.equal(byCategory[0].total, 1)
  })
})

test('getEquityCurve', async (t) => {
  await t.test('one point per closed trade, oldest first, value is the running cumulative total', () => {
    const history = [
      closedRecord({ closedAt: 300, entry: 100, exitPrice: 110 }), // +100 pips (0.1 pip size), out of order on purpose
      closedRecord({ closedAt: 100, entry: 100, exitPrice: 105 }), // +50 pips
      closedRecord({ closedAt: 200, status: 'loss', entry: 100, exitPrice: 98 }), // -20 pips
    ]
    const curve = getEquityCurve(history, 'XAUUSD')
    assert.deepEqual(
      curve.map((p) => [p.time, p.value]),
      [
        [100, 50],
        [200, 30],
        [300, 130],
      ]
    )
  })

  await t.test('ignores pending/running records — no exit price to include yet', () => {
    const history = [closedRecord({ status: 'pending', closedAt: undefined }), closedRecord({ status: 'running', closedAt: undefined })]
    assert.deepEqual(getEquityCurve(history, 'XAUUSD'), [])
  })

  await t.test('BTCUSD accumulates in raw $, not pips', () => {
    const history = [
      closedRecord({ symbolKey: 'BTCUSD', closedAt: 100, entry: 65000, exitPrice: 66200 }),
      closedRecord({ symbolKey: 'BTCUSD', closedAt: 200, status: 'loss', entry: 65000, exitPrice: 64800 }),
    ]
    const curve = getEquityCurve(history, 'BTCUSD')
    assert.deepEqual(
      curve.map((p) => p.value),
      [1200, 1000]
    )
  })

  await t.test('filters by symbol and (optional) timeframe like getHistory', () => {
    const history = [closedRecord({ symbolKey: 'XAUUSD', tf: 'H1' }), closedRecord({ symbolKey: 'XAUUSD', tf: 'H4' })]
    assert.equal(getEquityCurve(history, 'XAUUSD', 'H1').length, 1)
  })

  await t.test('an empty history returns an empty curve, not a throw', () => {
    assert.deepEqual(getEquityCurve([], 'XAUUSD'), [])
  })
})

test('buildHistoryCsv', async (t) => {
  await t.test('header row lists every column', () => {
    const csv = buildHistoryCsv([], 'XAUUSD')
    assert.equal(csv, 'Opened,Filled,Closed,Timeframe,Category,Strength,Direction,Entry,SL,TP,Status,Exit Price,Result')
  })

  await t.test('one data row per non-pending record, most recent first', () => {
    const history = [
      closedRecord({ openedAt: 1000, filledAt: 2000, closedAt: 3000, status: 'win', entry: 4300, exitPrice: 4320, hitTpIndex: 0 }),
      closedRecord({ openedAt: 500, status: 'pending', filledAt: 0, closedAt: 0 }),
    ]
    const csv = buildHistoryCsv(history, 'XAUUSD')
    const lines = csv.split('\n')
    assert.equal(lines.length, 2, 'header + 1 row — the pending record is excluded')
    assert.match(
      lines[1],
      /^\d{4}-\d\d-\d\dT.*Z,\d{4}-\d\d-\d\dT.*Z,\d{4}-\d\d-\d\dT.*Z,H1,Support,Medium,BUY,4300,95,110,win,4320,\+200 pips$/
    )
  })

  await t.test('a still-open (running) record has no Closed/Exit Price/Result, but is still included', () => {
    const history = [closedRecord({ status: 'running', closedAt: undefined, exitPrice: undefined, hitTpIndex: undefined })]
    const csv = buildHistoryCsv(history, 'XAUUSD')
    const [, row] = csv.split('\n')
    const cols = row.split(',')
    assert.equal(cols[2], '', 'Closed is blank')
    assert.equal(cols[10], 'running')
    assert.equal(cols[11], '', 'Exit Price is blank')
    assert.equal(cols[12], '', 'Result is blank')
  })

  await t.test('multiple TP levels are joined with ";" in one column', () => {
    const history = [closedRecord({ tp: [{ price: 110 }, { price: 120 }, { price: 130 }] })]
    const csv = buildHistoryCsv(history, 'XAUUSD')
    const [, row] = csv.split('\n')
    assert.match(row, /,110;120;130,/)
  })

  await t.test('a record with no strengthLabel leaves that column blank, not "undefined"', () => {
    const history = [closedRecord({ strengthLabel: undefined })]
    const csv = buildHistoryCsv(history, 'XAUUSD')
    const [, row] = csv.split('\n')
    assert.match(row, /,Support,,BUY,/)
  })

  await t.test('BTCUSD has no pip convention — Result is a raw $ amount', () => {
    const history = [closedRecord({ symbolKey: 'BTCUSD', entry: 65000, exitPrice: 66200 })]
    const csv = buildHistoryCsv(history, 'BTCUSD')
    const [, row] = csv.split('\n')
    assert.match(row, /\+1200$/)
  })
})

test('formatMove', async (t) => {
  await t.test('a buy win is reported as positive pips', () => {
    assert.equal(formatMove(PIP_SIZES.XAUUSD, 4381, 4387.75, true), '+68 pips')
  })

  await t.test('a buy loss is reported as negative pips', () => {
    assert.equal(formatMove(PIP_SIZES.XAUUSD, 4381, 4376.5, true), '-45 pips')
  })

  await t.test('a sell win flips the raw sign — price dropping is favorable for a sell', () => {
    assert.equal(formatMove(PIP_SIZES.XAUUSD, 4400, 4359, false), '+410 pips')
  })

  await t.test('a sell loss flips the raw sign the other way', () => {
    assert.equal(formatMove(PIP_SIZES.XAUUSD, 4400, 4403.5, false), '-35 pips')
  })

  await t.test('a symbol with no pip convention (e.g. crypto) shows the raw $ move instead', () => {
    assert.equal(formatMove(PIP_SIZES.BTCUSD, 65000, 66200, true), '+1200')
    assert.equal(PIP_SIZES.BTCUSD, null)
  })

  await t.test('a $ move keeps meaningful cents rather than always trimming to a whole number', () => {
    assert.equal(formatMove(PIP_SIZES.BTCUSD, 65000, 66200.5, true), '+1200.5')
    assert.equal(formatMove(PIP_SIZES.BTCUSD, 65000, 66200.25, true), '+1200.25')
  })
})

test('favorableMove / formatAmount', async (t) => {
  await t.test('favorableMove returns a raw pip count, not display text', () => {
    assert.equal(favorableMove(PIP_SIZES.XAUUSD, 4381, 4387.75, true), 68)
  })

  await t.test('favorableMove returns a raw, cents-rounded $ amount for a no-pip symbol', () => {
    assert.equal(favorableMove(PIP_SIZES.BTCUSD, 65000, 66200, true), 1200)
  })

  await t.test('favorableMove values sum cleanly — the daily/weekly report totals across many records this way', () => {
    const total = [
      favorableMove(PIP_SIZES.XAUUSD, 4381, 4387.75, true),
      favorableMove(PIP_SIZES.XAUUSD, 4400, 4403.5, false),
    ].reduce((a, b) => a + b, 0)
    assert.equal(total, 68 - 35)
  })

  await t.test('formatAmount formats a pip total the same way formatMove formats a single pip move', () => {
    assert.equal(formatAmount(PIP_SIZES.XAUUSD, 33), '+33 pips')
    assert.equal(formatAmount(PIP_SIZES.XAUUSD, -12), '-12 pips')
  })

  await t.test('formatAmount formats a $ total the same way formatMove formats a single $ move', () => {
    assert.equal(formatAmount(PIP_SIZES.BTCUSD, 1200), '+1200')
    assert.equal(formatAmount(PIP_SIZES.BTCUSD, -1200.5), '-1200.5')
  })
})

test('formatPrice', async (t) => {
  await t.test('drops a trailing .0 entirely', () => {
    assert.equal(formatPrice(4301.0), '4301')
    assert.equal(formatPrice(4301), '4301')
  })

  await t.test('keeps a genuine 1-decimal value', () => {
    assert.equal(formatPrice(4296.5), '4296.5')
  })

  await t.test('rounds anything beyond 1 decimal', () => {
    assert.equal(formatPrice(4307.75), '4307.8')
    assert.equal(formatPrice(4307.749999), '4307.7')
  })

  await t.test('works the same for large (crypto-scale) numbers', () => {
    assert.equal(formatPrice(63064.3), '63064.3')
    assert.equal(formatPrice(63064.0), '63064')
  })
})
