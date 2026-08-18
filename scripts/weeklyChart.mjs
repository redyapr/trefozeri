// Renders the weekly AND daily performance reports, each as ONE PNG buffer — weekly:
// bar chart + TP pie charts + trade-log table, all on one canvas; daily: one bar-chart
// panel per symbol with a trade that closed that day (see renderDailyReportImage
// below) — using @napi-rs/canvas, a
// Skia-backed canvas with prebuilt native bindings for every platform GitHub Actions'
// hosted runners use (linux-x64-gnu included), so no system libcairo/apt-get step is
// needed the way e.g. Python's cairosvg would require (see the design-preview session
// that led here: qlmanage and cairosvg were both tried and rejected before landing on
// this approach). JetBrains Mono is bundled under assets/fonts/ (OFL-licensed, same
// family the dashboard's own UI already uses) rather than relying on whatever fonts
// happen to be preinstalled on the CI runner — deterministic output on any machine.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas, GlobalFonts, Image } from '@napi-rs/canvas'
import { getClosedBetween, PIP_SIZES, favorableMove } from '../src/lib/signalHistoryCore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FONT_FAMILY = 'JetBrains Mono'

// Registering is idempotent and cheap — safe to call on every render rather than
// threading a "did we already register" flag through every caller.
function registerFonts() {
  GlobalFonts.registerFromPath(path.join(__dirname, '..', 'assets', 'fonts', 'JetBrainsMono-Regular.ttf'), FONT_FAMILY)
  GlobalFonts.registerFromPath(path.join(__dirname, '..', 'assets', 'fonts', 'JetBrainsMono-Bold.ttf'), FONT_FAMILY)
}

// .width/.height/.complete are available the instant .src is set, but the actual pixel
// data isn't guaranteed decoded until .decode() resolves — drawImage silently draws
// nothing (not an error) if called before that. Decoded once at module load via a
// top-level await (this is an ES module, and every caller — fetch-data.mjs's static
// import, node --test — already goes through Node's module loader, which awaits a
// module's own top-level await before it's considered loaded) so every render function
// below can stay synchronous.
const logoImage = new Image()
logoImage.src = readFileSync(path.join(__dirname, '..', 'public', 'trefozeri-logo.png'))
await logoImage.decode()

const LOGO_BADGE_PAD = 5

// The logo file itself is a full square lockup on a white background (not a
// transparent icon) — same "white badge" treatment the dashboard's own header gives it
// (see .brand-logo-badge in style.css) — a rounded white card behind it so it reads as
// a proper mark against the chart's black background instead of a stray white square.
// `edgeX`/align let the caller anchor it to either side without hand-computing the
// badge's own width first — top-right, here, next to the title text.
function drawLogoBadge(ctx, edgeX, y, h, align = 'left') {
  const logo = logoImage
  const pad = LOGO_BADGE_PAD
  const w = h * (logo.width / logo.height)
  const badgeW = w + pad * 2
  const badgeH = h + pad * 2
  const x = align === 'right' ? edgeX - badgeW : edgeX
  const r = 8
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + badgeW, y, x + badgeW, y + badgeH, r)
  ctx.arcTo(x + badgeW, y + badgeH, x, y + badgeH, r)
  ctx.arcTo(x, y + badgeH, x, y, r)
  ctx.arcTo(x, y, x + badgeW, y, r)
  ctx.closePath()
  ctx.fill()
  ctx.drawImage(logo, x + pad, y + pad, w, h)
  return badgeW
}

// Rendered at 2x the logical layout size ("HD") — every coordinate/font-size below is
// still written in the same 900px-wide logical space the design preview used; ctx.scale
// upscales the whole drawing (including line widths and text) onto a sharper bitmap, the
// standard retina-canvas technique, so the image still looks sharp after Telegram's own
// sendPhoto re-compression (the dashboard's own dark theme + flat colors/text compress
// far more gracefully under JPEG than a photograph would).
const SCALE = 2

const COLORS = {
  bg: '#000000',
  border: '#1a1a1a',
  borderSoft: '#282828',
  textDim: '#4d8a5c',
  textCol: '#d7ffe0',
  gold: '#ffd23f',
  cyan: '#00f0ff',
  win: '#6ee791',
  loss: '#ff6b6b',
}

function font(px, bold = false) {
  return `${bold ? 'bold ' : ''}${px}px "${FONT_FAMILY}"`
}

// This image is a report, same as the daily/weekly text (see reportAmount in
// fetch-data.mjs) — a chart is glanced at, not read closely, so it shows a
// consolidated whole number rather than per-pip/per-cent precision, and drops the
// "pips" unit entirely (XAUUSD's own convention; BTCUSD never had one) rather than
// mixing a labeled unit for one symbol with a bare number for the other.
function reportAmount(amount) {
  const rounded = Math.round(amount)
  return `${rounded >= 0 ? '+' : ''}${rounded}`
}

// Padded to "SELL"'s own length (the longer of the only two possible values) so "@"
// lands in the same column whether a row says BUY or SELL — same convention as
// paddedDirectionLabel in fetch-data.mjs's own text report.
function paddedDirectionLabel(record) {
  return (record.direction === 'buy' ? 'BUY' : 'SELL').padEnd(4)
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// How many of the (cascading, so non-increasing — TP1 >= TP2 >= TP3...) reach counts
// are actually non-zero. Once a stage reaches zero, every stage after it does too, so
// trimming that trailing run drops every TP nobody reached this week, not just the
// last one — a pie chart guaranteed to read 0% says nothing worth a glance.
export function countReachedTpStages(tpReachCount) {
  let count = tpReachCount.length
  while (count > 0 && tpReachCount[count - 1] === 0) count--
  return count
}

// Pure data prep, independently testable from the canvas drawing below. `days` is 7
// entries (Monday..Sunday, oldest first), each `{ label, startMs, endMs }` — the caller
// (fetch-data.mjs) owns all WIB calendar-date math; this module only ever sees plain
// ms ranges + display labels, so it has no timezone logic of its own to drift out of
// sync with the existing daily/weekly text report.
export function computeWeeklyChartData(history, days) {
  const symbols = ['XAUUSD', 'BTCUSD']
  const dailyBySymbol = { XAUUSD: [], BTCUSD: [] }
  const allTrades = []
  // The farthest TP rung actually offered by any trade this week — the pie row shows
  // every rung up to this (0 if nothing closed at all), not a fixed count, so a signal
  // with a long TP ladder (e.g. 5 targets) isn't silently truncated to the first 3, and
  // a quiet week isn't padded out with rungs no trade this week ever had.
  let maxTpLevels = 0

  for (const symbolKey of symbols) {
    const pipSize = PIP_SIZES[symbolKey]
    for (const day of days) {
      const closedList = getClosedBetween(history, symbolKey, 'H1', day.startMs, day.endMs)
      const net = closedList.reduce((sum, r) => sum + favorableMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy'), 0)
      dailyBySymbol[symbolKey].push(net)
      for (const r of closedList) {
        const isWin = r.status === 'win'
        maxTpLevels = Math.max(maxTpLevels, r.tp?.length ?? 0)
        allTrades.push({
          date: day.label,
          closedAt: r.closedAt,
          type: r.direction === 'buy' ? 'BUY' : 'SELL',
          pair: symbolKey,
          hit: isWin ? `TP${(r.hitTpIndex ?? 0) + 1}` : 'SL',
          hitTpIndex: isWin ? r.hitTpIndex ?? 0 : null,
          plText: reportAmount(favorableMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy')),
          isWin,
        })
      }
    }
  }

  allTrades.sort((a, b) => a.closedAt - b.closedAt)

  const totalClosed = allTrades.length
  const wins = allTrades.filter((t) => t.isWin).length
  const losses = totalClosed - wins
  const winRate = totalClosed ? Math.round((wins / totalClosed) * 100) : null

  // Cascading TP reach count: reaching TP2 implies TP1 was cleared too (one ladder, the
  // record just keeps the farthest level price actually reached), so TP1's count is
  // every win, not just the ones that stopped exactly at TP1.
  const tpReachCount = Array.from({ length: maxTpLevels }, (_, idx) => allTrades.filter((t) => t.isWin && t.hitTpIndex >= idx).length)
  const tpReachPct = tpReachCount.map((count) => (totalClosed ? Math.round((count / totalClosed) * 100) : 0))

  return {
    days: days.map((d) => d.label),
    xauDaily: dailyBySymbol.XAUUSD,
    btcDaily: dailyBySymbol.BTCUSD,
    xauTotal: dailyBySymbol.XAUUSD.reduce((a, b) => a + b, 0),
    btcTotal: dailyBySymbol.BTCUSD.reduce((a, b) => a + b, 0),
    trades: allTrades,
    wins,
    losses,
    winRate,
    totalClosed,
    tpReachCount,
    tpReachPct,
  }
}

// One horizontal bar per entry — the weekly report feeds one row per day (already
// filtered down to the days that actually had a closed trade, see activeDayEntries
// below, so a quiet day isn't shown as an empty "—" row at all), the daily report (see
// renderDailyReportImage) feeds one row per individual closed trade instead.
// labelW/emptyMessage are overridable since the two callers' row labels are a
// different shape (short weekday names vs. entry prices).
function drawHBarPanel(ctx, { label, total, entries, color, x0, y0, w, labelW = 62, emptyMessage = 'No trades closed this week.' }) {
  const rowH = 24
  const valueW = 78
  const barX0 = x0 + labelW
  const barW = w - labelW - valueW

  ctx.fillStyle = color
  ctx.font = font(18, true)
  ctx.fillText(label, x0, y0)
  const totalText = reportAmount(total)
  ctx.textAlign = 'right'
  ctx.fillText(totalText, x0 + w, y0)
  ctx.textAlign = 'left'

  const top = y0 + 28

  if (entries.length === 0) {
    ctx.fillStyle = COLORS.textDim
    ctx.font = font(13)
    ctx.fillText(emptyMessage, x0, top + rowH / 2 - 6)
    return top + rowH
  }

  const values = entries.map((e) => e.value)
  let vmin = Math.min(0, ...values)
  let vmax = Math.max(0, ...values)
  const pad = Math.max(1, (vmax - vmin) * 0.15)
  vmin -= pad
  vmax += pad

  const px = (v) => barX0 + ((v - vmin) / (vmax - vmin)) * barW
  const zeroX = px(0)

  ctx.strokeStyle = COLORS.borderSoft
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(zeroX, top)
  ctx.lineTo(zeroX, top + rowH * entries.length)
  ctx.stroke()

  entries.forEach(({ label: dayLabel, value: v }, i) => {
    const ry = top + i * rowH
    ctx.fillStyle = COLORS.textDim
    ctx.font = font(13)
    ctx.fillText(dayLabel, x0, ry + rowH / 2 - 6)

    const barColor = v >= 0 ? color : COLORS.loss
    if (v !== 0) {
      const left = Math.min(zeroX, px(v))
      const right = Math.max(zeroX, px(v))
      ctx.fillStyle = barColor
      ctx.fillRect(left, ry + 4, right - left, rowH - 10)
    }
    const vtext = reportAmount(v)
    ctx.fillStyle = barColor
    // Right-aligned at the panel's own right edge — same edge the header total above
    // uses — so every day's number lines up regardless of digit count.
    ctx.textAlign = 'right'
    ctx.fillText(vtext, x0 + w, ry + rowH / 2 - 6)
    ctx.textAlign = 'left'
  })

  return top + rowH * entries.length
}

// Which of the 7 calendar days actually had a closed trade for this symbol, paired with
// that day's already-computed net — derived from the trade list itself (not "is the net
// zero") so a real breakeven day (a win and a loss cancelling out) still shows, while a
// day with nothing closed at all is left out entirely.
function activeDayEntries(days, dailyValues, trades, symbolKey) {
  const activeDates = new Set(trades.filter((t) => t.pair === symbolKey).map((t) => t.date))
  return days.map((label, i) => ({ label, value: dailyValues[i] })).filter((e) => activeDates.has(e.label))
}

function drawPie(ctx, { cx, cy, radius, pct, label }) {
  ctx.strokeStyle = COLORS.borderSoft
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.stroke()

  if (pct > 0) {
    const start = -Math.PI / 2
    const end = start + Math.PI * 2 * (pct / 100)
    ctx.fillStyle = COLORS.win
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, radius, start, end)
    ctx.closePath()
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()
  }

  // Caption sits BELOW the circle, not inside it — a two-tone fill/background circle
  // has no single text color that stays legible across both halves.
  ctx.fillStyle = COLORS.textCol
  ctx.font = font(14, true)
  ctx.textAlign = 'center'
  ctx.fillText(`${label} · ${pct}%`, cx, cy + radius + 22)
  ctx.textAlign = 'left'
}

// Draws the trade-log table (DATE/TYPE/SYMBOL/HIT/P&L, justified across `w`) starting at
// `y0`, returning the y position just past the last row. No pagination — the whole log
// goes on this one canvas (see renderWeeklyReportImage below); a busy week for this
// dashboard's own signal frequency is a handful of rows, not hundreds, so an unbounded
// table just makes the one image taller rather than needing to be split up.
function drawTradeLogTable(ctx, { trades, x0, y0, w }) {
  const ROW_H = 30
  const HEADER_H = 22
  const COLUMN_COUNT = 5
  const colStep = w / (COLUMN_COUNT - 1)
  const colDate = x0
  const colType = x0 + colStep
  const colSymbol = x0 + colStep * 2
  const colHit = x0 + colStep * 3
  const colPlRight = x0 + w

  let y = y0
  ctx.fillStyle = COLORS.textDim
  ctx.font = font(14, true)
  ctx.fillText('DATE', colDate, y)
  ctx.fillText('TYPE', colType, y)
  ctx.fillText('SYMBOL', colSymbol, y)
  ctx.fillText('HIT', colHit, y)
  ctx.textAlign = 'right'
  ctx.fillText('P/L', colPlRight, y)
  ctx.textAlign = 'left'
  y += HEADER_H
  ctx.strokeStyle = COLORS.borderSoft
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(colDate, y)
  ctx.lineTo(colPlRight, y)
  ctx.stroke()
  y += 16

  for (const t of trades) {
    const rowColor = t.isWin ? COLORS.win : COLORS.loss
    const pairColor = t.pair === 'XAUUSD' ? COLORS.gold : COLORS.cyan
    ctx.fillStyle = COLORS.textCol
    ctx.font = font(14)
    ctx.fillText(t.date, colDate, y)
    ctx.fillText(t.type, colType, y)
    ctx.fillStyle = pairColor
    ctx.font = font(14, true)
    ctx.fillText(t.pair, colSymbol, y)
    ctx.fillStyle = rowColor
    ctx.fillText(t.hit, colHit, y)
    ctx.textAlign = 'right'
    ctx.fillText(t.plText, colPlRight, y)
    ctx.textAlign = 'left'
    y += ROW_H
    ctx.strokeStyle = COLORS.border
    ctx.beginPath()
    ctx.moveTo(colDate, y - 6)
    ctx.lineTo(colPlRight, y - 6)
    ctx.stroke()
  }

  return y
}

// Returns ONE PNG Buffer for the whole weekly report: title/summary, daily-pips-gained
// horizontal bars (XAUUSD alongside BTCUSD, side by side), the TP1->TP3 success-rate
// pies in a row, and the trade-log table — all on one canvas, rather than a separate
// image per section (a design-review correction: "gabung image trade log jadi satu
// dengan image utama").
export function renderWeeklyReportImage(data, rangeLabel) {
  registerFonts()
  const W = 900
  const MARGIN = 30
  const CW = 840

  // Rendered onto a generously-tall scratch canvas first, then cropped to the actual
  // content height — the same "measure as we go, crop at the end" approach as the
  // design-preview prototype, since the exact height depends on how many days actually
  // had a trade, how many pie rows, and how many trade-log rows there are.
  const scratch = createCanvas(W * SCALE, 2200 * SCALE)
  const ctx = scratch.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.textBaseline = 'top'
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, W, 2200)

  let y = 24
  ctx.fillStyle = COLORS.textCol
  ctx.font = font(24, true)
  ctx.fillText(`Weekly Performance (${rangeLabel})`, MARGIN, y)
  drawLogoBadge(ctx, W - MARGIN, y - 5, 34, 'right')
  y += 40

  ctx.fillStyle = COLORS.textDim
  ctx.font = font(15, true)
  const winRateText = data.totalClosed ? `${data.winRate}%` : 'No trades closed this week'
  ctx.fillText(`XAUUSD ${reportAmount(data.xauTotal)}  ·  BTCUSD ${reportAmount(data.btcTotal)}  ·  Win rate ${winRateText}`, MARGIN, y)
  y += 44

  ctx.fillStyle = COLORS.textCol
  ctx.font = font(16, true)
  ctx.fillText('DAILY P/L', MARGIN, y)
  y += 32
  const panelsTop = y

  const panelGap = 30
  const panelW = (CW - panelGap) / 2
  const xauX0 = MARGIN
  const btcX0 = MARGIN + panelW + panelGap // BTCUSD to the right of XAUUSD

  const yAfterXau = drawHBarPanel(ctx, {
    label: 'XAUUSD',
    total: data.xauTotal,
    entries: activeDayEntries(data.days, data.xauDaily, data.trades, 'XAUUSD'),
    color: COLORS.gold,
    x0: xauX0,
    y0: panelsTop,
    w: panelW,
  })
  const yAfterBtc = drawHBarPanel(ctx, {
    label: 'BTCUSD',
    total: data.btcTotal,
    entries: activeDayEntries(data.days, data.btcDaily, data.trades, 'BTCUSD'),
    color: COLORS.cyan,
    x0: btcX0,
    y0: panelsTop,
    w: panelW,
  })
  y = Math.max(yAfterXau, yAfterBtc) + 40

  // No pies at all when nothing this week ever reached a TP — a 0%-across-the-board row
  // says nothing a loss-only week doesn't already say via the bars/trade log above, and
  // an empty week has no ladder length to even know how many rungs to draw (see
  // maxTpLevels in computeWeeklyChartData).
  if (data.wins > 0) {
    ctx.fillStyle = COLORS.textCol
    ctx.font = font(16, true)
    ctx.fillText('TP SUCCESS RATE', MARGIN, y)
    y += 40

    // Horizontal row, TP1..TPn left to right (n = the longest TP ladder any trade this
    // week actually reached), evenly spaced across the same content width the bar
    // panels above use.
    const pieRadius = 46
    const tpNames = Array.from({ length: countReachedTpStages(data.tpReachCount) }, (_, idx) => `TP${idx + 1}`)
    const colW = CW / tpNames.length
    const pieCy = y + pieRadius
    tpNames.forEach((name, idx) => {
      const pieCx = MARGIN + colW * idx + colW / 2
      drawPie(ctx, { cx: pieCx, cy: pieCy, radius: pieRadius, pct: data.tpReachPct[idx], label: name })
    })
    y = pieCy + pieRadius + 22 + 18 + 40
  }

  ctx.fillStyle = COLORS.textCol
  ctx.font = font(16, true)
  ctx.fillText('TRADE LOG', MARGIN, y)
  y += 32

  if (data.trades.length) {
    y = drawTradeLogTable(ctx, { trades: data.trades, x0: MARGIN, y0: y, w: CW })
  } else {
    ctx.fillStyle = COLORS.textDim
    ctx.font = font(14)
    ctx.fillText('No signals closed this week.', MARGIN, y)
    y += 24
  }

  y += 10
  ctx.fillStyle = COLORS.textDim
  ctx.font = font(11)
  ctx.textAlign = 'right'
  ctx.fillText('P/L is in pips.', W - MARGIN, y)
  ctx.textAlign = 'left'
  y += 20

  const finalCanvas = createCanvas(W * SCALE, Math.round(y) * SCALE)
  const finalCtx = finalCanvas.getContext('2d')
  finalCtx.drawImage(scratch, 0, 0)
  return finalCanvas.toBuffer('image/png')
}

// Pure data prep for the daily image, independently testable from the canvas drawing
// below — same split as computeWeeklyChartData. Only symbols that actually closed
// something that day are included at all (mirrors buildDailyReportMessage's own "no
// activity, no section" rule in fetch-data.mjs) — a quiet symbol isn't a 0%/$0 row.
export function computeDailyChartData(history, dayStartMs, dayEndMs) {
  const bySymbol = {}
  for (const symbolKey of ['XAUUSD', 'BTCUSD']) {
    const pipSize = PIP_SIZES[symbolKey]
    const closedList = getClosedBetween(history, symbolKey, 'H1', dayStartMs, dayEndMs)
    if (!closedList.length) continue
    const wins = closedList.filter((r) => r.status === 'win').length
    const net = closedList.reduce((sum, r) => sum + favorableMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy'), 0)
    bySymbol[symbolKey] = {
      // One bar per trade (not per day — there's only one day here), labeled by its
      // direction + entry price rather than a TP/SL label so several trades don't all
      // repeat the same "TP1"/"SL" row label. Direction is padded so "@" lands in the
      // same column across every row, same convention as the text report.
      entries: closedList.map((r) => ({
        label: `${paddedDirectionLabel(r)} @ ${Math.round(r.entry)}`,
        value: favorableMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy'),
      })),
      wins,
      losses: closedList.length - wins,
      net,
      winRate: Math.round((wins / closedList.length) * 100),
    }
  }
  return bySymbol
}

// Returns ONE PNG Buffer for the daily report: title, then one bar-chart panel per
// symbol that actually closed something that day (bars = individual trades, same
// visual language as the weekly report's own daily-pips panels — see drawHBarPanel)
// plus that symbol's win rate. No TP-ladder pies or trade-log table here — a single
// day's handful of trades is already fully shown by its own bar panel, and rarely
// enough volume for a TP-success percentage to mean much.
export function renderDailyReportImage(data, dayLabel) {
  registerFonts()
  const W = 700
  const MARGIN = 28
  const CW = W - MARGIN * 2

  const scratch = createCanvas(W * SCALE, 900 * SCALE)
  const ctx = scratch.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.textBaseline = 'top'
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, W, 900)

  let y = 24
  ctx.fillStyle = COLORS.textCol
  ctx.font = font(22, true)
  ctx.fillText(`Daily Performance (${dayLabel})`, MARGIN, y)
  drawLogoBadge(ctx, W - MARGIN, y - 4, 30, 'right')
  y += 46

  const symbolMeta = [
    { key: 'XAUUSD', color: COLORS.gold },
    { key: 'BTCUSD', color: COLORS.cyan },
  ]

  let any = false
  for (const { key: symbolKey, color } of symbolMeta) {
    const s = data[symbolKey]
    if (!s) continue
    any = true
    y = drawHBarPanel(ctx, {
      label: symbolKey,
      total: s.net,
      entries: s.entries,
      color,
      x0: MARGIN,
      y0: y,
      w: CW,
      labelW: 100, // wide enough for "SELL @ " plus a 5-digit entry price (e.g. BTCUSD), not just "Sun 16"
      emptyMessage: 'No trades closed today.',
    })
    y += 10
    ctx.fillStyle = COLORS.textDim
    ctx.font = font(13)
    ctx.fillText(`Win rate: ${s.winRate}%`, MARGIN, y)
    y += 30
    ctx.strokeStyle = COLORS.border
    ctx.beginPath()
    ctx.moveTo(MARGIN, y)
    ctx.lineTo(W - MARGIN, y)
    ctx.stroke()
    y += 20
  }

  if (!any) {
    ctx.fillStyle = COLORS.textDim
    ctx.font = font(14)
    ctx.fillText('No activity today.', MARGIN, y)
    y += 30
  }

  y += 4
  ctx.fillStyle = COLORS.textDim
  ctx.font = font(11)
  ctx.textAlign = 'right'
  ctx.fillText('P/L is in pips.', W - MARGIN, y)
  ctx.textAlign = 'left'
  y += 20

  const finalCanvas = createCanvas(W * SCALE, Math.round(y) * SCALE)
  const finalCtx = finalCanvas.getContext('2d')
  finalCtx.drawImage(scratch, 0, 0)
  return finalCanvas.toBuffer('image/png')
}
