// ============================================================================
// Pivot-based Support/Resistance detection.
//
// Per timeframe, tracks the single most recent, still-valid Support, Resistance,
// SBR (Support-Broken-Resistance) and RBS (Resistance-Broken-Support) level, using
// a pivot + 3-state machine:
//   state 0 -> pure Support/Resistance (never broken)
//   state 1 -> broken once -> flips role (Support -> SBR, Resistance -> RBS)
//   state 2 -> broken a second time -> invalid; the next older still-valid pivot
//              takes its place automatically
// A level from one timeframe that lands within tolerance of the same-category level
// from another timeframe is flagged a "Golden Zone" (a cross-timeframe confluence
// signal).
// ============================================================================

const PIVOT_LEFT = 5 // bars required on each side of a swing to confirm it
const PIVOT_RIGHT = 5

const MAX_KEEP = 40 // pivots retained per side/timeframe before the oldest is dropped

// Breakout threshold and Golden Zone tolerance are both derived from each series' own
// ATR — a volatility-scaled "how far counts as a real break" — rather than a fixed
// pip value, so they self-calibrate per instrument and scale naturally with each
// timeframe's own volatility instead of sharing one absolute threshold across D1/H4/H1.
const BREAKOUT_ATR_MULT = 0.15
const GOLDEN_ZONE_ATR_MULT = 0.05
const GOLDEN_ZONE_RATIO = GOLDEN_ZONE_ATR_MULT / BREAKOUT_ATR_MULT

// Each level is a single price, not a touch-clustered range, but the chart draws zones
// as shaded bands — this gives each level a sliver of width around its price purely
// for visibility.
const ZONE_HALF_WIDTH_RATIO = 0.15

function computeATR(candles, period = 14) {
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const prevClose = candles[i - 1].close
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    )
    trs.push(tr)
  }
  const period14 = trs.slice(-period)
  return period14.reduce((a, b) => a + b, 0) / (period14.length || 1)
}

function bodyHigh(c) {
  return Math.max(c.open, c.close)
}
function bodyLow(c) {
  return Math.min(c.open, c.close)
}

// Swing detection on the candle *body*, not the wick, so one long shadow can't fake a level.
function findBodyPivots(candles, left, right) {
  const highs = []
  const lows = []

  for (let i = left; i < candles.length - right; i++) {
    const hi = bodyHigh(candles[i])
    const lo = bodyLow(candles[i])
    let isHigh = true
    let isLow = true

    for (let w = 1; w <= left && (isHigh || isLow); w++) {
      if (bodyHigh(candles[i - w]) >= hi) isHigh = false
      if (bodyLow(candles[i - w]) <= lo) isLow = false
    }
    for (let w = 1; w <= right && (isHigh || isLow); w++) {
      if (bodyHigh(candles[i + w]) >= hi) isHigh = false
      if (bodyLow(candles[i + w]) <= lo) isLow = false
    }

    if (isHigh) highs.push({ index: i, time: candles[i].time, price: hi })
    if (isLow) lows.push({ index: i, time: candles[i].time, price: lo })
  }

  return { highs, lows }
}

// Replays the per-pivot state machine bar-by-bar over the full series, exactly as it
// would evolve live, one candle at a time.
function runStateMachine(candles, breakoutThreshold) {
  const { highs, lows } = findBodyPivots(candles, PIVOT_LEFT, PIVOT_RIGHT)
  const lowByPivotIndex = new Map(lows.map((p) => [p.index, p]))
  const highByPivotIndex = new Map(highs.map((p) => [p.index, p]))

  // Newest pivot at the front — array.unshift onto the front, so index 0 is always latest.
  const supports = []
  const resistances = []

  for (let i = 0; i < candles.length; i++) {
    // A pivot centered `PIVOT_RIGHT` bars back only becomes known as of this bar.
    const confirmedIndex = i - PIVOT_RIGHT
    const pl = lowByPivotIndex.get(confirmedIndex)
    if (pl) {
      supports.unshift({ price: pl.price, state: 0, wasBeyond: false, time: pl.time })
      if (supports.length > MAX_KEEP) supports.pop()
    }
    const ph = highByPivotIndex.get(confirmedIndex)
    if (ph) {
      resistances.unshift({ price: ph.price, state: 0, wasBeyond: false, time: ph.time })
      if (resistances.length > MAX_KEEP) resistances.pop()
    }

    const close = candles[i].close

    for (const s of supports) {
      if (s.state === 0) {
        const beyond = close < s.price - breakoutThreshold
        if (beyond && !s.wasBeyond) s.state = 1 // support broken -> becomes SBR
        s.wasBeyond = beyond
      } else if (s.state === 1) {
        const beyond = close > s.price + breakoutThreshold
        if (beyond && !s.wasBeyond) s.state = 2 // SBR broken again -> invalid
        s.wasBeyond = beyond
      }
    }

    for (const r of resistances) {
      if (r.state === 0) {
        const beyond = close > r.price + breakoutThreshold
        if (beyond && !r.wasBeyond) r.state = 1 // resistance broken -> becomes RBS
        r.wasBeyond = beyond
      } else if (r.state === 1) {
        const beyond = close < r.price - breakoutThreshold
        if (beyond && !r.wasBeyond) r.state = 2 // RBS broken again -> invalid
        r.wasBeyond = beyond
      }
    }
  }

  // "Latest valid" selection: walk newest-to-oldest, take the first still-valid level
  // in each state — invalidated (state 2) levels are simply skipped over, which is how
  // an older still-valid pivot automatically takes over once a newer one is discarded.
  const pickLatest = (arr, wantedState) => arr.find((p) => p.state === wantedState) ?? null

  return {
    support: pickLatest(supports, 0),
    sbr: pickLatest(supports, 1),
    resistance: pickLatest(resistances, 0),
    rbs: pickLatest(resistances, 1),
  }
}

// Converts one detected level into the zone shape the rest of the app (chart, cards,
// signals) renders.
function toZone(level, category, type, currentPrice, breakoutThreshold) {
  if (!level) return null
  const halfWidth = breakoutThreshold * ZONE_HALF_WIDTH_RATIO
  return {
    category, // 'Support' | 'Resistance' | 'SBR' | 'RBS'
    type, // 'support' | 'resistance' — which side/color it renders as
    price: level.price,
    low: level.price - halfWidth,
    high: level.price + halfWidth,
    mid: level.price,
    startTime: level.time,
    broken: level.state === 1,
    threshold: breakoutThreshold,
    distanceFromPrice: Math.abs(currentPrice - level.price),
    isGolden: false, // filled in later by annotateGoldenZones once every timeframe is in
    confluence: [],
  }
}

// Detects the latest Support, Resistance, SBR and RBS levels for one timeframe's
// candles (0-4 zones — old, twice-broken levels are dropped automatically).
export function detectLevels(candles, currentPrice) {
  if (!candles || candles.length < PIVOT_LEFT + PIVOT_RIGHT + 1) return []

  const atr = computeATR(candles)
  const breakoutThreshold = Math.max(atr * BREAKOUT_ATR_MULT, currentPrice * 0.0002)

  const { support, resistance, sbr, rbs } = runStateMachine(candles, breakoutThreshold)

  return [
    toZone(support, 'Support', 'support', currentPrice, breakoutThreshold),
    toZone(rbs, 'RBS', 'support', currentPrice, breakoutThreshold),
    toZone(resistance, 'Resistance', 'resistance', currentPrice, breakoutThreshold),
    toZone(sbr, 'SBR', 'resistance', currentPrice, breakoutThreshold),
  ].filter(Boolean)
}

// Golden Zone: flags (and cross-links) any level that lands within tolerance of the
// same-category level from another timeframe. Mutates each timeframe's zones in place.
export function annotateGoldenZones(zonesByTimeframe) {
  const entries = Object.entries(zonesByTimeframe).filter(([, result]) => Array.isArray(result?.zones))

  for (const [tfKey, result] of entries) {
    for (const zone of result.zones) {
      const matches = entries
        .filter(([otherTf]) => otherTf !== tfKey)
        .filter(([, otherResult]) =>
          otherResult.zones.some(
            (z) =>
              z.category === zone.category &&
              Math.abs(z.price - zone.price) <= Math.min(zone.threshold, z.threshold) * GOLDEN_ZONE_RATIO
          )
        )
        .map(([otherTf]) => otherTf)

      zone.confluence = matches
      zone.isGolden = matches.length > 0
    }
  }
}

// A zone sitting almost on top of entry (e.g. two nearby levels on the same side)
// would otherwise surface as a "TP" worth basically nothing — require at least this
// much reward before trusting a level as a target over the fixed R-multiple fallback.
const MIN_ZONE_TP_RR = 0.5

function buildTakeProfits(entryPrice, sl, direction, candidateZones) {
  const risk = Math.abs(entryPrice - sl)
  if (!risk) return []

  const isBuy = direction === 'buy'
  const fromZones = candidateZones
    .map((z) => z.mid)
    .filter((price) => (isBuy ? price > entryPrice : price < entryPrice))
    .filter((price) => Math.abs(price - entryPrice) / risk >= MIN_ZONE_TP_RR)
    .sort((a, b) => (isBuy ? a - b : b - a))
    .slice(0, 3)

  const targets = fromZones.length
    ? fromZones
    : [1.5, 2.5, 3.5].map((mult) => entryPrice + (isBuy ? 1 : -1) * risk * mult)

  return targets.map((price) => ({ price, rr: Math.abs(price - entryPrice) / risk }))
}

// Turns one level into an actionable LIMIT order idea: these levels are
// reaction/structure zones (support & RBS bid up, resistance & SBR sell off), so every
// signal is a fade at the level itself — entry at the price, SL just beyond the
// breakout threshold that would invalidate it, TP at the nearest opposite-side levels.
function buildSignalForZone(zone, allZones) {
  const isSupport = zone.type === 'support'
  const direction = isSupport ? 'buy' : 'sell'
  const entry = zone.price
  const sl = isSupport ? zone.low - zone.threshold : zone.high + zone.threshold
  const targetPool = allZones.filter((z) => z.type !== zone.type)
  const tp = buildTakeProfits(entry, sl, direction, targetPool)

  return {
    zoneType: zone.type,
    category: zone.category,
    direction,
    orderType: 'LIMIT',
    entry,
    sl,
    tp,
    strengthLabel: zone.isGolden ? 'Strong' : 'Medium',
    confluence: zone.confluence,
  }
}

// One signal for the nearest qualifying bullish level (Support/RBS), one for the
// nearest qualifying bearish level (Resistance/SBR) — both sides of price get an idea.
export function buildSignals(zones) {
  if (!zones.length) return []

  const byDistance = (a, b) => a.distanceFromPrice - b.distanceFromPrice
  const nearestBullish = zones.filter((z) => z.type === 'support').sort(byDistance)[0]
  const nearestBearish = zones.filter((z) => z.type === 'resistance').sort(byDistance)[0]

  return [nearestBullish, nearestBearish].filter(Boolean).map((zone) => buildSignalForZone(zone, zones))
}
