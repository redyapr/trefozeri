import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeWeeklyChartData, renderWeeklyPerformanceChart, renderWeeklyTradeLogCharts } from '../scripts/weeklyChart.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000

// Monday 00:00 WIB, 10 Aug 2026 — a fixed week so every test's expected day labels/dates
// are hand-verifiable rather than computed relative to "now".
const WEEK_START_MS = Date.UTC(2026, 7, 10) - WIB_OFFSET_MS

function makeDays() {
  return ['Mon 10', 'Tue 11', 'Wed 12', 'Thu 13', 'Fri 14', 'Sat 15', 'Sun 16'].map((label, i) => ({
    label,
    startMs: WEEK_START_MS + i * DAY_MS,
    endMs: WEEK_START_MS + (i + 1) * DAY_MS,
  }))
}

function closedRecord(overrides) {
  return {
    key: 'k',
    symbolKey: 'XAUUSD',
    tf: 'H1',
    category: 'Support',
    direction: 'buy',
    entry: 4300,
    sl: 4290,
    tp: [{ price: 4320, rr: 2 }],
    openedAt: 0,
    filledAt: 0,
    status: 'win',
    exitPrice: 4320,
    hitTpIndex: 0,
    closedAt: WEEK_START_MS + 10 * 3600000, // Monday, 10am WIB
    ...overrides,
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('computeWeeklyChartData', async (t) => {
  await t.test('an empty week: all-zero daily arrays, no trades, winRate null', () => {
    const data = computeWeeklyChartData([], makeDays())
    assert.deepEqual(data.xauDaily, [0, 0, 0, 0, 0, 0, 0])
    assert.deepEqual(data.btcDaily, [0, 0, 0, 0, 0, 0, 0])
    assert.equal(data.xauTotal, 0)
    assert.equal(data.btcTotal, 0)
    assert.deepEqual(data.trades, [])
    assert.equal(data.totalClosed, 0)
    assert.equal(data.wins, 0)
    assert.equal(data.losses, 0)
    assert.equal(data.winRate, null)
    assert.deepEqual(data.tpReachPct, [0, 0, 0])
  })

  await t.test('buckets a win into the right weekday and daily-net array, XAUUSD in pips', () => {
    const history = [closedRecord({ entry: 4300, exitPrice: 4312, direction: 'buy' })] // +120 pips, Monday
    const data = computeWeeklyChartData(history, makeDays())
    assert.deepEqual(data.xauDaily, [120, 0, 0, 0, 0, 0, 0])
    assert.equal(data.xauTotal, 120)
    assert.equal(data.trades.length, 1)
    assert.equal(data.trades[0].date, 'Mon 10')
    assert.equal(data.trades[0].type, 'BUY')
    assert.equal(data.trades[0].pair, 'XAUUSD')
    assert.equal(data.trades[0].hit, 'TP1')
    assert.equal(data.trades[0].plText, '+120 pips')
    assert.equal(data.trades[0].isWin, true)
  })

  await t.test('a loss shows hit "SL", hitTpIndex null, and a negative plText', () => {
    const history = [
      closedRecord({ direction: 'buy', entry: 4300, exitPrice: 4295.5, status: 'loss', exitPrice: 4295.5, hitTpIndex: undefined }),
    ]
    const data = computeWeeklyChartData(history, makeDays())
    assert.equal(data.trades[0].hit, 'SL')
    assert.equal(data.trades[0].hitTpIndex, null)
    assert.match(data.trades[0].plText, /^-/)
    assert.equal(data.trades[0].isWin, false)
  })

  await t.test('BTCUSD has no pip convention — plText is a raw $ amount, no "pips" suffix', () => {
    const history = [
      closedRecord({
        symbolKey: 'BTCUSD',
        direction: 'buy',
        entry: 62000,
        exitPrice: 62850,
        closedAt: WEEK_START_MS + 5 * DAY_MS + 10 * 3600000, // Saturday
      }),
    ]
    const data = computeWeeklyChartData(history, makeDays())
    assert.equal(data.trades[0].pair, 'BTCUSD')
    assert.equal(data.trades[0].plText, '+850')
    assert.deepEqual(data.btcDaily, [0, 0, 0, 0, 0, 850, 0])
  })

  await t.test('a sell flips the favorable-move sign correctly', () => {
    const history = [closedRecord({ direction: 'sell', entry: 4300, exitPrice: 4288 })] // price fell 120 -> a sell wins +120
    const data = computeWeeklyChartData(history, makeDays())
    assert.equal(data.trades[0].type, 'SELL')
    assert.equal(data.trades[0].plText, '+120 pips')
  })

  await t.test('ignores non-H1 timeframes and still-open (pending/running) records', () => {
    const history = [
      closedRecord({ tf: 'H4' }),
      closedRecord({ status: 'pending', closedAt: undefined }),
      closedRecord({ status: 'running', closedAt: undefined }),
    ]
    const data = computeWeeklyChartData(history, makeDays())
    assert.equal(data.totalClosed, 0)
  })

  await t.test('ignores trades closed outside the given week', () => {
    const history = [closedRecord({ closedAt: WEEK_START_MS - 3600000 }), closedRecord({ closedAt: WEEK_START_MS + 7 * DAY_MS })]
    const data = computeWeeklyChartData(history, makeDays())
    assert.equal(data.totalClosed, 0)
  })

  await t.test('trades list is sorted chronologically, not by symbol or insertion order', () => {
    const history = [
      closedRecord({ symbolKey: 'BTCUSD', closedAt: WEEK_START_MS + 5 * DAY_MS + 3600000 }), // Saturday
      closedRecord({ symbolKey: 'XAUUSD', closedAt: WEEK_START_MS + 3600000 }), // Monday
      closedRecord({ symbolKey: 'XAUUSD', closedAt: WEEK_START_MS + 2 * DAY_MS + 3600000 }), // Wednesday
    ]
    const data = computeWeeklyChartData(history, makeDays())
    assert.deepEqual(
      data.trades.map((t) => t.date),
      ['Mon 10', 'Wed 12', 'Sat 15']
    )
  })

  await t.test('cascading TP reach: a TP3 win counts toward TP1 and TP2 as well, not just TP3', () => {
    const history = [closedRecord({ status: 'win', hitTpIndex: 2 })] // hit TP3
    const data = computeWeeklyChartData(history, makeDays())
    assert.deepEqual(data.tpReachCount, [1, 1, 1]) // TP1, TP2, TP3 all credited
    assert.deepEqual(data.tpReachPct, [100, 100, 100])
  })

  await t.test('TP success rate is a share of ALL closed trades, wins and losses alike', () => {
    const history = [
      closedRecord({ status: 'win', hitTpIndex: 0 }), // TP1 only
      closedRecord({ status: 'win', hitTpIndex: 1 }), // TP1 + TP2
      closedRecord({ status: 'loss', hitTpIndex: undefined }),
      closedRecord({ status: 'loss', hitTpIndex: undefined }),
    ]
    const data = computeWeeklyChartData(history, makeDays())
    assert.equal(data.totalClosed, 4)
    // TP1 reached by both wins (2/4=50%), TP2 by one (1/4=25%), TP3 by none.
    assert.deepEqual(data.tpReachPct, [50, 25, 0])
    assert.equal(data.winRate, 50)
  })
})

test('renderWeeklyPerformanceChart', async (t) => {
  await t.test('returns a valid PNG buffer for a populated week', () => {
    const history = [closedRecord({ entry: 4300, exitPrice: 4312 })]
    const data = computeWeeklyChartData(history, makeDays())
    const buf = renderWeeklyPerformanceChart(data, '10 – 16 Aug 2026')
    assert.ok(Buffer.isBuffer(buf))
    assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC)
    assert.ok(buf.length > 1000, 'a real rendered chart is well over 1KB, not a blank canvas')
  })

  await t.test('does not throw for an empty week (no trades closed)', () => {
    const data = computeWeeklyChartData([], makeDays())
    const buf = renderWeeklyPerformanceChart(data, '10 – 16 Aug 2026')
    assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC)
  })
})

test('renderWeeklyTradeLogCharts', async (t) => {
  await t.test('a week with no closed trades still returns exactly one (empty) page', () => {
    const data = computeWeeklyChartData([], makeDays())
    const pages = renderWeeklyTradeLogCharts(data, '10 – 16 Aug 2026')
    assert.equal(pages.length, 1)
    assert.deepEqual(pages[0].subarray(0, 8), PNG_MAGIC)
  })

  await t.test('paginates at 20 rows per image — 25 trades makes 2 pages', () => {
    const history = Array.from({ length: 25 }, (_, i) =>
      closedRecord({ key: `k${i}`, closedAt: WEEK_START_MS + (i % 7) * DAY_MS + 3600000 })
    )
    const data = computeWeeklyChartData(history, makeDays())
    assert.equal(data.totalClosed, 25)
    const pages = renderWeeklyTradeLogCharts(data, '10 – 16 Aug 2026')
    assert.equal(pages.length, 2)
    for (const page of pages) assert.deepEqual(page.subarray(0, 8), PNG_MAGIC)
  })

  await t.test('exactly 20 trades still fits on one page', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      closedRecord({ key: `k${i}`, closedAt: WEEK_START_MS + (i % 7) * DAY_MS + 3600000 })
    )
    const data = computeWeeklyChartData(history, makeDays())
    const pages = renderWeeklyTradeLogCharts(data, '10 – 16 Aug 2026')
    assert.equal(pages.length, 1)
  })
})
