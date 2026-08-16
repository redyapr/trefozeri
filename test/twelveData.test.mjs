import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchAllTimeframes, SYMBOLS, TIMEFRAMES } from '../src/lib/twelveData.js'

function mockFetch(handler) {
  const original = global.fetch
  global.fetch = handler
  return () => (global.fetch = original)
}

const H1 = [TIMEFRAMES[0]]
const goldValues = (n = 20) =>
  Array.from({ length: n }, (_, i) => ({
    datetime: `2026-08-15 ${String(i).padStart(2, '0')}:00:00`,
    open: 4300 + i,
    high: 4301 + i,
    low: 4299 + i,
    close: 4300.5 + i,
  }))

test('fetchAllTimeframes', async (t) => {
  await t.test('parses a successful response into candle objects', async () => {
    const restore = mockFetch(async () => ({ ok: true, json: async () => ({ status: 'ok', values: goldValues(3) }) }))
    try {
      const result = await fetchAllTimeframes(SYMBOLS[0].apiSymbol, H1)
      assert.equal(result.H1.error, undefined)
      assert.equal(result.H1.length, 3)
      assert.equal(typeof result.H1[0].time, 'number')
      assert.equal(result.H1[0].close, 4300.5)
    } finally {
      restore()
    }
  })

  await t.test('a non-ok response (e.g. 404) becomes {error}, not a thrown crash', async () => {
    const restore = mockFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    try {
      const result = await fetchAllTimeframes(SYMBOLS[0].apiSymbol, H1)
      assert.ok(result.H1.error)
      assert.match(result.H1.error, /404/)
    } finally {
      restore()
    }
  })

  await t.test('an API-level error payload (status/code/message) becomes {error}', async () => {
    const restore = mockFetch(async () => ({ ok: true, json: async () => ({ status: 'error', message: 'rate limited' }) }))
    try {
      const result = await fetchAllTimeframes(SYMBOLS[0].apiSymbol, H1)
      assert.equal(result.H1.error, 'rate limited')
    } finally {
      restore()
    }
  })

  await t.test('a valid-but-empty values array becomes {error}, instead of silently passing through as zero candles', async () => {
    // A provider/cron hiccup that still writes syntactically valid JSON with no
    // candles in it — main.js reads series[series.length - 1] right after a
    // "successful" fetch and would crash on undefined if this were treated as ok.
    const restore = mockFetch(async () => ({ ok: true, json: async () => ({ status: 'ok', values: [] }) }))
    try {
      const result = await fetchAllTimeframes(SYMBOLS[0].apiSymbol, H1)
      assert.ok(result.H1.error, 'an empty values array must not be treated as a successful fetch')
    } finally {
      restore()
    }
  })

  await t.test('a non-array values field becomes {error}', async () => {
    const restore = mockFetch(async () => ({ ok: true, json: async () => ({ status: 'ok', values: 'not an array' }) }))
    try {
      const result = await fetchAllTimeframes(SYMBOLS[0].apiSymbol, H1)
      assert.ok(result.H1.error)
    } finally {
      restore()
    }
  })

  await t.test('each timeframe is fetched and reported independently — one failing does not affect another', async () => {
    let call = 0
    const restore = mockFetch(async () => {
      call++
      if (call === 1) return { ok: true, json: async () => ({ status: 'ok', values: goldValues(2) }) }
      return { ok: false, status: 500, json: async () => ({}) }
    })
    try {
      const result = await fetchAllTimeframes(SYMBOLS[0].apiSymbol, TIMEFRAMES.slice(0, 2))
      assert.equal(result[TIMEFRAMES[0].key].error, undefined)
      assert.ok(result[TIMEFRAMES[1].key].error)
    } finally {
      restore()
    }
  })
})
