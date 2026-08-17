// Renders the weekly performance report as ONE PNG buffer (bar chart + TP pie charts +
// trade-log table, all on one canvas) using @napi-rs/canvas — a
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
import { getClosedBetween, PIP_SIZES, favorableMove, formatMove } from '../src/lib/signalHistoryCore.js'

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

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// How many rungs of the TP ladder to break out in the success-rate pies — the real
// per-signal TP count varies (see srDetector.js), but 3 covers the common case and
// keeps the chart a fixed, glanceable size rather than growing unbounded.
const TP_LEVELS = 3

// Pure data prep, independently testable from the canvas drawing below. `days` is 7
// entries (Monday..Sunday, oldest first), each `{ label, startMs, endMs }` — the caller
// (fetch-data.mjs) owns all WIB calendar-date math; this module only ever sees plain
// ms ranges + display labels, so it has no timezone logic of its own to drift out of
// sync with the existing daily/weekly text report.
export function computeWeeklyChartData(history, days) {
  const symbols = ['XAUUSD', 'BTCUSD']
  const dailyBySymbol = { XAUUSD: [], BTCUSD: [] }
  const allTrades = []

  for (const symbolKey of symbols) {
    const pipSize = PIP_SIZES[symbolKey]
    for (const day of days) {
      const closedList = getClosedBetween(history, symbolKey, 'H1', day.startMs, day.endMs)
      const net = closedList.reduce((sum, r) => sum + favorableMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy'), 0)
      dailyBySymbol[symbolKey].push(net)
      for (const r of closedList) {
        const isWin = r.status === 'win'
        allTrades.push({
          date: day.label,
          closedAt: r.closedAt,
          type: r.direction === 'buy' ? 'BUY' : 'SELL',
          pair: symbolKey,
          hit: isWin ? `TP${(r.hitTpIndex ?? 0) + 1}` : 'SL',
          hitTpIndex: isWin ? r.hitTpIndex ?? 0 : null,
          plText: formatMove(pipSize, r.entry, r.exitPrice, r.direction === 'buy'),
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
  const tpReachCount = Array.from({ length: TP_LEVELS }, (_, idx) => allTrades.filter((t) => t.isWin && t.hitTpIndex >= idx).length)
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

// `entries` is already filtered down to the days that actually had a closed trade (see
// activeDayEntries below) — a quiet day isn't shown as an empty "—" row at all anymore,
// rather than every one of the 7 calendar days always appearing.
function drawHBarPanel(ctx, { label, unitSuffix, total, entries, color, x0, y0, w }) {
  const rowH = 24
  const labelW = 62
  const valueW = 78
  const barX0 = x0 + labelW
  const barW = w - labelW - valueW

  ctx.fillStyle = color
  ctx.font = font(18, true)
  ctx.fillText(label, x0, y0)
  const sign = total >= 0 ? '+' : ''
  const totalText = `${sign}${total}${unitSuffix}`
  ctx.textAlign = 'right'
  ctx.fillText(totalText, x0 + w, y0)
  ctx.textAlign = 'left'

  const top = y0 + 28

  if (entries.length === 0) {
    ctx.fillStyle = COLORS.textDim
    ctx.font = font(13)
    ctx.fillText('No trades closed this week.', x0, top + rowH / 2 - 6)
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
    const vtext = `${v > 0 ? '+' : ''}${v}`
    ctx.fillStyle = barColor
    ctx.fillText(vtext, barX0 + barW + 8, ry + rowH / 2 - 6)
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

// Draws the trade-log table (DATE/TYPE/PAIR/HIT/P&L, justified across `w`) starting at
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
  const colPair = x0 + colStep * 2
  const colHit = x0 + colStep * 3
  const colPlRight = x0 + w

  let y = y0
  ctx.fillStyle = COLORS.textDim
  ctx.font = font(14, true)
  ctx.fillText('DATE', colDate, y)
  ctx.fillText('TYPE', colType, y)
  ctx.fillText('PAIR', colPair, y)
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
    ctx.fillText(t.pair, colPair, y)
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
  ctx.fillText(`Weekly Performance — ${rangeLabel}`, MARGIN, y)
  drawLogoBadge(ctx, W - MARGIN, y - 5, 34, 'right')
  y += 40

  ctx.fillStyle = COLORS.textDim
  ctx.font = font(15, true)
  const winRateText = data.totalClosed ? `${data.winRate}% (${data.wins}W / ${data.losses}L)` : 'No trades closed this week'
  ctx.fillText(`XAUUSD ${data.xauTotal >= 0 ? '+' : ''}${data.xauTotal} pips  ·  BTCUSD ${data.btcTotal >= 0 ? '+' : ''}${data.btcTotal}  ·  Win rate ${winRateText}`, MARGIN, y)
  y += 44

  ctx.fillStyle = COLORS.textCol
  ctx.font = font(16, true)
  ctx.fillText('DAILY PIPS GAINED', MARGIN, y)
  y += 32
  const panelsTop = y

  const panelGap = 30
  const panelW = (CW - panelGap) / 2
  const xauX0 = MARGIN
  const btcX0 = MARGIN + panelW + panelGap // BTCUSD to the right of XAUUSD

  const yAfterXau = drawHBarPanel(ctx, {
    label: 'XAUUSD',
    unitSuffix: ' pips',
    total: data.xauTotal,
    entries: activeDayEntries(data.days, data.xauDaily, data.trades, 'XAUUSD'),
    color: COLORS.gold,
    x0: xauX0,
    y0: panelsTop,
    w: panelW,
  })
  const yAfterBtc = drawHBarPanel(ctx, {
    label: 'BTCUSD',
    unitSuffix: '',
    total: data.btcTotal,
    entries: activeDayEntries(data.days, data.btcDaily, data.trades, 'BTCUSD'),
    color: COLORS.cyan,
    x0: btcX0,
    y0: panelsTop,
    w: panelW,
  })
  y = Math.max(yAfterXau, yAfterBtc) + 40

  ctx.fillStyle = COLORS.textCol
  ctx.font = font(16, true)
  ctx.fillText('TP SUCCESS RATE', MARGIN, y)
  y += 40

  // Horizontal row, TP1..TP3 left to right, evenly spaced across the same content width
  // the bar panels above use.
  const pieRadius = 46
  const tpNames = data.tpReachPct.map((_, idx) => `TP${idx + 1}`)
  const colW = CW / tpNames.length
  const pieCy = y + pieRadius
  tpNames.forEach((name, idx) => {
    const pieCx = MARGIN + colW * idx + colW / 2
    drawPie(ctx, { cx: pieCx, cy: pieCy, radius: pieRadius, pct: data.tpReachPct[idx], label: name })
  })
  y = pieCy + pieRadius + 22 + 18 + 40

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
  const finalCanvas = createCanvas(W * SCALE, Math.round(y) * SCALE)
  const finalCtx = finalCanvas.getContext('2d')
  finalCtx.drawImage(scratch, 0, 0)
  return finalCanvas.toBuffer('image/png')
}
