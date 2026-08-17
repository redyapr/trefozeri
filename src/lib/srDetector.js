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
// Exported so signalHistoryCore.js's fill-time oversized-candle check (see
// evaluateSignals) can derive the same effective ATR back out of a record's own stored
// `threshold` (= atr * BREAKOUT_ATR_MULT) without duplicating this constant.
export const BREAKOUT_ATR_MULT = 0.15
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
// 0.3 (the original value) meant a floored SL could be tighter than a single H1
// candle's own average range (ATR) — plain noise, not a real invalidation, could then
// plausibly sweep it. 0.5 still allows a genuinely tight structural wick to produce a
// tight SL, just no longer tighter than half an average candle's worth of room.
const SL_ATR_FLOOR_MULT = 0.5 // never tighter than this even if the wick sat right on the level
const SL_ATR_CAP_MULT = 1.5 // never wider than this even if the wick spiked hard
const SL_STRUCTURE_BUFFER_RATIO = 0.15 // extra room beyond the wick itself, as a fraction of ATR

// ----------------------------------------------------------------------------
// 2026-08-17 win-rate review: the live track record hit 0/11 closed trades. Real
// historical-candle verification (not just the recorded numbers) surfaced several
// concrete, fixable gaps between how this module traded S/R and how a disciplined S/R
// trader actually does — see the constants and their call sites below for each one.
// ----------------------------------------------------------------------------

// A single candle closing beyond a level used to flip its state immediately — a
// one-candle spike that reverses the very next bar still permanently broke the level,
// seeding a retest entry off what was really a fakeout. Requiring the close to hold for
// more than one consecutive bar filters that out. Applies symmetrically to both the
// original break (state 0 -> 1) and a later re-break that invalidates it (state 1 -> 2).
const BREAKOUT_CONFIRM_BARS = 2

// A level already tested (approached without breaking) this many times is real S/R
// wisdom to treat as weaker than a fresh, never-touched one — each successful defense
// makes the next attacker more likely to finally break it. Feeds strengthLabel below.
const RETEST_WEAKEN_THRESHOLD = 3

// A level that just flipped role needs to have actually traveled some real distance in
// the breakout direction before its retest counts as a genuine pullback worth trading —
// a "break" that's barely left home yet isn't a pullback, it's still forming. Scaled to
// the same ATR as everything else here rather than a fixed distance.
const MIN_PULLBACK_EXTENT_ATR_MULT = 0.5

// Was the original breakout candle backed by real participation, or just a thin poke
// through the level? Two independent, data-availability-dependent proxies (see
// evaluateBreakoutQuality) — real trailing-average volume where the candle carries one
// (BTCUSD, via Binance), or the candle's own body-to-range ratio as a volume-less
// stand-in (XAUUSD's Twelve Data spot feed has no volume field at all).
const VOLUME_LOOKBACK = 20
const VOLUME_CONFIRM_MULT = 1.2
const BODY_RATIO_CONFIRM_MIN = 0.5

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

const TREND_SMA_PERIOD = 50
// Within this many ATRs of the SMA counts as "no clear trend" — a fixed % band would
// treat XAUUSD and BTCUSD's very different volatility identically; this self-calibrates
// the same way every other threshold in this module does.
const TREND_NEUTRAL_ATR_MULT = 0.5

function computeSMA(candles, period) {
  const window = candles.slice(-period)
  return window.reduce((sum, c) => sum + c.close, 0) / (window.length || 1)
}

// Coarse higher-timeframe direction read, used to decide which side of a fade pair
// actually gets offered as a signal (see buildSignals) — a level-fade strategy applied
// symmetrically in both directions regardless of the prevailing trend systematically
// loses on whichever side fights it (confirmed against the 2026-08-17 review: even the
// trend-*aligned* trades in that batch still lost, but the counter-trend ones made up
// the majority of the losses). A 'neutral' read (price within TREND_NEUTRAL_ATR_MULT of
// its own recent average — no clear direction either way) keeps offering both sides,
// same as before this existed, since a fade strategy is arguably at its best exactly
// when neither side is confirmed.
export function computeTrend(candles, period = TREND_SMA_PERIOD) {
  if (!candles || candles.length < period) return 'neutral'
  const sma = computeSMA(candles, period)
  const atr = computeATR(candles)
  const band = atr * TREND_NEUTRAL_ATR_MULT
  const price = candles[candles.length - 1].close
  if (price > sma + band) return 'up'
  if (price < sma - band) return 'down'
  return 'neutral'
}

function bodyHigh(c) {
  return Math.max(c.open, c.close)
}
function bodyLow(c) {
  return Math.min(c.open, c.close)
}

// How many trailing candles to look at when deciding "has price actually moved
// lately" — 12 H1 candles (~12 hours) is long enough that a normal quiet stretch of
// real trading doesn't false-positive, but short enough to flag a closed/illiquid
// market within half a day rather than a full multi-day gap.
const STAGNANT_LOOKBACK = 12
// Same price-scaled floor convention as breakoutThreshold's own floor (see
// detectLevels) — self-calibrates per instrument rather than a fixed pip value.
const STAGNANT_PRICE_RATIO = 0.0002

// Detects "price genuinely isn't moving" directly from the data, independent of any
// calendar rule — isGoldMarketClosed (marketHours.js) only knows the *regular* weekend
// closure, so an exchange holiday on an otherwise normal weekday (which still returns
// near-frozen candles from the data provider) would otherwise go completely
// undetected. Used both for the dashboard's market-status banner and to gate opening
// new Telegram signals off data this stale, the same way isGoldMarketClosed already
// does for the regular weekend closure.
export function isPriceStagnant(candles, lookback = STAGNANT_LOOKBACK) {
  if (!candles || candles.length < lookback) return false
  const recent = candles.slice(-lookback)
  const currentPrice = recent[recent.length - 1].close
  let maxBody = -Infinity
  let minBody = Infinity
  for (const c of recent) {
    const hi = bodyHigh(c)
    const lo = bodyLow(c)
    if (hi > maxBody) maxBody = hi
    if (lo < minBody) minBody = lo
  }
  return maxBody - minBody < currentPrice * STAGNANT_PRICE_RATIO
}

// Swing detection on the candle *body*, not the wick, so one long shadow can't fake a
// level. minAmplitude requires the *whole* left+right window to span at least this much
// (highest body high to lowest body low across all 2*window+1 bars), not just the
// candidate itself — without some floor, a stretch of near-frozen candles (e.g. a data
// provider repeating the last real tick with sub-cent jitter while a market is closed)
// still always has *some* bar that's the local max/min, however microscopic the
// difference, and that noise gets reported as a real Support/Resistance pivot.
//
// Checking the *whole window's* range rather than "the candidate must clear every
// individual neighbor by minAmplitude" matters: an earlier version of this check did
// the latter, and it rejected genuine pivots too — e.g. a real double-bottom, where
// today's low lands a few cents above yesterday's close/low (a real retest, not noise)
// even though the rest of the window spans hundreds of dollars. Passing the same
// breakoutThreshold used elsewhere in this module keeps this self-calibrated per
// timeframe/instrument rather than a fixed magic number, and errs toward "no zone" over
// a fabricated one when price genuinely isn't moving at all.
function findBodyPivots(candles, left, right, minAmplitude = 0) {
  const highs = []
  const lows = []

  for (let i = left; i < candles.length - right; i++) {
    const hi = bodyHigh(candles[i])
    const lo = bodyLow(candles[i])
    let isHigh = true
    let isLow = true
    let windowMaxHigh = hi
    let windowMinLow = lo

    for (let w = 1; w <= left; w++) {
      const nHigh = bodyHigh(candles[i - w])
      const nLow = bodyLow(candles[i - w])
      if (nHigh >= hi) isHigh = false
      if (nLow <= lo) isLow = false
      if (nHigh > windowMaxHigh) windowMaxHigh = nHigh
      if (nLow < windowMinLow) windowMinLow = nLow
    }
    for (let w = 1; w <= right; w++) {
      const nHigh = bodyHigh(candles[i + w])
      const nLow = bodyLow(candles[i + w])
      if (nHigh >= hi) isHigh = false
      if (nLow <= lo) isLow = false
      if (nHigh > windowMaxHigh) windowMaxHigh = nHigh
      if (nLow < windowMinLow) windowMinLow = nLow
    }

    if (windowMaxHigh - windowMinLow < minAmplitude) {
      isHigh = false
      isLow = false
    }

    // wick: the candle's real high/low, kept alongside the body price so the SL logic
    // can anchor to what actually got rejected here, not just the body that defines the level.
    if (isHigh) highs.push({ index: i, time: candles[i].time, price: hi, wick: candles[i].high })
    if (isLow) lows.push({ index: i, time: candles[i].time, price: lo, wick: candles[i].low })
  }

  return { highs, lows }
}

// Trailing-average volume as of (but not including) index i — VOLUME_LOOKBACK bars,
// skipping any candle whose volume is missing. Returns null (not 0) when nothing usable
// is available, so callers can tell "no data" apart from "a real zero".
function avgVolumeBefore(candles, i) {
  const from = Math.max(0, i - VOLUME_LOOKBACK)
  const window = candles.slice(from, i).filter((c) => c.volume != null)
  if (!window.length) return null
  return window.reduce((sum, c) => sum + c.volume, 0) / window.length
}

// Was the candle that triggered a break backed by real conviction, or just a thin poke
// through the level? Real volume (where the candle carries one) beats the proxy: a
// low-volume push through the level reads as unconfirmed even with a decisive body,
// since it might just be a stop-run in thin liquidity. No candle at all (shouldn't
// happen once confirmed, but keeps this total) defaults to confirmed rather than
// blocking every signal on a data gap.
function evaluateBreakoutQuality(candle, avgVolume) {
  if (!candle) return true
  if (candle.volume != null && avgVolume != null && avgVolume > 0) {
    return candle.volume >= avgVolume * VOLUME_CONFIRM_MULT
  }
  const range = candle.high - candle.low
  if (!range) return true
  const body = Math.abs(candle.close - candle.open)
  return body / range >= BODY_RATIO_CONFIRM_MIN
}

// Replays the per-pivot state machine bar-by-bar over the full series, exactly as it
// would evolve live, one candle at a time.
function runStateMachine(candles, breakoutThreshold) {
  const { highs, lows } = findBodyPivots(candles, PIVOT_LEFT, PIVOT_RIGHT, breakoutThreshold)
  const lowByPivotIndex = new Map(lows.map((p) => [p.index, p]))
  const highByPivotIndex = new Map(highs.map((p) => [p.index, p]))

  // Newest pivot at the front — array.unshift onto the front, so index 0 is always latest.
  const supports = []
  const resistances = []

  const freshLevel = (price, time, wick) => ({
    price,
    state: 0,
    time,
    roleExtreme: wick,
    beyondStreak: 0, // consecutive bars closed beyond the level — see BREAKOUT_CONFIRM_BARS
    breakoutCandle: null, // the bar that started the current beyondStreak, snapshotted for evaluateBreakoutQuality
    breakoutAvgVolume: null,
    farExtreme: null, // furthest point reached in the breakout direction once broken — see MIN_PULLBACK_EXTENT_ATR_MULT
    touching: false, // edge-detects a prolonged approach as one test, not one per bar
    testCount: 0, // approaches that didn't break — see RETEST_WEAKEN_THRESHOLD
    tradeable: true, // set false at confirmation if evaluateBreakoutQuality rejects the breakout candle
  })

  for (let i = 0; i < candles.length; i++) {
    // A pivot centered `PIVOT_RIGHT` bars back only becomes known as of this bar.
    const confirmedIndex = i - PIVOT_RIGHT
    const pl = lowByPivotIndex.get(confirmedIndex)
    if (pl) {
      // roleExtreme starts at the pivot's own wick — the low that already got bought up
      // once, which is the natural first reference for "how far below is this level
      // actually defended".
      supports.unshift(freshLevel(pl.price, pl.time, pl.wick))
      if (supports.length > MAX_KEEP) supports.pop()
    }
    const ph = highByPivotIndex.get(confirmedIndex)
    if (ph) {
      resistances.unshift(freshLevel(ph.price, ph.time, ph.wick))
      if (resistances.length > MAX_KEEP) resistances.pop()
    }

    const candle = candles[i]
    const { close, high, low } = candle
    const avgVolNow = avgVolumeBefore(candles, i)

    for (const s of supports) {
      if (s.state === 0) {
        // Role = support, invalidated by a close below price — track the deepest low
        // wick seen while still acting as support (a real, already-tested downside).
        const beyond = close < s.price - breakoutThreshold
        if (beyond) {
          s.beyondStreak += 1
          if (s.beyondStreak === 1) {
            s.breakoutCandle = candle
            s.breakoutAvgVolume = avgVolNow
          }
          if (s.beyondStreak === BREAKOUT_CONFIRM_BARS) {
            s.state = 1 // support broken -> becomes SBR
            s.roleExtreme = high // fresh reference for the new (resistance) role: this bar's high
            s.farExtreme = low // breakout direction for a broken support is down
            s.tradeable = evaluateBreakoutQuality(s.breakoutCandle, s.breakoutAvgVolume)
          }
        } else {
          s.beyondStreak = 0
          s.breakoutCandle = null
          s.roleExtreme = Math.min(s.roleExtreme, low)
          const touching = low <= s.price + breakoutThreshold
          if (touching && !s.touching) s.testCount += 1
          s.touching = touching
        }
      } else if (s.state === 1) {
        // Role flipped to resistance (SBR) — now track the highest high seen while
        // still holding as resistance, and how far price has run below (its breakout
        // direction) since the flip.
        const beyond = close > s.price + breakoutThreshold
        if (beyond) {
          s.beyondStreak += 1
          if (s.beyondStreak === BREAKOUT_CONFIRM_BARS) s.state = 2 // SBR broken again -> invalid
        } else {
          s.beyondStreak = 0
          s.roleExtreme = Math.max(s.roleExtreme, high)
          s.farExtreme = Math.min(s.farExtreme, low)
        }
      }
    }

    for (const r of resistances) {
      if (r.state === 0) {
        const beyond = close > r.price + breakoutThreshold
        if (beyond) {
          r.beyondStreak += 1
          if (r.beyondStreak === 1) {
            r.breakoutCandle = candle
            r.breakoutAvgVolume = avgVolNow
          }
          if (r.beyondStreak === BREAKOUT_CONFIRM_BARS) {
            r.state = 1 // resistance broken -> becomes RBS
            r.roleExtreme = low // fresh reference for the new (support) role: this bar's low
            r.farExtreme = high // breakout direction for a broken resistance is up
            r.tradeable = evaluateBreakoutQuality(r.breakoutCandle, r.breakoutAvgVolume)
          }
        } else {
          r.beyondStreak = 0
          r.breakoutCandle = null
          r.roleExtreme = Math.max(r.roleExtreme, high)
          const touching = high >= r.price - breakoutThreshold
          if (touching && !r.touching) r.testCount += 1
          r.touching = touching
        }
      } else if (r.state === 1) {
        const beyond = close < r.price - breakoutThreshold
        if (beyond) {
          r.beyondStreak += 1
          if (r.beyondStreak === BREAKOUT_CONFIRM_BARS) r.state = 2 // RBS broken again -> invalid
        } else {
          r.beyondStreak = 0
          r.roleExtreme = Math.min(r.roleExtreme, low)
          r.farExtreme = Math.max(r.farExtreme, high)
        }
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

  // A broken level (RBS/SBR) additionally needs to have actually traveled some real
  // distance in the breakout direction — farExtreme tracks that since the flip — before
  // its retest counts as a genuine pullback rather than a break that's barely happened
  // yet. Doesn't apply to a never-broken Support/Resistance: there's no "breakout" to
  // have extended from.
  let pullbackOk = true
  if (level.state === 1 && level.farExtreme != null) {
    const extent = type === 'support' ? level.farExtreme - level.price : level.price - level.farExtreme
    pullbackOk = extent >= atr * MIN_PULLBACK_EXTENT_ATR_MULT
  }

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
    testCount: level.testCount ?? 0,
    // Still rendered as a zone either way (chart/cards stay informative) — only
    // buildSignals actually excludes a non-tradeable zone from becoming a live idea,
    // same "shown but not tradeable" treatment already given to H4/D1 zones.
    tradeable: level.tradeable !== false && pullbackOk,
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

// Symmetric ceiling: a "TP" hundreds of R away isn't a realistic target to still be
// showing — it mostly shows up because of higher-timeframe borrowing (see
// buildSignals) surfacing a genuinely distant confluence level. Past this point it's
// just noise on the signal card, not a level worth displaying or tracking as a target.
const MAX_ZONE_TP_RR = 100

// Prices display rounded to the nearest whole unit (see formatPrice in main.js). Two
// targets closer together than that would still round to the *same shown number* even
// after clearing the threshold-based dedup below (e.g. 4399.55 and 4400.44 are 0.89
// apart — more than a ~0.88 breakout threshold, but both round to "4400") — so this is
// enforced as a floor on top of the zone's own (sometimes much smaller) threshold.
const MIN_TP_DISPLAY_SEPARATION = 1

function buildTakeProfits(entryPrice, sl, direction, candidateZones, mergeThreshold) {
  const risk = Math.abs(entryPrice - sl)
  if (!risk) return []

  const isBuy = direction === 'buy'
  const sortedZones = candidateZones
    .filter((z) => (isBuy ? z.mid > entryPrice : z.mid < entryPrice))
    .filter((z) => {
      const rr = Math.abs(z.mid - entryPrice) / risk
      return rr >= MIN_ZONE_TP_RR && rr < MAX_ZONE_TP_RR
    })
    .sort((a, b) => (isBuy ? a.mid - b.mid : b.mid - a.mid))

  // Different zone categories (e.g. a fresh Resistance and an older SBR) can sit at
  // the same or near-identical price — collapse those into a single target instead of
  // surfacing "TP1" and "TP2" as the same number. The merge distance is scaled to the
  // *active* signal's own threshold, not each candidate zone's own — a target borrowed
  // from a higher timeframe (see buildSignalForZone) carries a much larger threshold of
  // its own (bigger ATR), which would otherwise over-merge targets that are
  // meaningfully separated at the scale actually being traded.
  const mergeDistance = Math.max(mergeThreshold, MIN_TP_DISPLAY_SEPARATION)
  const fromZones = []
  for (const z of sortedZones) {
    // Checked by length, not truthiness of the value itself — a price of exactly 0
    // (never realistic for XAUUSD/BTCUSD, but not worth relying on that) would
    // otherwise read as "no previous zone yet" and skip the merge check entirely.
    const last = fromZones.length ? fromZones[fromZones.length - 1] : null
    if (last != null && Math.abs(z.mid - last) <= mergeDistance) continue
    fromZones.push(z.mid)
  }

  // No cap on how many real structural targets surface — however many opposite-side
  // zones qualify (same-timeframe plus any borrowed higher-timeframe ones) all become
  // TPs. Only the synthetic R-multiple fallback below is a fixed set of 3.
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
  const rawWickDistance = isSupport ? zone.price - zone.structureAnchor : zone.structureAnchor - zone.price
  // zone.structureAnchor missing or corrupt (e.g. an unexpected zone shape) would
  // otherwise poison the whole calculation with NaN — degrade to a pure
  // volatility-based distance instead of failing outright.
  const wickDistance = Number.isFinite(rawWickDistance) ? rawWickDistance : effectiveAtr
  const raw = wickDistance + buffer
  return Math.min(Math.max(raw, effectiveAtr * SL_ATR_FLOOR_MULT), effectiveAtr * SL_ATR_CAP_MULT)
}

// Turns one level into an actionable LIMIT order idea: these levels are
// reaction/structure zones (support & RBS bid up, resistance & SBR sell off), so every
// signal is a fade at the level itself — entry at the price, SL beyond the deepest wick
// that already tested this level in its current role (see structuralSlDistance), TP at
// the nearest opposite-side levels — same-timeframe zones plus any higher-timeframe
// ones the caller allows borrowing from (see buildSignals). A real level is a real
// level regardless of which timeframe's candles drew it, and a higher timeframe's
// structure is more likely to actually hold as a target than reaching down to a lower
// timeframe's noise would be.
function buildSignalForZone(zone, allZones, higherTfZones = []) {
  const isSupport = zone.type === 'support'
  const direction = isSupport ? 'buy' : 'sell'
  const entry = zone.price
  const slDistance = structuralSlDistance(zone, isSupport)
  const sl = isSupport ? entry - slDistance : entry + slDistance
  const targetPool = [...allZones, ...higherTfZones].filter((z) => z.type !== zone.type)
  // Merge/dedup distance always uses the active zone's own threshold (its own
  // timeframe's ATR), not a borrowed target's — see buildTakeProfits.
  const tp = buildTakeProfits(entry, sl, direction, targetPool, zone.threshold)

  return {
    zoneType: zone.type,
    category: zone.category,
    direction,
    orderType: 'LIMIT',
    entry,
    sl,
    tp,
    threshold: zone.threshold, // lets the track record tell "same pivot, recalculated" apart from "replaced by a different one"
    // Golden Zone confluence always wins (cross-timeframe agreement is the strongest
    // signal this app has); otherwise a level tested RETEST_WEAKEN_THRESHOLD+ times
    // without breaking is downgraded — each successful defense makes the next attacker
    // more likely to finally break it, so a well-worn level is weaker, not equally
    // "Medium", to a fresh one.
    strengthLabel: zone.isGolden ? 'Strong' : zone.testCount >= RETEST_WEAKEN_THRESHOLD ? 'Weak' : 'Medium',
    confluence: zone.confluence,
  }
}

// One signal for the nearest qualifying bullish level (Support/RBS), one for the
// nearest qualifying bearish level (Resistance/SBR) — both sides of price get an idea,
// *unless* a confirmed higher-timeframe trend picks a side (see below).
// higherTfZones (optional): zones from timeframes higher than the one `zones` came
// from, made available as extra TP candidates (see buildSignalForZone) — the caller
// (main.js / fetch-data.mjs) is responsible for only ever passing *higher* timeframes'
// zones here, never lower ones.
// trend (optional, see computeTrend): 'up' only offers the bullish side, 'down' only
// the bearish side — a fade strategy taken symmetrically in both directions regardless
// of the prevailing trend fights itself on whichever side goes against it. 'neutral'
// (the default) offers both, same as before trend filtering existed.
export function buildSignals(zones, currentPrice, higherTfZones = [], trend = 'neutral') {
  if (!zones.length || currentPrice == null) return []

  // A LIMIT order only makes sense on the correct side of current price: a sell
  // (resistance-type) needs its entry at or above price — price has to rally UP to
  // reach it — and a buy (support-type) needs its entry at or below. (At-or-equal, not
  // strictly beyond: price sitting exactly on the entry is the fill point itself, not
  // an invalidated level.) A zone that's already past that is already run over, not a
  // live order price is approaching — this happens when this timeframe's own candles
  // haven't closed yet to reflect a break that a fresher currentPrice (from a lower
  // timeframe's more frequent candles, e.g. H1 feeding an H4/D1 zone) already shows.
  // Signaling it would just auto-fill nonsensically the instant it's created.
  const onCorrectSide = (z) => (z.type === 'support' ? z.price <= currentPrice : z.price >= currentPrice)
  // A broken level that hasn't cleared the pullback-extent/breakout-quality bar (see
  // toZone) is still shown on the chart, just not offered as a tradeable idea of its
  // own — same treatment already given to H4/D1 zones.
  const tradeable = (z) => z.tradeable !== false

  const byDistance = (a, b) => a.distanceFromPrice - b.distanceFromPrice
  const nearestBullish = zones.filter((z) => z.type === 'support' && onCorrectSide(z) && tradeable(z)).sort(byDistance)[0]
  const nearestBearish = zones.filter((z) => z.type === 'resistance' && onCorrectSide(z) && tradeable(z)).sort(byDistance)[0]

  let candidates = [nearestBullish, nearestBearish]
  if (trend === 'up') candidates = [nearestBullish]
  else if (trend === 'down') candidates = [nearestBearish]

  return candidates.filter(Boolean).map((zone) => buildSignalForZone(zone, zones, higherTfZones))
}
