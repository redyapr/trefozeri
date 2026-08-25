import './style.css'
import { TIMEFRAMES, SYMBOLS, fetchAllTimeframes } from './lib/twelveData.js'
import { detectLevels, buildSignals, annotateGoldenZones, isPriceStagnant, computeTrend } from './lib/srDetector.js'
import { fetchNewsCalendar, findUpcomingHighImpact } from './lib/newsCalendar.js'
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
import { loadHistory, getHistory, getStats, getBreakdown, buildHistoryCsv, getEquityCurve } from './lib/signalHistory.js'
import { formatMove, formatPrice } from './lib/signalHistoryCore.js'
import { renderEquityChart } from './lib/priceChart.js'
import { isGoldMarketClosed, nextGoldReopenUtc } from './lib/marketHours.js'

const NEWS_HORIZON_HOURS = 12
// The cron in .github/workflows/deploy.yml refreshes the static snapshot every 5
// minutes too (see fetchThrottled in scripts/fetch-data.mjs — XAUUSD's own H1/H4/D1
// are throttled to a slower cadence server-side, but the static JSON files themselves
// are still rewritten every run), so this matches that cadence 1:1. refreshData()
// refetches all three timeframes on every tick unconditionally — see TIMEFRAMES' own
// comment in twelveData.js for why that no longer needs its own client-side throttle.
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000

const symbolTabsEl = document.getElementById('symbol-tabs')
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
const historyExportBtn = document.getElementById('history-export-btn')
const installBtn = document.getElementById('install-btn')
const timeframeFilterEl = document.getElementById('timeframe-filter')

const uiState = loadUiState()

let activeSymbol = SYMBOLS.find((s) => s.key === uiState.symbolKey) ?? SYMBOLS[0]
// Which timeframes' zones show up in the zone cards and on the chart — a pure display
// filter (see renderContent below): signal generation, TP borrowing, trend, and the
// shared track record all still run off the full H1+H4+D1 set regardless, same as
// before this existed. Defaults to all three only when nothing's saved YET (no
// visibleTimeframes key at all, or a corrupt/non-array value) — a deliberately saved
// empty selection (the user unchecked everything) is respected as-is, not silently
// reset back to "all" on the next reload.
const ALL_TIMEFRAME_KEYS = TIMEFRAMES.map((tf) => tf.key)
let visibleTimeframes = new Set(
  Array.isArray(uiState.visibleTimeframes)
    ? uiState.visibleTimeframes.filter((tf) => ALL_TIMEFRAME_KEYS.includes(tf))
    : ALL_TIMEFRAME_KEYS
)
let zonesByTimeframe = {}
let currentPrice = null
let refreshing = false
// Bumped on every symbol switch so a fetch already in flight for the symbol just left
// can tell it's been superseded — its own `finally` block checks this before touching
// `refreshing`/re-rendering, so it can't re-open the guard or trigger an extra render
// out from under the new symbol's own, still-genuinely-in-progress fetch.
let refreshGeneration = 0
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

// Same reasoning as disposeChart above, but for the track record modal's own equity
// chart — historyBody.innerHTML is rebuilt from scratch on every renderHistory() call
// (including the 5-minute auto-refresh while the modal's left open), which orphans
// whatever chart instance was drawn into the previous container.
let activeEquityChart = null
function disposeEquityChart() {
  if (!activeEquityChart) return
  activeEquityChart.remove()
  activeEquityChart = null
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
      currentPrice = null
      priceEl.textContent = '—'
      lastUpdateEl.textContent = '' // the old symbol's fetch time no longer applies to this one
      refreshGeneration++
      renderSymbolTabs()
      renderDashboard()
      // Force past the in-flight guard: any still-running fetch for the symbol we
      // just left will see `activeSymbol !== symbol` and discard itself harmlessly —
      // and, since refreshGeneration just changed, its own finally block won't reset
      // `refreshing` or re-render out from under this fetch once it eventually settles.
      refreshing = false
      refreshData()
    })
    symbolTabsEl.appendChild(btn)
  }
}

function renderMarketStatusBanner() {
  if (activeSymbol.key !== 'XAUUSD') {
    marketStatusBannerEl.hidden = true
    return
  }

  if (isGoldMarketClosed()) {
    marketStatusBannerEl.hidden = false
    // No explicit timeZone — toLocaleString reads the browser's own local zone, so
    // this shows whenever the market actually reopens for the visitor, not a fixed
    // "22:00 UTC" they'd have to convert themselves.
    const reopenText = nextGoldReopenUtc().toLocaleString(undefined, {
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    })
    marketStatusBannerEl.innerHTML = `
      <span class="market-status-banner-icon">🌙</span>
      <span>Gold market is closed for the weekend (reopens ${reopenText}) — prices and signals may be stale.</span>
    `
    return
  }

  // isGoldMarketClosed only knows the regular Fri 22:00 -> Sun 22:00 UTC weekend
  // closure — it has no idea about an exchange holiday on an otherwise normal weekday.
  // isPriceStagnant catches that directly from the data instead: near-zero movement
  // over the last several H1 candles reads the same as "market's not really open"
  // regardless of which day it happens to be.
  if (isPriceStagnant(zonesByTimeframe.H1?.series)) {
    marketStatusBannerEl.hidden = false
    marketStatusBannerEl.innerHTML = `
      <span class="market-status-banner-icon">🌙</span>
      <span>Gold price looks stagnant (likely a market holiday) — prices and signals may be stale.</span>
    `
    return
  }

  marketStatusBannerEl.hidden = true
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
  // Ships `hidden` in the markup (like install-btn) so it never flashes visible for
  // an instant on an unsupported browser before this function gets to hide it — has
  // to be explicitly un-hidden here the first time support is confirmed.
  notifyBtn.hidden = false
  const permission = getNotifyPermission()
  const enabled = isNotifyEnabled()
  notifyBtn.classList.toggle('active', enabled)
  notifyBtn.disabled = permission === 'denied'
  const label =
    permission === 'denied'
      ? 'Notifications blocked — enable in browser settings'
      : enabled
        ? 'Disable price/signal alerts'
        : 'Enable price/signal alerts'
  notifyBtn.title = label
  // aria-label wins over title as the accessible name — update both, or a screen
  // reader keeps announcing the button's very first state forever.
  notifyBtn.setAttribute('aria-label', label)
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

// Distinguishes "genuinely no filled signals yet" from "haven't fetched the track
// record from the server at all yet" — without this, opening the modal in the brief
// window before the first refreshHistory() resolves shows the same empty-state copy
// as a real zero-signals case, which reads as "this dashboard has no track record"
// rather than "still loading".
let historyLoaded = false

// How many rows are currently shown per symbol — starts at HISTORY_PAGE_SIZE, grows by
// the same amount each "Load more" click. Kept per-symbol (not just one shared number)
// so switching symbols and back doesn't reset how far you'd scrolled into either one.
// A plain module-level Map survives across renderHistory() calls (including the
// 5-minute auto-refresh) without needing to thread it through anything.
const HISTORY_PAGE_SIZE = 30
const historyVisibleCounts = new Map()

function breakdownGroupHtml(title, groups) {
  return `
    <div class="breakdown-section">
      <h3>${title}</h3>
      <div class="breakdown-list">
        ${groups
          .map(
            (g) => `
          <div class="breakdown-row">
            <span class="breakdown-label">${g.key}</span>
            <div class="breakdown-bar"><div class="breakdown-bar-fill" style="width:${g.winRate}%"></div></div>
            <span class="breakdown-value">${g.winRate}% <small>(${g.wins}W/${g.losses}L)</small></span>
          </div>`
          )
          .join('')}
      </div>
    </div>`
}

function renderHistory() {
  disposeEquityChart()

  if (!historyLoaded) {
    historyBody.innerHTML = '<p class="history-empty">Loading track record…</p>'
    historyExportBtn.disabled = true
    return
  }

  // No per-timeframe filter — signals (and so the track record) are H1-only now (see
  // scripts/fetch-data.mjs), so "every timeframe" and "H1 only" are already the same
  // thing going forward. A handful of H4/D1 records from before that policy may still
  // show up here until they finish closing out on their own.
  const stats = getStats(activeSymbol.key)
  const breakdown = getBreakdown(activeSymbol.key)
  const equityPoints = getEquityCurve(activeSymbol.key)
  // 'pending' (not yet filled) signals are already visible as live cards on the main
  // dashboard — the track record is for what's actually happened, so it only lists
  // trades that have at least filled. Not sliced yet — CSV export and the "Load more"
  // remaining-count both need the true total, not just what's currently visible.
  const records = getHistory(activeSymbol.key).filter((r) => r.status !== 'pending')
  historyExportBtn.disabled = records.length === 0

  const visibleCount = historyVisibleCounts.get(activeSymbol.key) ?? HISTORY_PAGE_SIZE
  const visibleRecords = records.slice(0, visibleCount)

  const statsHtml = `
    <div class="history-stats">
      <div class="history-stat running"><div class="num">${stats.running}</div><div class="lbl">Running</div></div>
      <div class="history-stat win"><div class="num">${stats.wins}</div><div class="lbl">Wins</div></div>
      <div class="history-stat loss"><div class="num">${stats.losses}</div><div class="lbl">Losses</div></div>
      <div class="history-stat"><div class="num">${stats.winRate != null ? stats.winRate + '%' : '—'}</div><div class="lbl">Win rate</div></div>
    </div>
  `

  // The one visual-trend view — cumulative pips/$ over time — alongside the static
  // numbers above. Needs at least 2 closed trades to draw a meaningful line; skipped
  // (not shown as an empty chart) otherwise.
  const equityHtml =
    equityPoints.length >= 2 ? `<div id="history-equity-chart" class="history-equity-chart"></div>` : ''

  // Which setup is actually reliable — by zone category (Support/Resistance/SBR/RBS)
  // and by zone strength (Golden/Diamond Zone vs Medium) — rather than only the one
  // aggregate win rate above. Skipped entirely once there's nothing closed yet (would
  // just repeat the empty-state message below), and the strength half is skipped on
  // its own if every closed record predates that field being recorded (see
  // recordSignals in signalHistoryCore.js).
  const breakdownHtml =
    stats.wins + stats.losses > 0
      ? `<div class="history-breakdown">
          ${breakdownGroupHtml('By Zone Type', breakdown.byCategory)}
          ${breakdown.byStrength.length ? breakdownGroupHtml('By Zone Strength', breakdown.byStrength) : ''}
        </div>`
      : ''

  const rowsHtml = visibleRecords.length
    ? `<div class="history-list">${visibleRecords
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
    : `<p class="history-empty">No filled signals yet for ${activeSymbol.label} — pending ones are on the dashboard, check back here once one fills.</p>`

  const remaining = records.length - visibleRecords.length
  const loadMoreHtml =
    remaining > 0
      ? `<button type="button" id="history-load-more" class="history-load-more">Load more (${remaining} older)</button>`
      : ''

  historyBody.innerHTML = statsHtml + equityHtml + breakdownHtml + rowsHtml + loadMoreHtml

  // The chart needs a real, already-in-DOM container to size itself against — created
  // fresh above the moment historyBody.innerHTML was set, so it's queried here rather
  // than passed as an element reference.
  const equityContainer = document.getElementById('history-equity-chart')
  if (equityContainer) activeEquityChart = renderEquityChart(equityContainer, equityPoints)

  document.getElementById('history-load-more')?.addEventListener('click', () => {
    historyVisibleCounts.set(activeSymbol.key, visibleCount + HISTORY_PAGE_SIZE)
    renderHistory()
  })
}

// Remembers whatever had focus before the modal opened, so closing it (via Escape,
// the backdrop, or the close button) returns focus there instead of dropping it back
// to <body> — standard modal-dialog accessibility expectation.
let previouslyFocusedEl = null

function openHistoryModal() {
  previouslyFocusedEl = document.activeElement
  renderHistory()
  historyModal.hidden = false
  historyCloseBtn.focus()
}

function closeHistoryModal() {
  historyModal.hidden = true
  previouslyFocusedEl?.focus?.()
  previouslyFocusedEl = null
}

historyBtn.addEventListener('click', openHistoryModal)

historyCloseBtn.addEventListener('click', closeHistoryModal)

// Client-side CSV export — a Blob + a throwaway <a download> is the standard way to
// trigger a file save with no server endpoint involved, matching how this whole site
// already has no backend of its own (see fetch-data.mjs's static-JSON-file approach).
historyExportBtn.addEventListener('click', () => {
  const csv = buildHistoryCsv(activeSymbol.key)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `trefozeri-${activeSymbol.key.toLowerCase()}-track-record.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
})

historyModal.addEventListener('click', (e) => {
  if (e.target === historyModal) closeHistoryModal()
})

// Escape closes it; Tab/Shift+Tab is trapped inside it while open, so background
// content (topbar, symbol/timeframe tabs) never becomes keyboard-reachable behind an
// open modal. historyBody's contents (the tf-filter buttons) are re-rendered on every
// renderHistory() call, so focusable elements are queried fresh on every keypress
// rather than cached once at open time.
historyModal.addEventListener('keydown', (e) => {
  if (historyModal.hidden) return
  if (e.key === 'Escape') {
    closeHistoryModal()
    return
  }
  if (e.key !== 'Tab') return
  const focusable = historyModal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
})

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
  historyLoaded = true
  renderDashboard()
}

// Abbreviated for display only — 'Resistance' is long enough to crowd the price
// next to it in the card's fixed-width label column; matching/confluence logic
// elsewhere still uses the full zone.category string.
function shortCategory(category) {
  return category === 'Resistance' ? 'Resist.' : category
}

// The confluence badge is named/colored per the active symbol — "★ Golden" for
// XAUUSD, "◆ Diamond" for BTCUSD (see style.css's body[data-symbol] accents) —
// rather than always "Golden", since that name only really makes sense for gold itself.
function confluenceBadgeHtml() {
  const isXau = activeSymbol.key === 'XAUUSD'
  const icon = isXau ? '★' : '◆'
  const label = isXau ? 'Golden' : 'Diamond'
  return `<span class="confluence-badge"><span class="confluence-badge-icon">${icon}</span> ${label}</span>`
}

// A non-Strong badge used to always render as the literal text "Medium" regardless of
// the actual label — silently hiding a real "Weak" behind the wrong word. Shared by
// renderZoneCard and renderSignalCard so both show whichever of the two it actually is.
function strengthBadgeHtml(label) {
  return `<span class="strength-badge ${label.toLowerCase()}">${label}</span>`
}

// showBadges (see renderContent) is false when every zone in the current combined list
// would show the exact same label — nothing to contrast it against, so the whole row of
// identical badges is dropped rather than shown for no informational value.
function renderZoneCard(zone, showBadges) {
  const card = document.createElement('div')
  card.className = `zone-card ${zone.type}`
  const flippedFrom = zone.type === 'support' ? 'resistance' : 'support'
  const brokenNote = zone.broken ? ` · flipped from ${flippedFrom} after one breakout` : ''
  const confluenceNote = zone.confluence.length ? ` · also on ${zone.confluence.join(', ')}` : ''
  // isGolden (confluence) and strengthLabel (see computeStrengthLabel in srDetector.js)
  // are independent now — a zone can be Strong and golden, Strong and not, or neither.
  // Confluence still wins the display slot when both are true: it's the stronger signal
  // and there's no room for two badges here.
  const badge = !showBadges ? '' : zone.isGolden ? confluenceBadgeHtml() : strengthBadgeHtml(zone.strengthLabel)
  // Two columns only: timeframe + category + strength badge stacked on the left
  // (zone-label), price + the rest of the metadata on the right (zone-range) — the
  // timeframe used to live in zone-meta and the badge in its own third column.
  card.innerHTML = `
    <div class="zone-label">
      <span class="zone-type">${zone.tf} ${shortCategory(zone.category)}</span>
      ${badge}
    </div>
    <div class="zone-range">
      <div class="zone-price">${formatPrice(zone.price)}</div>
      <div class="zone-meta">Distance: ${formatPrice(zone.distanceFromPrice)} · Formed ${timeAgo(zone.startTime)}${brokenNote}${confluenceNote}</div>
    </div>
  `
  return card
}

// Tracks which per-timeframe fingerprint (see refreshData) is currently reflected by
// activeChart, so a refresh tick whose candles all came back byte-identical to last
// time — every timeframe refetches on every tick now, see TIMEFRAMES' own comment in
// twelveData.js — can skip tearing the chart down. renderDashboard() runs after every
// refreshData()/refreshHistory() (every 5 minutes each), and rebuilding the chart
// unconditionally would reset any zoom/pan the user was mid-inspection with even though
// nothing actually changed. Chart candles are always H1's own series (the
// finest-grained one); H4/D1 only ever contribute their zone bands on top of it.
let chartedH1 = null
let chartedH4 = null
let chartedD1 = null
// Which timeframes were baked into activeChart's zone bands (see visibleTimeframes) —
// tracked alongside the data fingerprints above for the same reason: toggling a
// checkbox doesn't change H1/H4/D1's own data, so without this the chart wouldn't
// know it needs rebuilding just because the checkbox itself changed.
let chartedVisibility = null

function renderContent() {
  const h1 = zonesByTimeframe.H1
  const h4 = zonesByTimeframe.H4
  const d1 = zonesByTimeframe.D1

  if (!h1) {
    disposeChart()
    chartedH1 = chartedH4 = chartedD1 = chartedVisibility = null
    contentEl.innerHTML = `<p class="empty-state">Loading data...</p>`
    return
  }

  // Every zone from all three timeframes, tagged with which one it came from — the
  // chart and the zone cards below both show H1, H4 and D1 combined, with no
  // per-timeframe tab to switch between them. allZonesUnfiltered still has all three
  // regardless of visibleTimeframes — only display reads from the filtered allZones
  // below; signal generation/TP borrowing/trend (see refreshData) always use the full,
  // unfiltered zonesByTimeframe directly, never this function's own filtered view.
  const allZonesUnfiltered = [
    ...h1.zones.map((z) => ({ ...z, tf: 'H1' })),
    ...(h4?.zones ?? []).map((z) => ({ ...z, tf: 'H4' })),
    ...(d1?.zones ?? []).map((z) => ({ ...z, tf: 'D1' })),
  ]
  const allZones = allZonesUnfiltered.filter((z) => visibleTimeframes.has(z.tf))

  if (!allZonesUnfiltered.length) {
    disposeChart()
    chartedH1 = chartedH4 = chartedD1 = chartedVisibility = null
    contentEl.innerHTML = `<p class="empty-state">No significant S/R zones detected yet.</p>`
    return
  }

  if (!allZones.length) {
    disposeChart()
    chartedH1 = chartedH4 = chartedD1 = chartedVisibility = null
    contentEl.innerHTML = `<p class="empty-state">No timeframe selected — check H1, H4 or D1 above to see levels.</p>`
    return
  }

  const visibilityKey = [...visibleTimeframes].sort().join(',')
  const needsFreshChart =
    chartedH1 !== h1.fingerprint ||
    chartedH4 !== h4?.fingerprint ||
    chartedD1 !== d1?.fingerprint ||
    chartedVisibility !== visibilityKey
  if (needsFreshChart) {
    disposeChart()
    contentEl.innerHTML = ''
    // Chart needs to be attached to the DOM before it's created (lightweight-charts
    // measures the container for its initial size), so append the empty div first.
    const chartContainer = document.createElement('div')
    chartContainer.className = 'zone-chart'
    contentEl.appendChild(chartContainer)
    activeChart = renderZoneChart(chartContainer, h1.series, allZones)
    chartedH1 = h1.fingerprint
    chartedH4 = h4?.fingerprint
    chartedD1 = d1?.fingerprint
    chartedVisibility = visibilityKey
  } else {
    // Nothing actually refetched this tick — leave the chart and its DOM alone, just
    // drop the old zone/signal cards below it before rebuilding them fresh.
    contentEl.querySelectorAll('.zones-grid, .signals-grid').forEach((el) => el.remove())
  }

  // Finest timeframe first (H1, then H4, then D1), nearest-to-price within each — H1
  // is what's actually tradeable (see refreshData below), so its levels lead; H4/D1
  // are grouped together underneath for context rather than interleaved by distance.
  const byTfThenDistance = (a, b) => {
    const tfOrder = TIMEFRAMES.findIndex((tf) => tf.key === a.tf) - TIMEFRAMES.findIndex((tf) => tf.key === b.tf)
    return tfOrder || a.distanceFromPrice - b.distanceFromPrice
  }
  const resistances = allZones.filter((z) => z.type === 'resistance').sort(byTfThenDistance)
  const supports = allZones.filter((z) => z.type === 'support').sort(byTfThenDistance)
  // Across the whole combined list, not per column — a Golden zone on the support side
  // still makes the resistance side's badges meaningful by contrast. Keyed on whatever
  // badge would actually render (isGolden wins display over strengthLabel — see
  // renderZoneCard), not just strengthLabel alone: isGolden and strengthLabel are
  // independent now, so an all-Medium list with one golden zone in it is still 2
  // distinct badges on screen, not 1.
  const badgeIdentity = (z) => (z.isGolden ? 'golden' : z.strengthLabel)
  const showBadges = new Set(allZones.map(badgeIdentity)).size > 1

  const zonesGrid = document.createElement('div')
  zonesGrid.className = 'zones-grid'

  if (supports.length) {
    const column = document.createElement('div')
    column.className = 'zone-column'
    supports.forEach((zone) => column.appendChild(renderZoneCard(zone, showBadges)))
    zonesGrid.appendChild(column)
  }
  if (resistances.length) {
    const column = document.createElement('div')
    column.className = 'zone-column'
    resistances.forEach((zone) => column.appendChild(renderZoneCard(zone, showBadges)))
    zonesGrid.appendChild(column)
  }
  contentEl.appendChild(zonesGrid)

  // Signals go below the S/R zones they're derived from, not above. H1 only — H4/D1
  // zones are shown for context (and still get borrowed as H1's own TP candidates),
  // but never become tradeable ideas of their own (see refreshData below).
  const signals = h1.signals ?? []
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
    // Signals are H1-only (see refreshData) — hardcoded rather than read off anything,
    // since the signal object itself doesn't carry its own timeframe.
    `${label} — ${activeSymbol.label} H1`,
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
  // isGolden (confluence) and strengthLabel (Strong/Medium/Weak off the level's own
  // track record — see computeStrengthLabel in srDetector.js) are independent; a
  // strengthLabel of 'Strong' no longer implies golden, so this checks isGolden
  // directly rather than the old (and now wrong) `strengthLabel === 'Strong'`.
  // Otherwise shows whichever it actually is (see strengthBadgeHtml) — this used to
  // hardcode "Medium" regardless, silently hiding a real Weak (or Strong) signal.
  const badge = signal.isGolden ? confluenceBadgeHtml() : strengthBadgeHtml(signal.strengthLabel ?? 'Medium')

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

  refreshing = true
  const myGeneration = refreshGeneration
  // All three timeframes are always fetched together now (no tab to be "off"), so
  // every visible card dims for the duration of the fetch.
  contentEl.querySelectorAll('.zone-card, .signal-card').forEach((c) => (c.style.opacity = '0.6'))

  const symbol = activeSymbol

  try {
    const raw = await fetchAllTimeframes(symbol.apiSymbol, TIMEFRAMES)
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
      // H1 is the finest timeframe still fetched, so it's the freshest source for spot.
      if (tf.key === 'H1') {
        currentPrice = last.close
        priceEl.textContent = formatPrice(currentPrice)
      }
      const zones = detectLevels(series, currentPrice ?? last.close)
      // fingerprint (2026-08-23): every timeframe refetches on every tick now (see
      // TIMEFRAMES' own comment in twelveData.js), so `series` is always a brand-new
      // array even when its content is byte-identical to last tick's — a plain object
      // identity check can no longer tell "actually changed" from "just refetched".
      // renderContent compares this instead, so the chart only tears down (losing the
      // user's zoom/pan) when the data it's showing has genuinely moved.
      const fingerprint = `${series.length}:${last.time}:${last.close}`
      zonesByTimeframe[tf.key] = { zones, series, fingerprint }
    }

    // Every due timeframe failed (offline, or the whole API is down) — nothing
    // actually changed, so leave whatever "Last updated" message was already on
    // screen rather than claiming a freshness that didn't happen.
    if (!anySuccess) return

    // Golden Zone confluence needs every timeframe's levels at once, so it only runs
    // once all of them are in.
    annotateGoldenZones(zonesByTimeframe)
    // Signals (actionable BUY/SELL LIMIT cards) are H1-only — H4/D1 zones are still
    // shown (for context) and still get offered to H1 as higher-timeframe TP
    // candidates just below, they just never become tradeable ideas of their own
    // (matches the shared track record's own policy, see fetch-data.mjs).
    const h1Result = zonesByTimeframe.H1
    if (h1Result) {
      const higherTfZones = TIMEFRAMES.slice(1).flatMap((tf) => zonesByTimeframe[tf.key]?.zones ?? [])
      // A stagnant timeframe (see isPriceStagnant) sizes its SL off an ATR computed
      // from near-frozen candles — even a genuinely old, real level ends up with a
      // razor-thin SL and an absurd R-multiple (e.g. 30R) that isn't a real trade idea.
      // Zones still render (the chart/zone cards stay informative), just no actionable
      // BUY/SELL LIMIT cards until price is actually moving again.
      // H4 (falling back to D1) rather than H1 itself — same reasoning as
      // updateSignalHistoryForSymbol in fetch-data.mjs: a trend read off the same
      // fine-grained series a fade signal comes from would just describe its own recent
      // noise, not an actual higher-timeframe direction. Kept in sync with that same
      // logic — see computeTrend in srDetector.js. Not news-gated the way the recorded
      // track record is (see isNearHighImpactNews in fetch-data.mjs): this is a live
      // display refresh, not a record write, and threading calendar data through here
      // just to skip briefly showing a signal card during a news window wasn't worth
      // the added coupling — the shared history stays the source of truth regardless.
      const trend = computeTrend(zonesByTimeframe.H4?.series?.length ? zonesByTimeframe.H4.series : zonesByTimeframe.D1?.series ?? [])
      // buildSignals always returns both sides now (see its own comment — trend only
      // *annotates* trendAligned rather than omitting the off-trend side, so an
      // already-open record on that side never gets spuriously dropped/recreated by
      // recordSignals). The dashboard has no such record to protect — it's a pure
      // display refresh — so it filters trendAligned itself, same visual result as
      // before.
      h1Result.signals = isPriceStagnant(h1Result.series)
        ? []
        : buildSignals(h1Result.zones, currentPrice, higherTfZones, trend).filter((s) => s.trendAligned !== false)
    }
    checkZonesAndSignals(symbol.key, symbol.label, zonesByTimeframe, currentPrice)

    lastUpdateEl.textContent = `Last updated: ${new Date().toLocaleTimeString('en-US')}`
  } catch (err) {
    console.error(err) // keep last good data on screen, no user-facing warning
  } finally {
    // A symbol switch that happened while this fetch was in flight already bumped
    // refreshGeneration — if so, this call has been superseded: the new symbol's own
    // refreshData() call owns `refreshing`/rendering now, and this stale one touching
    // either would race it (reopening the guard or re-rendering mid-flight of the
    // fetch that actually matters).
    if (myGeneration === refreshGeneration) {
      refreshing = false
      renderDashboard()
    }
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

// Reflects visibleTimeframes onto the checkboxes — called once on startup (the
// markup's own hardcoded `checked` attributes only cover the all-visible default, not
// a saved selection) and isn't needed again after that: each checkbox's own `checked`
// already reflects the click that triggered the change listener below.
function syncTimeframeFilterCheckboxes() {
  timeframeFilterEl.querySelectorAll('input[data-tf]').forEach((input) => {
    input.checked = visibleTimeframes.has(input.dataset.tf)
  })
}

// Delegated on the container rather than one listener per checkbox — same 3 inputs
// either way, but this doesn't need updating if more timeframes are ever added here.
timeframeFilterEl.addEventListener('change', (e) => {
  const tf = e.target?.dataset?.tf
  if (!tf) return
  if (e.target.checked) visibleTimeframes.add(tf)
  else visibleTimeframes.delete(tf)
  saveUiState({ visibleTimeframes: [...visibleTimeframes] })
  // A pure display re-render off already-fetched data — no need to touch refreshData
  // or anything network-related, see visibleTimeframes' own comment.
  renderContent()
})

applySymbolTheme(activeSymbol)
syncTimeframeFilterCheckboxes()
renderSymbolTabs()
updateNotifyBtn()
renderDashboard()
refreshData()
refreshNewsCalendar()
refreshHistory()
setInterval(() => {
  refreshData()
  refreshNewsCalendar()
  refreshHistory()
}, AUTO_REFRESH_INTERVAL_MS)
