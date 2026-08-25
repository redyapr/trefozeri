#!/usr/bin/env node
// ONE-OFF, SINGLE-USE follow-up to scripts/one-off-tp1-correction.mjs (already run and
// deleted) — that script's 3 close-reply edits succeeded, but its 2 daily-report edits
// silently failed: the daily/weekly report goes out as a *photo* with the report text
// as its caption (see sendTelegramPhoto/maybeSendDailyReport), so it needs
// editMessageCaption, not editMessageText, which is all telegramEditMessage in
// fetch-data.mjs knows how to call. data/signal-history.json is already correctly
// updated (that part of the original script worked and was committed) — this only
// resends the 2 report captions, using the data as it already stands.
import { readFile } from 'node:fs/promises'
import { buildDailyReportMessage } from './fetch-data.mjs'

const HISTORY_PATH = new URL('../data/signal-history.json', import.meta.url)
const history = JSON.parse(await readFile(HISTORY_PATH, 'utf8'))

const aug24Wib = Date.UTC(2026, 7, 23, 17, 0, 0) // Aug 24 00:00 WIB
const aug25Wib = Date.UTC(2026, 7, 24, 17, 0, 0) // Aug 25 00:00 WIB
const edits = [
  { messageId: 1956, text: buildDailyReportMessage(history, aug24Wib) },
  { messageId: 1961, text: buildDailyReportMessage(history, aug25Wib) },
]

async function editCaption(caption, messageId) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  const res = await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, caption, parse_mode: 'HTML' }),
  })
  const json = await res.json()
  if (!json.ok) console.warn(`[telegram] editMessageCaption failed for ${messageId}: ${json.description}`)
  return json.ok
}

for (const e of edits) {
  const ok = await editCaption(e.text, e.messageId)
  console.log(`message ${e.messageId} (caption): ${ok ? 'OK' : 'FAILED'}`)
}
