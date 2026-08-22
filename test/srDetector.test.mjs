import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectLevels, annotateGoldenZones, buildSignals, isPriceStagnant, computeTrend } from '../src/lib/srDetector.js'

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

// A flat run at `base` for `count` bars, then `count` more drifting by `stepPerBar`
// each bar — enough bars for computeTrend's 50-period SMA plus real ATR-scale movement
// to clear its neutral band.
function trendingSeries(base, stepPerBar, count = 60) {
  const candles = []
  for (let i = 0; i < count; i++) candles.push(candle(i, base, base + 1, base - 1, base))
  for (let i = 0; i < count; i++) {
    const price = base + stepPerBar * (i + 1)
    candles.push(candle(count + i, price, price + 1, price - 1, price))
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

  // Regression test for a real production bug found the same day: an earlier version
  // of the amplitude check required the candidate to clear *every individual neighbor*
  // by minAmplitude — which rejected a genuine double-bottom (today's low landing a
  // few cents above yesterday's close, a real retest) even though the rest of the
  // window spanned nearly $100, because that one adjacent candle happened to be close.
  // Checking the *whole window's* range instead of every neighbor individually fixes
  // this while still rejecting the near-frozen case above.
  await t.test('a real double-bottom (today\'s low lands just above yesterday\'s close/low) is still recognized', () => {
    const base = 4300
    const candles = []
    let t = 0
    // Wide chop well away from the eventual low pair — establishes plenty of genuine
    // range across the window, unlike the frozen-market case above.
    for (let i = 0; i < 5; i++) candles.push(candle(t++, base + 80, base + 90, base + 70, base + 85))
    // Yesterday: closes right at the bottom of a selloff.
    candles.push(candle(t++, base + 5, base + 10, base, base + 0.5))
    // Today (the pivot candidate): opens almost exactly where yesterday closed, dips a
    // hair lower intrabar, then rallies hard — a real retest, not noise.
    candles.push(candle(t++, base + 0.4, base + 60, base - 1, base + 55))
    for (let i = 0; i < 5; i++) candles.push(candle(t++, base + 50, base + 65, base + 40, base + 55))
    const zones = detectLevels(candles, candles.at(-1).close)
    const support = zones.find((z) => z.category === 'Support')
    assert.ok(support, 'the retested low must still be recognized as a pivot')
    assert.equal(support.price, base + 0.4)
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

test('computeTrend', async (t) => {
  await t.test('a sustained climb well past the neutral band reads as up', () => {
    assert.equal(computeTrend(trendingSeries(4300, 0.5)), 'up')
  })

  await t.test('a sustained decline well past the neutral band reads as down', () => {
    assert.equal(computeTrend(trendingSeries(4300, -0.5)), 'down')
  })

  await t.test('flat chop (price near its own recent average) reads as neutral', () => {
    const candles = []
    for (let i = 0; i < 60; i++) candles.push(candle(i, 4300, 4300.2, 4299.8, 4300))
    assert.equal(computeTrend(candles), 'neutral')
  })

  await t.test('fewer candles than the SMA period defaults to neutral rather than guessing', () => {
    assert.equal(computeTrend(trendingSeries(4300, 0.5, 10)), 'neutral')
  })

  await t.test('no candles at all defaults to neutral', () => {
    assert.equal(computeTrend(null), 'neutral')
    assert.equal(computeTrend([]), 'neutral')
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

  function supportZone(overrides = {}) {
    return {
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
      ...overrides,
    }
  }

  function resistanceZone(overrides = {}) {
    return {
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
      ...overrides,
    }
  }

  await t.test('an "up" trend marks only the bearish (sell) side not-aligned — both sides still returned', () => {
    // Not omitted from the array entirely: an already-open pending record on the
    // off-trend side must keep matching against this list (see recordSignals in
    // signalHistoryCore.js) or it gets dropped-and-recreated the moment trend flips.
    const signals = buildSignals([supportZone(), resistanceZone()], 4300, [], 'up')
    assert.equal(signals.length, 2)
    assert.equal(signals.find((s) => s.direction === 'buy').trendAligned, true)
    assert.equal(signals.find((s) => s.direction === 'sell').trendAligned, false)
  })

  await t.test('a "down" trend marks only the bullish (buy) side not-aligned', () => {
    const signals = buildSignals([supportZone(), resistanceZone()], 4300, [], 'down')
    assert.equal(signals.length, 2)
    assert.equal(signals.find((s) => s.direction === 'buy').trendAligned, false)
    assert.equal(signals.find((s) => s.direction === 'sell').trendAligned, true)
  })

  await t.test('"neutral" (or omitting trend entirely) marks both sides aligned, same as before trend filtering existed', () => {
    for (const signals of [
      buildSignals([supportZone(), resistanceZone()], 4300, [], 'neutral'),
      buildSignals([supportZone(), resistanceZone()], 4300, []),
    ]) {
      assert.equal(signals.length, 2)
      assert.ok(signals.every((s) => s.trendAligned === true))
    }
  })

  await t.test('a zone flagged not-tradeable is excluded even though it would otherwise qualify', () => {
    const signals = buildSignals([supportZone({ tradeable: false }), resistanceZone()], 4300)
    assert.equal(signals.length, 1)
    assert.equal(signals[0].direction, 'sell')
  })

  await t.test('a zone with no `tradeable` field at all (e.g. a never-broken Support/Resistance) is still offered', () => {
    // toZone only sets tradeable=false for a broken level that fails its
    // quality/pullback-extent check — a pure, never-broken level has no such field.
    const { tradeable, ...withoutTradeable } = supportZone()
    const signals = buildSignals([withoutTradeable, resistanceZone()], 4300)
    assert.equal(signals.length, 2)
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

// 2026-08-17 win-rate review: the tests below cover the concrete behavior changes made
// to runStateMachine/toZone off of that review — level freshness (testCount/
// strengthLabel) and breakout-quality gating (pullback extent, and volume/body-ratio
// conviction) that decides whether a broken level is `tradeable`. The breakout-
// persistence gate (requiring 2 consecutive confirming closes) that used to also be
// covered here was reverted 2026-08-23 — see BREAKOUT_CONFIRM_BARS' own comment — a
// single confirming close now flips a level immediately, covered below instead.

test('breakout confirmation is instant — a single confirming close flips the level right away', async (t) => {
  await t.test('one close beyond threshold flips Support straight to SBR, no second confirming bar needed', () => {
    const candles = seriesWithLowPivot(4300)
    let t2 = candles.length
    candles.push(candle(t2++, 4278, 4279, 4275, 4278)) // one close well beyond threshold
    const zones = detectLevels(candles, candles.at(-1).close)
    assert.equal(zones.find((z) => z.category === 'Support'), undefined, 'no longer a pure Support')
    const sbr = zones.find((z) => z.category === 'SBR')
    assert.ok(sbr, 'expected the level to have flipped on this very candle')
    assert.equal(sbr.broken, true)
  })

  await t.test('a sustained break (many holding candles) still flips and stays flipped', () => {
    const candles = seriesWithLowPivot(4300, { breakBelow: true }) // holds below for many bars
    const zones = detectLevels(candles, candles.at(-1).close)
    assert.ok(zones.find((z) => z.category === 'SBR'), 'expected the level to have flipped')
  })
})

test('detectLevels: level freshness (testCount)', async (t) => {
  await t.test('a level nobody has come back to test yet has testCount 0', () => {
    const candles = seriesWithLowPivot(4300)
    const support = detectLevels(candles, candles.at(-1).close).find((z) => z.category === 'Support')
    assert.equal(support.testCount, 0)
  })

  await t.test('price dipping back near the level (without breaking it) increases testCount', () => {
    const base = seriesWithLowPivot(4300)
    const before = detectLevels(base, base.at(-1).close).find((z) => z.category === 'Support')
    let t2 = base.length
    const dip = before.price - before.threshold * 0.5 // within threshold, not beyond it
    const approach = [
      candle(t2++, before.price + 3, before.price + 4, dip, before.price + 3),
      candle(t2++, before.price + 8, before.price + 9, before.price + 7, before.price + 8), // pulls away
    ]
    const after = detectLevels([...base, ...approach], approach.at(-1).close).find((z) => z.category === 'Support')
    assert.ok(after.testCount > before.testCount, 'a real approach that did not break the level should be counted')
  })
})

test('strengthLabel reflects Golden Zone confluence and level freshness', async (t) => {
  function zoneWithTestCount(testCount, overrides = {}) {
    return {
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
      testCount,
      ...overrides,
    }
  }

  await t.test('a Golden Zone (isGolden) is Strong regardless of testCount', () => {
    const [signal] = buildSignals([zoneWithTestCount(5, { isGolden: true, confluence: ['H4'] })], 4300)
    assert.equal(signal.strengthLabel, 'Strong')
  })

  await t.test('a level tested 3+ times without breaking is downgraded to Weak', () => {
    const [signal] = buildSignals([zoneWithTestCount(3)], 4300)
    assert.equal(signal.strengthLabel, 'Weak')
  })

  await t.test('a fresh level (below the weaken threshold) stays Medium', () => {
    const [signal] = buildSignals([zoneWithTestCount(1)], 4300)
    assert.equal(signal.strengthLabel, 'Medium')
  })

  await t.test('a level with no testCount at all (e.g. pre-existing detectLevels output) defaults to Medium, not Weak', () => {
    const { testCount, ...withoutTestCount } = zoneWithTestCount(0)
    const [signal] = buildSignals([withoutTestCount], 4300)
    assert.equal(signal.strengthLabel, 'Medium')
  })
})

test('detectLevels: pullback extent gates whether a broken level is offered as tradeable', async (t) => {
  // Both scenarios use a strong, full-bodied breakout candle (so the quality gate
  // covered in the block below always passes) — isolating extent as the only thing
  // that varies between them.
  function strongBreakoutCandle(t, price) {
    return candle(t, price + 1, price + 1.1, price - 0.1, price)
  }

  await t.test('a break that clearly runs well past the level is tradeable', () => {
    const candles = seriesWithLowPivot(4300)
    const support = detectLevels(candles, candles.at(-1).close).find((z) => z.category === 'Support')
    let t2 = candles.length
    const p = support.price - support.threshold - 5
    const extra = [
      strongBreakoutCandle(t2++, p),
      strongBreakoutCandle(t2++, p - 1),
      strongBreakoutCandle(t2++, p - 20), // plenty of follow-through
    ]
    const sbr = detectLevels([...candles, ...extra], extra.at(-1).close).find((z) => z.category === 'SBR')
    assert.ok(sbr, 'expected the level to have flipped to SBR')
    assert.equal(sbr.tradeable, true)
  })

  await t.test('a break that barely clears threshold and never extends further is not yet tradeable', () => {
    const candles = seriesWithLowPivot(4300)
    const support = detectLevels(candles, candles.at(-1).close).find((z) => z.category === 'Support')
    let t2 = candles.length
    // Just barely beyond the breakout threshold, held there for 2 confirming bars, but
    // never actually extends any further in the breakout direction.
    const p = support.price - support.threshold - 0.05
    const extra = [strongBreakoutCandle(t2++, p), strongBreakoutCandle(t2++, p)]
    const sbr = detectLevels([...candles, ...extra], extra.at(-1).close).find((z) => z.category === 'SBR')
    assert.ok(sbr, 'expected the level to have flipped to SBR')
    assert.equal(sbr.tradeable, false, 'not enough follow-through yet to count as a real pullback opportunity')
  })
})

test('detectLevels: breakout-quality gating (volume where available, body-ratio proxy otherwise)', async (t) => {
  await t.test('a low-volume breakout candle is not tradeable even with plenty of follow-through', () => {
    const base = seriesWithLowPivot(4300).map((c) => ({ ...c, volume: 100 })) // steady trailing volume
    const support = detectLevels(base, base.at(-1).close).find((z) => z.category === 'Support')
    let t2 = base.length
    const p = support.price - support.threshold - 5
    const extra = [
      { ...candle(t2++, p, p + 1, p - 1, p), volume: 10 }, // thin — well under 1.2x the ~100 trailing average
      { ...candle(t2++, p - 1, p, p - 2, p - 1), volume: 100 },
      { ...candle(t2++, p - 20, p - 19, p - 21, p - 20), volume: 100 }, // plenty of follow-through
    ]
    const sbr = detectLevels([...base, ...extra], extra.at(-1).close).find((z) => z.category === 'SBR')
    assert.ok(sbr)
    assert.equal(sbr.tradeable, false, 'a breakout candle with well-below-average volume should not confirm')
  })

  await t.test('a high-volume breakout candle with follow-through is tradeable', () => {
    const base = seriesWithLowPivot(4300).map((c) => ({ ...c, volume: 100 }))
    const support = detectLevels(base, base.at(-1).close).find((z) => z.category === 'Support')
    let t2 = base.length
    const p = support.price - support.threshold - 5
    const extra = [
      { ...candle(t2++, p, p + 1, p - 1, p), volume: 500 }, // well over 1.2x average
      { ...candle(t2++, p - 1, p, p - 2, p - 1), volume: 100 },
      { ...candle(t2++, p - 20, p - 19, p - 21, p - 20), volume: 100 },
    ]
    const sbr = detectLevels([...base, ...extra], extra.at(-1).close).find((z) => z.category === 'SBR')
    assert.ok(sbr)
    assert.equal(sbr.tradeable, true)
  })

  await t.test('with no volume data, a small-bodied (near-doji) breakout candle falls back to the body-ratio proxy and is not tradeable', () => {
    const base = seriesWithLowPivot(4300) // no volume field anywhere
    const support = detectLevels(base, base.at(-1).close).find((z) => z.category === 'Support')
    let t2 = base.length
    const p = support.price - support.threshold - 5
    // Long wicks both ways, indecisive close near the open — a volume-less proxy for
    // thin conviction.
    const extra = [
      candle(t2++, p, p + 10, p - 10, p + 0.5),
      candle(t2++, p, p + 1, p - 1, p),
      candle(t2++, p - 20, p - 19, p - 21, p - 20),
    ]
    const sbr = detectLevels([...base, ...extra], extra.at(-1).close).find((z) => z.category === 'SBR')
    assert.ok(sbr)
    assert.equal(sbr.tradeable, false)
  })

  await t.test('with no volume data, a strong full-bodied breakout candle is tradeable', () => {
    const base = seriesWithLowPivot(4300)
    const support = detectLevels(base, base.at(-1).close).find((z) => z.category === 'Support')
    let t2 = base.length
    const p = support.price - support.threshold - 5
    const extra = [
      candle(t2++, p + 1, p + 1.1, p - 0.1, p), // decisive, mostly-body candle
      candle(t2++, p, p + 1, p - 1, p),
      candle(t2++, p - 20, p - 19, p - 21, p - 20),
    ]
    const sbr = detectLevels([...base, ...extra], extra.at(-1).close).find((z) => z.category === 'SBR')
    assert.ok(sbr)
    assert.equal(sbr.tradeable, true)
  })
})
