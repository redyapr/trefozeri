import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isGoldMarketClosed } from '../src/lib/marketHours.js'

test('isGoldMarketClosed', async (t) => {
  await t.test('all of Saturday is closed', () => {
    assert.equal(isGoldMarketClosed(new Date('2026-08-15T00:00:00Z')), true)
    assert.equal(isGoldMarketClosed(new Date('2026-08-15T12:00:00Z')), true)
    assert.equal(isGoldMarketClosed(new Date('2026-08-15T23:59:00Z')), true)
  })

  await t.test('Sunday before 22:00 UTC is closed', () => {
    assert.equal(isGoldMarketClosed(new Date('2026-08-16T00:00:00Z')), true)
    assert.equal(isGoldMarketClosed(new Date('2026-08-16T21:59:00Z')), true)
  })

  await t.test('Sunday from 22:00 UTC is open (week reopens)', () => {
    assert.equal(isGoldMarketClosed(new Date('2026-08-16T22:00:00Z')), false)
    assert.equal(isGoldMarketClosed(new Date('2026-08-16T23:00:00Z')), false)
  })

  await t.test('Friday before 22:00 UTC is open', () => {
    assert.equal(isGoldMarketClosed(new Date('2026-08-14T00:00:00Z')), false)
    assert.equal(isGoldMarketClosed(new Date('2026-08-14T21:59:00Z')), false)
  })

  await t.test('Friday from 22:00 UTC is closed (week close)', () => {
    assert.equal(isGoldMarketClosed(new Date('2026-08-14T22:00:00Z')), true)
    assert.equal(isGoldMarketClosed(new Date('2026-08-14T23:59:00Z')), true)
  })

  await t.test('any time Monday through Thursday is open', () => {
    assert.equal(isGoldMarketClosed(new Date('2026-08-10T00:00:00Z')), false) // Monday
    assert.equal(isGoldMarketClosed(new Date('2026-08-11T12:00:00Z')), false) // Tuesday
    assert.equal(isGoldMarketClosed(new Date('2026-08-12T23:59:00Z')), false) // Wednesday
    assert.equal(isGoldMarketClosed(new Date('2026-08-13T00:00:00Z')), false) // Thursday
  })

  await t.test('defaults to the current time when no date is passed', () => {
    // Just confirm it doesn't throw and returns a boolean — the actual value depends
    // on when the suite happens to run.
    assert.equal(typeof isGoldMarketClosed(), 'boolean')
  })
})
