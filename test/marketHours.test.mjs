import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isGoldMarketClosed, nextGoldReopenUtc, isWeekendUtc } from '../src/lib/marketHours.js'

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

test('nextGoldReopenUtc', async (t) => {
  await t.test('during Saturday, reopens that same week\'s Sunday 22:00 UTC', () => {
    const reopen = nextGoldReopenUtc(new Date('2026-08-15T12:00:00Z')) // Saturday
    assert.equal(reopen.toISOString(), '2026-08-16T22:00:00.000Z')
  })

  await t.test('Sunday before 22:00 UTC reopens later that same day', () => {
    const reopen = nextGoldReopenUtc(new Date('2026-08-16T05:00:00Z'))
    assert.equal(reopen.toISOString(), '2026-08-16T22:00:00.000Z')
  })

  await t.test('Sunday from 22:00 UTC onward (already reopened) rolls to next week', () => {
    assert.equal(nextGoldReopenUtc(new Date('2026-08-16T22:00:00Z')).toISOString(), '2026-08-23T22:00:00.000Z')
    assert.equal(nextGoldReopenUtc(new Date('2026-08-16T23:30:00Z')).toISOString(), '2026-08-23T22:00:00.000Z')
  })

  await t.test('Friday before close still points at the upcoming Sunday 22:00 UTC', () => {
    const reopen = nextGoldReopenUtc(new Date('2026-08-14T10:00:00Z'))
    assert.equal(reopen.toISOString(), '2026-08-16T22:00:00.000Z')
  })

  await t.test('Friday from 22:00 UTC (just closed) points at the same upcoming Sunday', () => {
    const reopen = nextGoldReopenUtc(new Date('2026-08-14T23:00:00Z'))
    assert.equal(reopen.toISOString(), '2026-08-16T22:00:00.000Z')
  })

  await t.test('a weekday mid-week points at the upcoming Sunday 22:00 UTC', () => {
    const reopen = nextGoldReopenUtc(new Date('2026-08-11T12:00:00Z')) // Tuesday
    assert.equal(reopen.toISOString(), '2026-08-16T22:00:00.000Z')
  })

  await t.test('defaults to the current time when no date is passed', () => {
    assert.ok(nextGoldReopenUtc() instanceof Date)
  })
})

test('isWeekendUtc', async (t) => {
  await t.test('Saturday and Sunday are the weekend', () => {
    assert.equal(isWeekendUtc(new Date('2026-08-15T12:00:00Z')), true) // Saturday
    assert.equal(isWeekendUtc(new Date('2026-08-16T00:00:00Z')), true) // Sunday, any hour
    assert.equal(isWeekendUtc(new Date('2026-08-16T23:59:00Z')), true)
  })

  await t.test('Monday through Friday are not the weekend, any hour', () => {
    assert.equal(isWeekendUtc(new Date('2026-08-10T00:00:00Z')), false) // Monday
    assert.equal(isWeekendUtc(new Date('2026-08-14T23:59:00Z')), false) // Friday, even late
  })

  await t.test('defaults to the current time when no date is passed', () => {
    assert.equal(typeof isWeekendUtc(), 'boolean')
  })
})
