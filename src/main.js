import './style.css'
import { TIMEFRAMES, fetchAllTimeframes } from './lib/twelveData.js'
import { detectZones, buildSignals } from './lib/srDetector.js'

const AUTO_REFRESH_MS = 3 * 60 * 1000

const tabsEl = document.getElementById('tabs')
const contentEl = document.getElementById('content')
const priceEl = document.getElementById('price-display')
const lastUpdateEl = document.getElementById('last-update')
const refreshBtn = document.getElementById('refresh-btn')

let activeTab = TIMEFRAMES[2].key // M30 default: reasonable middle ground
let zonesByTimeframe = {}
let currentPrice = null
let refreshing = false

function renderTabs() {
  tabsEl.innerHTML = ''
  for (const tf of TIMEFRAMES) {
    const btn = document.createElement('button')
    btn.className = 'tab-btn' + (tf.key === activeTab ? ' active' : '')
    btn.textContent = tf.label
    btn.addEventListener('click', () => {
      activeTab = tf.key
      renderTabs()
      renderContent()
    })
    tabsEl.appendChild(btn)
  }
}

function formatPrice(p) {
  return Math.round(p).toLocaleString('en-US')
}

function timeAgo(ts) {
  const diffMs = Date.now() - ts
  const mins = Math.round(diffMs / 60000)
  if (mins < 60) return `${mins}m ago`

  const days = Math.floor(mins / 1440)
  if (days >= 1) {
    const remHours = Math.floor((mins % 1440) / 60)
    return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`
  }

  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `${hours}h ${remMins}m ago` : `${hours}h ago`
}

function renderZoneCard(zone) {
  const card = document.createElement('div')
  card.className = `zone-card ${zone.type}`
  const brokenNote = zone.brokenCount > 0 ? ` · broken ${zone.brokenCount}x` : ''
  card.innerHTML = `
    <span class="zone-type">${zone.type === 'support' ? 'Support' : 'Resistance'}</span>
    <div class="zone-range">
      <div class="zone-price">${formatPrice(zone.low)} – ${formatPrice(zone.high)}</div>
      <div class="zone-meta">Distance: ${formatPrice(zone.distanceFromPrice)} · Last test: ${timeAgo(zone.lastTouchTime)}${brokenNote}</div>
    </div>
    <div class="zone-stats">
      <span class="strength-badge ${zone.strengthLabel.toLowerCase()}">${zone.strengthLabel} · ${zone.strengthScore}</span>
      <span class="touches">${zone.touchCount} touches</span>
    </div>
  `
  return card
}

function renderGroupHeading(text, type) {
  const heading = document.createElement('div')
  heading.className = `group-heading ${type}`
  heading.textContent = text
  return heading
}

function renderContent() {
  const result = zonesByTimeframe[activeTab]

  if (!result) {
    contentEl.innerHTML = `<p class="empty-state">Loading ${activeTab} data...</p>`
    return
  }

  if (!result.zones.length) {
    contentEl.innerHTML = `<p class="empty-state">No significant S/R zones detected yet for ${activeTab}.</p>`
    return
  }

  contentEl.innerHTML = ''

  const signals = result.signals ?? []
  if (signals.length) {
    const signalsGrid = document.createElement('div')
    signalsGrid.className = 'signals-grid'
    signals.forEach((signal) => signalsGrid.appendChild(renderSignalCard(signal)))
    contentEl.appendChild(signalsGrid)
  }

  const resistances = result.zones.filter((z) => z.type === 'resistance')
  const supports = result.zones.filter((z) => z.type === 'support')

  const zonesGrid = document.createElement('div')
  zonesGrid.className = 'zones-grid'

  if (resistances.length) {
    const column = document.createElement('div')
    column.className = 'zone-column'
    column.appendChild(renderGroupHeading('Resistance', 'resistance'))
    resistances.forEach((zone) => column.appendChild(renderZoneCard(zone)))
    zonesGrid.appendChild(column)
  }
  if (supports.length) {
    const column = document.createElement('div')
    column.className = 'zone-column'
    column.appendChild(renderGroupHeading('Support', 'support'))
    supports.forEach((zone) => column.appendChild(renderZoneCard(zone)))
    zonesGrid.appendChild(column)
  }
  contentEl.appendChild(zonesGrid)
}

function renderSignalCard(signal) {
  const card = document.createElement('div')
  card.className = `signal-card ${signal.direction}`

  const label = `${signal.direction === 'buy' ? 'BUY' : 'SELL'} ${signal.orderType}`
  const zoneLabel = signal.zoneType === 'support' ? 'Support' : 'Resistance'
  const entryText = formatPrice(signal.entry)

  const tpRows = signal.tp
    .map(
      (t, i) => `
      <div class="signal-tp-row">
        <span>TP${i + 1}</span>
        <span>${formatPrice(t.price)}</span>
        <span class="rr">${t.rr.toFixed(1)}R</span>
      </div>`
    )
    .join('')

  card.innerHTML = `
    <div class="signal-header">
      <span class="signal-direction">${label}</span>
      <span class="signal-zone-strength">${signal.strengthLabel} ${zoneLabel}</span>
    </div>
    <div class="signal-row">
      <span class="signal-label">Entry</span>
      <span class="signal-value">${entryText}</span>
    </div>
    <div class="signal-row sl">
      <span class="signal-label">SL</span>
      <span class="signal-value">${formatPrice(signal.sl)}</span>
    </div>
    <div class="signal-tp">${tpRows}</div>
  `
  return card
}

async function refreshData() {
  if (refreshing) return

  refreshing = true
  refreshBtn.classList.add('spinning')
  contentEl.querySelectorAll('.zone-card, .signal-card').forEach((c) => (c.style.opacity = '0.6'))

  try {
    const raw = await fetchAllTimeframes()
    for (const tf of TIMEFRAMES) {
      const series = raw[tf.key]
      // Rate-limited or transient fetch failure: keep whatever data is already
      // on screen for this timeframe instead of clearing it out.
      if (series?.error) continue
      const last = series[series.length - 1]
      if (tf.key === 'M5') {
        currentPrice = last.close
        priceEl.textContent = formatPrice(currentPrice)
      }
      const zones = detectZones(series, currentPrice ?? last.close)
      zonesByTimeframe[tf.key] = {
        zones,
        signals: buildSignals(zones, series),
      }
    }
    lastUpdateEl.textContent = `Last updated: ${new Date().toLocaleTimeString('en-US')}`
  } catch (err) {
    console.error(err) // keep last good data on screen, no user-facing warning
  } finally {
    refreshing = false
    refreshBtn.classList.remove('spinning')
    renderContent()
  }
}

refreshBtn.addEventListener('click', refreshData)

renderTabs()
renderContent()
refreshData()
setInterval(refreshData, AUTO_REFRESH_MS)
