import { createChart, CandlestickSeries, BaselineSeries, ColorType, CrosshairMode } from 'lightweight-charts'
import { formatPrice } from './signalHistoryCore.js'

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// Exported (only) so it's directly unit-testable — renderZoneChart itself needs a
// real canvas + lightweight-charts instance, which isn't worth a test-only shim; this
// pure helper is where the actual parsing logic worth verifying lives.
export function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '')
  // Support the shorthand 3-digit form (#rgb) too, not just the 6-digit one this
  // codebase's own CSS vars currently always use — and fall back to a neutral gray
  // instead of silently producing NaN channels (an invisible fill, no error anywhere)
  // if the value is ever something else entirely (e.g. a CSS color function).
  const expanded = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const value = parseInt(expanded, 16)
  if (expanded.length !== 6 || Number.isNaN(value)) {
    console.error(`[priceChart] unrecognized color value, falling back to gray: "${hex}"`)
    return `rgba(128, 128, 128, ${alpha})`
  }
  const r = (value >> 16) & 255
  const g = (value >> 8) & 255
  const b = value & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Draws one S/R zone as a shaded band instead of a line spanning the whole chart —
// it starts at the candle where the zone actually formed (its earliest contributing
// swing point) and fills through to the current right edge of the pane, rather than
// implying the level existed before price ever established it.
class ZoneRectangle {
  constructor(zone, colors) {
    this._zone = zone
    this._colors = colors
    this._chart = null
    this._series = null
  }

  attached({ chart, series }) {
    this._chart = chart
    this._series = series
  }

  detached() {
    this._chart = null
    this._series = null
  }

  updateAllViews() {}

  paneViews() {
    return [
      {
        renderer: () => ({
          draw: (target) => {
            const chart = this._chart
            const series = this._series
            if (!chart || !series) return

            const y1 = series.priceToCoordinate(this._zone.high)
            const y2 = series.priceToCoordinate(this._zone.low)
            // Only bail when *neither* edge maps to a coordinate — that's genuinely
            // nothing to draw. One edge coming back null (the price scale's visible
            // range only covers part of the zone) used to bail on the whole zone;
            // now that edge is clipped to the pane's own boundary below instead, so a
            // zone that's only partially in view still shows the visible portion.
            if (y1 == null && y2 == null) return

            const startX = chart.timeScale().timeToCoordinate(Math.floor(this._zone.startTime / 1000))
            // Timeframe first — with H1/H4/D1 now combined on one chart (see main.js),
            // "Support" alone no longer says which one this band came from. Price last
            // (same formatPrice used everywhere else a price is shown — zone cards,
            // signal cards, Telegram) — e.g. "H1 Support @ 4610.7" — so the band is
            // readable on its own without having to line it up against the price axis.
            const tfPrefix = this._zone.tf ? `${this._zone.tf} ` : ''
            const goldenPrefix = this._zone.isGolden ? '★ ' : ''
            const label = `${tfPrefix}${goldenPrefix}${this._zone.category} @ ${formatPrice(this._zone.price)}`

            target.useBitmapCoordinateSpace((scope) => {
              const { context: ctx, horizontalPixelRatio: hRatio, verticalPixelRatio: vRatio, mediaSize } = scope
              const left = (startX == null ? 0 : Math.max(0, startX)) * hRatio
              const right = mediaSize.width * hRatio
              if (right <= left) return

              const topPx = y1 == null ? 0 : y1 * vRatio
              const bottomPx = y2 == null ? mediaSize.height * vRatio : y2 * vRatio
              const top = Math.min(topPx, bottomPx)
              const bottom = Math.max(topPx, bottomPx)

              ctx.fillStyle = this._colors.fill
              ctx.fillRect(left, top, right - left, bottom - top)
              ctx.strokeStyle = this._colors.border
              ctx.lineWidth = Math.max(1, Math.round(hRatio))
              ctx.strokeRect(left, top, right - left, bottom - top)

              // Label centered inside the zone's own bounds, not on the price axis —
              // it should read as "part of" the band it describes.
              const fontSize = Math.round(11 * hRatio)
              ctx.font = `600 ${fontSize}px 'JetBrains Mono', monospace`
              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              const textWidth = ctx.measureText(label).width
              const paddingX = 6 * hRatio
              const paddingY = 3 * vRatio
              const boxW = textWidth + paddingX * 2
              const boxH = fontSize + paddingY * 2
              if (boxW > right - left) return

              const centerX = (left + right) / 2
              const centerY = (top + bottom) / 2
              ctx.fillStyle = this._colors.border
              ctx.fillRect(centerX - boxW / 2, centerY - boxH / 2, boxW, boxH)
              ctx.fillStyle = '#ffffff'
              ctx.fillText(label, centerX, centerY + 1)
            })
          },
        }),
      },
    ]
  }
}

function zoneColors(zone) {
  const base = zone.type === 'support' ? cssVar('--support') : cssVar('--resistance')
  return { fill: hexToRgba(base, 0.18), border: hexToRgba(base, 0.75) }
}

// Renders one candlestick chart into `container` for a single timeframe, with each S/R
// zone drawn as a shaded price band. Returns { chart, series } — chart so the caller
// can `.remove()` it before the next re-render (charts don't clean themselves up when
// their container is dropped from the DOM), series so the caller can push incremental
// updates (see main.js's updateChartSpotPrice) without tearing the whole chart down —
// series.update() on the same `time` as the last bar patches that bar in place,
// leaving the user's zoom/pan untouched.
export function renderZoneChart(container, candles, zones) {
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: cssVar('--panel') },
      textColor: cssVar('--text-dim'),
    },
    grid: {
      vertLines: { color: cssVar('--border-soft') },
      horzLines: { color: cssVar('--border-soft') },
    },
    rightPriceScale: { borderColor: cssVar('--border') },
    timeScale: { borderColor: cssVar('--border'), timeVisible: true },
    crosshair: { mode: CrosshairMode.Normal },
  })

  const series = chart.addSeries(CandlestickSeries, {
    upColor: cssVar('--support'),
    downColor: cssVar('--resistance'),
    borderVisible: false,
    wickUpColor: cssVar('--support'),
    wickDownColor: cssVar('--resistance'),
  })

  series.setData(
    candles.map((c) => ({
      time: Math.floor(c.time / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }))
  )

  zones.forEach((zone) => series.attachPrimitive(new ZoneRectangle(zone, zoneColors(zone))))
  chart.timeScale().fitContent()

  return { chart, series }
}

// Renders the track record's equity-curve trend (cumulative pips/$ over time, see
// getEquityCurve in signalHistoryCore.js) — the one visual-trend view alongside the
// modal's static win/loss/win-rate numbers. A BaselineSeries (not a plain line) so a
// drawdown below zero is immediately visually distinct (red) from being ahead (green),
// not just readable from the sign of the number. Deliberately static — this is a small
// glanceable overview inside a modal, not an instrument meant to be zoomed/panned/
// inspected like the main price chart, so scroll/scale/crosshair interaction is all
// switched off. Same `.remove()`-before-redraw lifecycle as renderZoneChart above — the
// caller owns disposing the previous instance.
export function renderEquityChart(container, points) {
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: cssVar('--panel') },
      textColor: cssVar('--text-dim'),
    },
    grid: {
      vertLines: { color: cssVar('--border-soft') },
      horzLines: { color: cssVar('--border-soft') },
    },
    rightPriceScale: { borderColor: cssVar('--border') },
    timeScale: { borderColor: cssVar('--border'), timeVisible: true },
    crosshair: { mode: CrosshairMode.Hidden },
    handleScroll: false,
    handleScale: false,
  })

  const support = cssVar('--support')
  const resistance = cssVar('--resistance')
  const series = chart.addSeries(BaselineSeries, {
    baseValue: { type: 'price', price: 0 },
    topLineColor: support,
    topFillColor1: hexToRgba(support, 0.28),
    topFillColor2: hexToRgba(support, 0.05),
    bottomLineColor: resistance,
    bottomFillColor1: hexToRgba(resistance, 0.05),
    bottomFillColor2: hexToRgba(resistance, 0.28),
    lineWidth: 2,
  })

  // lightweight-charts requires strictly ascending, unique `time` values — two trades
  // that closed within the same second (seconds-resolution, same as the candle chart's
  // own Math.floor(c.time / 1000) above) would otherwise collide. Deduping to the last
  // value for that second is the right choice here regardless: it's still the accurate
  // cumulative total as of that moment.
  const bySecond = new Map()
  for (const p of points) bySecond.set(Math.floor(p.time / 1000), p.value)
  series.setData([...bySecond.entries()].sort(([a], [b]) => a - b).map(([time, value]) => ({ time, value })))

  chart.timeScale().fitContent()
  return chart
}
