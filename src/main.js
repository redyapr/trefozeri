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
import { formatMove, formatPrice } from './lib/signalHistoryCore.js'
import { isGoldMarketClosed } from './lib/marketHours.js'

const NEWS_HORIZON_HOURS = 12
// The cron in .github/workflows/deploy.yml refreshes the static snapshot roughly
// every 15 minutes — polling more often than that just re-fetches the same JSON,
// so this checks a few times per cron cycle to pick up each update promptly
// without a manual reload. refreshData() itself is cheap to call when nothing's
// due yet: it checks each timeframe's minRefetchMs before touching the network.
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000

const symbolTabsEl = document.getElementById('symbol-tabs')
const tabsEl = document.getElementById('tabs')
const marketStatusBannerEl = document.getElementById('market-status-banner')
const newsBannerEl = document.getElementById('news-banner')
const contentEl = document.getElementById('content')
const priceEl = document.getElementById('price-display')
const lastUpdateEl = document.getElementById('last-update')
const notifyBtn = document.getElementById('notify-btn')
const historyBtn = document.getElementById('history-btn')
const historyModal = document.getElementById('history-modal')
const historyBody = document.getElementById('history-body')
const historyCloseBtn = document.getElementById('history-close')
const installBtn = document.getElementById('install-btn')

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

// Every accent-driven color on the page (brand mark, icon buttons, prices,
// confluence badge, ...) reads off CSS variables scoped to `body[data-symbol]` (see
// style.css) — so switching symbol re-skins the whole UI, not just which data is shown.
function applySymbolTheme(symbol) {
  document.body.dataset.symbol = symbol.key.toLowerCase()
}

function renderSymbolTabs() {
  symbolTabsEl.innerHTML = ''
  for (const symbol of SYMBOLS) {
    const btn = document.createElement('button')
    btn.className = 'symbol-tab-btn' + (symbol.key === activeSymbol.key ? ' active' : '')
    btn.dataset.sym = symbol.key.toLowerCase()
    btn.textContent = symbol.label
    btn.addEventListener('click', () => {
      if (symbol.key === activeSymbol.key) return
      activeSymbol = symbol
      applySymbolTheme(activeSymbol)
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

function renderMarketStatusBanner() {
  if (activeSymbol.key !== 'XAUUSD' || !isGoldMarketClosed()) {
    marketStatusBannerEl.hidden = true
    return
  }
  marketStatusBannerEl.hidden = false
  marketStatusBannerEl.innerHTML = `
    <span class="market-status-banner-icon">🌙</span>
    <span>Gold market is closed for the weekend (reopens Sunday 22:00 UTC) — prices and signals may be stale.</span>
  `
}

function renderDashboard() {
  renderMarketStatusBanner()
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

// 'ALL' combines every timeframe. Telegram only ever posts H1 signals (see
// TELEGRAM_TIMEFRAMES in scripts/fetch-data.mjs), so the combined win rate here can
// otherwise read differently than the channel's own H1-only track record — this lets
// someone line the two up directly instead of wondering why they don't match.
let historyTfFilter = 'ALL'

function renderHistory() {
  const stats = getStats(activeSymbol.key, historyTfFilter)
  // 'pending' (not yet filled) signals are already visible as live cards on the main
  // dashboard — the track record is for what's actually happened, so it only lists
  // trades that have at least filled.
  const records = getHistory(activeSymbol.key, historyTfFilter)
    .filter((r) => r.status !== 'pending')
    .slice(0, 30)

  const tfFilterHtml = `
    <div class="history-tf-filter">
      ${['ALL', ...TIMEFRAMES.map((tf) => tf.key)]
        .map(
          (tf) =>
            `<button type="button" class="history-tf-btn${tf === historyTfFilter ? ' active' : ''}" data-tf-filter="${tf}">${tf === 'ALL' ? 'All' : tf}</button>`
        )
        .join('')}
    </div>
  `

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
          // running: filled, waiting on SL/TP. win/loss: closed — show what it hit,
          // at what price, and the pip/price move. ('pending' rows are filtered out above.)
          const secondLine =
            r.status === 'running'
              ? `<span>Filled ${formatDateTime(r.filledAt)} (${timeAgo(r.filledAt)}) · running</span>`
              : `<span>${historyExitLine(r, activeSymbol)} (${timeAgo(r.closedAt)})</span>`
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
    : `<p class="history-empty">No filled signals yet for ${activeSymbol.label}${historyTfFilter !== 'ALL' ? ` on ${historyTfFilter}` : ''} — pending ones are on the dashboard, check back here once one fills.</p>`

  historyBody.innerHTML = tfFilterHtml + statsHtml + rowsHtml
}

// Delegated once on the stable container rather than re-attached per render, since
// renderHistory() replaces historyBody's entire innerHTML each time it runs.
historyBody.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tf-filter]')
  if (!btn) return
  historyTfFilter = btn.dataset.tfFilter
  renderHistory()
})

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

function formatDateTime(ts) {
  const d = new Date(ts)
  return `${d.toLocaleDateString('en-US')} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
}

// One line describing how a closed signal ended: which target (or the SL) it hit,
// at what price, how far that was from entry, and when.
function historyExitLine(r, symbol) {
  const isBuy = r.direction === 'buy'
  const label = r.status === 'win' ? `TP${(r.hitTpIndex ?? 0) + 1} hit` : 'SL hit'
  const move = formatMove(symbol.pipSize, r.entry, r.exitPrice, isBuy)
  return `${label} @ ${formatPrice(r.exitPrice)} (${move}) · ${formatDateTime(r.closedAt)}`
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

// The confluence badge is named/colored per the active symbol — "★ Golden Zone" for
// XAUUSD, "◆ Diamond Zone" for BTCUSD (see style.css's body[data-symbol] accents) —
// rather than always "Golden", since that name only really makes sense for gold itself.
function confluenceBadgeHtml() {
  const isXau = activeSymbol.key === 'XAUUSD'
  const icon = isXau ? '★' : '◆'
  const label = isXau ? 'Golden Zone' : 'Diamond Zone'
  return `<span class="confluence-badge"><span class="confluence-badge-icon">${icon}</span> ${label}</span>`
}

function renderZoneCard(zone) {
  const card = document.createElement('div')
  card.className = `zone-card ${zone.type}`
  const flippedFrom = zone.type === 'support' ? 'resistance' : 'support'
  const brokenNote = zone.broken ? ` · flipped from ${flippedFrom} after one breakout` : ''
  const confluenceNote = zone.confluence.length ? ` · also on ${zone.confluence.join(', ')}` : ''
  // Strong and Golden Zone are literally the same condition (see srDetector.js's
  // strengthLabel) — there's no "strong but not confluent" state, so the confluence
  // badge fully replaces a separate "Strong" badge instead of sitting next to one.
  const badge = zone.isGolden ? confluenceBadgeHtml() : '<span class="strength-badge medium">Medium</span>'
  card.innerHTML = `
    <span class="zone-type">${shortCategory(zone.category)}</span>
    <div class="zone-range">
      <div class="zone-price">${formatPrice(zone.price)}</div>
      <div class="zone-meta">Distance: ${formatPrice(zone.distanceFromPrice)} · Formed ${timeAgo(zone.startTime)}${brokenNote}${confluenceNote}</div>
    </div>
    <div class="zone-stats">${badge}</div>
  `
  return card
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
    resistances.forEach((zone) => column.appendChild(renderZoneCard(zone)))
    zonesGrid.appendChild(column)
  }
  if (supports.length) {
    const column = document.createElement('div')
    column.className = 'zone-column'
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
    ...signal.tp.map((t, i) => `TP${i + 1}: ${formatPrice(t.price)} (${formatPrice(t.rr)}R)`),
  ].join('\n')
}

function renderSignalCard(signal) {
  const card = document.createElement('div')
  card.className = `signal-card ${signal.direction}`

  const label = `${signal.direction === 'buy' ? 'BUY' : 'SELL'} ${signal.orderType}`
  const entryText = formatPrice(signal.entry)
  // Strong and Golden Zone are literally the same condition (see srDetector.js's
  // strengthLabel) — no separate "Strong" wording needed once the badge is shown.
  const badge =
    signal.strengthLabel === 'Strong' ? confluenceBadgeHtml() : '<span class="strength-badge medium">Medium</span>'

  const tpRows = signal.tp
    .map(
      (t, i) => `
      <div class="signal-tp-row">
        <span class="signal-tp-left">
          <span>TP${i + 1}</span>
          <span class="rr">(${formatPrice(t.rr)}R)</span>
        </span>
        <span>${formatPrice(t.price)}</span>
      </div>`
    )
    .join('')

  const confluenceRow = signal.confluence?.length
    ? `<div class="signal-confluence">Confluence: also on ${signal.confluence.join(', ')}</div>`
    : ''

  card.innerHTML = `
    <div class="signal-header">
      <div class="signal-header-left">
        <button type="button" class="signal-copy-btn" title="Copy signal" aria-label="Copy signal">${COPY_ICON}</button>
        <span class="signal-direction">${label}</span>
      </div>
      <div class="signal-header-right">
        ${badge}
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
      // TIMEFRAMES is ordered finest-to-broadest (H1, H4, D1) — everything after this
      // timeframe's own index is "higher" and gets offered as extra TP candidates (see
      // buildSignals). H1 can borrow H4/D1 structure; D1 has nothing above it to borrow.
      const tfIndex = TIMEFRAMES.findIndex((tf) => tf.key === tfKey)
      const higherTfZones = TIMEFRAMES.slice(tfIndex + 1).flatMap((tf) => zonesByTimeframe[tf.key]?.zones ?? [])
      result.signals = buildSignals(result.zones, currentPrice, higherTfZones)
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

// Custom install prompt: the browser's own default install UI is inconsistent (a tiny
// address-bar icon on some browsers, nothing visible at all on others) and fires on
// its own schedule — capturing the event instead lets the app show one obvious button
// and trigger the native prompt whenever the user actually clicks it.
let deferredInstallPrompt = null

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredInstallPrompt = e
  installBtn.hidden = false
})

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return
  installBtn.hidden = true
  deferredInstallPrompt.prompt()
  await deferredInstallPrompt.userChoice
  deferredInstallPrompt = null
})

// Already installed (or the browser installed it without ever asking) — nothing left
// to prompt, so the button should never appear even if beforeinstallprompt fires late.
window.addEventListener('appinstalled', () => {
  installBtn.hidden = true
  deferredInstallPrompt = null
})

applySymbolTheme(activeSymbol)
renderSymbolTabs()
renderTabs()
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
