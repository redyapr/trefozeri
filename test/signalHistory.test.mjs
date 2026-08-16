import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadHistory, getHistory, getStats, getBreakdown, buildHistoryCsv, getEquityCurve } from '../src/lib/signalHistory.js'

function mockFetch(handler) {
  const original = global.fetch
  global.fetch = handler
  return () => (global.fetch = original)
}

const record = (overrides) => ({
  key: 'XAUUSD-H1-Support-buy',
  symbolKey: 'XAUUSD',
  tf: 'H1',
  category: 'Support',
  direction: 'buy',
  entry: 4300,
  sl: 4295,
  tp: [{ price: 4310, rr: 2 }],
  openedAt: Date.now(),
  status: 'pending',
  ...overrides,
})

test('loadHistory / getHistory / getStats', async (t) => {
  await t.test('loads records on a successful fetch, readable via getHistory/getStats', async () => {
    const restore = mockFetch(async () => ({ ok: true, json: async () => [record()] }))
    try {
      const records = await loadHistory()
      assert.equal(records.length, 1)
      assert.equal(getHistory('XAUUSD').length, 1)
      assert.equal(getStats('XAUUSD').pending, 1)
    } finally {
      restore()
    }
  })

  await t.test('keeps the last good history on a non-ok response, does not throw', async () => {
    const restoreGood = mockFetch(async () => ({ ok: true, json: async () => [record()] }))
    await loadHistory()
    restoreGood()

    const restoreBad = mockFetch(async () => ({ ok: false, status: 404 }))
    try {
      const records = await loadHistory()
      assert.equal(records.length, 1, 'still the previously loaded record, not wiped out')
    } finally {
      restoreBad()
    }
  })

  await t.test('keeps the last good history when the fetch itself throws', async () => {
    const restoreGood = mockFetch(async () => ({ ok: true, json: async () => [record()] }))
    await loadHistory()
    restoreGood()

    const restoreThrow = mockFetch(async () => {
      throw new Error('network down')
    })
    try {
      const records = await loadHistory()
      assert.equal(records.length, 1)
    } finally {
      restoreThrow()
    }
  })

  await t.test('keeps the last good history when the response is valid JSON but not an array', async () => {
    const restoreGood = mockFetch(async () => ({ ok: true, json: async () => [record()] }))
    await loadHistory()
    restoreGood()

    const restoreBadShape = mockFetch(async () => ({ ok: true, json: async () => ({ not: 'an array' }) }))
    try {
      const records = await loadHistory()
      assert.equal(records.length, 1)
    } finally {
      restoreBadShape()
    }
  })

  await t.test('getHistory/getStats filter by symbolKey and (optionally) timeframe', async () => {
    const restore = mockFetch(async () => ({
      ok: true,
      json: async () => [
        record({ key: 'a', symbolKey: 'XAUUSD', tf: 'H1' }),
        record({ key: 'b', symbolKey: 'XAUUSD', tf: 'H4' }),
        record({ key: 'c', symbolKey: 'BTCUSD', tf: 'H1' }),
      ],
    }))
    try {
      await loadHistory()
      assert.equal(getHistory('XAUUSD').length, 2)
      assert.equal(getHistory('XAUUSD', 'H1').length, 1)
      assert.equal(getHistory('BTCUSD').length, 1)
      assert.equal(getStats('XAUUSD', 'H1').total, 1)
    } finally {
      restore()
    }
  })

  await t.test('getBreakdown/buildHistoryCsv read from the same loaded records', async () => {
    const restore = mockFetch(async () => ({
      ok: true,
      json: async () => [
        record({ key: 'a', status: 'win', strengthLabel: 'Strong', exitPrice: 4320, hitTpIndex: 0, closedAt: Date.now() }),
      ],
    }))
    try {
      await loadHistory()
      const { byCategory, byStrength } = getBreakdown('XAUUSD')
      assert.equal(byCategory[0].key, 'Support')
      assert.equal(byStrength[0].key, 'Strong')

      const csv = buildHistoryCsv('XAUUSD')
      assert.match(csv, /^Opened,Filled,Closed,Timeframe,Category,Strength,Direction,Entry,SL,TP,Status,Exit Price,Result/)
      assert.match(csv, /Support,Strong,BUY,4300,4295,4310,win,4320,\+200 pips/)

      const curve = getEquityCurve('XAUUSD')
      assert.equal(curve.length, 1)
      assert.equal(curve[0].value, 200)
    } finally {
      restore()
    }
  })
})
