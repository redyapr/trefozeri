import './style.css'
import { TIMEFRAMES, SYMBOLS, fetchAllTimeframes } from './lib/twelveData.js'
import { detectZones, buildSignals, annotateConfluence } from './lib/srDetector.js'
import { loadPositionSettings, savePositionSettings, calculatePositionSize } from './lib/positionSize.js'
import { loadJournal, updateJournal, computeJournalStats } from './lib/journal.js'
import { notificationPermission, requestNotificationPermission, checkEntryAlerts } from './lib/notifications.js'
import { createGoldChart } from './lib/chart.js'
import { fetchNewsCalendar, findUpcomingHighImpact } from './lib/newsCalendar.js'

const AUTO_REFRESH_MS = 3 * 60 * 1000
const NEWS_REFRESH_MS = 30 * 60 * 1000
const NEWS_HORIZON_HOURS = 12
const VIEWS = [
  { key: 'dashboard', label: 'Signals' },
  { key: 'journal', label: 'Journal' },
]

const symbolTabsEl = document.getElementById('symbol-tabs')
const brandEyebrowEl = document.getElementById('brand-eyebrow')
const viewTabsEl = document.getElementById('view-tabs')
const tabsEl = document.getElementById('tabs')
const positionSettingsWrapEl = document.getElementById('position-settings')
const newsBannerEl = document.getElementById('news-banner')
const chartContainerEl = document.getElementById('chart-container')
const contentEl = document.getElementById('content')
const priceEl = document.getElementById('price-display')
const lastUpdateEl = document.getElementById('last-update')
const refreshBtn = document.getElementById('refresh-btn')
const notifyBtn = document.getElementById('notify-btn')
const psBalanceEl = document.getElementById('ps-balance')
const psRiskEl = document.getElementById('ps-risk')
const psUnitsEl = document.getElementById('ps-units')

let activeSymbol = SYMBOLS[0]
let activeView = VIEWS[0].key
let activeTab = TIMEFRAMES[2].key // M30 default: reasonable middle ground
let zonesByTimeframe = {}
let currentPrice = null
let refreshing = false
let newsEvents = []
let positionSettings = loadPositionSettings(activeSymbol)
const chart = createGoldChart(chartContainerEl)

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
      chart.clear()
      positionSettings = loadPositionSettings(activeSymbol)
      brandEyebrowEl.textContent = `${activeSymbol.eyebrow} · ${activeSymbol.label}`
      renderSymbolTabs()
      renderPositionSettings()
      renderActiveView()
      // Force past the in-flight guard: any still-running fetch for the symbol we
      // just left will see `activeSymbol !== symbol` and discard itself harmlessly.
      refreshing = false
      refreshData()
    })
    symbolTabsEl.appendChild(btn)
  }
}

function renderViewTabs() {
  viewTabsEl.innerHTML = ''
  for (const view of VIEWS) {
    const btn = document.createElement('button')
    btn.className = 'view-tab-btn' + (view.key === activeView ? ' active' : '')
    btn.textContent = view.label
    btn.addEventListener('click', () => {
      activeView = view.key
      renderViewTabs()
      renderActiveView()
    })
    viewTabsEl.appendChild(btn)
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

function renderActiveView() {
  const isDashboard = activeView === 'dashboard'
  tabsEl.hidden = !isDashboard
  positionSettingsWrapEl.hidden = !isDashboard
  chartContainerEl.hidden = !isDashboard

  if (isDashboard) {
    renderNewsBanner()
    renderContent()
  } else {
    newsBannerEl.hidden = true
    renderJournalView()
  }
}

function renderPositionSettings() {
  psBalanceEl.value = positionSettings.balance
  psRiskEl.value = positionSettings.riskPercent
  psUnitsEl.value = positionSettings.unitsPerLot
}

// Attached once — reads `positionSettings`/`activeSymbol` fresh each time it fires,
// so it stays correct across symbol switches without needing to be re-bound.
function initPositionSettingsListeners() {
  const onChange = (key, el) => {
    el.addEventListener('input', () => {
      positionSettings = { ...positionSettings, [key]: parseFloat(el.value) || 0 }
      savePositionSettings(activeSymbol, positionSettings)
      renderContent()
    })
  }
  onChange('balance', psBalanceEl)
  onChange('riskPercent', psRiskEl)
  onChange('unitsPerLot', psUnitsEl)
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

  chart.update({ series: result.series, zones: result.zones, signals: result.signals ?? [] })

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

function renderEquitySparkline(equityCurve) {
  if (equityCurve.length < 2) return ''

  const width = 100
  const height = 28
  const min = Math.min(0, ...equityCurve)
  const max = Math.max(0, ...equityCurve)
  const range = max - min || 1
  const toY = (v) => (height - ((v - min) / range) * height).toFixed(1)

  const points = equityCurve
    .map((v, i) => `${((i / (equityCurve.length - 1)) * width).toFixed(1)},${toY(v)}`)
    .join(' ')
  const last = equityCurve[equityCurve.length - 1]

  return `
    <svg class="equity-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line x1="0" y1="${toY(0)}" x2="${width}" y2="${toY(0)}" />
      <polyline points="${points}" fill="none" stroke="${last >= 0 ? '#7fa787' : '#b1665c'}" stroke-width="2" />
    </svg>
  `
}

function renderJournalStats(stats) {
  const wrap = document.createElement('div')
  wrap.className = 'journal-summary'

  const tiles = document.createElement('div')
  tiles.className = 'journal-tiles'
  tiles.innerHTML = `
    <div class="journal-tile">
      <span class="journal-tile-label">Win rate</span>
      <span class="journal-tile-value">${Math.round(stats.winRate * 100)}%</span>
      <span class="journal-tile-sub">${stats.wins}W / ${stats.losses}L</span>
    </div>
    <div class="journal-tile">
      <span class="journal-tile-label">Expectancy</span>
      <span class="journal-tile-value ${stats.expectancy >= 0 ? 'positive' : 'negative'}">${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy.toFixed(2)}R</span>
      <span class="journal-tile-sub">per trade</span>
    </div>
    <div class="journal-tile">
      <span class="journal-tile-label">Avg win</span>
      <span class="journal-tile-value positive">+${stats.avgWinR.toFixed(2)}R</span>
    </div>
    <div class="journal-tile">
      <span class="journal-tile-label">Avg loss</span>
      <span class="journal-tile-value negative">${stats.avgLossR.toFixed(2)}R</span>
    </div>
    <div class="journal-tile">
      <span class="journal-tile-label">Open</span>
      <span class="journal-tile-value">${stats.openCount}</span>
    </div>
  `
  wrap.appendChild(tiles)

  if (stats.equityCurve.length >= 2) {
    const curve = document.createElement('div')
    curve.className = 'journal-equity'
    curve.innerHTML = `<span class="journal-tile-label">Equity curve (R)</span>${renderEquitySparkline(stats.equityCurve)}`
    wrap.appendChild(curve)
  }

  return wrap
}

function renderJournalView() {
  const journal = [...loadJournal()].reverse()

  if (!journal.length) {
    contentEl.innerHTML = '<p class="empty-state">No signals logged yet — they\'re recorded automatically as they appear.</p>'
    return
  }

  const stats = computeJournalStats(journal)

  contentEl.innerHTML = ''
  contentEl.appendChild(renderJournalStats(stats))

  const list = document.createElement('div')
  list.className = 'journal-list'
  for (const entry of journal) {
    const row = document.createElement('div')
    row.className = `journal-row ${entry.outcome}`
    row.innerHTML = `
      <span class="journal-symbol">${entry.symbol ?? 'XAUUSD'}</span>
      <span class="journal-tf">${entry.timeframe}</span>
      <span class="journal-dir ${entry.direction}">${entry.direction === 'buy' ? 'BUY' : 'SELL'} ${entry.orderType}</span>
      <span class="journal-prices">${formatPrice(entry.entry)} · SL ${formatPrice(entry.sl)} · TP ${formatPrice(entry.tp[0])}</span>
      <span class="journal-outcome ${entry.outcome}">${entry.outcome}</span>
      <span class="journal-time">${new Date(entry.loggedAt).toLocaleString('en-US')}</span>
    `
    list.appendChild(row)
  }
  contentEl.appendChild(list)
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

  const size = calculatePositionSize(positionSettings, signal.entry, signal.sl)

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
    <div class="signal-row size">
      <span class="signal-label">Size (risking $${formatPrice(size.riskAmount)})</span>
      <span class="signal-value">${size.lots.toFixed(2)} lots</span>
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
      zonesByTimeframe[tf.key] = { zones, series }
    }

    // Confluence needs every timeframe's zones at once, so it only runs once all of
    // them are in — then signals are built per timeframe with confluence attached.
    annotateConfluence(zonesByTimeframe)
    for (const result of Object.values(zonesByTimeframe)) {
      result.signals = buildSignals(result.zones, result.series)
    }
    updateJournal(symbol.key, zonesByTimeframe)
    checkEntryAlerts(symbol, zonesByTimeframe, currentPrice)

    lastUpdateEl.textContent = `Last updated: ${new Date().toLocaleTimeString('en-US')}`
  } catch (err) {
    console.error(err) // keep last good data on screen, no user-facing warning
  } finally {
    refreshing = false
    refreshBtn.classList.remove('spinning')
    renderActiveView()
  }
}

refreshBtn.addEventListener('click', refreshData)
notifyBtn.addEventListener('click', async () => {
  await requestNotificationPermission()
  updateNotifyButtonState()
})

brandEyebrowEl.textContent = `${activeSymbol.eyebrow} · ${activeSymbol.label}`
renderSymbolTabs()
renderViewTabs()
renderTabs()
renderPositionSettings()
initPositionSettingsListeners()
updateNotifyButtonState()
renderActiveView()
refreshData()
refreshNewsCalendar()
setInterval(refreshData, AUTO_REFRESH_MS)
setInterval(refreshNewsCalendar, NEWS_REFRESH_MS)
