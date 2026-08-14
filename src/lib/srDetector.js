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

// SL placement answers a different question than the breakout threshold above: not
// "when is this level invalid" but "how much room does a live trade actually need".
// It's anchored to the deepest wick that has already tested this level's *current*
// role without closing through it (see roleExtreme in runStateMachine) — i.e. real
// price action that already got rejected here — plus a small buffer, rather than a
// fixed volatility distance that ignores what the candles actually did at the level.
// Still floored and capped by ATR so a razor-thin wick or a freak spike can't push the
// SL to either extreme.
const SL_ATR_FLOOR_MULT = 0.3 // never tighter than this even if the wick sat right on the level
const SL_ATR_CAP_MULT = 1.5 // never wider than this even if the wick spiked hard
const SL_STRUCTURE_BUFFER_RATIO = 0.15 // extra room beyond the wick itself, as a fraction of ATR

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

    // wick: the candle's real high/low, kept alongside the body price so the SL logic
    // can anchor to what actually got rejected here, not just the body that defines the level.
    if (isHigh) highs.push({ index: i, time: candles[i].time, price: hi, wick: candles[i].high })
    if (isLow) lows.push({ index: i, time: candles[i].time, price: lo, wick: candles[i].low })
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
      // roleExtreme starts at the pivot's own wick — the low that already got bought up
      // once, which is the natural first reference for "how far below is this level
      // actually defended".
      supports.unshift({ price: pl.price, state: 0, wasBeyond: false, time: pl.time, roleExtreme: pl.wick })
      if (supports.length > MAX_KEEP) supports.pop()
    }
    const ph = highByPivotIndex.get(confirmedIndex)
    if (ph) {
      resistances.unshift({ price: ph.price, state: 0, wasBeyond: false, time: ph.time, roleExtreme: ph.wick })
      if (resistances.length > MAX_KEEP) resistances.pop()
    }

    const { close, high, low } = candles[i]

    for (const s of supports) {
      if (s.state === 0) {
        // Role = support, invalidated by a close below price — track the deepest low
        // wick seen while still acting as support (a real, already-tested downside).
        const beyond = close < s.price - breakoutThreshold
        if (beyond && !s.wasBeyond) {
          s.state = 1 // support broken -> becomes SBR
          s.roleExtreme = high // fresh reference for the new (resistance) role: this bar's high
        } else {
          s.roleExtreme = Math.min(s.roleExtreme, low)
        }
        s.wasBeyond = beyond
      } else if (s.state === 1) {
        // Role flipped to resistance (SBR) — now track the highest high seen while
        // still holding as resistance.
        const beyond = close > s.price + breakoutThreshold
        if (beyond && !s.wasBeyond) {
          s.state = 2 // SBR broken again -> invalid
        } else {
          s.roleExtreme = Math.max(s.roleExtreme, high)
        }
        s.wasBeyond = beyond
      }
    }

    for (const r of resistances) {
      if (r.state === 0) {
        const beyond = close > r.price + breakoutThreshold
        if (beyond && !r.wasBeyond) {
          r.state = 1 // resistance broken -> becomes RBS
          r.roleExtreme = low // fresh reference for the new (support) role: this bar's low
        } else {
          r.roleExtreme = Math.max(r.roleExtreme, high)
        }
        r.wasBeyond = beyond
      } else if (r.state === 1) {
        const beyond = close < r.price - breakoutThreshold
        if (beyond && !r.wasBeyond) {
          r.state = 2 // RBS broken again -> invalid
        } else {
          r.roleExtreme = Math.min(r.roleExtreme, low)
        }
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
function toZone(level, category, type, currentPrice, breakoutThreshold, atr) {
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
    atr, // carried through for SL sizing (see buildSignalForZone)
    structureAnchor: level.roleExtreme, // deepest wick that already tested this level in its current role
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
    toZone(support, 'Support', 'support', currentPrice, breakoutThreshold, atr),
    toZone(rbs, 'RBS', 'support', currentPrice, breakoutThreshold, atr),
    toZone(resistance, 'Resistance', 'resistance', currentPrice, breakoutThreshold, atr),
    toZone(sbr, 'SBR', 'resistance', currentPrice, breakoutThreshold, atr),
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

// Prices display rounded to the nearest whole unit (see formatPrice in main.js). Two
// targets closer together than that would still round to the *same shown number* even
// after clearing the threshold-based dedup below (e.g. 4399.55 and 4400.44 are 0.89
// apart — more than a ~0.88 breakout threshold, but both round to "4400") — so this is
// enforced as a floor on top of the zone's own (sometimes much smaller) threshold.
const MIN_TP_DISPLAY_SEPARATION = 1

function buildTakeProfits(entryPrice, sl, direction, candidateZones) {
  const risk = Math.abs(entryPrice - sl)
  if (!risk) return []

  const isBuy = direction === 'buy'
  const sortedZones = candidateZones
    .filter((z) => (isBuy ? z.mid > entryPrice : z.mid < entryPrice))
    .filter((z) => Math.abs(z.mid - entryPrice) / risk >= MIN_ZONE_TP_RR)
    .sort((a, b) => (isBuy ? a.mid - b.mid : b.mid - a.mid))

  // Different zone categories (e.g. a fresh Resistance and an older SBR) can sit at
  // the same or near-identical price — collapse those into a single target instead of
  // surfacing "TP1" and "TP2" as the same number.
  const fromZones = []
  for (const z of sortedZones) {
    const last = fromZones[fromZones.length - 1]
    if (last && Math.abs(z.mid - last) <= Math.max(z.threshold, MIN_TP_DISPLAY_SEPARATION)) continue
    fromZones.push(z.mid)
    if (fromZones.length === 3) break
  }

  const targets = fromZones.length
    ? fromZones
    : [1.5, 2.5, 3.5].map((mult) => entryPrice + (isBuy ? 1 : -1) * risk * mult)

  return targets.map((price) => ({ price, rr: Math.abs(price - entryPrice) / risk }))
}

// SL distance = how far beyond the zone's already-tested wick (structureAnchor) plus a
// small buffer, floored/capped by ATR so a wick sitting right on the level (too tight)
// or a freak spike (too wide) can't drag the SL to an extreme.
function structuralSlDistance(zone, isSupport) {
  // A stretch of perfectly flat candles (a data-provider glitch, or a duplicated
  // trailing bar) makes ATR come out as exactly 0 — floor and cap would then both
  // collapse to 0 too, forcing the SL onto the entry price itself (and, via
  // buildTakeProfits' risk === 0 guard, wiping out every TP). zone.threshold never
  // hits 0 (detectLevels floors it at price * 0.0002), so fall back to the ATR that
  // would've produced it as a sane, self-calibrated stand-in.
  const effectiveAtr = zone.atr || zone.threshold / BREAKOUT_ATR_MULT
  const buffer = effectiveAtr * SL_STRUCTURE_BUFFER_RATIO
  const wickDistance = isSupport ? zone.price - zone.structureAnchor : zone.structureAnchor - zone.price
  const raw = wickDistance + buffer
  return Math.min(Math.max(raw, effectiveAtr * SL_ATR_FLOOR_MULT), effectiveAtr * SL_ATR_CAP_MULT)
}

// Turns one level into an actionable LIMIT order idea: these levels are
// reaction/structure zones (support & RBS bid up, resistance & SBR sell off), so every
// signal is a fade at the level itself — entry at the price, SL beyond the deepest wick
// that already tested this level in its current role (see structuralSlDistance), TP at
// the nearest opposite-side levels.
function buildSignalForZone(zone, allZones) {
  const isSupport = zone.type === 'support'
  const direction = isSupport ? 'buy' : 'sell'
  const entry = zone.price
  const slDistance = structuralSlDistance(zone, isSupport)
  const sl = isSupport ? entry - slDistance : entry + slDistance
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
    threshold: zone.threshold, // lets the track record tell "same pivot, recalculated" apart from "replaced by a different one"
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
