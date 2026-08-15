import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  keyFor,
  recordSignals,
  evaluateSignals,
  trimRecords,
  getHistory,
  getStats,
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
    const added = recordSignals(history, 'XAUUSD', 'H1', [buySignal()])
    assert.equal(added.length, 1)
    assert.equal(history.length, 1)
    assert.equal(history[0].status, 'pending')
    assert.equal(history[0].key, 'XAUUSD-H1-Support-buy')
  })

  await t.test('does not duplicate an already-open signal on the next tick', () => {
    const history = []
    recordSignals(history, 'XAUUSD', 'H1', [buySignal()])
    const added = recordSignals(history, 'XAUUSD', 'H1', [buySignal({ entry: 101 })]) // slight recalculation drift
    assert.equal(added.length, 0, 'no new record should be added')
    assert.equal(history.length, 1)
    assert.equal(history[0].entry, 100, 'the original open record keeps its own entry, unmodified')
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
    assert.equal(formatMove(PIP_SIZES.BTCUSD, 65000, 66200, true), '+1200.00')
    assert.equal(PIP_SIZES.BTCUSD, null)
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
