// One-off script: sends a single backfilled "ENTRY FILLED" reply to a specific,
// already-sent Telegram message. Not part of the normal cron flow — the fill-race bug
// fixed in 5eecc7f caused this particular fill to silently vanish from
// data/signal-history.json before the bot ever got a chance to post its own reply
// (see the backfill commit that restored the underlying record). Triggered manually
// via the "Backfill Telegram reply (one-off)" workflow (workflow_dispatch only, never
// runs on a schedule or push). Hardcoded on purpose — this is a single one-time send,
// not a general-purpose "send arbitrary message" utility. Safe to delete this file and
// its workflow once run.

const token = process.env.TELEGRAM_BOT_TOKEN
const chatId = process.env.TELEGRAM_CHAT_ID
if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set')

const MESSAGE_ID = 997 // the original "SELL LIMIT — BTCUSD" signal message this replies to
const TEXT = '🟡 ENTRY FILLED'

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    chat_id: chatId,
    text: TEXT,
    parse_mode: 'HTML',
    reply_to_message_id: MESSAGE_ID,
    allow_sending_without_reply: true,
  }),
})
const json = await res.json()
console.log(JSON.stringify(json, null, 2))
if (!json.ok) throw new Error(`Telegram send failed: ${json.description || res.status}`)
console.log(`Sent backfilled fill reply to message ${MESSAGE_ID}`)
