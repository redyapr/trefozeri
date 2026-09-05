// Performance (performance/index.html) — the shared signal track record, as its own
// full page. Used to be a modal opened from the dashboard (see historyBtn/history-modal
// in the pre-2026-09-05 main.js); split out in the multi-page revamp so it has a real
// URL and doesn't need the mapping page's own heavier data-fetching machinery loaded
// just to view it.
import '../style.css'
import { SYMBOLS } from '../lib/twelveData.js'
import { loadUiState, saveUiState } from '../lib/uiState.js'
import { renderEquityChart } from '../lib/priceChart.js'
import { loadHistory, getHistory, getStats, getBreakdown, buildHistoryCsv, getEquityCurve, getRiskStats } from '../lib/signalHistory.js'
import { formatMove, formatPrice, groupWinRate } from '../lib/signalHistoryCore.js'
import { initInstallPrompt } from '../lib/installPrompt.js'

// Same cadence as the mapping page's own refreshData/refreshNewsCalendar — the cron in
// .github/workflows/deploy.yml rewrites data/signal-history.json roughly every 15
// minutes, but polling every 5 keeps this page's own tick simple and consistent with
// the rest of the site rather than introducing a third cadence to reason about.
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000

const symbolTabsEl = document.getElementById('symbol-tabs')
const historyBody = document.getElementById('history-body')
const historyExportBtn = document.getElementById('history-export-btn')
const installBtn = document.getElementById('install-btn')

const uiState = loadUiState()
let activeSymbol = SYMBOLS.find((s) => s.key === uiState.symbolKey) ?? SYMBOLS[0]

// Every accent-driven color on the page reads off CSS variables scoped to
// `body[data-symbol]` (see style.css) — so switching symbol re-skins the whole page,
// matching the same behavior on the Mapping & Signal page.
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
      // Shared with the Mapping & Signal page's own uiState key — switching symbol
      // here also becomes the default the next time either page loads.
      saveUiState({ symbolKey: activeSymbol.key })
      renderSymbolTabs()
      renderHistory()
    })
    symbolTabsEl.appendChild(btn)
  }
}

// Same reasoning as the old modal's own equity chart: historyBody.innerHTML is rebuilt
// from scratch on every renderHistory() call (including the 5-minute auto-refresh),
// which orphans whatever chart instance was drawn into the previous container.
let activeEquityChart = null
function disposeEquityChart() {
  if (!activeEquityChart) return
  activeEquityChart.remove()
  activeEquityChart = null
}

// Distinguishes "genuinely no filled signals yet" from "haven't fetched the track
// record from the server at all yet" — without this, the very first render (before
// refreshHistory() resolves) shows the same empty-state copy as a real zero-signals
// case, which reads as "this dashboard has no track record" rather than "still loading".
let historyLoaded = false

// How many rows are currently shown per symbol — starts at HISTORY_PAGE_SIZE, grows by
// the same amount each "Load more" click. Kept per-symbol (not just one shared number)
// so switching symbols and back doesn't reset how far you'd scrolled into either one.
const HISTORY_PAGE_SIZE = 30
const historyVisibleCounts = new Map()

// Whether the row-by-row trade list is expanded, per symbol (so switching symbols and
// back doesn't reset it) — collapsed by default.
const historyListExpanded = new Map()

// Local (viewer's own browser timezone) day-of-week, used only for the "By Day Opened"
// breakdown below — getDay() is Sunday-first (0-6) to match this array's own order,
// same convention getBreakdown's other groupings already sort by. Deliberately computed
// here, not inside the shared/Node-tested signalHistoryCore.js: which calendar day a
// trade "belongs to" is inherently a per-viewer, local-time question with no single
// correct answer server-side, and baking a specific timezone into the shared module
// would either be wrong for most viewers (if fixed to one zone) or non-deterministic to
// test (if left to the machine running the test suite).
const LOCAL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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

function formatDateTime(ts) {
  const d = new Date(ts)
  return `${d.toLocaleDateString('en-US')} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
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

// Abbreviated for display only — matches the Mapping & Signal page's own shortCategory.
function shortCategory(category) {
  return category === 'Resistance' ? 'Resist.' : category
}

// One line describing how a closed signal ended: which target (or the SL) it hit,
// at what price, how far that was from entry, and when.
function historyExitLine(r, symbol) {
  const isBuy = r.direction === 'buy'
  const label = r.status === 'win' ? `TP${(r.hitTpIndex ?? 0) + 1} hit` : 'SL hit'
  const move = formatMove(symbol.pipSize, r.entry, r.exitPrice, isBuy)
  return `${label} @ ${formatPrice(r.exitPrice)} (${move}) · ${formatDateTime(r.closedAt)}`
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
  const riskStats = getRiskStats(activeSymbol.key)
  const equityPoints = getEquityCurve(activeSymbol.key)
  // 'pending' (not yet filled) signals are already visible as live cards on the
  // Mapping & Signal page — this page is for what's actually happened, so it only
  // lists trades that have at least filled. Not sliced yet — CSV export and the "Load
  // more" remaining-count both need the true total, not just what's currently visible.
  const records = getHistory(activeSymbol.key).filter((r) => r.status !== 'pending')
  historyExportBtn.disabled = records.length === 0

  // Built here, not inside getBreakdown (see LOCAL_DAY_NAMES' own comment) — the same
  // closed win/loss records getBreakdown itself filters down to, grouped by the
  // viewer's own local calendar day via the shared groupWinRate helper.
  const byDayOfWeek = groupWinRate(
    records.filter((r) => r.status === 'win' || r.status === 'loss'),
    (r) => LOCAL_DAY_NAMES[new Date(r.openedAt).getDay()]
  ).sort((a, b) => LOCAL_DAY_NAMES.indexOf(a.key) - LOCAL_DAY_NAMES.indexOf(b.key))

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

  // A healthy-looking aggregate win rate can still have survived a brutal losing streak
  // or a deep equity dip along the way — neither shows up in statsHtml's own numbers
  // above, so this surfaces them alongside average win/loss size (see getRiskStats).
  // Same gating as breakdownHtml below: nothing to show before the first closed trade.
  // Max DD is maxDrawdownPct (see getRiskStats' own comment on why % of the peak, not
  // raw pips/$, is the closest honest equivalent to a conventional backtest's "max
  // drawdown %" this app can report without a real account-equity model) — "—" when
  // that peak was never positive to begin with (a losing streak right at the start).
  //
  // Avg win/loss deliberately skip formatAmount (unlike everywhere else a pip/$ move is
  // shown) — no "pips" unit suffix at all: each box's own <div class="lbl"> already
  // says what the number is, and these 5 compact boxes have no room to spare repeating
  // the unit under every single one. getRiskStats itself already rounds these to a
  // whole number regardless of symbol, so this is just the sign + the number.
  const riskAmount = (n) => `${n >= 0 ? '+' : ''}${n}`
  const riskStatsHtml =
    stats.wins + stats.losses > 0
      ? `<div class="history-risk-stats">
          <div class="history-stat win"><div class="num">${riskStats.maxWinStreak}</div><div class="lbl">Win streak</div></div>
          <div class="history-stat loss"><div class="num">${riskStats.maxLossStreak}</div><div class="lbl">Loss streak</div></div>
          <div class="history-stat loss"><div class="num">${riskStats.maxDrawdownPct != null ? `-${riskStats.maxDrawdownPct}%` : '—'}</div><div class="lbl">Max DD</div></div>
          <div class="history-stat win"><div class="num">${riskStats.avgWin != null ? riskAmount(riskStats.avgWin) : '—'}</div><div class="lbl">Avg win</div></div>
          <div class="history-stat loss"><div class="num">${riskStats.avgLoss != null ? riskAmount(riskStats.avgLoss) : '—'}</div><div class="lbl">Avg loss</div></div>
        </div>`
      : ''

  // Which setup — and when — is actually reliable: by zone category (Support/
  // Resistance/SBR/RBS), zone strength (Golden/Diamond Zone vs Medium), timeframe, and
  // day of week opened — rather than only the one aggregate win rate above. Skipped
  // entirely once there's nothing closed yet (would just repeat the empty-state message
  // below); strength/timeframe are each skipped on their own if there's nothing
  // meaningful to contrast (strength: every closed record predates that field being
  // recorded, see recordSignals in signalHistoryCore.js; timeframe: everything closed
  // is H1 anyway, the now-default going forward — see getBreakdown's own comment).
  const breakdownHtml =
    stats.wins + stats.losses > 0
      ? `<div class="history-breakdown">
          ${breakdownGroupHtml('By Zone Type', breakdown.byCategory)}
          ${breakdown.byStrength.length ? breakdownGroupHtml('By Zone Strength', breakdown.byStrength) : ''}
          ${breakdown.byTimeframe.length > 1 ? breakdownGroupHtml('By Timeframe', breakdown.byTimeframe) : ''}
          ${breakdownGroupHtml('By Day Opened', byDayOfWeek)}
        </div>`
      : ''

  const remaining = records.length - visibleRecords.length
  const loadMoreHtml =
    remaining > 0
      ? `<button type="button" id="history-load-more" class="history-load-more">Load more (${remaining} older)</button>`
      : ''

  // Row-by-row trade list, collapsed inside a native <details> by default (see
  // historyListExpanded's own comment) — the stats/breakdown above already give the
  // useful summary at a glance; the individual rows are the most repetitive, lowest-
  // information-density part of the page, especially once "Load more" is in play.
  const rowsSectionHtml = visibleRecords.length
    ? `<details class="history-list-details"${historyListExpanded.get(activeSymbol.key) ? ' open' : ''}>
        <summary class="history-list-summary">${records.length} filled signal${records.length === 1 ? '' : 's'}</summary>
        <div class="history-list">${visibleRecords
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
          .join('')}</div>
        ${loadMoreHtml}
      </details>`
    : `<p class="history-empty">No filled signals yet for ${activeSymbol.label} — pending ones are on the Mapping &amp; Signal page, check back here once one fills.</p>`

  historyBody.innerHTML = statsHtml + riskStatsHtml + equityHtml + breakdownHtml + rowsSectionHtml

  // The chart needs a real, already-in-DOM container to size itself against — created
  // fresh above the moment historyBody.innerHTML was set, so it's queried here rather
  // than passed as an element reference.
  const equityContainer = document.getElementById('history-equity-chart')
  if (equityContainer) activeEquityChart = renderEquityChart(equityContainer, equityPoints)

  document.getElementById('history-load-more')?.addEventListener('click', () => {
    historyVisibleCounts.set(activeSymbol.key, visibleCount + HISTORY_PAGE_SIZE)
    renderHistory()
  })

  document.querySelector('.history-list-details')?.addEventListener('toggle', (e) => {
    historyListExpanded.set(activeSymbol.key, e.target.open)
  })
}

// Client-side CSV export — a Blob + a throwaway <a download> is the standard way to
// trigger a file save with no server endpoint involved, matching how this whole site
// already has no backend of its own (see fetch-data.mjs's static-JSON-file approach).
historyExportBtn.addEventListener('click', () => {
  const csv = buildHistoryCsv(activeSymbol.key)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `trefozeri-${activeSymbol.key.toLowerCase()}-performance.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
})

// The shared track record is a static file the cron job rewrites roughly every 15
// minutes (see scripts/fetch-data.mjs) — refetch it on the same cadence as the rest of
// the site rather than only once at load, so a page left open updates on its own.
async function refreshHistory() {
  await loadHistory()
  historyLoaded = true
  renderHistory()
}

initInstallPrompt(installBtn)

applySymbolTheme(activeSymbol)
renderSymbolTabs()
renderHistory()
refreshHistory()
setInterval(() => {
  // Paused while the tab is backgrounded — same reasoning as the Mapping & Signal
  // page's own interval.
  if (document.hidden) return
  refreshHistory()
}, AUTO_REFRESH_INTERVAL_MS)

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  refreshHistory()
})
