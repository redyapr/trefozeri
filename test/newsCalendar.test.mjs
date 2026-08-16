import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchNewsCalendar, findUpcomingHighImpact } from '../src/lib/newsCalendar.js'

function mockFetch(handler) {
  const original = global.fetch
  global.fetch = handler
  return () => (global.fetch = original)
}

test('fetchNewsCalendar', async (t) => {
  await t.test('returns the array on a successful fetch', async () => {
    const restore = mockFetch(async () => ({ ok: true, json: async () => [{ country: 'USD', impact: 'High' }] }))
    try {
      const events = await fetchNewsCalendar()
      assert.deepEqual(events, [{ country: 'USD', impact: 'High' }])
    } finally {
      restore()
    }
  })

  await t.test('keeps the last good calendar on a non-ok response, does not throw', async () => {
    const restoreGood = mockFetch(async () => ({ ok: true, json: async () => [{ country: 'USD', impact: 'High' }] }))
    await fetchNewsCalendar()
    restoreGood()

    const restoreBad = mockFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    try {
      const events = await fetchNewsCalendar()
      assert.deepEqual(events, [{ country: 'USD', impact: 'High' }], 'still the previously cached events, not wiped out')
    } finally {
      restoreBad()
    }
  })

  await t.test('keeps the last good calendar when the fetch itself throws (network error)', async () => {
    const restoreGood = mockFetch(async () => ({ ok: true, json: async () => [{ country: 'USD', impact: 'High' }] }))
    await fetchNewsCalendar()
    restoreGood()

    const restoreThrow = mockFetch(async () => {
      throw new Error('network down')
    })
    try {
      const events = await fetchNewsCalendar()
      assert.deepEqual(events, [{ country: 'USD', impact: 'High' }])
    } finally {
      restoreThrow()
    }
  })

  await t.test('keeps the last good calendar when the response is valid JSON but not an array', async () => {
    const restoreGood = mockFetch(async () => ({ ok: true, json: async () => [{ country: 'USD', impact: 'High' }] }))
    await fetchNewsCalendar()
    restoreGood()

    const restoreBadShape = mockFetch(async () => ({ ok: true, json: async () => ({ not: 'an array' }) }))
    try {
      const events = await fetchNewsCalendar()
      assert.deepEqual(events, [{ country: 'USD', impact: 'High' }])
    } finally {
      restoreBadShape()
    }
  })
})

test('findUpcomingHighImpact', async (t) => {
  const now = Date.now()
  const inHours = (h) => new Date(now + h * 60 * 60 * 1000).toISOString()

  await t.test('keeps only USD + High impact events', () => {
    const events = [
      { country: 'USD', impact: 'High', date: inHours(2) },
      { country: 'EUR', impact: 'High', date: inHours(2) },
      { country: 'USD', impact: 'Medium', date: inHours(2) },
    ]
    const result = findUpcomingHighImpact(events, 12)
    assert.equal(result.length, 1)
    assert.equal(result[0].country, 'USD')
  })

  await t.test('is case-insensitive on country/impact', () => {
    const events = [{ country: 'usd', impact: 'high', date: inHours(2) }]
    const result = findUpcomingHighImpact(events, 12)
    assert.equal(result.length, 1)
  })

  await t.test('excludes events outside the [now, now+withinHours] window', () => {
    const events = [
      { country: 'USD', impact: 'High', date: inHours(-1) }, // already passed
      { country: 'USD', impact: 'High', date: inHours(13) }, // beyond a 12h horizon
      { country: 'USD', impact: 'High', date: inHours(5) }, // within window
    ]
    const result = findUpcomingHighImpact(events, 12)
    assert.equal(result.length, 1)
    assert.ok(Math.abs(result[0].timestamp - (now + 5 * 3600000)) < 1000)
  })

  await t.test('sorts soonest first', () => {
    const events = [
      { country: 'USD', impact: 'High', date: inHours(10) },
      { country: 'USD', impact: 'High', date: inHours(1) },
      { country: 'USD', impact: 'High', date: inHours(5) },
    ]
    const result = findUpcomingHighImpact(events, 12)
    assert.deepEqual(
      result.map((e) => Math.round((e.timestamp - now) / 3600000)),
      [1, 5, 10]
    )
  })

  await t.test('skips an event with an unparseable date instead of crashing or sorting it in', () => {
    const events = [
      { country: 'USD', impact: 'High', date: 'not a real date' },
      { country: 'USD', impact: 'High', date: inHours(3) },
    ]
    const result = findUpcomingHighImpact(events, 12)
    assert.equal(result.length, 1)
    assert.ok(Math.abs(result[0].timestamp - (now + 3 * 3600000)) < 1000)
  })

  await t.test('defaults to a 12-hour horizon when none is given', () => {
    const events = [{ country: 'USD', impact: 'High', date: inHours(11) }]
    assert.equal(findUpcomingHighImpact(events).length, 1)
  })
})
