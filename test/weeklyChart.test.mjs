import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeWeeklyChartData,
  renderWeeklyReportImage,
  countReachedTpStages,
  computeDailyChartData,
  renderDailyReportImage,
} from '../scripts/weeklyChart.mjs'

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
    assert.deepEqual(data.tpReachPct, [], 'no ladder length to derive from an empty week — no pies, not a padded default')
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
    assert.equal(data.trades[0].plText, '+120', 'no "pips" suffix — the chart is a report, same convention as the text reports')
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
    assert.equal(data.trades[0].plText, '+120')
  })

  await t.test('plText is always a whole number, even when the underlying $ move has cents', () => {
    const history = [
      closedRecord({ symbolKey: 'BTCUSD', direction: 'buy', entry: 62000, exitPrice: 62850.34 }),
    ]
    const data = computeWeeklyChartData(history, makeDays())
    assert.equal(data.trades[0].plText, '+850')
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

  // A 3-level ladder — long enough to represent a TP3 win/an unreached TP3.
  const threeLevelTp = [{ price: 4310, rr: 1 }, { price: 4320, rr: 2 }, { price: 4330, rr: 3 }]

  await t.test('cascading TP reach: a TP3 win counts toward TP1 and TP2 as well, not just TP3', () => {
    const history = [closedRecord({ status: 'win', hitTpIndex: 2, tp: threeLevelTp })] // hit TP3
    const data = computeWeeklyChartData(history, makeDays())
    assert.deepEqual(data.tpReachCount, [1, 1, 1]) // TP1, TP2, TP3 all credited
    assert.deepEqual(data.tpReachPct, [100, 100, 100])
  })

  await t.test('the pie ladder only goes as far as the longest TP array any trade this week actually had', () => {
    const history = [closedRecord({ status: 'win', hitTpIndex: 0, tp: [{ price: 4310, rr: 1 }] })] // a 1-level signal
    const data = computeWeeklyChartData(history, makeDays())
    assert.deepEqual(data.tpReachPct, [100], 'one rung only — this signal never offered a TP2/TP3 to begin with')
  })

  await t.test('TP success rate is a share of ALL closed trades, wins and losses alike', () => {
    const history = [
      closedRecord({ status: 'win', hitTpIndex: 0, tp: threeLevelTp }), // TP1 only
      closedRecord({ status: 'win', hitTpIndex: 1, tp: threeLevelTp }), // TP1 + TP2
      closedRecord({ status: 'loss', hitTpIndex: undefined, tp: threeLevelTp }),
      closedRecord({ status: 'loss', hitTpIndex: undefined, tp: threeLevelTp }),
    ]
    const data = computeWeeklyChartData(history, makeDays())
    assert.equal(data.totalClosed, 4)
    // TP1 reached by both wins (2/4=50%), TP2 by one (1/4=25%), TP3 by none.
    assert.deepEqual(data.tpReachPct, [50, 25, 0])
    assert.equal(data.winRate, 50)
  })
})

test('renderWeeklyReportImage', async (t) => {
  await t.test('returns a valid, single PNG buffer for a populated week', () => {
    const history = [closedRecord({ entry: 4300, exitPrice: 4312 })]
    const data = computeWeeklyChartData(history, makeDays())
    const buf = renderWeeklyReportImage(data, '10 – 16 Aug 2026')
    assert.ok(Buffer.isBuffer(buf))
    assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC)
    assert.ok(buf.length > 1000, 'a real rendered chart is well over 1KB, not a blank canvas')
  })

  await t.test('does not throw for an empty week (no trades closed) — bars and an empty trade-log note render, no pie row', () => {
    const data = computeWeeklyChartData([], makeDays())
    const buf = renderWeeklyReportImage(data, '10 – 16 Aug 2026')
    assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC)
  })

  function pngHeight(buf) {
    // IHDR is always the first chunk, right after the 8-byte signature: 4-byte length,
    // 4-byte type, then width (4 bytes) and height (4 bytes), big-endian.
    return buf.readUInt32BE(8 + 4 + 4 + 4)
  }

  await t.test('skips the whole TP success-rate pie row when nothing this week ever reached a TP', () => {
    const lossOnly = [closedRecord({ status: 'loss', hitTpIndex: undefined })]
    const withAWin = [closedRecord({ status: 'win', hitTpIndex: 0 })]
    const lossOnlyBuf = renderWeeklyReportImage(computeWeeklyChartData(lossOnly, makeDays()), '10 – 16 Aug 2026')
    const withAWinBuf = renderWeeklyReportImage(computeWeeklyChartData(withAWin, makeDays()), '10 – 16 Aug 2026')
    assert.ok(
      pngHeight(lossOnlyBuf) < pngHeight(withAWinBuf),
      'a loss-only week (no pie row) renders shorter than one with a win (pie row present)'
    )
  })

  await t.test('grows taller as more trade-log rows are added — the log is on the same canvas, not a separate image', () => {
    const few = [closedRecord({ entry: 4300, exitPrice: 4312 })]
    const many = Array.from({ length: 25 }, (_, i) =>
      closedRecord({ key: `k${i}`, closedAt: WEEK_START_MS + (i % 7) * DAY_MS + 3600000 })
    )
    const shortBuf = renderWeeklyReportImage(computeWeeklyChartData(few, makeDays()), '10 – 16 Aug 2026')
    const tallBuf = renderWeeklyReportImage(computeWeeklyChartData(many, makeDays()), '10 – 16 Aug 2026')
    assert.ok(pngHeight(tallBuf) > pngHeight(shortBuf), '25 trade-log rows must make the image taller than 1 row does')
  })

  await t.test('height keeps scaling linearly on an unusually busy week — no longer capped at a fixed scratch-canvas budget', () => {
    // The scratch canvas used to be a flat 2200px regardless of content — anything
    // drawn past that (including the "P/L is in pips." footnote) was silently clipped,
    // never an error. Comparing two busy weeks confirms height still grows roughly
    // 30px/row well past where the old fixed budget would have plateaued instead.
    const trades = (n) => Array.from({ length: n }, (_, i) => closedRecord({ key: `k${i}`, closedAt: WEEK_START_MS + (i % 7) * DAY_MS + 3600000 }))
    const h40 = pngHeight(renderWeeklyReportImage(computeWeeklyChartData(trades(40), makeDays()), '10 – 16 Aug 2026'))
    const h80 = pngHeight(renderWeeklyReportImage(computeWeeklyChartData(trades(80), makeDays()), '10 – 16 Aug 2026'))
    assert.ok(h80 - h40 > 1000, `40 extra 30px trade-log rows should add >1000px; only grew by ${h80 - h40}px`)
  })
})

test('countReachedTpStages', async (t) => {
  await t.test('trims a trailing run of zero-reach stages, not just the very last one', () => {
    assert.equal(countReachedTpStages([2, 1, 0, 0, 0]), 2)
  })

  await t.test('keeps every stage when all of them were reached at least once', () => {
    assert.equal(countReachedTpStages([3, 2, 1]), 3)
  })

  await t.test('an all-zero ladder (no wins at all) counts as zero stages', () => {
    assert.equal(countReachedTpStages([0, 0, 0]), 0)
  })

  await t.test('an empty ladder (no data) counts as zero stages', () => {
    assert.equal(countReachedTpStages([]), 0)
  })
})

const DAY_START_MS = WEEK_START_MS // reuse the same fixed Monday for daily tests too
const DAY_END_MS = DAY_START_MS + DAY_MS

test('computeDailyChartData', async (t) => {
  await t.test('an empty day: no symbols at all, not a 0%/$0 placeholder for either', () => {
    const data = computeDailyChartData([], DAY_START_MS, DAY_END_MS)
    assert.deepEqual(data, {})
  })

  await t.test('only includes a symbol that actually closed something that day', () => {
    const history = [closedRecord({ symbolKey: 'XAUUSD' })]
    const data = computeDailyChartData(history, DAY_START_MS, DAY_END_MS)
    assert.ok(data.XAUUSD)
    assert.equal(data.BTCUSD, undefined)
  })

  await t.test('one bar entry per trade, labeled by direction + (rounded) entry price, "@" padded to align BUY/SELL', () => {
    const history = [
      closedRecord({ entry: 4300, exitPrice: 4320 }), // +200 pips
      closedRecord({ entry: 4310.6, direction: 'sell', status: 'loss', exitPrice: 4315 }), // a loss
    ]
    const data = computeDailyChartData(history, DAY_START_MS, DAY_END_MS)
    assert.deepEqual(data.XAUUSD.entries, [
      { label: 'BUY  @ 4300', value: 200 },
      { label: 'SELL @ 4311', value: -44 },
    ])
  })

  await t.test('wins/losses/net/winRate are computed the same way the weekly data is', () => {
    const history = [
      closedRecord({ entry: 4300, exitPrice: 4320 }), // win, +200
      closedRecord({ status: 'loss', entry: 4300, exitPrice: 4290 }), // loss, -100
    ]
    const data = computeDailyChartData(history, DAY_START_MS, DAY_END_MS)
    assert.equal(data.XAUUSD.wins, 1)
    assert.equal(data.XAUUSD.losses, 1)
    assert.equal(data.XAUUSD.net, 100)
    assert.equal(data.XAUUSD.winRate, 50)
  })

  await t.test('excludes trades outside the day window and from other timeframes', () => {
    const history = [
      closedRecord({ closedAt: DAY_START_MS - 1 }), // just before the window
      closedRecord({ closedAt: DAY_END_MS }), // the exclusive end
      closedRecord({ tf: 'H4', closedAt: DAY_START_MS + 1000 }), // wrong timeframe
    ]
    assert.deepEqual(computeDailyChartData(history, DAY_START_MS, DAY_END_MS), {})
  })
})

test('renderDailyReportImage', async (t) => {
  await t.test('returns a valid PNG buffer for a day with a closed trade', () => {
    const data = computeDailyChartData([closedRecord({ entry: 4300, exitPrice: 4320 })], DAY_START_MS, DAY_END_MS)
    const buf = renderDailyReportImage(data, 'Monday, 10 Aug 2026')
    assert.ok(Buffer.isBuffer(buf))
    assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC)
    assert.ok(buf.length > 500, 'a real rendered chart is well over 500 bytes, not a blank canvas')
  })

  await t.test('does not throw for a day with no activity at all', () => {
    const data = computeDailyChartData([], DAY_START_MS, DAY_END_MS)
    const buf = renderDailyReportImage(data, 'Monday, 10 Aug 2026')
    assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC)
  })

  await t.test('grows taller with a second symbol\'s panel than with just one', () => {
    function pngHeight(buf) {
      return buf.readUInt32BE(8 + 4 + 4 + 4)
    }
    const oneSymbol = computeDailyChartData([closedRecord({ symbolKey: 'XAUUSD' })], DAY_START_MS, DAY_END_MS)
    const bothSymbols = computeDailyChartData(
      [closedRecord({ symbolKey: 'XAUUSD' }), closedRecord({ symbolKey: 'BTCUSD' })],
      DAY_START_MS,
      DAY_END_MS
    )
    const oneBuf = renderDailyReportImage(oneSymbol, 'Monday, 10 Aug 2026')
    const bothBuf = renderDailyReportImage(bothSymbols, 'Monday, 10 Aug 2026')
    assert.ok(pngHeight(bothBuf) > pngHeight(oneBuf), 'a second symbol panel must make the image taller')
  })

  await t.test('height keeps scaling on an unusually busy day — no longer capped at a fixed scratch-canvas budget', () => {
    function pngHeight(buf) {
      return buf.readUInt32BE(8 + 4 + 4 + 4)
    }
    const trades = (n) => Array.from({ length: n }, (_, i) => closedRecord({ key: `k${i}`, symbolKey: 'XAUUSD' }))
    const few = renderDailyReportImage(computeDailyChartData(trades(5), DAY_START_MS, DAY_END_MS), 'Monday, 10 Aug 2026')
    const many = renderDailyReportImage(computeDailyChartData(trades(30), DAY_START_MS, DAY_END_MS), 'Monday, 10 Aug 2026')
    assert.ok(pngHeight(many) - pngHeight(few) > 500, `25 extra 24px bar rows should add >500px; only grew by ${pngHeight(many) - pngHeight(few)}px`)
  })
})
