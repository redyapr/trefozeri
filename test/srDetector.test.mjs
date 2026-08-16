import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLevels, annotateGoldenZones, buildSignals, isPriceStagnant } from '../src/lib/srDetector.js'

function candle(t, o, h, l, c) {
  return { time: t, open: o, high: h, low: l, close: c }
}

// A flat run of chop, then a clean low pivot (a single bar dipping well below its
// neighbors' bodies), then more chop holding above it — the minimal shape
// findBodyPivots needs to confirm a Support pivot at `base + 1`.
function seriesWithLowPivot(base, { breakBelow = false, rebreakAbove = false } = {}) {
  const candles = []
  let t = 0
  for (let i = 0; i < 10; i++) candles.push(candle(t++, base + 5, base + 6, base + 4, base + 5))
  candles.push(candle(t++, base + 1, base + 2, base - 5, base + 1)) // the pivot itself
  for (let i = 0; i < 5; i++) candles.push(candle(t++, base + 3, base + 4, base + 2, base + 3)) // confirms it
  for (let i = 0; i < 15; i++) candles.push(candle(t++, base + 3, base + 5, base + 2, base + 4)) // holds
  if (breakBelow) {
    // A close well below the pivot, beyond any plausible breakout threshold.
    candles.push(candle(t++, base - 20, base - 19, base - 25, base - 22))
    for (let i = 0; i < 10; i++) candles.push(candle(t++, base - 22, base - 20, base - 24, base - 21)) // holds below
  }
  if (rebreakAbove) {
    candles.push(candle(t++, base + 30, base + 35, base + 29, base + 32))
    for (let i = 0; i < 10; i++) candles.push(candle(t++, base + 32, base + 34, base + 30, base + 33))
  }
  return candles
}

function seriesWithHighPivot(base, opts) {
  // Mirror image of seriesWithLowPivot (high pivot instead of low).
  const candles = []
  let t = 0
  for (let i = 0; i < 10; i++) candles.push(candle(t++, base - 5, base - 4, base - 6, base - 5))
  candles.push(candle(t++, base - 1, base + 5, base - 2, base - 1))
  for (let i = 0; i < 5; i++) candles.push(candle(t++, base - 3, base - 2, base - 4, base - 3))
  for (let i = 0; i < 15; i++) candles.push(candle(t++, base - 3, base - 2, base - 5, base - 4))
  if (opts?.breakAbove) {
    candles.push(candle(t++, base + 20, base + 25, base + 19, base + 22))
    for (let i = 0; i < 10; i++) candles.push(candle(t++, base + 21, base + 24, base + 20, base + 22))
  }
  return candles
}

test('detectLevels: pivot state machine', async (t) => {
  await t.test('a pivot that never breaks is a pure Support zone', () => {
    const candles = seriesWithLowPivot(4300)
    const zones = detectLevels(candles, candles.at(-1).close)
    const support = zones.find((z) => z.category === 'Support')
    assert.ok(support, 'expected a Support zone')
    assert.equal(support.type, 'support')
    assert.equal(support.broken, false)
    assert.equal(support.price, 4301)
  })

  await t.test('breaking once flips Support into SBR (now type resistance)', () => {
    const candles = seriesWithLowPivot(4300, { breakBelow: true })
    const zones = detectLevels(candles, candles.at(-1).close)
    assert.equal(
      zones.find((z) => z.category === 'Support'),
      undefined,
      'no longer a pure Support once broken'
    )
    const sbr = zones.find((z) => z.category === 'SBR')
    assert.ok(sbr, 'expected an SBR zone')
    assert.equal(sbr.type, 'resistance')
    assert.equal(sbr.broken, true)
  })

  await t.test('breaking a second time invalidates the level entirely', () => {
    const candles = seriesWithLowPivot(4300, { breakBelow: true, rebreakAbove: true })
    const zones = detectLevels(candles, candles.at(-1).close)
    assert.equal(zones.find((z) => z.category === 'SBR'), undefined, 'SBR should be invalidated')
    assert.equal(zones.find((z) => z.category === 'Support'), undefined)
  })

  await t.test('mirror: a high pivot is Resistance, and RBS after it breaks', () => {
    const plain = detectLevels(seriesWithHighPivot(4300), 4300)
    assert.ok(plain.find((z) => z.category === 'Resistance' && z.type === 'resistance'))

    const broken = detectLevels(seriesWithHighPivot(4300, { breakAbove: true }), 4320)
    const rbs = broken.find((z) => z.category === 'RBS')
    assert.ok(rbs, 'expected an RBS zone')
    assert.equal(rbs.type, 'support')
  })

  await t.test('every zone carries atr/threshold/structureAnchor for SL sizing', () => {
    const zones = detectLevels(seriesWithLowPivot(4300), 4305)
    for (const z of zones) {
      assert.equal(typeof z.atr, 'number')
      assert.ok(z.atr >= 0)
      assert.equal(typeof z.threshold, 'number')
      assert.ok(z.threshold > 0, 'threshold always has a price-relative floor')
      assert.equal(typeof z.structureAnchor, 'number')
    }
  })

  await t.test('too few candles returns no zones instead of throwing', () => {
    assert.deepEqual(detectLevels([candle(0, 1, 2, 0, 1)], 1), [])
    assert.deepEqual(detectLevels(null, 100), [])
  })

  await t.test('still correctly picks the newest pivot once far more than MAX_KEEP (40) have accumulated', () => {
    // Each cycle reuses seriesWithLowPivot's own shape (well-separated bases so pivots
    // never interfere with each other), repeated well past the 40-pivot retention cap
    // — if that cap or the "pick the newest still-valid one" logic ever regressed,
    // this would either crash or return a stale/wrong price instead of the latest one.
    let all = []
    let t = 0
    let lastBase
    const CYCLES = 45
    for (let c = 0; c < CYCLES; c++) {
      const base = 4300 + c * 50
      lastBase = base
      const cycle = seriesWithLowPivot(base).map((candle) => ({ ...candle, time: candle.time + t }))
      all = all.concat(cycle)
      t += cycle.length
    }
    const zones = detectLevels(all, all.at(-1).close)
    const support = zones.find((z) => z.category === 'Support')
    assert.ok(support, 'expected exactly one still-current Support zone')
    assert.equal(support.price, lastBase + 1, 'must be the newest cycle\'s pivot, not a stale earlier one')
  })
})

// Regression test for a real production bug: a data provider (Twelve Data) repeating
// the last real tick with only sub-cent jitter while gold's market is closed (open
// pinned, close wiggling by ~0.1 out of a series whose breakoutThreshold floor alone is
// ~0.86 for this price range) produced a "Support" and a "Resistance" pivot barely 0.13
// apart — visually overlapping on the chart — because findBodyPivots accepted a
// candidate as a pivot even when it beat its neighbors by a razor-thin margin.
// Mirrors the real weekend XAUUSD feed: open pinned, close jittering by ~0.1 total —
// an order of magnitude below any sane breakout threshold for this price range.
function frozenCandles(base, count, startTime = 0) {
  const candles = []
  for (let i = 0; i < count; i++) {
    const jitter = (i % 2 === 0 ? 1 : -1) * 0.05
    candles.push(candle(startTime + i, base, base + 0.2, base - 0.2, base + jitter))
  }
  return candles
}

test('detectLevels: does not fabricate zones from near-frozen (closed-market) data', async (t) => {
  await t.test('a fully frozen series never fabricates a Support/Resistance pair out of noise', () => {
    const candles = frozenCandles(4375, 40)
    const zones = detectLevels(candles, candles.at(-1).close)
    assert.deepEqual(zones, [])
  })

  await t.test('a real pivot followed by a frozen tail keeps the real pivot, not a noise pivot from the tail', () => {
    const base = 4375
    const real = seriesWithLowPivot(base)
    const tail = frozenCandles(base + 3, 30, real.length)
    const zones = detectLevels([...real, ...tail], tail.at(-1).close)
    const support = zones.find((z) => z.category === 'Support')
    assert.ok(support, 'the earlier real pivot should still be found')
    assert.equal(support.price, base + 1, 'must not be a spurious pivot manufactured from the frozen tail\'s jitter')
  })

  await t.test('a real high pivot is likewise unaffected by a frozen tail (mirror of the Support case)', () => {
    const base = 4375
    const real = seriesWithHighPivot(base)
    const tail = frozenCandles(base - 3, 30, real.length)
    const zones = detectLevels([...real, ...tail], tail.at(-1).close)
    const resistance = zones.find((z) => z.category === 'Resistance')
    assert.ok(resistance, 'the earlier real pivot should still be found')
    assert.equal(resistance.price, base - 1, 'must not be a spurious pivot manufactured from the frozen tail\'s jitter')
  })
})

// Root-cause detector shared by the market-status banner (main.js) and the cron's
// new-signal gating (fetch-data.mjs) — reads "is price actually moving" directly from
// the data, independent of any calendar rule, so a holiday closure on an otherwise
// normal weekday is caught the same way the regular weekend closure is.
test('isPriceStagnant', async (t) => {
  await t.test('a frozen series (near-zero movement) is flagged stagnant', () => {
    assert.equal(isPriceStagnant(frozenCandles(4375, 20)), true)
  })

  await t.test('a normally-moving series is not flagged stagnant', () => {
    assert.equal(isPriceStagnant(seriesWithLowPivot(4300)), false)
  })

  await t.test('fewer candles than the lookback is never flagged (not enough data to judge)', () => {
    assert.equal(isPriceStagnant(frozenCandles(4375, 5), 12), false)
  })

  await t.test('only the trailing `lookback` candles matter — real movement further back does not mask a stagnant tail', () => {
    const real = seriesWithLowPivot(4375)
    const tail = frozenCandles(4378, 20, real.length)
    assert.equal(isPriceStagnant([...real, ...tail], 12), true)
  })

  await t.test('the lookback is configurable', () => {
    assert.equal(isPriceStagnant(frozenCandles(4375, 6), 6), true)
  })
})

test('annotateGoldenZones', async (t) => {
  await t.test('flags matching same-category levels across timeframes', () => {
    const h1 = detectLevels(seriesWithLowPivot(4300), 4305)
    const h4 = detectLevels(seriesWithLowPivot(4300), 4305) // identical series -> identical price
    const zonesByTimeframe = { H1: { zones: h1 }, H4: { zones: h4 } }
    annotateGoldenZones(zonesByTimeframe)

    const h1Support = h1.find((z) => z.category === 'Support')
    assert.equal(h1Support.isGolden, true)
    assert.deepEqual(h1Support.confluence, ['H4'])
  })

  await t.test('does not flag levels that are genuinely far apart', () => {
    const h1 = detectLevels(seriesWithLowPivot(4300), 4305)
    const d1 = detectLevels(seriesWithLowPivot(3800), 3805) // far-away price
    const zonesByTimeframe = { H1: { zones: h1 }, D1: { zones: d1 } }
    annotateGoldenZones(zonesByTimeframe)

    const h1Support = h1.find((z) => z.category === 'Support')
    assert.equal(h1Support.isGolden, false)
    assert.deepEqual(h1Support.confluence, [])
  })

  await t.test('lists every matching timeframe when 3+ are in play at once (production always runs H1+H4+D1 together)', () => {
    const h1 = detectLevels(seriesWithLowPivot(4300), 4305)
    const h4 = detectLevels(seriesWithLowPivot(4300), 4305) // identical -> matches H1
    const d1 = detectLevels(seriesWithLowPivot(3800), 3805) // far away -> matches neither
    const zonesByTimeframe = { H1: { zones: h1 }, H4: { zones: h4 }, D1: { zones: d1 } }
    annotateGoldenZones(zonesByTimeframe)

    const h1Support = h1.find((z) => z.category === 'Support')
    assert.equal(h1Support.isGolden, true)
    assert.deepEqual(h1Support.confluence, ['H4'], 'matches H4 only, not the genuinely-distant D1')

    const d1Support = d1.find((z) => z.category === 'Support')
    assert.equal(d1Support.isGolden, false)
    assert.deepEqual(d1Support.confluence, [])
  })

  await t.test('confluence lists all matching timeframes when a level matches more than one at once', () => {
    const h1 = detectLevels(seriesWithLowPivot(4300), 4305)
    const h4 = detectLevels(seriesWithLowPivot(4300), 4305)
    const d1 = detectLevels(seriesWithLowPivot(4300), 4305) // all three identical -> all match each other
    const zonesByTimeframe = { H1: { zones: h1 }, H4: { zones: h4 }, D1: { zones: d1 } }
    annotateGoldenZones(zonesByTimeframe)

    const h1Support = h1.find((z) => z.category === 'Support')
    assert.equal(h1Support.isGolden, true)
    assert.deepEqual(h1Support.confluence.sort(), ['D1', 'H4'])
  })
})

test('buildSignals', async (t) => {
  await t.test('rejects a resistance-type signal whose entry has fallen below current price', () => {
    // This reproduces a real bug found in production: an H4 SBR-sell zone at 4331.96
    // while the (fresher, H1-sourced) currentPrice had already moved to ~4380 — the
    // level's own H4 candles hadn't caught up to reflect the break yet.
    const zones = [
      {
        category: 'SBR',
        type: 'resistance',
        price: 4331.96,
        mid: 4331.96,
        threshold: 5,
        atr: 10,
        structureAnchor: 4335,
        distanceFromPrice: 48.04,
        isGolden: false,
        confluence: [],
      },
    ]
    assert.deepEqual(buildSignals(zones, 4380), [])
  })

  await t.test('rejects a support-type signal whose entry is already above current price', () => {
    const zones = [
      {
        category: 'RBS',
        type: 'support',
        price: 4400,
        mid: 4400,
        threshold: 5,
        atr: 10,
        structureAnchor: 4395,
        distanceFromPrice: 100,
        isGolden: false,
        confluence: [],
      },
    ]
    assert.deepEqual(buildSignals(zones, 4300), [])
  })

  await t.test('price sitting exactly on the entry is still valid (the fill point itself)', () => {
    const zones = [
      {
        category: 'Support',
        type: 'support',
        price: 4301,
        mid: 4301,
        threshold: 5,
        atr: 10,
        structureAnchor: 4295,
        distanceFromPrice: 0,
        isGolden: false,
        confluence: [],
      },
    ]
    const signals = buildSignals(zones, 4301)
    assert.equal(signals.length, 1)
    assert.equal(signals[0].direction, 'buy')
  })

  await t.test('no signals at all when currentPrice is missing', () => {
    const zones = [
      { category: 'Support', type: 'support', price: 4301, mid: 4301, threshold: 5, distanceFromPrice: 0 },
    ]
    assert.deepEqual(buildSignals(zones, null), [])
    assert.deepEqual(buildSignals(zones, undefined), [])
  })

  await t.test('picks the nearest qualifying zone on each side, one buy + one sell', () => {
    const near = {
      category: 'Support',
      type: 'support',
      price: 4295,
      mid: 4295,
      threshold: 5,
      atr: 10,
      structureAnchor: 4290,
      distanceFromPrice: 5,
      isGolden: false,
      confluence: [],
    }
    const far = { ...near, category: 'RBS', price: 4200, mid: 4200, distanceFromPrice: 100, structureAnchor: 4195 }
    const resistance = {
      category: 'Resistance',
      type: 'resistance',
      price: 4310,
      mid: 4310,
      threshold: 5,
      atr: 10,
      structureAnchor: 4315,
      distanceFromPrice: 10,
      isGolden: false,
      confluence: [],
    }
    const signals = buildSignals([near, far, resistance], 4300)
    assert.equal(signals.length, 2)
    assert.equal(signals.find((s) => s.direction === 'buy').category, 'Support')
    assert.equal(signals.find((s) => s.direction === 'sell').category, 'Resistance')
  })
})

test('SL sizing edge cases (via buildSignals -> buildSignalForZone -> structuralSlDistance)', async (t) => {
  function zoneWith(overrides) {
    return {
      category: 'RBS',
      type: 'support',
      price: 4295.86705,
      mid: 4295.86705,
      threshold: 5.68,
      distanceFromPrice: 5,
      isGolden: false,
      confluence: [],
      ...overrides,
    }
  }

  await t.test('atr === 0 (flat/glitched candles) falls back to a threshold-derived ATR instead of collapsing to 0', () => {
    const zone = zoneWith({ atr: 0, structureAnchor: 4262.11 })
    const [signal] = buildSignals([zone], 4300)
    assert.notEqual(signal.sl, signal.entry, 'SL must not collapse onto entry')
    assert.ok(signal.tp.length > 0, 'TP list must not be wiped out by a zero-risk signal')
  })

  await t.test('a missing/corrupt structureAnchor degrades to a pure volatility-based distance, not NaN', () => {
    const zone = zoneWith({ atr: 10, structureAnchor: undefined })
    const [signal] = buildSignals([zone], 4300)
    assert.equal(Number.isNaN(signal.sl), false)
    assert.ok(signal.tp.length > 0)
  })

  await t.test('a very deep wick is capped rather than producing an oversized SL', () => {
    const zone = zoneWith({ atr: 3, structureAnchor: 4200 }) // ~96 points away — way more than 1.5x atr
    const [signal] = buildSignals([zone], 4300)
    const distance = Math.abs(signal.entry - signal.sl)
    assert.ok(distance <= 3 * 1.5 + 1e-9, `SL distance ${distance} should be capped near 1.5x ATR`)
  })

  await t.test('a wick sitting right on the level is floored rather than producing a razor-thin SL', () => {
    const zone = zoneWith({ atr: 3, structureAnchor: 4295.8 }) // basically no wick beyond the level
    const [signal] = buildSignals([zone], 4300)
    const distance = Math.abs(signal.entry - signal.sl)
    assert.ok(distance >= 3 * 0.5 - 1e-9, `SL distance ${distance} should be floored near 0.5x ATR`)
  })
})

test('take-profit building and display-collision dedup', async (t) => {
  function buySignalWith(targetZones, entry = 4359, sl = 4356) {
    const zone = {
      category: 'RBS',
      type: 'support',
      price: entry,
      mid: entry,
      threshold: 0.88,
      atr: 3,
      structureAnchor: sl,
      distanceFromPrice: 1,
      isGolden: false,
      confluence: [],
    }
    return buildSignals([zone, ...targetZones], entry + 1)[0]
  }

  await t.test('two different-category zones at (almost) the same price collapse into one TP', () => {
    const a = {
      category: 'Resistance',
      type: 'resistance',
      price: 4399.55,
      mid: 4399.55,
      threshold: 0.88,
      atr: 3,
      structureAnchor: 4402,
      distanceFromPrice: 40,
      isGolden: false,
      confluence: [],
    }
    const b = { ...a, category: 'SBR', price: 4400.44, mid: 4400.44, structureAnchor: 4403 }
    const signal = buySignalWith([a, b])
    assert.equal(signal.tp.length, 1, 'should collapse into a single TP, not two nearly-identical ones')
  })

  await t.test('genuinely distinct targets are not over-merged', () => {
    const a = {
      category: 'Resistance',
      type: 'resistance',
      price: 4400,
      mid: 4400,
      threshold: 0.88,
      atr: 3,
      structureAnchor: 4402,
      distanceFromPrice: 40,
      isGolden: false,
      confluence: [],
    }
    const b = { ...a, category: 'SBR', price: 4415, mid: 4415, structureAnchor: 4417 }
    const signal = buySignalWith([a, b])
    assert.equal(signal.tp.length, 2)
  })

  await t.test('falls back to fixed R-multiples when no opposite-side zone qualifies', () => {
    const signal = buySignalWith([])
    assert.equal(signal.tp.length, 3)
    signal.tp.forEach((t, i) => assert.ok(Math.abs(t.rr - [1.5, 2.5, 3.5][i]) < 1e-6))
  })

  await t.test('more than 3 qualifying opposite-side zones all surface — no cap', () => {
    const zones = [4370, 4380, 4390, 4400, 4410].map((price, i) => ({
      category: i % 2 ? 'SBR' : 'Resistance',
      type: 'resistance',
      price,
      mid: price,
      threshold: 0.88,
      atr: 3,
      structureAnchor: price + 3,
      distanceFromPrice: 40,
      isGolden: false,
      confluence: [],
    }))
    const signal = buySignalWith(zones)
    assert.equal(signal.tp.length, 5, 'every genuinely distinct zone becomes its own TP, not just the first 3')
  })

  await t.test('excludes a target 100R or beyond, but keeps a genuinely closer one', () => {
    // structuralSlDistance recalculates the actual SL from the zone's own ATR/wick
    // rather than using the raw entry/sl passed to buySignalWith directly — read the
    // real risk back off a baseline signal instead of assuming it matches those inputs.
    const risk = Math.abs(buySignalWith([]).entry - buySignalWith([]).sl)
    const entry = 4359
    const tooFar = {
      category: 'Resistance',
      type: 'resistance',
      price: entry + risk * 120, // 120R — well past the ceiling
      mid: entry + risk * 120,
      threshold: 0.88,
      atr: 3,
      structureAnchor: entry + risk * 120 + 3,
      distanceFromPrice: 40,
      isGolden: false,
      confluence: [],
    }
    const closer = { ...tooFar, category: 'SBR', price: entry + risk * 10, mid: entry + risk * 10 } // 10R
    const signal = buySignalWith([tooFar, closer])
    assert.equal(signal.tp.length, 1, 'the 120R target is dropped, only the 10R one surfaces')
    assert.ok(Math.abs(signal.tp[0].rr - 10) < 1e-6)
  })

  await t.test('falls back to fixed R-multiples when every qualifying zone is 100R or beyond', () => {
    const risk = Math.abs(buySignalWith([]).entry - buySignalWith([]).sl)
    const entry = 4359
    const tooFar = {
      category: 'Resistance',
      type: 'resistance',
      price: entry + risk * 150,
      mid: entry + risk * 150,
      threshold: 0.88,
      atr: 3,
      structureAnchor: entry + risk * 150 + 3,
      distanceFromPrice: 40,
      isGolden: false,
      confluence: [],
    }
    const signal = buySignalWith([tooFar])
    assert.equal(signal.tp.length, 3)
    signal.tp.forEach((t, i) => assert.ok(Math.abs(t.rr - [1.5, 2.5, 3.5][i]) < 1e-6))
  })

  await t.test('excludes a target under 0.5R, but keeps a genuinely-rewarding one', () => {
    // Symmetric case to the 100R ceiling above — a zone sitting almost on top of
    // entry is a "TP" worth basically nothing (see MIN_ZONE_TP_RR's own comment).
    const risk = Math.abs(buySignalWith([]).entry - buySignalWith([]).sl)
    const entry = 4359
    const tooClose = {
      category: 'Resistance',
      type: 'resistance',
      price: entry + risk * 0.2, // 0.2R — under the 0.5R floor
      mid: entry + risk * 0.2,
      threshold: 0.88,
      atr: 3,
      structureAnchor: entry + risk * 0.2 + 3,
      distanceFromPrice: 40,
      isGolden: false,
      confluence: [],
    }
    const farEnough = { ...tooClose, category: 'SBR', price: entry + risk * 5, mid: entry + risk * 5 } // 5R
    const signal = buySignalWith([tooClose, farEnough])
    assert.equal(signal.tp.length, 1, 'the 0.2R target is dropped, only the 5R one surfaces')
    assert.ok(Math.abs(signal.tp[0].rr - 5) < 1e-6)
  })

  await t.test('falls back to fixed R-multiples when every qualifying zone is under 0.5R', () => {
    const risk = Math.abs(buySignalWith([]).entry - buySignalWith([]).sl)
    const entry = 4359
    const tooClose = {
      category: 'Resistance',
      type: 'resistance',
      price: entry + risk * 0.1,
      mid: entry + risk * 0.1,
      threshold: 0.88,
      atr: 3,
      structureAnchor: entry + risk * 0.1 + 3,
      distanceFromPrice: 40,
      isGolden: false,
      confluence: [],
    }
    const signal = buySignalWith([tooClose])
    assert.equal(signal.tp.length, 3)
    signal.tp.forEach((t, i) => assert.ok(Math.abs(t.rr - [1.5, 2.5, 3.5][i]) < 1e-6))
  })
})

test('buildSignals: cross-timeframe TP borrowing (higher timeframes only)', async (t) => {
  function activeSupportZone() {
    return {
      category: 'Support',
      type: 'support',
      price: 4300,
      mid: 4300,
      threshold: 2, // small — active (e.g. H1) timeframe's own scale
      atr: 3,
      structureAnchor: 4295,
      distanceFromPrice: 5,
      isGolden: false,
      confluence: [],
    }
  }

  function higherTfResistance(price, overrides = {}) {
    return {
      category: 'Resistance',
      type: 'resistance',
      price,
      mid: price,
      threshold: 20, // much larger — a higher timeframe's own (bigger) scale
      atr: 30,
      structureAnchor: price + 15,
      distanceFromPrice: 100,
      isGolden: false,
      confluence: [],
      ...overrides,
    }
  }

  await t.test('a borrowed higher-timeframe zone becomes an extra TP when none exist locally', () => {
    const zone = activeSupportZone()
    const higherTfZones = [higherTfResistance(4340)]
    const [signal] = buildSignals([zone], 4300, higherTfZones)
    assert.equal(signal.tp.length, 1)
    assert.equal(signal.tp[0].price, 4340)
  })

  await t.test('same-timeframe and borrowed targets are merged and sorted by nearest distance first', () => {
    const zone = activeSupportZone()
    const localResistance = { ...higherTfResistance(4320), threshold: 2, atr: 3 } // local scale
    const higherTfZones = [higherTfResistance(4360), higherTfResistance(4400)]
    const [signal] = buildSignals([zone, localResistance], 4300, higherTfZones)
    assert.deepEqual(
      signal.tp.map((t) => t.price),
      [4320, 4360, 4400],
      'nearest first regardless of which timeframe each target came from'
    )
  })

  await t.test('the merge/dedup distance uses the active zone\'s own (smaller) threshold, not the borrowed zone\'s', () => {
    const zone = activeSupportZone() // threshold: 2
    // Two borrowed targets 5 apart — closer than the borrowed zone's own threshold
    // (20), which would wrongly merge them, but farther than the active zone's
    // threshold (2), which correctly keeps them distinct.
    const higherTfZones = [higherTfResistance(4340), higherTfResistance(4345)]
    const [signal] = buildSignals([zone], 4300, higherTfZones)
    assert.equal(signal.tp.length, 2, 'active-timeframe scale keeps genuinely separated borrowed targets apart')
  })

  await t.test('borrowing is opt-in per call — omitting higherTfZones behaves exactly as before', () => {
    const zone = activeSupportZone()
    const [signal] = buildSignals([zone], 4300)
    assert.equal(signal.tp.length, 3, 'falls back to fixed R-multiples, unaffected by any higher-timeframe zone')
  })
})
