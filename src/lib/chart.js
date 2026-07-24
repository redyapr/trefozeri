import { createChart, CandlestickSeries } from 'lightweight-charts'

// One chart instance is reused across timeframe switches/refreshes — recreating
// a lightweight-charts instance on every render is unnecessary work and causes
// a visible flash, so callers just call `update()` with fresh data instead.
export function createGoldChart(container) {
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { color: 'transparent' },
      textColor: '#948a76',
      fontFamily: 'Inter, -apple-system, sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(212, 175, 55, 0.06)' },
      horzLines: { color: 'rgba(212, 175, 55, 0.06)' },
    },
    rightPriceScale: { borderColor: 'rgba(212, 175, 55, 0.2)' },
    timeScale: { borderColor: 'rgba(212, 175, 55, 0.2)', timeVisible: true, secondsVisible: false },
  })

  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: '#7fa787',
    downColor: '#b1665c',
    borderVisible: false,
    wickUpColor: '#7fa787',
    wickDownColor: '#b1665c',
  })

  let priceLines = []

  function addLine(price, color, lineStyle, title, axisLabelVisible) {
    priceLines.push(candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle, axisLabelVisible, title }))
  }

  function update({ series, zones, signals }) {
    candleSeries.setData(
      series.map((c) => ({
        time: Math.floor(c.time / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    )

    priceLines.forEach((line) => candleSeries.removePriceLine(line))
    priceLines = []

    // Zones and TP levels stay as unlabeled dashed lines — with up to 6 zones plus
    // 2 signals' worth of TPs, labeling all of them stacks unreadable price badges
    // on the axis. Only Entry/SL (the two prices that actually matter to act on)
    // get an axis label; TP prices are still visible in the signal cards below.
    for (const zone of zones) {
      addLine(zone.mid, zone.type === 'support' ? '#7fa787' : '#b1665c', 2, zone.type === 'support' ? 'S' : 'R', false)
    }

    for (const signal of signals) {
      addLine(signal.entry, '#cda43e', 0, 'Entry', true)
      addLine(signal.sl, '#b1665c', 3, 'SL', true)
      signal.tp.forEach((t, i) => addLine(t.price, '#7fa787', 3, `TP${i + 1}`, false))
    }

    chart.timeScale().fitContent()
  }

  // Used when switching instruments: without this, the chart keeps showing the
  // previous symbol's candles (e.g. gold) until the new symbol's first fetch lands,
  // which reads as "wrong data" rather than "still loading".
  function clear() {
    update({ series: [], zones: [], signals: [] })
  }

  return { update, clear }
}
