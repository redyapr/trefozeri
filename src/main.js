import './style.css'
import { TIMEFRAMES, SYMBOLS, fetchAllTimeframes } from './lib/twelveData.js'
import { detectZones, buildSignals, annotateConfluence } from './lib/srDetector.js'
import { notificationPermission, requestNotificationPermission, checkEntryAlerts } from './lib/notifications.js'
import { fetchNewsCalendar, findUpcomingHighImpact } from './lib/newsCalendar.js'
import { saveLastKnown, loadLastKnown } from './lib/offlineCache.js'

const NEWS_HORIZON_HOURS = 12

const symbolTabsEl = document.getElementById('symbol-tabs')
const tabsEl = document.getElementById('tabs')
const newsBannerEl = document.getElementById('news-banner')
const contentEl = document.getElementById('content')
const priceEl = document.getElementById('price-display')
const lastUpdateEl = document.getElementById('last-update')
const refreshBtn = document.getElementById('refresh-btn')
const notifyBtn = document.getElementById('notify-btn')

let activeSymbol = SYMBOLS[0]
let activeTab = TIMEFRAMES[2].key // M30 default: reasonable middle ground
let zonesByTimeframe = {}
let currentPrice = null
let refreshing = false
let newsEvents = []

function renderSymbolTabs() {
  symbolTabsEl.innerHTML = ''
  for (const symbol of SYMBOLS) {
    const btn = document.createElement('button')
    btn.className = 'symbol-tab-btn' + (symbol.key === activeSymbol.key ? ' active' : '')
    btn.textContent = symbol.label
    btn.addEventListener('click', () => {
      if (symbol.key === activeSymbol.key) return
      activeSymbol = symbol
      zonesByTimeframe = {}
      currentPrice = null
      priceEl.textContent = '—'
      renderSymbolTabs()
      hydrateFromCache(activeSymbol)
      renderDashboard()
      // Force past the in-flight guard: any still-running fetch for the symbol we
      // just left will see `activeSymbol !== symbol` and discard itself harmlessly.
      refreshing = false
      refreshData()
    })
    symbolTabsEl.appendChild(btn)
  }
}

function updateNotifyButtonState() {
  const permission = notificationPermission()
  notifyBtn.classList.toggle('active', permission === 'granted')
  notifyBtn.disabled = permission === 'unsupported'
  notifyBtn.title =
    permission === 'granted'
      ? 'Price alerts enabled'
      : permission === 'denied'
        ? 'Price alerts blocked in browser settings'
        : 'Enable price alerts'
}

function hydrateFromCache(symbol) {
  const cached = loadLastKnown(symbol.key)
  if (!cached) return

  zonesByTimeframe = cached.zonesByTimeframe
  currentPrice = cached.currentPrice
  if (currentPrice != null) priceEl.textContent = formatPrice(currentPrice)
  lastUpdateEl.textContent = `Showing cached data from ${new Date(cached.savedAt).toLocaleString('en-US')}`
}

function renderDashboard() {
  renderNewsBanner()
  renderContent()
}

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

function timeUntil(ts) {
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000))
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`
}

function renderNewsBanner() {
  const upcoming = findUpcomingHighImpact(newsEvents, NEWS_HORIZON_HOURS)

  if (!upcoming.length) {
    newsBannerEl.hidden = true
    return
  }

  const [next, ...rest] = upcoming
  const moreNote = rest.length ? ` (+${rest.length} more within ${NEWS_HORIZON_HOURS}h)` : ''
  newsBannerEl.hidden = false
  newsBannerEl.innerHTML = `
    <span class="news-banner-icon">⚠</span>
    <span>High-impact USD news in ${timeUntil(next.timestamp)}: <strong>${next.title}</strong>${moreNote}</span>
  `
}

async function refreshNewsCalendar() {
  newsEvents = await fetchNewsCalendar()
  renderNewsBanner()
}

function renderZoneCard(zone) {
  const card = document.createElement('div')
  card.className = `zone-card ${zone.type}`
  const brokenNote = zone.brokenCount > 0 ? ` · broken ${zone.brokenCount}x` : ''
  const confluenceNote = zone.confluence?.length ? ` · also on ${zone.confluence.join(', ')}` : ''
  card.innerHTML = `
    <span class="zone-type">${zone.type === 'support' ? 'Support' : 'Resistance'}</span>
    <div class="zone-range">
      <div class="zone-price">${formatPrice(zone.low)} – ${formatPrice(zone.high)}</div>
      <div class="zone-meta">Distance: ${formatPrice(zone.distanceFromPrice)} · Last test: ${timeAgo(zone.lastTouchTime)}${brokenNote}${confluenceNote}</div>
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

  const confluenceRow = signal.confluence?.length
    ? `<div class="signal-confluence">Confluence: also on ${signal.confluence.join(', ')}</div>`
    : ''

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
    ${confluenceRow}
  `
  return card
}

async function refreshData() {
  if (refreshing) return

  refreshing = true
  refreshBtn.classList.add('spinning')
  contentEl.querySelectorAll('.zone-card, .signal-card').forEach((c) => (c.style.opacity = '0.6'))

  const symbol = activeSymbol

  try {
    const raw = await fetchAllTimeframes(symbol.apiSymbol)
    // The user switched symbols while this fetch was in flight — these results
    // belong to the symbol we've since navigated away from, so drop them rather
    // than mixing them into the new symbol's (freshly reset) state.
    if (activeSymbol !== symbol) return

    let anySuccess = false
    for (const tf of TIMEFRAMES) {
      const series = raw[tf.key]
      // Rate-limited or transient fetch failure: keep whatever data is already
      // on screen for this timeframe instead of clearing it out.
      if (series?.error) continue
      anySuccess = true
      const last = series[series.length - 1]
      if (tf.key === 'M5') {
        currentPrice = last.close
        priceEl.textContent = formatPrice(currentPrice)
      }
      const zones = detectZones(series, currentPrice ?? last.close)
      zonesByTimeframe[tf.key] = { zones, series }
    }

    // Every timeframe failed (offline, or the whole API is down) — nothing actually
    // changed, so leave whatever "Last updated" / "Showing cached data" message was
    // already on screen rather than claiming a freshness that didn't happen.
    if (!anySuccess) return

    // Confluence needs every timeframe's zones at once, so it only runs once all of
    // them are in — then signals are built per timeframe with confluence attached.
    annotateConfluence(zonesByTimeframe)
    for (const result of Object.values(zonesByTimeframe)) {
      result.signals = buildSignals(result.zones, result.series)
    }
    checkEntryAlerts(symbol, zonesByTimeframe, currentPrice)
    saveLastKnown(symbol.key, zonesByTimeframe, currentPrice)

    lastUpdateEl.textContent = `Last updated: ${new Date().toLocaleTimeString('en-US')}`
  } catch (err) {
    console.error(err) // keep last good data on screen, no user-facing warning
  } finally {
    refreshing = false
    refreshBtn.classList.remove('spinning')
    renderDashboard()
  }
}

// Refresh is manual-only — the button is the sole trigger, for both price data and
// the news calendar, rather than polling on a timer.
refreshBtn.addEventListener('click', () => {
  refreshData()
  refreshNewsCalendar()
})
notifyBtn.addEventListener('click', async () => {
  await requestNotificationPermission()
  updateNotifyButtonState()
})

renderSymbolTabs()
renderTabs()
updateNotifyButtonState()
hydrateFromCache(activeSymbol)
renderDashboard()
refreshData()
refreshNewsCalendar()
