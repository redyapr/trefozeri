#!/usr/bin/env node
// ONE-OFF, SINGLE-USE script — 2026-08-26. Not part of the regular fetch pipeline, not
// imported/run by anything else. Corrects 3 records that were recorded as SL-hit losses
// before the TP1-checkpoint fix (see srDetector.js's FAR_TP_THRESHOLD_RR) — a
// walk-forward + real-M1-data retrospective check confirmed each of these actually
// touched the new 1R checkpoint before the SL that closed them, which the fixed logic
// would have credited as a win (a win, once credited, stands even if SL is touched
// afterward — see evaluateSignals' own doc comment in signalHistoryCore.js). Deleted
// once run — see the PR/commit that introduced this for the one-time context.
//
// Run only via .github/workflows/one-off-tp1-correction.yml (workflow_dispatch) — this
// needs real network access to api.telegram.org, which the environment this was
// authored in doesn't have (t.me itself was reachable to read the original messages
// and confirm their content/timestamps, but api.telegram.org was not — DNS resolution
// timed out on every attempt).
import { readFile, writeFile } from 'node:fs/promises'
import { buildCloseMessage, buildDailyReportMessage, editTelegramMessage } from './fetch-data.mjs'

const HISTORY_PATH = new URL('../data/signal-history.json', import.meta.url)

const history = JSON.parse(await readFile(HISTORY_PATH, 'utf8'))

const corrections = [
  { entry: 77475.67, sl: 77274.05142857143, closeReplyId: 1947, checkpointHitAt: Date.UTC(2026, 7, 23, 21, 13, 0) },
  { entry: 4636.48792, sl: 4626.189337142857, closeReplyId: 1957, checkpointHitAt: Date.UTC(2026, 7, 24, 17, 21, 0) },
  { entry: 4622.62236, sl: 4613.650577142857, closeReplyId: 1960, checkpointHitAt: Date.UTC(2026, 7, 25, 8, 23, 0) },
]

const closeEdits = []
for (const c of corrections) {
  const record = history.find((r) => r.entry === c.entry && r.sl === c.sl && r.status === 'loss')
  if (!record) throw new Error(`record not found for entry=${c.entry}`)
  const isBuy = record.direction === 'buy'
  const risk = Math.abs(record.entry - record.sl)
  const checkpointPrice = record.entry + (isBuy ? 1 : -1) * risk

  record.status = 'win'
  record.hitTpIndex = 0
  record.exitPrice = checkpointPrice
  record.closedAt = c.checkpointHitAt
  delete record.slReachedAt
  record.tp = [{ price: checkpointPrice, rr: 1, reachedAt: c.checkpointHitAt, telegramMessageId: c.closeReplyId }, ...record.tp]

  closeEdits.push({ messageId: c.closeReplyId, text: buildCloseMessage(record.symbolKey, record) })
}

const aug24Wib = Date.UTC(2026, 7, 23, 17, 0, 0) // Aug 24 00:00 WIB
const aug25Wib = Date.UTC(2026, 7, 24, 17, 0, 0) // Aug 25 00:00 WIB
const dailyEdits = [
  { messageId: 1956, text: buildDailyReportMessage(history, aug24Wib) },
  { messageId: 1961, text: buildDailyReportMessage(history, aug25Wib) },
]

for (const e of [...closeEdits, ...dailyEdits]) {
  const ok = await editTelegramMessage(e.text, e.messageId)
  console.log(`message ${e.messageId}: ${ok ? 'OK' : 'FAILED'}`)
}

await writeFile(HISTORY_PATH, JSON.stringify(history))
console.log('wrote corrected data/signal-history.json')
