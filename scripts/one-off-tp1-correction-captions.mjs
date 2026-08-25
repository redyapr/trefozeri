#!/usr/bin/env node
// ONE-OFF, SINGLE-USE follow-up to scripts/one-off-tp1-correction.mjs (already run and
// deleted) — that script's 3 close-reply edits succeeded, but its 2 daily-report edits
// silently failed: the daily/weekly report goes out as a *photo* (the bar-chart image)
// with the report text as its caption (see sendTelegramPhoto/maybeSendDailyReport), so
// correcting it needs editMessageMedia (swaps both the image and caption together), not
// editMessageText, which is all editTelegramMessage in fetch-data.mjs knows how to
// call — and a caption-only fix (editMessageCaption) would still leave the old chart
// image showing a red "loss" bar for a trade the corrected caption now calls a win.
// data/signal-history.json is already correctly updated (that part of the original
// script worked and was committed) — this only re-renders and resends the 2 report
// images+captions, using the data as it already stands.
import { readFile } from 'node:fs/promises'
import { buildDailyReportMessage } from './fetch-data.mjs'
import { computeDailyChartData, renderDailyReportImage } from './weeklyChart.mjs'

const HISTORY_PATH = new URL('../data/signal-history.json', import.meta.url)
const history = JSON.parse(await readFile(HISTORY_PATH, 'utf8'))
const DAY_MS = 24 * 60 * 60 * 1000

const reports = [
  { messageId: 1956, dayStartMs: Date.UTC(2026, 7, 23, 17, 0, 0), dayLabel: 'Monday, 24 Aug 2026' }, // Aug 24 00:00 WIB
  { messageId: 1961, dayStartMs: Date.UTC(2026, 7, 24, 17, 0, 0), dayLabel: 'Tuesday, 25 Aug 2026' }, // Aug 25 00:00 WIB
]

async function editMedia(buffer, filename, caption, messageId) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  const form = new FormData()
  form.append('chat_id', chatId)
  form.append('message_id', String(messageId))
  form.append('media', JSON.stringify({ type: 'photo', media: 'attach://photo', caption, parse_mode: 'HTML' }))
  form.append('photo', new Blob([buffer], { type: 'image/png' }), filename)
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageMedia`, { method: 'POST', body: form })
  const json = await res.json()
  if (!json.ok) console.warn(`[telegram] editMessageMedia failed for ${messageId}: ${json.description}`)
  return json.ok
}

for (const r of reports) {
  const caption = buildDailyReportMessage(history, r.dayStartMs)
  const data = computeDailyChartData(history, r.dayStartMs, r.dayStartMs + DAY_MS)
  const buffer = renderDailyReportImage(data, r.dayLabel)
  const ok = await editMedia(buffer, 'daily-performance.png', caption, r.messageId)
  console.log(`message ${r.messageId} (image+caption): ${ok ? 'OK' : 'FAILED'}`)
}
