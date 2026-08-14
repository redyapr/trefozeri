import './style.css'
import { TIMEFRAMES, SYMBOLS, fetchAllTimeframes } from './lib/twelveData.js'
import { detectLevels, buildSignals, annotateGoldenZones } from './lib/srDetector.js'
import { fetchNewsCalendar, findUpcomingHighImpact } from './lib/newsCalendar.js'
import { saveLastKnown, loadLastKnown } from './lib/offlineCache.js'
import { loadUiState, saveUiState } from './lib/uiState.js'
import { renderZoneChart } from './lib/priceChart.js'
import {
  isSupported as isNotifySupported,
  getPermission as getNotifyPermission,
  isEnabled as isNotifyEnabled,
  enableNotifications,
  disableNotifications,
  checkZonesAndSignals,
} from './lib/notifications.js'
import { loadHistory, getHistory, getStats } from './lib/signalHistory.js'

const NEWS_HORIZON_HOURS = 12
// The cron in .github/workflows/deploy.yml refreshes the static snapshot roughly
// every 15 minutes — polling more often than that just re-fetches the same JSON,
// so this checks a few times per cron cycle to pick up each update promptly
// without a manual reload. refreshData() itself is cheap to call when nothing's
// due yet: it checks each timeframe's minRefetchMs before touching the network.
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000

const symbolTabsEl = document.getElementById('symbol-tabs')
const tabsEl = document.getElementById('tabs')
const newsBannerEl = document.getElementById('news-banner')
const contentEl = document.getElementById('content')
const priceEl = document.getElementById('price-display')
const lastUpdateEl = document.getElementById('last-update')
const themeBtn = document.getElementById('theme-btn')
const notifyBtn = document.getElementById('notify-btn')
const historyBtn = document.getElementById('history-btn')
const historyModal = document.getElementById('history-modal')
const historyBody = document.getElementById('history-body')
const historyCloseBtn = document.getElementById('history-close')

const uiState = loadUiState()

let activeSymbol = SYMBOLS.find((s) => s.key === uiState.symbolKey) ?? SYMBOLS[0]
let activeTab = TIMEFRAMES.find((tf) => tf.key === uiState.tab)?.key ?? TIMEFRAMES[0].key // H1 default
let zonesByTimeframe = {}
let lastFetchedAt = {}
let currentPrice = null
let refreshing = false
let newsEvents = []
let activeChart = null

// Charts don't clean themselves up when their container is dropped from the DOM
// (contentEl.innerHTML rebuilds it on every render), so the old instance must be
// torn down explicitly first or its resize observer/canvas leaks.
function disposeChart() {
  if (!activeChart) return
  activeChart.remove()
  activeChart = null
}

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
  // Keep the track-record modal live if it's already open, instead of only updating
  // it the next time it's opened.
  if (!historyModal.hidden) renderHistory()
}

function updateNotifyBtn() {
  if (!isNotifySupported()) {
    notifyBtn.hidden = true
    return
  }
  const permission = getNotifyPermission()
  const enabled = isNotifyEnabled()
  notifyBtn.classList.toggle('active', enabled)
  notifyBtn.disabled = permission === 'denied'
  notifyBtn.title =
    permission === 'denied'
      ? 'Notifications blocked — enable in browser settings'
      : enabled
        ? 'Disable price/signal alerts'
        : 'Enable price/signal alerts'
}

notifyBtn.addEventListener('click', async () => {
  if (getNotifyPermission() !== 'denied') {
    if (isNotifyEnabled()) {
      disableNotifications()
    } else {
      await enableNotifications()
    }
  }
  // Refresh either way — permission can also change out-of-band (revoked in the
  // browser's own site settings while the tab is still open).
  updateNotifyBtn()
})

function renderHistory() {
  const stats = getStats(activeSymbol.key)
  const records = getHistory(activeSymbol.key).slice(0, 30)

  const statsHtml = `
    <div class="history-stats">
      <div class="history-stat running"><div class="num">${stats.running}</div><div class="lbl">Running</div></div>
      <div class="history-stat win"><div class="num">${stats.wins}</div><div class="lbl">Wins</div></div>
      <div class="history-stat loss"><div class="num">${stats.losses}</div><div class="lbl">Losses</div></div>
      <div class="history-stat"><div class="num">${stats.winRate != null ? stats.winRate + '%' : '—'}</div><div class="lbl">Win rate</div></div>
    </div>
  `

  const rowsHtml = records.length
    ? `<div class="history-list">${records
        .map((r) => {
          // pending: order not filled yet, nothing more to show.
          // running: filled, waiting on SL/TP.
          // win/loss: closed — show what it hit, at what price, and the pip/price move.
          const secondLine =
            r.status === 'running'
              ? `<span>Filled ${formatDateTime(r.filledAt)} (${timeAgo(r.filledAt)}) · running</span>`
              : r.status !== 'pending'
                ? `<span>${historyExitLine(r, activeSymbol)} (${timeAgo(r.closedAt)})</span>`
                : ''
          return `
        <div class="history-row">
          <div class="history-row-main">
            <strong>${r.direction === 'buy' ? 'BUY' : 'SELL'} ${shortCategory(r.category)} · ${r.tf} at ${formatPrice(r.entry)}</strong>
            <span>Opened ${formatDateTime(r.openedAt)} (${timeAgo(r.openedAt)})</span>
            ${secondLine}
          </div>
          <span class="history-row-badge ${r.status}">${r.status}</span>
        </div>`
        })
        .join('')}</div>`
    : `<p class="history-empty">No signals recorded yet for ${activeSymbol.label} — check back after a few refreshes.</p>`

  historyBody.innerHTML = statsHtml + rowsHtml
}

historyBtn.addEventListener('click', () => {
  renderHistory()
  historyModal.hidden = false
})

historyCloseBtn.addEventListener('click', () => {
  historyModal.hidden = true
})

historyModal.addEventListener('click', (e) => {
  if (e.target === historyModal) historyModal.hidden = true
})

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
  return String(Math.round(p))
}

// Track-record rows need real precision (pips are a fraction of a whole price unit),
// unlike the rest of the app's rounded-to-whole-number display.
function formatExitPrice(p) {
  return p.toFixed(2)
}

function formatDateTime(ts) {
  const d = new Date(ts)
  return `${d.toLocaleDateString('en-US')} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
}

// How far price moved from entry to exit, in the trade's favor being positive —
// e.g. a sell's exit price is *below* entry on a win, so this flips the raw sign
// rather than just reporting exitPrice - entry verbatim.
function formatMove(symbol, entry, exitPrice, isBuy) {
  const raw = exitPrice - entry
  const favorable = isBuy ? raw : -raw
  const sign = favorable >= 0 ? '+' : ''
  if (symbol.pipSize) {
    const pips = Math.round(favorable / symbol.pipSize)
    return `${sign}${pips} pips`
  }
  // No standard pip convention for this symbol (e.g. crypto) — show the raw $ move instead.
  return `${sign}${favorable.toFixed(2)}`
}

// One line describing how a closed signal ended: which target (or the SL) it hit,
// at what price, how far that was from entry, and when.
function historyExitLine(r, symbol) {
  const isBuy = r.direction === 'buy'
  const label = r.status === 'win' ? `TP${(r.hitTpIndex ?? 0) + 1} hit` : 'SL hit'
  const move = formatMove(symbol, r.entry, r.exitPrice, isBuy)
  return `${label} @ ${formatExitPrice(r.exitPrice)} (${move}) · ${formatDateTime(r.closedAt)}`
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

// The shared track record is a static file the cron job rewrites roughly every 15
// minutes (see scripts/fetch-data.mjs) — refetch it on the same cadence as price data
// rather than only once at startup, so a track record modal left open updates on its own.
async function refreshHistory() {
  await loadHistory()
  renderDashboard()
}

// Abbreviated for display only — 'Resistance' is long enough to crowd the price
// next to it in the card's fixed-width label column; matching/confluence logic
// elsewhere still uses the full zone.category string.
function shortCategory(category) {
  return category === 'Resistance' ? 'Resist.' : category
}

function renderZoneCard(zone) {
  const card = document.createElement('div')
  card.className = `zone-card ${zone.type}`
  const flippedFrom = zone.type === 'support' ? 'resistance' : 'support'
  const brokenNote = zone.broken ? ` · flipped from ${flippedFrom} after one breakout` : ''
  const confluenceNote = zone.confluence.length ? ` · also on ${zone.confluence.join(', ')}` : ''
  card.innerHTML = `
    <span class="zone-type">${shortCategory(zone.category)}</span>
    <div class="zone-range">
      <div class="zone-price">${formatPrice(zone.price)}</div>
      <div class="zone-meta">Distance: ${formatPrice(zone.distanceFromPrice)} · Formed ${timeAgo(zone.startTime)}${brokenNote}${confluenceNote}</div>
    </div>
    <div class="zone-stats">
      <span class="strength-badge ${zone.isGolden ? 'strong' : 'medium'}">${zone.isGolden ? '★ Golden Zone' : 'Medium'}</span>
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
  disposeChart()

  if (!result) {
    contentEl.innerHTML = `<p class="empty-state">Loading ${activeTab} data...</p>`
    return
  }

  if (!result.zones.length) {
    contentEl.innerHTML = `<p class="empty-state">No significant S/R zones detected yet for ${activeTab}.</p>`
    return
  }

  contentEl.innerHTML = ''

  // Chart needs to be attached to the DOM before it's created (lightweight-charts
  // measures the container for its initial size), so append the empty div first.
  const chartContainer = document.createElement('div')
  chartContainer.className = 'zone-chart'
  contentEl.appendChild(chartContainer)
  activeChart = renderZoneChart(chartContainer, result.series, result.zones)

  // Nearest-to-price first — the levels most likely to matter for the next move show
  // up top (there's at most one Support/Resistance/SBR/RBS each, so this is a 0-2 sort).
  const byDistance = (a, b) => a.distanceFromPrice - b.distanceFromPrice
  const resistances = result.zones.filter((z) => z.type === 'resistance').sort(byDistance)
  const supports = result.zones.filter((z) => z.type === 'support').sort(byDistance)

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

  // Signals go below the S/R zones they're derived from, not above.
  const signals = result.signals ?? []
  if (signals.length) {
    const signalsGrid = document.createElement('div')
    signalsGrid.className = 'signals-grid'
    signals.forEach((signal) => signalsGrid.appendChild(renderSignalCard(signal)))
    contentEl.appendChild(signalsGrid)
  }
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
  const zoneLabel = shortCategory(signal.category)
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
  // this is what keeps refreshData() (called on startup and on every symbol switch)
  // from re-requesting all timeframes every time and blowing through the API's
  // per-minute rate limit.
  const dueTimeframes = TIMEFRAMES.filter(
    (tf) => !lastFetchedAt[tf.key] || now - lastFetchedAt[tf.key] >= tf.minRefetchMs
  )
  if (!dueTimeframes.length) return

  refreshing = true
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
      // H1 is the finest timeframe still fetched, so it's the freshest source for spot.
      if (tf.key === 'H1') {
        currentPrice = last.close
        priceEl.textContent = formatPrice(currentPrice)
      }
      const zones = detectLevels(series, currentPrice ?? last.close)
      zonesByTimeframe[tf.key] = { zones, series }
    }

    // Every due timeframe failed (offline, or the whole API is down) — nothing
    // actually changed, so leave whatever "Last updated" / "Showing cached data"
    // message was already on screen rather than claiming a freshness that didn't happen.
    if (!anySuccess) return

    // Golden Zone confluence needs every timeframe's levels at once, so it only runs
    // once all of them are in — then signals are built per timeframe with it attached.
    annotateGoldenZones(zonesByTimeframe)
    for (const [tfKey, result] of Object.entries(zonesByTimeframe)) {
      result.signals = buildSignals(result.zones)
    }
    checkZonesAndSignals(symbol.key, symbol.label, zonesByTimeframe, currentPrice)
    saveLastKnown(symbol.key, zonesByTimeframe, currentPrice)

    lastUpdateEl.textContent = `Last updated: ${new Date().toLocaleTimeString('en-US')}`
  } catch (err) {
    console.error(err) // keep last good data on screen, no user-facing warning
  } finally {
    refreshing = false
    renderDashboard()
  }
}

themeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  saveUiState({ theme: next })
  // Chart colors are read from CSS vars at creation time, so it needs a rebuild to pick up the new theme.
  renderContent()
})

renderSymbolTabs()
renderTabs()
applyTheme(uiState.theme === 'dark' ? 'dark' : 'light')
updateNotifyBtn()
hydrateFromCache(activeSymbol)
renderDashboard()
refreshData()
refreshNewsCalendar()
refreshHistory()
setInterval(() => {
  refreshData()
  refreshNewsCalendar()
  refreshHistory()
}, AUTO_REFRESH_INTERVAL_MS)
