const FRACTAL_WING = 2 // bars on each side to confirm a swing point

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

function findSwingPoints(candles) {
  const swings = []
  for (let i = FRACTAL_WING; i < candles.length - FRACTAL_WING; i++) {
    const c = candles[i]
    let isHigh = true
    let isLow = true
    for (let w = 1; w <= FRACTAL_WING; w++) {
      if (candles[i - w].high >= c.high || candles[i + w].high >= c.high) isHigh = false
      if (candles[i - w].low <= c.low || candles[i + w].low <= c.low) isLow = false
    }
    if (isHigh) swings.push({ index: i, price: c.high, time: c.time, type: 'high' })
    if (isLow) swings.push({ index: i, price: c.low, time: c.time, type: 'low' })
  }
  return swings
}

// Merge swing points into zones when they sit within `tolerance` of each other.
// Capped at maxSpanMultiplier * tolerance total width, otherwise a chain of points each
// individually close to its neighbor (but far apart end-to-end) would merge into one
// unbounded "zone" spanning way more price than a real S/R level ever should.
function clusterSwings(swings, tolerance, maxSpanMultiplier = 2) {
  const sorted = [...swings].sort((a, b) => a.price - b.price)
  const clusters = []
  let current = []

  for (const s of sorted) {
    const withinGap = current.length === 0 || s.price - current[current.length - 1].price <= tolerance
    const withinSpan = current.length === 0 || s.price - current[0].price <= tolerance * maxSpanMultiplier
    if (withinGap && withinSpan) {
      current.push(s)
    } else {
      clusters.push(current)
      current = [s]
    }
  }
  if (current.length) clusters.push(current)
  return clusters
}

// Group consecutive candles that poke into the zone into single "events" (so a slow
// grind through the zone isn't inflated into many touches), keeping the index of the
// candle right after each event so we can tell whether price bounced back or blew through.
function findTouchEvents(candles, low, high) {
  const events = []
  let eventIndices = []

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const touches = c.high >= low && c.low <= high
    if (touches) {
      eventIndices.push(i)
    } else if (eventIndices.length) {
      events.push(eventIndices)
      eventIndices = []
    }
  }
  if (eventIndices.length) events.push(eventIndices)
  return events
}

// A zone only "holds" if price is rejected back to the side matching its current
// role. If the candle right after the event closes clean through the other side,
// the level failed at that point in time — it shouldn't count as proof the zone works.
function classifyEvent(indices, candles, zoneLow, zoneHigh, isSupport) {
  const next = candles[indices[indices.length - 1] + 1]
  if (!next) return 'pending' // still unresolved at the edge of the dataset
  if (isSupport) {
    if (next.close > zoneHigh) return 'hold'
    if (next.close < zoneLow) return 'break'
  } else {
    if (next.close < zoneLow) return 'hold'
    if (next.close > zoneHigh) return 'break'
  }
  return 'pending'
}

function wickRejectionRatio(candle, isSupport) {
  const range = candle.high - candle.low
  if (range <= 0) return 0
  if (isSupport) {
    const wick = Math.min(candle.open, candle.close) - candle.low
    return Math.max(0, wick / range)
  }
  const wick = candle.high - Math.max(candle.open, candle.close)
  return Math.max(0, wick / range)
}

function scoreZone({ holdEvents, breakCount, candles, zoneLow, zoneHigh, isSupport, lastCandleTime, firstCandleTime }) {
  const touchCount = holdEvents.length
  const touchScore = (Math.min(touchCount, 8) / 8) * 40

  const lastEventIndices = holdEvents[holdEvents.length - 1]
  const lastTouchTime = candles[lastEventIndices[lastEventIndices.length - 1]].time
  const totalSpan = lastCandleTime - firstCandleTime || 1
  const recencyRatio = 1 - (lastCandleTime - lastTouchTime) / totalSpan
  const recencyScore = Math.max(0, Math.min(1, recencyRatio)) * 25

  const rejectionRatios = holdEvents.map((indices) => {
    return indices.reduce((max, idx) => {
      const r = wickRejectionRatio(candles[idx], isSupport)
      return r > max ? r : max
    }, 0)
  })
  const avgRejection = rejectionRatios.reduce((a, b) => a + b, 0) / (rejectionRatios.length || 1)
  const rejectionScore = avgRejection * 20

  const priceSpan = zoneHigh - zoneLow
  const referencePrice = (zoneHigh + zoneLow) / 2
  const tightnessRatio = 1 - Math.min(1, priceSpan / (referencePrice * 0.01))
  const tightnessScore = Math.max(0, tightnessRatio) * 15

  const rawScore = touchScore + recencyScore + rejectionScore + tightnessScore

  // Zones that have failed before are less trustworthy than a clean, unbroken level,
  // even if they've since re-established themselves — dampen the score accordingly.
  const reliability = touchCount / (touchCount + breakCount)
  const reliabilityMultiplier = 0.6 + 0.4 * reliability
  const total = rawScore * reliabilityMultiplier

  return {
    total: Math.round(Math.max(0, Math.min(100, total))),
    touchCount,
    lastTouchTime,
  }
}

function strengthLabel(score) {
  if (score >= 70) return 'Strong'
  if (score >= 40) return 'Medium'
  return 'Weak'
}

export function detectZones(candles, currentPrice, maxZonesPerSide = 3) {
  if (!candles || candles.length < FRACTAL_WING * 2 + 5) return []

  const atr = computeATR(candles)
  const tolerance = Math.max(atr * 0.5, currentPrice * 0.0005)

  const swings = findSwingPoints(candles)
  if (!swings.length) return []

  const clusters = clusterSwings(swings, tolerance)
  const firstCandleTime = candles[0].time
  const lastCandleTime = candles[candles.length - 1].time

  const zones = clusters
    .map((cluster) => {
      const prices = cluster.map((s) => s.price)
      const zoneLow = Math.min(...prices) - tolerance / 2
      const zoneHigh = Math.max(...prices) + tolerance / 2
      // Earliest swing that contributed to this cluster — the moment the level first
      // established itself as a pivot, as opposed to a candle merely wicking through
      // the same price range by coincidence before the level existed.
      const startTime = Math.min(...cluster.map((s) => s.time))

      // Price is currently trading inside this range — it can't act as a directional
      // support or resistance level right now, so it isn't a usable zone.
      if (currentPrice >= zoneLow && currentPrice <= zoneHigh) return null

      const isSupport = (zoneLow + zoneHigh) / 2 < currentPrice

      const events = findTouchEvents(candles, zoneLow, zoneHigh)
      if (events.length === 0) return null

      const holdEvents = []
      let breakCount = 0
      for (const indices of events) {
        const outcome = classifyEvent(indices, candles, zoneLow, zoneHigh, isSupport)
        if (outcome === 'hold') holdEvents.push(indices)
        else if (outcome === 'break') breakCount += 1
      }

      // Never actually respected (pure fly-through, or only ever broken) — not a real level.
      if (holdEvents.length === 0) return null

      const { total, touchCount, lastTouchTime } = scoreZone({
        holdEvents,
        breakCount,
        candles,
        zoneLow,
        zoneHigh,
        isSupport,
        lastCandleTime,
        firstCandleTime,
      })

      return {
        type: isSupport ? 'support' : 'resistance',
        low: zoneLow,
        high: zoneHigh,
        mid: (zoneLow + zoneHigh) / 2,
        startTime,
        touchCount,
        brokenCount: breakCount,
        reliability: touchCount / (touchCount + breakCount),
        lastTouchTime,
        strengthScore: total,
        strengthLabel: strengthLabel(total),
        distanceFromPrice: Math.abs(currentPrice - (zoneLow + zoneHigh) / 2),
      }
    })
    .filter(Boolean)

  const supports = zones
    .filter((z) => z.type === 'support')
    .sort((a, b) => a.distanceFromPrice - b.distanceFromPrice)
    .slice(0, maxZonesPerSide)

  const resistances = zones
    .filter((z) => z.type === 'resistance')
    .sort((a, b) => a.distanceFromPrice - b.distanceFromPrice)
    .slice(0, maxZonesPerSide)

  // Nearest-to-price first: the zones most likely to matter for the next move show up top.
  return [...resistances, ...supports].sort((a, b) => a.distanceFromPrice - b.distanceFromPrice)
}

// Above this reliability (share of touches that held vs broke), bet on the zone holding
// again (LIMIT/fade). Below it, the zone fails often enough to bet on it breaking instead
// (STOP/breakout).
const RELIABILITY_LIMIT_THRESHOLD = 0.6

// A zone sitting almost on top of entry (e.g. two nearby clusters on the same side)
// would otherwise surface as a "TP" worth basically nothing — require at least this
// much reward before trusting a zone as a target over the fixed R-multiple fallback.
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

// Turns one zone into an actionable pending-order idea. Reliable zones (mostly held so
// far) get a fade play: LIMIT entry inside the zone, betting it holds again. Unreliable
// zones (broken often) get a breakout play: STOP entry beyond the zone, betting it fails.
function buildSignalForZone(zone, zones, atr) {
  const isSupport = zone.type === 'support'
  const useLimit = zone.reliability >= RELIABILITY_LIMIT_THRESHOLD
  const buffer = Math.max(atr * 0.25, (zone.high - zone.low) * 0.5)
  const direction = useLimit === isSupport ? 'buy' : 'sell'

  let entry, sl, targetPool

  if (useLimit) {
    // Fade: entry is the zone's midpoint, SL just beyond its outer (price-facing) edge.
    entry = zone.mid
    sl = isSupport ? zone.low - buffer : zone.high + buffer
    targetPool = zones.filter((z) => z.type !== zone.type)
  } else {
    // Breakout: entry sits just past the zone's far edge, SL back on the other side of it.
    entry = isSupport ? zone.low - buffer : zone.high + buffer
    sl = isSupport ? zone.high + buffer : zone.low - buffer
    targetPool = zones.filter((z) => z.type === zone.type && z !== zone)
  }

  const tp = buildTakeProfits(entry, sl, direction, targetPool)

  return {
    zoneType: zone.type,
    direction,
    orderType: useLimit ? 'LIMIT' : 'STOP',
    entry,
    sl,
    tp,
    reliability: zone.reliability,
    strengthLabel: zone.strengthLabel,
    confluence: zone.confluence ?? [],
  }
}

// A zone that also shows up on other timeframes is a much stronger level — traders
// call this "confluence". Mutates each timeframe's zones in place, tagging every zone
// with the list of other timeframe keys that have an overlapping same-type zone.
export function annotateConfluence(zonesByTimeframe) {
  const entries = Object.entries(zonesByTimeframe).filter(([, result]) => Array.isArray(result?.zones))

  for (const [tfKey, result] of entries) {
    for (const zone of result.zones) {
      zone.confluence = entries
        .filter(([otherTf]) => otherTf !== tfKey)
        .filter(([, otherResult]) =>
          otherResult.zones.some((z) => z.type === zone.type && zone.low <= z.high && z.low <= zone.high)
        )
        .map(([otherTf]) => otherTf)
    }
  }
}

// One signal for the nearest qualifying support, one for the nearest qualifying
// resistance — both sides of price get an idea, since either could be the next move.
export function buildSignals(zones, candles, minScore = 40) {
  if (!zones.length) return []

  const atr = computeATR(candles)
  const nearestSupport = zones.find((z) => z.type === 'support' && z.strengthScore >= minScore)
  const nearestResistance = zones.find((z) => z.type === 'resistance' && z.strengthScore >= minScore)

  return [nearestSupport, nearestResistance]
    .filter(Boolean)
    .map((zone) => buildSignalForZone(zone, zones, atr))
}
