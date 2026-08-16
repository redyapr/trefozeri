// Renders the weekly performance report's chart images (bar chart + TP pie charts,
// and a separate trade-log table) as PNG buffers, using @napi-rs/canvas — a
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
// Trade log images are paginated at this many rows each — "possible akan banyak" (could
// get long over a busy week), and a single giant image would be unreadable in Telegram's
// in-chat preview.
const TRADE_LOG_PAGE_SIZE = 20

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

// Returns one PNG Buffer: title/summary, daily-pips-gained horizontal bars (XAUUSD
// alongside BTCUSD, side by side), and the TP1->TP3 success-rate pies in a row below.
export function renderWeeklyPerformanceChart(data, rangeLabel) {
  registerFonts()
  const W = 900
  const MARGIN = 30
  const CW = 840

  // Rendered onto a generously-tall scratch canvas first, then cropped to the actual
  // content height — the same "measure as we go, crop at the end" approach as the
  // design-preview prototype, since the exact height depends on how many days actually
  // had a trade (quiet days are no longer shown at all) and how many lines the note
  // wraps to.
  const scratch = createCanvas(W * SCALE, 1400 * SCALE)
  const ctx = scratch.getContext('2d')
  ctx.scale(SCALE, SCALE)
  ctx.textBaseline = 'top'
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, W, 1400)

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
  y = pieCy + pieRadius + 22 + 18 + 24

  const finalCanvas = createCanvas(W * SCALE, Math.round(y) * SCALE)
  const finalCtx = finalCanvas.getContext('2d')
  finalCtx.drawImage(scratch, 0, 0)
  return finalCanvas.toBuffer('image/png')
}

// Returns an ARRAY of PNG Buffers — one per page of up to TRADE_LOG_PAGE_SIZE rows —
// rather than a single Buffer, since a busy week's trade count isn't bounded and a
// single giant image would be unreadable in Telegram's in-chat preview.
export function renderWeeklyTradeLogCharts(data, rangeLabel) {
  registerFonts()
  const MARGIN = 30
  const ROW_H = 30
  const HEADER_H = 22

  if (data.trades.length === 0) {
    return [renderTradeLogPage([], rangeLabel, 1, 1, data)]
  }

  const pages = []
  for (let i = 0; i < data.trades.length; i += TRADE_LOG_PAGE_SIZE) {
    pages.push(data.trades.slice(i, i + TRADE_LOG_PAGE_SIZE))
  }
  return pages.map((rows, i) => renderTradeLogPage(rows, rangeLabel, i + 1, pages.length, data))

  function renderTradeLogPage(rows, rangeLabel, pageNum, pageCount, data) {
    const pageSuffix = pageCount > 1 ? ` (${pageNum}/${pageCount})` : ''
    const titleText = `Weekly Trade Log — ${rangeLabel}${pageSuffix}`

    // Fixed page width, same as the performance chart (visual consistency within the
    // album), with the 5 columns "justified" across it — evenly spaced from the left
    // margin to the right margin (DATE flush left, P/L flush right, the rest spaced
    // equally between) — rather than either bunched together with dead space on the
    // right, or stretched with one huge gap before the last column.
    const W = 900
    const CW = 840
    const COLUMN_COUNT = 5
    const colStep = CW / (COLUMN_COUNT - 1)
    const colDate = MARGIN
    const colType = MARGIN + colStep
    const colPair = MARGIN + colStep * 2
    const colHit = MARGIN + colStep * 3
    const colPlRight = MARGIN + CW

    const H = 24 + 40 + 30 + HEADER_H + 20 + ROW_H * Math.max(rows.length, 1) + 24
    const canvas = createCanvas(W * SCALE, H * SCALE)
    const ctx = canvas.getContext('2d')
    ctx.scale(SCALE, SCALE)
    ctx.textBaseline = 'top'
    ctx.fillStyle = COLORS.bg
    ctx.fillRect(0, 0, W, H)

    let y = 24
    ctx.fillStyle = COLORS.textCol
    ctx.font = font(24, true)
    ctx.fillText(titleText, MARGIN, y)
    drawLogoBadge(ctx, W - MARGIN, y - 5, 34, 'right')
    y += 40

    ctx.fillStyle = COLORS.textDim
    ctx.font = font(15, true)
    const summary = data.totalClosed
      ? `${data.totalClosed} closed  ·  Win rate ${data.winRate}% (${data.wins}W / ${data.losses}L)`
      : 'No trades closed this week'
    ctx.fillText(summary, MARGIN, y)
    y += 44

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

    if (rows.length === 0) {
      ctx.fillStyle = COLORS.textDim
      ctx.font = font(14)
      ctx.fillText('No signals closed this week.', colDate, y)
      y += ROW_H
    }

    for (const t of rows) {
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

    return canvas.toBuffer('image/png')
  }
}
