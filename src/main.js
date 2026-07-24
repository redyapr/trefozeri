import './style.css'
import { TIMEFRAMES, SYMBOLS, fetchAllTimeframes } from './lib/twelveData.js'
import { detectZones, buildSignals, annotateConfluence } from './lib/srDetector.js'
import { fetchNewsCalendar, findUpcomingHighImpact } from './lib/newsCalendar.js'
import { saveLastKnown, loadLastKnown } from './lib/offlineCache.js'
import { loadUiState, saveUiState } from './lib/uiState.js'

const NEWS_HORIZON_HOURS = 12

const symbolTabsEl = document.getElementById('symbol-tabs')
const tabsEl = document.getElementById('tabs')
const newsBannerEl = document.getElementById('news-banner')
const contentEl = document.getElementById('content')
const priceEl = document.getElementById('price-display')
const lastUpdateEl = document.getElementById('last-update')
const refreshBtn = document.getElementById('refresh-btn')
const themeBtn = document.getElementById('theme-btn')

const uiState = loadUiState()

let activeSymbol = SYMBOLS.find((s) => s.key === uiState.symbolKey) ?? SYMBOLS[0]
let activeTab = TIMEFRAMES.find((tf) => tf.key === uiState.tab)?.key ?? TIMEFRAMES[2].key // M30 default: reasonable middle ground
let zonesByTimeframe = {}
let lastFetchedAt = {}
let currentPrice = null
let refreshing = false
let newsEvents = []

const MOON_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
const SUN_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>'

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  themeBtn.innerHTML = theme === 'dark' ? SUN_ICON : MOON_ICON
  themeBtn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
}

function renderSymbolTabs() {
  symbolTabsEl.innerHTML = ''
  for (const symbol of SYMBOLS) {
    const btn = document.createElement('button')
    btn.className = 'symbol-tab-btn' + (symbol.key === activeSymbol.key ? ' active' : '')
    btn.textContent = symbol.label
    btn.addEventListener('click', () => {
      if (symbol.key === activeSymbol.key) return
      activeSymbol = symbol
      saveUiState({ symbolKey: activeSymbol.key })
      zonesByTimeframe = {}
      lastFetchedAt = {}
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

function hydrateFromCache(symbol) {
  const cached = loadLastKnown(symbol.key)
  if (!cached) return

  zonesByTimeframe = cached.zonesByTimeframe
  currentPrice = cached.currentPrice
  // We only store one save time for the whole snapshot, not per timeframe, but that's
  // a fine approximation — it stops the refresh that follows hydration from immediately
  // re-fetching everything the cache just gave us for free.
  lastFetchedAt = Object.fromEntries(Object.keys(cached.zonesByTimeframe).map((key) => [key, cached.savedAt]))
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
      saveUiState({ tab: activeTab })
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

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'

function buildSignalText(signal) {
  const label = `${signal.direction === 'buy' ? 'BUY' : 'SELL'} ${signal.orderType}`
  return [
    `${label} — ${activeSymbol.label} ${activeTab}`,
    `Entry: ${formatPrice(signal.entry)}`,
    `SL: ${formatPrice(signal.sl)}`,
    ...signal.tp.map((t, i) => `TP${i + 1}: ${formatPrice(t.price)} (${t.rr.toFixed(1)}R)`),
  ].join('\n')
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
      <div class="signal-header-right">
        <span class="signal-zone-strength">${signal.strengthLabel} ${zoneLabel}</span>
        <button type="button" class="signal-copy-btn" title="Copy signal" aria-label="Copy signal">${COPY_ICON}</button>
      </div>
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

  const copyBtn = card.querySelector('.signal-copy-btn')
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(buildSignalText(signal))
      copyBtn.innerHTML = CHECK_ICON
      copyBtn.classList.add('copied')
      setTimeout(() => {
        copyBtn.innerHTML = COPY_ICON
        copyBtn.classList.remove('copied')
      }, 1500)
    } catch (err) {
      console.error(err) // clipboard permission denied or unsupported — no destructive fallback needed
    }
  })

  return card
}

async function refreshData() {
  if (refreshing) return

  const now = Date.now()
  // Skip timeframes that were fetched too recently to plausibly have new data yet —
  // this is what keeps a burst of manual refreshes from re-requesting all 6
  // timeframes every time and blowing through the API's per-minute rate limit.
  const dueTimeframes = TIMEFRAMES.filter(
    (tf) => !lastFetchedAt[tf.key] || now - lastFetchedAt[tf.key] >= tf.minRefetchMs
  )
  if (!dueTimeframes.length) {
    // Nothing could plausibly have changed yet — skip the network round-trip, but
    // still acknowledge the click so the button doesn't look unresponsive.
    refreshBtn.classList.add('spinning')
    setTimeout(() => refreshBtn.classList.remove('spinning'), 400)
    return
  }

  refreshing = true
  refreshBtn.classList.add('spinning')
  contentEl.querySelectorAll('.zone-card, .signal-card').forEach((c) => (c.style.opacity = '0.6'))

  const symbol = activeSymbol

  try {
    const raw = await fetchAllTimeframes(symbol.apiSymbol, dueTimeframes)
    // The user switched symbols while this fetch was in flight — these results
    // belong to the symbol we've since navigated away from, so drop them rather
    // than mixing them into the new symbol's (freshly reset) state.
    if (activeSymbol !== symbol) return

    let anySuccess = false
    for (const tf of dueTimeframes) {
      const series = raw[tf.key]
      // Rate-limited or transient fetch failure: keep whatever data is already
      // on screen for this timeframe instead of clearing it out, and leave it
      // due for next time rather than marking it as freshly fetched.
      if (series?.error) continue
      anySuccess = true
      lastFetchedAt[tf.key] = now
      const last = series[series.length - 1]
      if (tf.key === 'M5') {
        currentPrice = last.close
        priceEl.textContent = formatPrice(currentPrice)
      }
      const zones = detectZones(series, currentPrice ?? last.close)
      zonesByTimeframe[tf.key] = { zones, series }
    }

    // Every due timeframe failed (offline, or the whole API is down) — nothing
    // actually changed, so leave whatever "Last updated" / "Showing cached data"
    // message was already on screen rather than claiming a freshness that didn't happen.
    if (!anySuccess) return

    // Confluence needs every timeframe's zones at once, so it only runs once all of
    // them are in — then signals are built per timeframe with confluence attached.
    annotateConfluence(zonesByTimeframe)
    for (const result of Object.values(zonesByTimeframe)) {
      result.signals = buildSignals(result.zones, result.series)
    }
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
themeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  saveUiState({ theme: next })
})

renderSymbolTabs()
renderTabs()
applyTheme(uiState.theme === 'dark' ? 'dark' : 'light')
hydrateFromCache(activeSymbol)
renderDashboard()
refreshData()
refreshNewsCalendar()
