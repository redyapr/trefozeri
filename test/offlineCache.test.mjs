import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, teardownDom } from '../test-helpers/setupDom.mjs'
import { saveLastKnown, loadLastKnown } from '../src/lib/offlineCache.js'

beforeEach(() => setupDom())
afterEach(() => teardownDom())

test('offlineCache', async (t) => {
  await t.test('loadLastKnown returns null when nothing has ever been saved', () => {
    assert.equal(loadLastKnown('XAUUSD'), null)
  })

  await t.test('round-trips zones/price/savedAt for a symbol', () => {
    const zonesByTimeframe = { H1: { zones: [{ category: 'Support', price: 4300 }] } }
    saveLastKnown('XAUUSD', zonesByTimeframe, 4305)
    const loaded = loadLastKnown('XAUUSD')
    assert.deepEqual(loaded.zonesByTimeframe, zonesByTimeframe)
    assert.equal(loaded.currentPrice, 4305)
    assert.equal(typeof loaded.savedAt, 'number')
  })

  await t.test('keeps each symbol independent', () => {
    saveLastKnown('XAUUSD', { H1: { zones: [] } }, 4300)
    saveLastKnown('BTCUSD', { H1: { zones: [] } }, 65000)
    assert.equal(loadLastKnown('XAUUSD').currentPrice, 4300)
    assert.equal(loadLastKnown('BTCUSD').currentPrice, 65000)
  })

  await t.test('a second save for the same symbol overwrites, not merges', () => {
    saveLastKnown('XAUUSD', { H1: { zones: [] } }, 4300)
    saveLastKnown('XAUUSD', { H4: { zones: [] } }, 4310)
    const loaded = loadLastKnown('XAUUSD')
    assert.equal(loaded.currentPrice, 4310)
    assert.deepEqual(Object.keys(loaded.zonesByTimeframe), ['H4'])
  })

  await t.test('corrupt stored JSON is treated as "nothing saved" rather than throwing', () => {
    localStorage.setItem('gold-sr-last-known-v3', '{not valid json')
    assert.equal(loadLastKnown('XAUUSD'), null)
  })

  await t.test('a storage write failure (e.g. quota exceeded) is swallowed, not thrown', () => {
    const original = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      assert.doesNotThrow(() => saveLastKnown('XAUUSD', { H1: { zones: [] } }, 4300))
    } finally {
      localStorage.setItem = original
    }
  })
})
