import { createChart, CandlestickSeries, ColorType, CrosshairMode } from 'lightweight-charts'

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
            const label = this._zone.isGolden ? `★ ${this._zone.category}` : this._zone.category

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
// zone drawn as a shaded price band. Returns the chart instance so the caller can
// `.remove()` it before the next re-render (charts don't clean themselves up when
// their container is dropped from the DOM).
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

  return chart
}
