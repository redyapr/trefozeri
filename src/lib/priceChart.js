import { createChart, CandlestickSeries, LineStyle, ColorType, CrosshairMode } from 'lightweight-charts'

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// One price line per zone edge (low/high) rather than a filled rectangle — lightweight-charts
// has no built-in shaded band, and a custom drawing primitive is overkill for this — the two
// dashed lines already read clearly as a zone's bounds on the chart.
function drawZone(series, zone) {
  const color = zone.type === 'support' ? cssVar('--support') : cssVar('--resistance')
  const label = zone.type === 'support' ? 'S' : 'R'

  series.createPriceLine({
    price: zone.high,
    color,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: `${label} ${zone.strengthLabel}`,
  })
  series.createPriceLine({
    price: zone.low,
    color,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: '',
  })
}

// Renders one candlestick chart into `container` for a single timeframe, with each S/R
// zone drawn as a pair of dashed price lines. Returns the chart instance so the caller
// can `.remove()` it before the next re-render (charts don't clean themselves up when
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

  zones.forEach((zone) => drawZone(series, zone))
  chart.timeScale().fitContent()

  return chart
}
