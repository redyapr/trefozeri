import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

// This module has top-level env-var reads inside its functions (not at import time),
// so setting them before import is enough — no need to mock process.env per-test.
process.env.TELEGRAM_BOT_TOKEN = 'fake-token'
process.env.TELEGRAM_CHAT_ID = '-100public'
process.env.TELEGRAM_PERSONAL_CHAT_ID = '999personal'
// Every send in this suite is already a fake token against a mocked fetch (see
// mockTelegram below) — no real network call is possible either way — so opting the
// whole suite into telegramSendsAllowed() is safe. Individual tests for that gate
// itself (see 'telegramSendsAllowed' below) unset this locally to exercise the
// no-op-by-default path.
process.env.ALLOW_TELEGRAM_SEND = 'true'

const {
  buildNewSignalMessage,
  buildFillMessage,
  buildCloseMessage,
  buildInvalidatedMessage,
  updateSignalHistoryForSymbol,
  notifyNewSignals,
  notifyFilledSignals,
  notifyClosedSignals,
  notifyInvalidatedSignals,
  withRetry,
  fetchWithFallback,
  sendTelegramMessage,
  editTelegramMessage,
  sendTelegramPhoto,
  telegramSendsAllowed,
  sendAdminAlert,
  sendAdminAlertDeduped,
  getFailures,
  resetFailures,
  toTwelveDataDatetime,
  parseUtc,
  toCandles,
  buildDailyReportMessage,
  buildWeeklyReportMessage,
  maybeSendDailyReport,
  maybeSendWeeklyReport,
  isNearHighImpactNews,
  main,
} = await import('../scripts/fetch-data.mjs')

// sendAdminAlertDeduped persists its de-dup state to this real file (there's no
// injectable path — it has to survive across separate CI processes) — back it up and
// restore it around any test that exercises the wrapper, so the suite never leaves the
// repo's actual alert state altered.
const ALERT_STATE_PATH = path.join(process.cwd(), 'data', 'last-alert.json')
async function withClearAlertState(fn) {
  const backup = await readFile(ALERT_STATE_PATH, 'utf8').catch(() => null)
  await rm(ALERT_STATE_PATH, { force: true })
  try {
    await fn()
  } finally {
    if (backup == null) await rm(ALERT_STATE_PATH, { force: true })
    else await writeFile(ALERT_STATE_PATH, backup)
  }
}

// main() writes the real, git-tracked data/signal-history.json (there's no injectable
// path — it has to survive across separate CI processes, same reasoning as
// ALERT_STATE_PATH above) — back it up and restore it around any test that actually
// calls main(), so the suite never leaves the repo's real shared track record altered.
// public/data/* is NOT backed up: it's gitignored and regenerated from scratch by any
// real run anyway, so main() overwriting it with test fixture data during a test run
// is harmless.
const REAL_HISTORY_PATH = path.join(process.cwd(), 'data', 'signal-history.json')
async function withBackedUpHistoryFile(fn) {
  const backup = await readFile(REAL_HISTORY_PATH, 'utf8').catch(() => null)
  try {
    await fn()
  } finally {
    if (backup == null) await rm(REAL_HISTORY_PATH, { force: true })
    else await writeFile(REAL_HISTORY_PATH, backup)
  }
}

// maybeSendDailyReport/maybeSendWeeklyReport persist to this real file too (same
// reasoning as ALERT_STATE_PATH — no injectable path) — back it up/restore it around
// any test that could touch it.
const REPORT_STATE_PATH = path.join(process.cwd(), 'data', 'last-report.json')
async function withClearReportState(fn) {
  const backup = await readFile(REPORT_STATE_PATH, 'utf8').catch(() => null)
  await rm(REPORT_STATE_PATH, { force: true })
  try {
    await fn()
  } finally {
    if (backup == null) await rm(REPORT_STATE_PATH, { force: true })
    else await writeFile(REPORT_STATE_PATH, backup)
  }
}

// "hour:minute WIB on this date" -> the UTC ms it corresponds to (WIB is a fixed +7h
// offset, no DST) — lets test fixtures read as the wall-clock moment they represent
// instead of hand-computed epoch numbers.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000
function wibTime(year, month, day, hour = 0, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - WIB_OFFSET_MS
}

// Intercepts calls to api.telegram.org and records them instead of hitting the network.
// Any other fetch() call (e.g. a real fallback snapshot fetch) is left to a caller-
// supplied handler so each test controls exactly what "the network" does. A JSON body
// (sendMessage/editMessageText) is parsed as before; sendPhoto sends a multipart
// FormData body instead — recorded as-is (fields readable via .get()/.getAll()) rather
// than attempting to JSON.parse it.
function mockTelegram(otherHandler) {
  const sent = []
  const original = global.fetch
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) {
      const isForm = opts.body instanceof FormData
      const body = isForm ? opts.body : JSON.parse(opts.body)
      const messageId = sent.length + 1
      sent.push(body)
      return { ok: true, json: async () => ({ ok: true, result: { message_id: messageId } }) }
    }
    if (otherHandler) return otherHandler(url, opts)
    throw new Error(`unexpected fetch: ${url}`)
  }
  return { sent, restore: () => (global.fetch = original) }
}

// Forces telegramSendsAllowed() to false for the duration of `fn` — must clear BOTH
// CI and ALLOW_TELEGRAM_SEND, not just the latter: a real GitHub Actions run has
// CI='true' ambiently, so clearing only ALLOW_TELEGRAM_SEND still leaves sends allowed
// there even though the exact same test correctly no-ops on a local machine (where CI
// is normally unset) — this bit a real CI run once already (see git history).
async function withTelegramSendsDisallowed(fn) {
  const savedCi = process.env.CI
  const savedAllow = process.env.ALLOW_TELEGRAM_SEND
  delete process.env.CI
  delete process.env.ALLOW_TELEGRAM_SEND
  try {
    return await fn()
  } finally {
    if (savedCi == null) delete process.env.CI
    else process.env.CI = savedCi
    if (savedAllow == null) delete process.env.ALLOW_TELEGRAM_SEND
    else process.env.ALLOW_TELEGRAM_SEND = savedAllow
  }
}

function candle(t, o, h, l, c) {
  return { time: t, open: o, high: h, low: l, close: c }
}

// unit scales the pivot's amplitude — needed at BTC price scale (~60000), where
// detectLevels' breakoutThreshold floor (currentPrice * 0.0002 ≈ 12) is far bigger than
// the fixed offsets below would give at their default XAUUSD-scale (~4300) amplitude
// (see srDetector.js's minimum-pivot-amplitude check). Defaults to 1 so every existing
// XAUUSD-scale call (and its exact-price assertions) is unaffected.
function seriesWithLowPivot(base, unit = 1) {
  const candles = []
  let t = 0
  for (let i = 0; i < 10; i++) candles.push(candle(t++, base + 5 * unit, base + 6 * unit, base + 4 * unit, base + 5 * unit))
  candles.push(candle(t++, base + 1 * unit, base + 2 * unit, base - 5 * unit, base + 1 * unit))
  for (let i = 0; i < 5; i++) candles.push(candle(t++, base + 3 * unit, base + 4 * unit, base + 2 * unit, base + 3 * unit))
  for (let i = 0; i < 20; i++) candles.push(candle(t++, base + 3 * unit, base + 5 * unit, base + 2 * unit, base + 4 * unit))
  return candles
}

function seriesWithHighPivot(base) {
  const candles = []
  let t = 0
  for (let i = 0; i < 10; i++) candles.push(candle(t++, base - 5, base - 4, base - 6, base - 5))
  candles.push(candle(t++, base - 1, base + 5, base - 2, base - 1))
  for (let i = 0; i < 5; i++) candles.push(candle(t++, base - 3, base - 2, base - 4, base - 3))
  for (let i = 0; i < 20; i++) candles.push(candle(t++, base - 3, base - 2, base - 5, base - 4))
  return candles
}

// No distinguishable high/low pivot anywhere — detectLevels finds nothing on this
// series, so it never itself produces a signal (used to isolate "does another
// timeframe's signal alone drive the outcome" test cases).
function flatSeries(base, length = 36) {
  return Array.from({ length }, (_, i) => candle(i, base, base + 0.5, base - 0.5, base))
}

test('buildNewSignalMessage', async (t) => {
  await t.test('buy -> blue circle, sell -> red circle, no bold, no timeframe mentioned', () => {
    const buySignal = { tf: 'H1', direction: 'buy', category: 'Support', entry: 4301, sl: 4296.5, tp: [{ price: 4307.75, rr: 1.5 }], strengthLabel: 'Medium' }
    const buyMsg = buildNewSignalMessage('XAUUSD', [buySignal])
    assert.match(buyMsg, /^<a href="[^"]+">🔵 BUY LIMIT/)
    assert.doesNotMatch(buyMsg, /<b>/)
    assert.doesNotMatch(buyMsg, /H1/)

    const sellMsg = buildNewSignalMessage('XAUUSD', [{ ...buySignal, direction: 'sell' }])
    assert.match(sellMsg, /^<a href="[^"]+">🔴 SELL LIMIT/)
  })

  await t.test('the title is a hyperlink to SITE_URL (or its default)', () => {
    const signal = { tf: 'H1', direction: 'buy', category: 'Support', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Medium' }
    const msg = buildNewSignalMessage('XAUUSD', [signal])
    const url = process.env.SITE_URL || 'https://redyapr.github.io/trefozeri'
    assert.match(msg, new RegExp(`^<a href="${url.replace(/\//g, '\\/')}">`))
  })

  await t.test('the body is wrapped in <code> (Monospace) so the columns render fixed-width', () => {
    const signal = { tf: 'H1', direction: 'buy', category: 'Support', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Medium' }
    const msg = buildNewSignalMessage('XAUUSD', [signal])
    assert.match(msg, /<code>[\s\S]*<\/code>$/)
  })

  await t.test('labels are padded so every ":" lines up in the same column', () => {
    const signal = {
      tf: 'H1',
      direction: 'buy',
      category: 'Support',
      entry: 4301,
      sl: 4296.5,
      tp: [
        { price: 4307.75, rr: 1.5 },
        { price: 4312.25, rr: 2.5 },
      ],
      strengthLabel: 'Medium',
    }
    const msg = buildNewSignalMessage('XAUUSD', [signal])
    // Longest label here is "Price" (5 chars) — every label pads to 6 (+1) so there's
    // always at least one space before the ":", even for the widest one.
    assert.match(msg, /Zone  : Support \(Medium\)/)
    assert.match(msg, /Price : 4301/)
    assert.match(msg, /SL    : 4296\.5/)
    assert.match(msg, /TP1   : 4307\.8 \(1\.5R\)/)
    assert.match(msg, /TP2   : 4312\.3 \(2\.5R\)/)
  })

  await t.test('TP price is left-aligned (trailing spaces), "(rr R)" is right-aligned (leading spaces) — the price column and the paren column are sized independently', () => {
    const signal = {
      tf: 'H1',
      direction: 'sell',
      category: 'SBR',
      entry: 4391.5,
      sl: 4398.1,
      tp: [
        { price: 4342.3, rr: 7.5 }, // price 6 chars (widest), "(7.5R)" 6 chars
        { price: 4314, rr: 11.9 }, // price 4 chars, "(11.9R)" 7 chars (widest)
        { price: 4028.6, rr: 55.6 }, // price 6 chars (widest), "(55.6R)" 7 chars (widest)
      ],
      strengthLabel: 'Medium',
    }
    const msg = buildNewSignalMessage('XAUUSD', [signal])
    const tpLines = msg
      .split('\n')
      .filter((line) => /^TP\d/.test(line.replace(/^<code>/, '')))
      .map((line) => line.replace(/^<code>/, '').replace(/<\/code>$/, ''))
    assert.equal(tpLines.length, 3)
    // Every TP row's own line ends right after its ")" (nothing trails it), so equal
    // line lengths across all three directly proves the closing ")" lands in the same
    // column for every row despite their differing price/rr digit counts.
    const lineLengths = tpLines.map((line) => line.length)
    assert.ok(lineLengths.every((len) => len === lineLengths[0]), 'every TP line ends at the same column — "(...R)" is right-aligned')
    assert.match(msg, /TP1   : 4342\.3  \(7\.5R\)/, 'the widest price, joined to a shorter paren, gets extra leading spaces before "("')
    assert.match(msg, /TP2   : 4314   \(11\.9R\)/, 'the shortest price is padded out (trailing spaces) to match the widest price')
    assert.match(msg, /TP3   : 4028\.6 \(55\.6R\)/, 'both columns at their own widest — exactly one space in between')
  })

  await t.test('flags a Golden Zone (Strong) confluence level in the title and zone line', () => {
    const strong = { tf: 'H1', direction: 'buy', category: 'Support', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Strong' }
    const msg = buildNewSignalMessage('XAUUSD', [strong])
    assert.match(msg, /⭐ Golden Zone/)
    assert.match(msg, /Zone  : Support \(Strong\)/)
  })

  await t.test('a non-golden level shows Medium and no star', () => {
    const medium = { tf: 'H1', direction: 'buy', category: 'Support', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Medium' }
    const msg = buildNewSignalMessage('XAUUSD', [medium])
    assert.doesNotMatch(msg, /⭐/)
    assert.match(msg, /Zone  : Support \(Medium\)/)
  })

  await t.test('prices drop a trailing .0, TPs are numbered in order', () => {
    const signal = {
      tf: 'H1',
      direction: 'buy',
      category: 'Support',
      entry: 4301, // whole number -> "4301", not "4301.0"
      sl: 4296.5,
      tp: [
        { price: 4307.75, rr: 1.5 },
        { price: 4312.25, rr: 2.5 },
      ],
      strengthLabel: 'Medium',
    }
    const msg = buildNewSignalMessage('XAUUSD', [signal])
    assert.match(msg, /Price : 4301\n/)
    assert.match(msg, /SL    : 4296\.5/)
    assert.match(msg, /TP1   : 4307\.8 \(1\.5R\)/)
    assert.match(msg, /TP2   : 4312\.3 \(2\.5R\)/)
  })

  await t.test('a multi-member group uses the earliest timeframe (TF_ORDER) as primary', () => {
    const h4 = { tf: 'H4', direction: 'buy', category: 'Support', entry: 999, sl: 990, tp: [], strengthLabel: 'Medium' }
    const h1 = { tf: 'H1', direction: 'buy', category: 'Support', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Medium' }
    const msg = buildNewSignalMessage('XAUUSD', [h4, h1]) // passed out of order on purpose
    assert.match(msg, /Price : 4301/, 'H1 (earlier in TF_ORDER) should be used, not H4')
  })
})

test('buildFillMessage', () => {
  assert.equal(buildFillMessage(), '<code>🟡 ENTRY FILLED</code>')
})

test('buildInvalidatedMessage', () => {
  assert.equal(buildInvalidatedMessage(), '<code>❌ INVALIDATED</code>')
})

test('buildCloseMessage', async (t) => {
  await t.test('a win: green check, TP index + 1, pips, single line, wrapped in <code> (Monospace)', () => {
    const record = { direction: 'buy', status: 'win', hitTpIndex: 0, entry: 4301, exitPrice: 4307.75 }
    const msg = buildCloseMessage('XAUUSD', record)
    assert.equal(msg, '<code>✅ TP1 HIT +68 pips</code>')
  })

  await t.test('a win crediting a farther TP shows the right index', () => {
    const record = { direction: 'buy', status: 'win', hitTpIndex: 1, entry: 4301, exitPrice: 4312.25 }
    const msg = buildCloseMessage('XAUUSD', record)
    assert.match(msg, /^<code>✅ TP2 HIT/)
  })

  await t.test('a loss: red cross, negative pips', () => {
    const record = { direction: 'buy', status: 'loss', entry: 4301, exitPrice: 4296.5 }
    const msg = buildCloseMessage('XAUUSD', record)
    assert.equal(msg, '<code>❌ SL HIT -45 pips</code>')
  })

  await t.test('a sell result flips the sign correctly', () => {
    const win = { direction: 'sell', status: 'win', hitTpIndex: 0, entry: 4400, exitPrice: 4359 }
    assert.match(buildCloseMessage('XAUUSD', win), /^<code>✅ TP1 HIT \+410 pips<\/code>$/)
  })

  await t.test('BTCUSD (no pip convention) shows a raw $ move', () => {
    const record = { direction: 'buy', status: 'win', hitTpIndex: 0, entry: 65000, exitPrice: 66200 }
    assert.equal(buildCloseMessage('BTCUSD', record), '<code>✅ TP1 HIT +1200</code>')
  })
})

test('withRetry', async (t) => {
  await t.test('succeeds without retrying when the first attempt works', async () => {
    let calls = 0
    const result = await withRetry(async () => { calls++; return 'ok' }, 'test', { attempts: 2, baseDelayMs: 1 })
    assert.equal(result, 'ok')
    assert.equal(calls, 1)
  })

  await t.test('retries on failure and succeeds once the underlying call recovers', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new Error('transient')
        return 'recovered'
      },
      'test',
      { attempts: 2, baseDelayMs: 1 }
    )
    assert.equal(result, 'recovered')
    assert.equal(calls, 3)
  })

  await t.test('throws the last error once attempts are exhausted', async () => {
    let calls = 0
    await assert.rejects(
      withRetry(
        async () => { calls++; throw new Error('always fails') },
        'test',
        { attempts: 2, baseDelayMs: 1 }
      ),
      /always fails/
    )
    assert.equal(calls, 3, '1 initial + 2 retries')
  })
})

test('fetchWithFallback', async (t) => {
  await t.test('returns the primary result directly when it succeeds', async () => {
    const { restore } = mockTelegram()
    try {
      const result = await fetchWithFallback('SRC', async () => ({ ok: true }), 'irrelevant.json', { attempts: 0 })
      assert.deepEqual(result, { ok: true })
    } finally {
      restore()
    }
  })

  await t.test('falls back to the last snapshot when the primary fails, using the default SITE_URL', async () => {
    const { restore } = mockTelegram((url) => {
      assert.equal(String(url), 'https://redyapr.github.io/trefozeri/data/irrelevant.json')
      return { ok: true, json: async () => ({ fallback: true }) }
    })
    try {
      const result = await fetchWithFallback(
        'SRC',
        async () => { throw new Error('primary down') },
        'irrelevant.json',
        { attempts: 0 }
      )
      assert.deepEqual(result, { fallback: true })
    } finally {
      restore()
    }
  })

  await t.test('SITE_URL overrides the default fallback base (a fork/rename/domain change needs no code edit)', async () => {
    const saved = process.env.SITE_URL
    process.env.SITE_URL = 'https://example.com/myfork'
    try {
      // A fresh module instance — LIVE_BASE is computed once at import time from
      // whatever SITE_URL was set then, so overriding it after the top-of-file import
      // wouldn't be visible without re-importing.
      const fresh = await import(`../scripts/fetch-data.mjs?t=${Date.now()}`)
      const { restore } = mockTelegram((url) => {
        assert.equal(String(url), 'https://example.com/myfork/data/irrelevant.json')
        return { ok: true, json: async () => ({ fallback: true }) }
      })
      try {
        const result = await fresh.fetchWithFallback(
          'SRC',
          async () => { throw new Error('primary down') },
          'irrelevant.json',
          { attempts: 0 }
        )
        assert.deepEqual(result, { fallback: true })
      } finally {
        restore()
      }
    } finally {
      process.env.SITE_URL = saved
    }
  })

  await t.test('records a failure and returns null when both primary and fallback fail', async () => {
    const { restore } = mockTelegram(() => ({ ok: false, status: 503, json: async () => ({}) }))
    resetFailures()
    try {
      const result = await fetchWithFallback(
        'SRC',
        async () => { throw new Error('primary down') },
        'irrelevant.json',
        { attempts: 0 }
      )
      assert.equal(result, null)
      assert.equal(getFailures().length, 1)
      assert.match(getFailures()[0], /SRC/)
    } finally {
      restore()
    }
  })
})

test('telegramSendsAllowed', async (t) => {
  // Every test here saves/restores both env vars around itself — the rest of this
  // whole suite depends on ALLOW_TELEGRAM_SEND='true' (set at the top of this file)
  // to actually exercise its mocked sends at all.
  function withEnv(ci, allow, fn) {
    const savedCi = process.env.CI
    const savedAllow = process.env.ALLOW_TELEGRAM_SEND
    if (ci == null) delete process.env.CI
    else process.env.CI = ci
    if (allow == null) delete process.env.ALLOW_TELEGRAM_SEND
    else process.env.ALLOW_TELEGRAM_SEND = allow
    try {
      return fn()
    } finally {
      if (savedCi == null) delete process.env.CI
      else process.env.CI = savedCi
      if (savedAllow == null) delete process.env.ALLOW_TELEGRAM_SEND
      else process.env.ALLOW_TELEGRAM_SEND = savedAllow
    }
  }

  await t.test('false by default — neither CI nor ALLOW_TELEGRAM_SEND set (the safe default for a plain local run)', () => {
    withEnv(null, null, () => assert.equal(telegramSendsAllowed(), false))
  })

  await t.test('true in CI — GitHub Actions sets CI=true on every job automatically, no workflow change needed', () => {
    withEnv('true', null, () => assert.equal(telegramSendsAllowed(), true))
  })

  await t.test('true when explicitly opted into locally via ALLOW_TELEGRAM_SEND=true', () => {
    withEnv(null, 'true', () => assert.equal(telegramSendsAllowed(), true))
  })

  await t.test('some other truthy-looking CI value (not the exact string "true") does not accidentally allow it', () => {
    withEnv('1', null, () => assert.equal(telegramSendsAllowed(), false))
  })
})

test('sendTelegramMessage', async (t) => {
  await t.test('no-ops (returns null, makes no request) when ALLOW_TELEGRAM_SEND/CI is not set, even with a valid token/chat id', async () => {
    await withTelegramSendsDisallowed(async () => {
      const { sent, restore } = mockTelegram()
      try {
        const result = await sendTelegramMessage('hello')
        assert.equal(result, null)
        assert.equal(sent.length, 0)
      } finally {
        restore()
      }
    })
  })

  await t.test('no-ops (returns null, makes no request) when the token/chat id are missing', async () => {
    const savedToken = process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_BOT_TOKEN
    const { sent, restore } = mockTelegram()
    try {
      const result = await sendTelegramMessage('hello')
      assert.equal(result, null)
      assert.equal(sent.length, 0)
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = savedToken
      restore()
    }
  })

  await t.test('includes reply_to_message_id only when replying, with allow_sending_without_reply false', async () => {
    const { sent, restore } = mockTelegram()
    try {
      await sendTelegramMessage('a fresh message')
      await sendTelegramMessage('a reply', 42)
      assert.equal(sent[0].reply_to_message_id, undefined)
      assert.equal(sent[1].reply_to_message_id, 42)
      // false, not true: if the message being replied to was deleted (e.g. manually),
      // this notification should be skipped entirely, not posted as an orphaned
      // standalone message with no context — see the next test.
      assert.equal(sent[1].allow_sending_without_reply, false)
    } finally {
      restore()
    }
  })

  await t.test('a reply to a since-deleted message is skipped entirely, not posted standalone', async () => {
    const original = global.fetch
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: 'Bad Request: message to reply not found' }) })
    try {
      const result = await sendTelegramMessage('FILLED', 42)
      assert.equal(result, null, 'no message_id — nothing was actually sent')
    } finally {
      global.fetch = original
    }
  })

  await t.test('routes to the given chatId override instead of the public channel', async () => {
    const { sent, restore } = mockTelegram()
    try {
      await sendTelegramMessage('to somewhere else', undefined, 'some-other-chat')
      assert.equal(sent[0].chat_id, 'some-other-chat')
    } finally {
      restore()
    }
  })

  await t.test('always disables link previews — a signal message\'s title link would otherwise attach a big preview card', async () => {
    const { sent, restore } = mockTelegram()
    try {
      await sendTelegramMessage('hello')
      assert.deepEqual(sent[0].link_preview_options, { is_disabled: true })
    } finally {
      restore()
    }
  })
})

test('editTelegramMessage', async (t) => {
  await t.test('no-ops (returns false, makes no request) when ALLOW_TELEGRAM_SEND/CI is not set', async () => {
    await withTelegramSendsDisallowed(async () => {
      const { sent, restore } = mockTelegram()
      try {
        assert.equal(await editTelegramMessage('hello', 1), false)
        assert.equal(sent.length, 0)
      } finally {
        restore()
      }
    })
  })

  await t.test('no-ops (returns false, makes no request) when the token/chat id/messageId are missing', async () => {
    const savedToken = process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_BOT_TOKEN
    const { sent, restore } = mockTelegram()
    try {
      assert.equal(await editTelegramMessage('hello', 1), false)
      assert.equal(sent.length, 0)
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = savedToken
      restore()
    }
  })

  await t.test('sends the message_id + text, with link previews disabled, and returns true on success', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const result = await editTelegramMessage('updated text', 123)
      assert.equal(result, true)
      assert.equal(sent[0].message_id, 123)
      assert.equal(sent[0].text, 'updated text')
      assert.deepEqual(sent[0].link_preview_options, { is_disabled: true })
    } finally {
      restore()
    }
  })

  await t.test('returns false (swallowed) when Telegram rejects the edit, e.g. the message was deleted', async () => {
    const original = global.fetch
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: 'message to edit not found' }) })
    try {
      assert.equal(await editTelegramMessage('hello', 999), false)
    } finally {
      global.fetch = original
    }
  })
})

test('sendTelegramPhoto', async (t) => {
  await t.test('no-ops (returns null, makes no request) when ALLOW_TELEGRAM_SEND/CI is not set', async () => {
    await withTelegramSendsDisallowed(async () => {
      const { sent, restore } = mockTelegram()
      try {
        const result = await sendTelegramPhoto(Buffer.from('fake png'), 'chart.png')
        assert.equal(result, null)
        assert.equal(sent.length, 0)
      } finally {
        restore()
      }
    })
  })

  await t.test('no-ops (returns null, makes no request) when the token/chat id are missing', async () => {
    const savedChat = process.env.TELEGRAM_CHAT_ID
    delete process.env.TELEGRAM_CHAT_ID
    const { sent, restore } = mockTelegram()
    try {
      const result = await sendTelegramPhoto(Buffer.from('fake png'), 'chart.png')
      assert.equal(result, null)
      assert.equal(sent.length, 0)
    } finally {
      process.env.TELEGRAM_CHAT_ID = savedChat
      restore()
    }
  })

  await t.test('posts the buffer as a photo, with the given filename, caption, and HTML parse_mode', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const buf = Buffer.from('fake png bytes')
      const result = await sendTelegramPhoto(buf, 'weekly-performance.png', 'a <b>caption</b>')
      assert.equal(result, 1)
      const form = sent[0]
      assert.equal(form.get('chat_id'), '-100public')
      assert.equal(form.get('caption'), 'a <b>caption</b>')
      assert.equal(form.get('parse_mode'), 'HTML')
      const file = form.get('photo')
      assert.equal(file.name, 'weekly-performance.png')
      assert.equal(await file.text(), 'fake png bytes')
    } finally {
      restore()
    }
  })

  await t.test('omits caption and parse_mode entirely when no caption is given', async () => {
    const { sent, restore } = mockTelegram()
    try {
      await sendTelegramPhoto(Buffer.from('x'), 'x.png')
      assert.equal(sent[0].get('caption'), null)
      assert.equal(sent[0].get('parse_mode'), null)
    } finally {
      restore()
    }
  })

  await t.test('returns null (swallowed) when Telegram rejects the upload', async () => {
    const original = global.fetch
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: false, description: 'file too large' }) })
    try {
      assert.equal(await sendTelegramPhoto(Buffer.from('x'), 'x.png'), null)
    } finally {
      global.fetch = original
    }
  })
})

test('sendAdminAlert', async (t) => {
  await t.test('goes to TELEGRAM_PERSONAL_CHAT_ID, never the public channel', async () => {
    const { sent, restore } = mockTelegram()
    try {
      await sendAdminAlert('something broke')
      assert.equal(sent.length, 1)
      assert.equal(sent[0].chat_id, process.env.TELEGRAM_PERSONAL_CHAT_ID)
      assert.notEqual(sent[0].chat_id, process.env.TELEGRAM_CHAT_ID)
      assert.match(sent[0].text, /something broke/)
    } finally {
      restore()
    }
  })

  await t.test('no-ops when TELEGRAM_PERSONAL_CHAT_ID is unset', async () => {
    const saved = process.env.TELEGRAM_PERSONAL_CHAT_ID
    delete process.env.TELEGRAM_PERSONAL_CHAT_ID
    const { sent, restore } = mockTelegram()
    try {
      await sendAdminAlert('nobody should see this')
      assert.equal(sent.length, 0)
    } finally {
      process.env.TELEGRAM_PERSONAL_CHAT_ID = saved
      restore()
    }
  })
})

test('sendAdminAlertDeduped', async (t) => {
  await t.test('sends the first time a given failure text is seen', async () => {
    await withClearAlertState(async () => {
      const { sent, restore } = mockTelegram()
      try {
        await sendAdminAlertDeduped('API key expired')
        assert.equal(sent.length, 1)
      } finally {
        restore()
      }
    })
  })

  await t.test('suppresses an immediate repeat of the exact same text', async () => {
    await withClearAlertState(async () => {
      const { sent, restore } = mockTelegram()
      try {
        await sendAdminAlertDeduped('API key expired')
        await sendAdminAlertDeduped('API key expired')
        await sendAdminAlertDeduped('API key expired')
        assert.equal(sent.length, 1, 'the same failure repeating every cron tick should only alert once')
      } finally {
        restore()
      }
    })
  })

  await t.test('a different failure text sends immediately, independent of any suppressed one', async () => {
    await withClearAlertState(async () => {
      const { sent, restore } = mockTelegram()
      try {
        await sendAdminAlertDeduped('API key expired')
        await sendAdminAlertDeduped('Binance.US is down')
        assert.equal(sent.length, 2)
      } finally {
        restore()
      }
    })
  })

  await t.test('re-sends the same text once the suppression window has passed', async () => {
    await withClearAlertState(async () => {
      await writeFile(ALERT_STATE_PATH, JSON.stringify({ dedupKey: 'API key expired', sentAt: Date.now() - 7 * 60 * 60 * 1000 }))
      const { sent, restore } = mockTelegram()
      try {
        await sendAdminAlertDeduped('API key expired')
        assert.equal(sent.length, 1, 'more than 6 hours have passed since the last send')
      } finally {
        restore()
      }
    })
  })

  await t.test('ALERT_SUPPRESS_HOURS overrides the default 6-hour suppression window', async () => {
    await withClearAlertState(async () => {
      // 2 hours ago — would still be suppressed under the default 6-hour window, but
      // not under a 1-hour override.
      await writeFile(ALERT_STATE_PATH, JSON.stringify({ dedupKey: 'API key expired', sentAt: Date.now() - 2 * 60 * 60 * 1000 }))
      const saved = process.env.ALERT_SUPPRESS_HOURS
      process.env.ALERT_SUPPRESS_HOURS = '1'
      try {
        // A fresh module instance — ALERT_SUPPRESS_MS is computed once at import time.
        const fresh = await import(`../scripts/fetch-data.mjs?t=${Date.now()}`)
        const { sent, restore } = mockTelegram()
        try {
          await fresh.sendAdminAlertDeduped('API key expired')
          assert.equal(sent.length, 1, 'more than 1 hour (the override) has passed since the last send')
        } finally {
          restore()
        }
      } finally {
        process.env.ALERT_SUPPRESS_HOURS = saved
      }
    })
  })

  await t.test('a dedupKey lets two different-text alerts still be recognized as the same underlying cause', async () => {
    // Reproduces a real fragility: a persistent failure (e.g. an expired API key) can
    // still vary its exact error text run to run (a different retry count, a slightly
    // different upstream response body) — exact-text matching would never dedupe that,
    // defeating ALERT_SUPPRESS_HOURS for the one case it exists to handle. Passing an
    // explicit, stable dedupKey separate from the (possibly-varying) text fixes this.
    await withClearAlertState(async () => {
      const { sent, restore } = mockTelegram()
      try {
        await sendAdminAlertDeduped('XAUUSD H1: attempt 1 failed (timeout after 3011ms)', 'data-source-failure:XAUUSD H1')
        await sendAdminAlertDeduped('XAUUSD H1: attempt 2 failed (timeout after 2847ms)', 'data-source-failure:XAUUSD H1')
        assert.equal(sent.length, 1, 'same dedupKey — still recognized as the same persistent cause despite differing text')
      } finally {
        restore()
      }
    })
  })

  await t.test('without an explicit dedupKey, it still defaults to the text itself (backward compatible)', async () => {
    await withClearAlertState(async () => {
      const { sent, restore } = mockTelegram()
      try {
        await sendAdminAlertDeduped('API key expired')
        await sendAdminAlertDeduped('API key expired')
        assert.equal(sent.length, 1)
      } finally {
        restore()
      }
    })
  })
})

test('updateSignalHistoryForSymbol: end-to-end Telegram wiring', async (t) => {
  await t.test('a signal that would be real on H4 is never recorded at all — signals are H1-only', async () => {
    const { sent, restore } = mockTelegram()
    try {
      // H1 is flat (no pivot at all -> no signal of its own), so currentPrice still
      // comes from H1, but the only actual qualifying level this tick is on H4.
      const seriesByTf = { H1: flatSeries(4290), H4: seriesWithHighPivot(4300) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', seriesByTf)
      assert.equal(sent.length, 0)
      assert.deepEqual(history, [], 'H4 never becomes a tracked record, real level or not')
    } finally {
      restore()
    }
  })

  await t.test('a still-pending H4 record from before this policy gets dropped, not left lingering forever', async () => {
    const { restore } = mockTelegram()
    try {
      const history = [
        {
          key: 'XAUUSD-H4-Resistance-sell',
          symbolKey: 'XAUUSD',
          tf: 'H4',
          category: 'Resistance',
          direction: 'sell',
          entry: 4400,
          sl: 4410,
          tp: [],
          openedAt: 0,
          status: 'pending',
        },
      ]
      const seriesByTf = { H1: flatSeries(4290), H4: seriesWithHighPivot(4300) }
      await updateSignalHistoryForSymbol(history, 'XAUUSD', seriesByTf)
      assert.deepEqual(history, [], 'recordSignals still runs with an empty signal list for H4, so it gets pruned')
    } finally {
      restore()
    }
  })

  await t.test('an already-running H4 position (filled before this policy) is left alone until it naturally closes', async () => {
    const { restore } = mockTelegram()
    try {
      const history = [
        {
          key: 'XAUUSD-H4-Resistance-sell',
          symbolKey: 'XAUUSD',
          tf: 'H4',
          category: 'Resistance',
          direction: 'sell',
          entry: 4291,
          sl: 4400,
          tp: [{ price: 4200, rr: 1 }],
          openedAt: 0,
          status: 'running',
          filledAt: 0,
        },
      ]
      const seriesByTf = { H1: flatSeries(4290), H4: seriesWithHighPivot(4300) }
      await updateSignalHistoryForSymbol(history, 'XAUUSD', seriesByTf)
      assert.equal(history.length, 1, 'a running record is never dropped just because new signals stopped generating for its timeframe')
      assert.equal(history[0].status, 'running')
    } finally {
      restore()
    }
  })

  await t.test('H4/D1-only signals (no H1 series in the input at all) never reach Telegram — and produce no signals, since currentPrice has no source', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const seriesByTf = { H4: seriesWithHighPivot(4300) } // no H1 series at all -> no currentPrice reference
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', seriesByTf)
      assert.equal(sent.length, 0)
      assert.deepEqual(history, [], 'H4 signals are never recorded regardless — and there is no currentPrice to build from anyway')
    } finally {
      restore()
    }
  })

  await t.test('notifyNewSignals folds a genuine cross-timeframe confluence group into one message (exercised directly, since TELEGRAM_TIMEFRAMES currently pre-filters this away in normal operation)', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const h1Signal = { category: 'Support', direction: 'buy', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Strong', confluence: ['H4'] }
      const h4Signal = { category: 'Support', direction: 'buy', entry: 4300.5, sl: 4296, tp: [], strengthLabel: 'Strong', confluence: ['H1'] }
      const added = [
        { key: 'XAUUSD-H1-Support-buy', tf: 'H1' },
        { key: 'XAUUSD-H4-Support-buy', tf: 'H4' },
      ]
      const signalByKey = new Map([
        ['XAUUSD-H1-Support-buy', h1Signal],
        ['XAUUSD-H4-Support-buy', h4Signal],
      ])
      await notifyNewSignals('XAUUSD', added, signalByKey)
      assert.equal(sent.length, 1, 'both fold into a single message')
      assert.equal(added[0].telegramMessageId, 1)
      assert.equal(added[1].telegramMessageId, 1, 'both records share the same message id')
    } finally {
      restore()
    }
  })

  await t.test("notifyNewSignals doesn't fold in a confluence timeframe that wasn't itself newly added this tick", async () => {
    const { sent, restore } = mockTelegram()
    try {
      const h1Signal = { category: 'Support', direction: 'buy', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Strong', confluence: ['H4'] }
      // H4's own signal already existed before this tick (not in `added`) — H1 still
      // posts, just on its own, since there's nothing new on H4 to fold in.
      const added = [{ key: 'XAUUSD-H1-Support-buy', tf: 'H1' }]
      const signalByKey = new Map([['XAUUSD-H1-Support-buy', h1Signal]])
      await notifyNewSignals('XAUUSD', added, signalByKey)
      assert.equal(sent.length, 1)
      assert.equal(added[0].telegramMessageId, 1)
    } finally {
      restore()
    }
  })

  await t.test('BTCUSD sends a new-signal message on a weekday too, for H1 (see the dedicated daily-gating tests below)', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(60000, 20)
      const weekday = Date.UTC(2026, 7, 12, 12, 0, 0) // Wednesday
      const seriesByTf = { H1: base.map((c, i) => ({ ...c, time: weekday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'BTCUSD', seriesByTf)
      assert.ok(sent.length > 0)
      assert.ok(history.length > 0, 'still tracked in the shared history')
    } finally {
      restore()
    }
  })

  await t.test('re-running identical data sends no duplicate new-signal message', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const seriesByTf = { H1: seriesWithLowPivot(4300) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', seriesByTf)
      await updateSignalHistoryForSymbol(history, 'XAUUSD', seriesByTf)
      assert.equal(sent.length, 1)
    } finally {
      restore()
    }
  })

  await t.test('a still-pending signal that recalculates (no fill) edits its own Telegram message', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(4300)
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: base })
      assert.equal(sent.length, 1, 'initial new-signal message')
      const h1 = history.find((r) => r.tf === 'H1')
      const originalMessageId = h1.telegramMessageId
      const originalSl = h1.sl

      // One extra wide-range candle shifts ATR (and so SL/TP) without moving price
      // anywhere near the entry — still pending, not filled.
      const recalculated = { H1: [...base, candle(base.length, 4310, 4320, 4305, 4315)] }
      await updateSignalHistoryForSymbol(history, 'XAUUSD', recalculated)

      assert.equal(sent.length, 2, 'an edit, not a brand-new message')
      assert.equal(sent[1].message_id, originalMessageId, 'edits the same message the signal was first posted as')
      assert.equal(sent[1].reply_to_message_id, undefined, 'an edit, not a reply')
      assert.notEqual(h1.sl, originalSl, 'the record itself is synced too, not just the Telegram message')
      assert.match(sent[1].text, /SL\s*: /)
      assert.equal(history.length, 1, 'still the same single record, not a duplicate')
      assert.equal(h1.status, 'pending')
    } finally {
      restore()
    }
  })

  await t.test('re-running identical data after a recalculation sends no further edit', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(4300)
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: base })
      const recalculated = { H1: [...base, candle(base.length, 4310, 4320, 4305, 4315)] }
      await updateSignalHistoryForSymbol(history, 'XAUUSD', recalculated)
      await updateSignalHistoryForSymbol(history, 'XAUUSD', recalculated) // identical again
      assert.equal(sent.length, 2, 'no further edit once nothing actually changed')
    } finally {
      restore()
    }
  })

  await t.test('a signal that both recalculates and fills in the same tick only gets a FILLED reply, not an edit too', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(4300)
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: base })
      const h1 = history.find((r) => r.tf === 'H1')

      // A wide-range candle (shifts ATR) immediately followed by one dipping to the
      // entry (fills it), both in the same call.
      const filledAndRecalculated = {
        H1: [
          ...base,
          candle(base.length, 4310, 4320, 4305, 4315),
          candle(base.length + 1, h1.entry, h1.entry + 1, h1.entry - 1, h1.entry),
        ],
      }
      await updateSignalHistoryForSymbol(history, 'XAUUSD', filledAndRecalculated)

      assert.equal(sent.length, 2, 'new-signal + FILLED reply only — no separate edit')
      assert.equal(sent[1].text, '<code>🟡 ENTRY FILLED</code>')
      assert.equal(h1.status, 'running')
    } finally {
      restore()
    }
  })

  await t.test('a record with no telegramMessageId (never posted) is synced but nothing is edited', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(4300)
      const saturday = Date.UTC(2026, 7, 15, 12, 0, 0) // Saturday — gold's own market is closed, no new-signal post
      const withTime = (series) => series.map((c, i) => ({ ...c, time: saturday - (series.length - i) * 3600000 }))
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: withTime(base) })
      assert.equal(sent.length, 0)
      const h1 = history.find((r) => r.tf === 'H1')
      assert.equal(h1.telegramMessageId, undefined)
      const originalSl = h1.sl

      const recalculated = [...base, candle(base.length, 4310, 4320, 4305, 4315)]
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: withTime(recalculated) })

      assert.equal(sent.length, 0, 'still nothing to send — there was never a message to edit')
      assert.notEqual(h1.sl, originalSl, 'the record is still synced regardless')
    } finally {
      restore()
    }
  })

  await t.test('full lifecycle: open -> fill -> TP hit, all three replies chained to the same message', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const seriesByTf = { H1: seriesWithLowPivot(4300) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', seriesByTf)
      const h1 = history.find((r) => r.tf === 'H1')

      const filledSeries = { H1: [...seriesByTf.H1, candle(998, h1.entry, h1.entry + 1, h1.entry - 1, h1.entry)] }
      await updateSignalHistoryForSymbol(history, 'XAUUSD', filledSeries)

      const winSeries = { H1: [...filledSeries.H1, candle(999, h1.tp[0].price + 1, h1.tp[0].price + 2, h1.tp[0].price, h1.tp[0].price + 1)] }
      await updateSignalHistoryForSymbol(history, 'XAUUSD', winSeries)

      assert.equal(sent.length, 3)
      assert.match(sent[0].text, /BUY LIMIT/)
      assert.equal(sent[1].text, '<code>🟡 ENTRY FILLED</code>')
      assert.match(sent[2].text, /^<code>✅ TP1 HIT/)
      assert.equal(sent[1].reply_to_message_id, 1)
      assert.equal(sent[2].reply_to_message_id, 1)
    } finally {
      restore()
    }
  })

  await t.test('a record evaluateSignals reports only in `closed` (a same-tick fill-and-close) gets exactly one message, not a fill + a close', async () => {
    // evaluateSignals itself (see signalHistoryCore.test.mjs) already guarantees a
    // same-tick fill-and-close only ever appears in `closed`, never also in `filled` —
    // this confirms the wiring on this side reads those two disjoint lists correctly:
    // calling both notifiers with evaluateSignals' actual disjoint output must not
    // double-notify a record that only closed.
    const { sent, restore } = mockTelegram()
    try {
      const record = { direction: 'buy', status: 'loss', entry: 100, exitPrice: 94, telegramMessageId: 7 }
      await notifyFilledSignals([]) // nothing filled this tick
      await notifyClosedSignals('XAUUSD', [record]) // only closed
      assert.equal(sent.length, 1)
      assert.match(sent[0].text, /^<code>❌ SL HIT/)
      assert.equal(sent[0].reply_to_message_id, 7)
    } finally {
      restore()
    }
  })

  await t.test('notifyInvalidatedSignals replies "INVALIDATED" to each record\'s own message', async () => {
    const { sent, restore } = mockTelegram()
    try {
      await notifyInvalidatedSignals([{ telegramMessageId: 7 }, { telegramMessageId: 9 }])
      assert.equal(sent.length, 2)
      assert.ok(sent.every((m) => m.text === '<code>❌ INVALIDATED</code>'))
      assert.deepEqual(sent.map((m) => m.reply_to_message_id), [7, 9])
    } finally {
      restore()
    }
  })

  await t.test('notifyInvalidatedSignals skips a record that never got posted (no telegramMessageId)', async () => {
    const { sent, restore } = mockTelegram()
    try {
      await notifyInvalidatedSignals([{ telegramMessageId: undefined }])
      assert.equal(sent.length, 0)
    } finally {
      restore()
    }
  })

  await t.test('skips new-signal notifications for XAUUSD while the gold market is closed', async () => {
    const { sent, restore } = mockTelegram()
    try {
      // Force the H1 series' last candle onto a Saturday.
      const base = seriesWithLowPivot(4300)
      const saturday = Date.UTC(2026, 7, 15, 12, 0, 0) // 2026-08-15 is a Saturday
      const closedSeries = { H1: base.map((c, i) => ({ ...c, time: saturday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', closedSeries)
      assert.equal(sent.length, 0, 'no new-signal message while the market is closed')
      assert.ok(history.length > 0, 'still tracked in the shared history for when the market reopens')
    } finally {
      restore()
    }
  })

  await t.test('still notifies fills/closes for XAUUSD even while the market is closed', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(4300)
      const weekday = Date.UTC(2026, 7, 12, 12, 0, 0) // Wednesday — market open
      const openSeries = { H1: base.map((c, i) => ({ ...c, time: weekday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', openSeries) // opens while market's open

      const h1 = history.find((r) => r.tf === 'H1')
      const saturday = Date.UTC(2026, 7, 15, 12, 0, 0)
      const filledOnSaturday = { H1: [...openSeries.H1, candle(saturday, h1.entry, h1.entry + 1, h1.entry - 1, h1.entry)] }
      await updateSignalHistoryForSymbol(history, 'XAUUSD', filledOnSaturday)

      assert.equal(sent.length, 2, 'open + fill — fills are never suppressed by market-closed, only new signals')
      assert.equal(sent[1].text, '<code>🟡 ENTRY FILLED</code>')
    } finally {
      restore()
    }
  })

  await t.test('a pending SELL survives its own resistance breaking, and only fills once a later candle genuinely retests + closes confirming it', async () => {
    // Reproduces a real production bug: a SELL entry sits right at a resistance level,
    // so price reaching that entry (rallying up to it) and price breaking that same
    // resistance (closing above it) are, for a level right at the fill point, often
    // the very same candle. recordSignals used to drop a still-`pending` record
    // whenever its level no longer matched any of the tick's fresh signals (the broken
    // resistance flips to a different category, RBS) — before evaluateSignals ever got
    // a chance to mark the fill, silently vanishing a signal that, from the price
    // action, plainly did fill. recordSignals now takes currentPrice and skips that
    // drop for a pending record whose own entry currentPrice already shows was reached
    // (see its own comment) — the record survives either way.
    //
    // What evaluateSignals then does with it changed in the 2026-08-17 win-rate review,
    // though: a bare touch is no longer enough to fill (see FILL_CANDLE_SKIP_ATR_MULT /
    // close-confirmation in signalHistoryCore.js) — a candle that closes decisively
    // *through* the level is a breakout continuing, not a held retest, so it correctly
    // stays pending rather than confirm-filling off it. Only a later candle that
    // touches the entry and closes back on the favorable side actually fills it.
    const { restore } = mockTelegram()
    try {
      const base = seriesWithHighPivot(4300) // forms a Resistance pivot
      const weekday = Date.UTC(2026, 7, 12, 12, 0, 0) // Wednesday — market open
      const openSeries = { H1: base.map((c, i) => ({ ...c, time: weekday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', openSeries)

      const pending = history.find((r) => r.tf === 'H1' && r.direction === 'sell')
      assert.ok(pending, 'expected a pending SELL off the resistance pivot')

      // Two consecutive closes above the resistance both break it (flips it to RBS in
      // detectLevels' state machine — BREAKOUT_CONFIRM_BARS needs 2 consecutive closes
      // beyond threshold, a different category/key entirely) and reach the sell entry
      // itself (breaking a resistance means closing above it) — but neither closes back
      // down, so this is a breakout continuing, not a held retest. Kept within the
      // pending record's own SL (a few points above entry) rather than blowing past it —
      // once price is past its own SL without ever confirming a fill, the record is
      // correctly dropped as invalidated instead (see the SL-guard test in
      // signalHistoryCore.test.mjs); this test is specifically about the narrower,
      // still-in-play case.
      const breakoutTime = weekday + openSeries.H1.length * 3600000
      const breakoutClose = pending.entry + 2
      let series = [
        ...openSeries.H1,
        candle(breakoutTime, breakoutClose - 2, breakoutClose + 3, breakoutClose - 3, breakoutClose),
        candle(breakoutTime + 3600000, breakoutClose, breakoutClose + 4, breakoutClose - 1, breakoutClose + 1),
      ]
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: series })

      let record = history.find((r) => r.key === pending.key)
      assert.ok(record, 'the original record must still exist — not silently dropped')
      assert.equal(record.status, 'pending', 'a candle that closes through the level, not back down, is not a held retest yet')

      // A later candle retests the level (touches above entry) and closes back down
      // exactly on it — a genuine held retest, confirms the fill. Closing exactly on
      // entry (not below) also keeps recordSignals' own "already reached" guard tested
      // above satisfied (>= entry), so this candle alone covers both mechanisms.
      const retestTime = breakoutTime + 2 * 3600000
      series = [...series, candle(retestTime, pending.entry - 1, pending.entry + 1, pending.entry - 2, pending.entry)]
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: series })

      record = history.find((r) => r.key === pending.key)
      assert.equal(record.status, 'running', 'a later candle that touches entry and closes back below it confirms the fill')
    } finally {
      restore()
    }
  })

  await t.test('sends new-signal notifications for BTCUSD on a weekday too (no longer weekend-only)', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(60000, 20)
      const weekday = Date.UTC(2026, 7, 12, 12, 0, 0) // Wednesday
      const weekdaySeries = { H1: base.map((c, i) => ({ ...c, time: weekday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'BTCUSD', weekdaySeries)
      assert.ok(sent.length > 0, 'BTCUSD signals now post on weekdays too')
    } finally {
      restore()
    }
  })

  await t.test('sends new-signal notifications for BTCUSD on the weekend', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(60000, 20)
      const saturday = Date.UTC(2026, 7, 15, 12, 0, 0) // Saturday
      const weekendSeries = { H1: base.map((c, i) => ({ ...c, time: saturday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'BTCUSD', weekendSeries)
      assert.ok(sent.length > 0, 'BTCUSD signals do post on the weekend')
    } finally {
      restore()
    }
  })

  await t.test('still notifies BTCUSD fills/closes on a weekday', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(60000, 20)
      const saturday = Date.UTC(2026, 7, 15, 12, 0, 0)
      const openSeries = { H1: base.map((c, i) => ({ ...c, time: saturday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'BTCUSD', openSeries) // opens on the weekend

      const h1 = history.find((r) => r.tf === 'H1')
      const monday = Date.UTC(2026, 7, 17, 12, 0, 0) // Monday — back to a weekday
      const filledOnMonday = { H1: [...openSeries.H1, candle(monday, h1.entry, h1.entry + 1, h1.entry - 1, h1.entry)] }
      await updateSignalHistoryForSymbol(history, 'BTCUSD', filledOnMonday)

      assert.equal(sent.length, 2, 'open (weekend) + fill (weekday)')
      assert.equal(sent[1].text, '<code>🟡 ENTRY FILLED</code>')
    } finally {
      restore()
    }
  })
})

// Regression test for a real production bug: a real, older Support pivot survived a
// frozen (closed-market) tail (see srDetector.test.mjs), but the signal built from it
// still sized its SL off the *current* ATR — computed from that same frozen tail — so
// even a genuinely real level got a razor-thin SL and an absurd ~30R "reward". Neither
// the dashboard nor the shared track record should ever record a signal like that.
test('updateSignalHistoryForSymbol: never records/notifies a signal built on stagnant (frozen-tail) data', async (t) => {
  function frozenCandles(base, count, startTime) {
    const candles = []
    for (let i = 0; i < count; i++) {
      const jitter = (i % 2 === 0 ? 1 : -1) * 0.05
      candles.push(candle(startTime + i, base, base + 0.2, base - 0.2, base + jitter))
    }
    return candles
  }

  await t.test('a real pivot behind a long frozen tail still produces no signals (SL sizing off frozen-tail ATR would be nonsense)', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const real = seriesWithLowPivot(4300) // a genuine Support pivot at 4301
      const tail = frozenCandles(4303, 30, real.length) // near-frozen, as a closed market would return
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: [...real, ...tail] })
      assert.equal(sent.length, 0, 'no new-signal Telegram post')
      assert.equal(history.length, 0, 'no pending/running record added to the shared track record')
    } finally {
      restore()
    }
  })

  await t.test('once price is moving again (no frozen tail), the same real pivot does produce a signal', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: seriesWithLowPivot(4300) })
      assert.equal(sent.length, 1)
      assert.equal(history.length, 1)
    } finally {
      restore()
    }
  })
})

test('updateSignalHistoryForSymbol: withholds new signals in a window straddling high-impact USD news', async (t) => {
  await t.test('a high-impact USD event at the data\'s own current time suppresses new signal formation', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const series = seriesWithLowPivot(4300) // a genuine Support pivot
      const currentTime = series.at(-1).time
      const calendar = [{ country: 'USD', impact: 'High', date: new Date(currentTime).toISOString() }]
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: series }, calendar)
      assert.equal(sent.length, 0, 'no new-signal Telegram post during the news window')
      assert.equal(history.length, 0, 'no pending record added during the news window')
    } finally {
      restore()
    }
  })

  await t.test('omitting calendar entirely (the default) behaves exactly as before — no gate applied', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: seriesWithLowPivot(4300) })
      assert.equal(sent.length, 1)
      assert.equal(history.length, 1)
    } finally {
      restore()
    }
  })

  await t.test('a high-impact event well outside the window does not suppress anything', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const series = seriesWithLowPivot(4300)
      const currentTime = series.at(-1).time
      const calendar = [{ country: 'USD', impact: 'High', date: new Date(currentTime + 6 * 60 * 60 * 1000).toISOString() }]
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', { H1: series }, calendar)
      assert.equal(sent.length, 1)
      assert.equal(history.length, 1)
    } finally {
      restore()
    }
  })
})

test('toTwelveDataDatetime / parseUtc round-trip', async (t) => {
  await t.test('toTwelveDataDatetime formats a UTC epoch as "YYYY-MM-DD HH:mm:ss"', () => {
    const ms = Date.UTC(2026, 7, 15, 9, 5, 3) // 2026-08-15 09:05:03 UTC
    assert.equal(toTwelveDataDatetime(ms), '2026-08-15 09:05:03')
  })

  await t.test('pads single-digit month/day/hour/minute/second', () => {
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5) // 2026-01-02 03:04:05 UTC
    assert.equal(toTwelveDataDatetime(ms), '2026-01-02 03:04:05')
  })

  await t.test('parseUtc parses that exact format back to the same epoch ms', () => {
    const ms = Date.UTC(2026, 7, 15, 9, 5, 3)
    assert.equal(parseUtc(toTwelveDataDatetime(ms)), ms)
  })

  await t.test('parseUtc treats a date-only string ("YYYY-MM-DD", as D1 candles use) as UTC midnight', () => {
    assert.equal(parseUtc('2026-08-15'), Date.UTC(2026, 7, 15, 0, 0, 0))
  })

  await t.test('parseUtc never drifts by the host machine\'s own timezone offset (the bug a naive `new Date(str)` would have)', () => {
    // If this used `new Date(datetime)` directly (no explicit 'Z'), a naive string
    // with no offset parses as *local* time — on a host west of UTC that silently
    // shifts every candle's timestamp, and can even make "ago" math go negative.
    const ms = parseUtc('2026-08-15 00:00:00')
    assert.equal(new Date(ms).getUTCHours(), 0, 'must land on UTC midnight regardless of the host TZ')
  })
})

test('toCandles', async (t) => {
  await t.test('parses datetime + OHLC strings/numbers into numeric candle objects', () => {
    const values = [{ datetime: '2026-08-15 09:00:00', open: '4300.5', high: '4310', low: '4295.2', close: '4305' }]
    const candles = toCandles(values)
    assert.equal(candles.length, 1)
    assert.equal(candles[0].time, Date.UTC(2026, 7, 15, 9, 0, 0))
    assert.equal(candles[0].open, 4300.5)
    assert.equal(candles[0].high, 4310)
    assert.equal(candles[0].low, 4295.2)
    assert.equal(candles[0].close, 4305)
  })

  await t.test('preserves input order and handles an empty array', () => {
    assert.deepEqual(toCandles([]), [])
    const values = [
      { datetime: '2026-08-15 09:00:00', open: 1, high: 2, low: 0, close: 1 },
      { datetime: '2026-08-15 10:00:00', open: 1, high: 2, low: 0, close: 1 },
    ]
    const candles = toCandles(values)
    assert.ok(candles[0].time < candles[1].time)
  })

  await t.test('parses a numeric/string volume when present (BTCUSD, via fetchBinance)', () => {
    const values = [{ datetime: '2026-08-15 09:00:00', open: 1, high: 2, low: 0, close: 1, volume: '12.5' }]
    assert.equal(toCandles(values)[0].volume, 12.5)
  })

  await t.test('leaves volume undefined (not NaN/0) when the source has none at all (XAUUSD, via Twelve Data)', () => {
    const values = [{ datetime: '2026-08-15 09:00:00', open: 1, high: 2, low: 0, close: 1 }]
    assert.equal(toCandles(values)[0].volume, undefined)
  })
})

test('isNearHighImpactNews', async (t) => {
  const now = Date.UTC(2026, 7, 15, 12, 0, 0)

  await t.test('flags a high-impact USD event coming up shortly', () => {
    const calendar = [{ country: 'USD', impact: 'High', date: new Date(now + 10 * 60 * 1000).toISOString() }]
    assert.equal(isNearHighImpactNews(calendar, now), true)
  })

  await t.test('flags one that just happened, not only upcoming ones', () => {
    const calendar = [{ country: 'USD', impact: 'High', date: new Date(now - 10 * 60 * 1000).toISOString() }]
    assert.equal(isNearHighImpactNews(calendar, now), true)
  })

  await t.test('does not flag one outside the window either direction', () => {
    const calendar = [{ country: 'USD', impact: 'High', date: new Date(now + 45 * 60 * 1000).toISOString() }]
    assert.equal(isNearHighImpactNews(calendar, now), false)
  })

  await t.test('ignores a low/medium-impact event even inside the window', () => {
    const calendar = [{ country: 'USD', impact: 'Medium', date: new Date(now).toISOString() }]
    assert.equal(isNearHighImpactNews(calendar, now), false)
  })

  await t.test('ignores a high-impact event for a different country', () => {
    const calendar = [{ country: 'EUR', impact: 'High', date: new Date(now).toISOString() }]
    assert.equal(isNearHighImpactNews(calendar, now), false)
  })

  await t.test('case-insensitive on country/impact, matching findUpcomingHighImpact\'s own convention', () => {
    const calendar = [{ country: 'usd', impact: 'high', date: new Date(now).toISOString() }]
    assert.equal(isNearHighImpactNews(calendar, now), true)
  })

  await t.test('an unparseable date is skipped, not thrown', () => {
    const calendar = [{ country: 'USD', impact: 'High', date: 'not-a-date' }]
    assert.equal(isNearHighImpactNews(calendar, now), false)
  })

  await t.test('null/non-array calendar (fetch failed, no fallback available) reads as no news risk', () => {
    assert.equal(isNearHighImpactNews(null, now), false)
    assert.equal(isNearHighImpactNews(undefined, now), false)
  })
})

const DAY_MS = 24 * 60 * 60 * 1000

function closedRecord(overrides) {
  return {
    key: 'k',
    symbolKey: 'XAUUSD',
    tf: 'H1',
    category: 'Support',
    direction: 'buy',
    entry: 4300,
    sl: 4290,
    tp: [{ price: 4320, rr: 2 }],
    openedAt: 0,
    filledAt: 0,
    status: 'win',
    exitPrice: 4320,
    hitTpIndex: 0,
    closedAt: 0,
    ...overrides,
  }
}

function runningRecord(overrides) {
  return {
    key: 'k',
    symbolKey: 'XAUUSD',
    tf: 'H1',
    category: 'Support',
    direction: 'buy',
    entry: 4300,
    sl: 4290,
    tp: [{ price: 4320, rr: 2 }],
    openedAt: 0,
    filledAt: 0,
    status: 'running',
    ...overrides,
  }
}

test('buildDailyReportMessage', async (t) => {
  await t.test('returns null when neither symbol has any activity that day — no "nothing happened" spam', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0) // Tuesday
    assert.equal(buildDailyReportMessage([], dayStart), null)
  })

  await t.test('includes only the symbol that actually closed something, omitting the other entirely', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0)
    const history = [closedRecord({ symbolKey: 'XAUUSD', status: 'win', entry: 4300, exitPrice: 4320, closedAt: dayStart + 1000 })]
    const msg = buildDailyReportMessage(history, dayStart)
    assert.match(msg, /XAUUSD/)
    assert.doesNotMatch(msg, /BTCUSD/)
  })

  await t.test('the title has no emoji — just the bold "Daily Performance (date)" text', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0)
    const history = [closedRecord({ status: 'win', entry: 4300, exitPrice: 4320, closedAt: dayStart + 1000 })]
    const msg = buildDailyReportMessage(history, dayStart)
    assert.match(msg, /^<b>Daily Performance \(Tuesday, 11 Aug 2026\)<\/b>/)
    assert.doesNotMatch(msg, /📊/)
  })

  await t.test('a still-running signal is never shown — the report recaps only what actually closed', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0)
    const history = [runningRecord({ category: 'Resistance', direction: 'sell', entry: 4350 })]
    assert.equal(buildDailyReportMessage(history, dayStart), null, 'nothing closed that day, and a running signal alone is not "activity" for this report')
  })

  await t.test('lists closed trades with win\\/loss lines (no category, no "HIT", no "pips", whole numbers), arrows + numbers aligned, win rate, and net — no "Closed" heading at all', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0)
    const history = [
      closedRecord({ status: 'win', entry: 4300, exitPrice: 4320, hitTpIndex: 0, closedAt: dayStart + 1000 }),
      closedRecord({ status: 'loss', entry: 4300, exitPrice: 4290, closedAt: dayStart + 2000 }),
    ]
    const msg = buildDailyReportMessage(history, dayStart)
    assert.doesNotMatch(msg, /Closed/)
    assert.match(msg, /✅ BUY  @ 4300 → TP1 \+200/)
    assert.match(msg, /❌ BUY  @ 4300 → SL  -100/)
    assert.doesNotMatch(msg, /Support|HIT|pips/)
    assert.match(msg, /Win rate: 50% · Net: \+100/)
    assert.doesNotMatch(msg, /1W|1L/)
    assert.doesNotMatch(msg, /Win rate today/)
    assert.doesNotMatch(msg, /Running/)
  })

  await t.test('rounds prices and pip/dollar amounts to whole numbers, report-wide', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0)
    const history = [
      closedRecord({ symbolKey: 'BTCUSD', status: 'win', entry: 64036.61, exitPrice: 64919.95, hitTpIndex: 3, closedAt: dayStart + 1000 }),
    ]
    const msg = buildDailyReportMessage(history, dayStart)
    assert.match(msg, /✅ BUY  @ 64037 → TP4 \+883/, 'closed entry and $ amount both rounded, no decimal')
    assert.doesNotMatch(msg, /\.\d/, 'no decimal point anywhere in the message')
  })

  await t.test('right-aligns the pip/dollar number column, even when the label (TP1 vs SL) and the number\'s own width both differ', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0)
    const history = [
      // label "TP1" (3 chars), number "+2000" (5 chars)
      closedRecord({ status: 'win', entry: 4300, exitPrice: 4500, hitTpIndex: 0, closedAt: dayStart + 1000 }),
      // label "SL" (2 chars), number "-5" (2 chars) — both columns differ from the row above
      closedRecord({ status: 'loss', entry: 4300, exitPrice: 4299.5, closedAt: dayStart + 2000 }),
    ]
    const msg = buildDailyReportMessage(history, dayStart)
    const closedLines = msg
      .split('\n')
      .filter((line) => line.includes('→'))
      .map((line) => line.replace(/^<code>/, ''))
    assert.equal(closedLines.length, 2)
    // The number itself ends at the same column on both lines (right-aligned), even
    // though the label before it and the number's own digit count both differ.
    const endColumns = closedLines.map((line) => line.length)
    assert.equal(endColumns[0], endColumns[1], 'both lines end at the same column — the number is right-aligned within its column')
  })

  await t.test('aligns "@" in the same column for both BUY and SELL lines', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0)
    const history = [
      closedRecord({ direction: 'buy', status: 'win', entry: 4300, exitPrice: 4320, hitTpIndex: 0, closedAt: dayStart + 1000 }),
      closedRecord({ direction: 'sell', status: 'loss', entry: 4300, exitPrice: 4310, closedAt: dayStart + 2000 }),
    ]
    const msg = buildDailyReportMessage(history, dayStart)
    const atColumns = msg
      .split('\n')
      .filter((line) => line.includes('@'))
      .map((line) => line.replace(/^<code>/, '').indexOf('@'))
    assert.equal(atColumns.length, 2)
    assert.equal(atColumns[0], atColumns[1], '"@" lands in the same column for BUY and SELL alike')
  })


  await t.test('aligns the "→" in the same column across multiple closed-trade lines of different widths', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0)
    const history = [
      // Shorter left side: "✅ BUY  @ 4300"
      closedRecord({ status: 'win', entry: 4300, exitPrice: 4320, hitTpIndex: 0, closedAt: dayStart + 1000 }),
      // Longer left side (an extra price digit): "❌ SELL @ 64194"
      closedRecord({ direction: 'sell', status: 'loss', entry: 64194, exitPrice: 64310, closedAt: dayStart + 2000 }),
    ]
    const msg = buildDailyReportMessage(history, dayStart)
    // Strip the leading <code> tag before measuring — Telegram renders it as pure
    // formatting, not visible text, so the tag's own characters don't count toward
    // what a reader actually sees lined up.
    const closedLines = msg
      .split('\n')
      .filter((line) => line.includes('→'))
      .map((line) => line.replace(/^<code>/, ''))
    assert.equal(closedLines.length, 2)
    const arrowColumns = closedLines.map((line) => line.indexOf('→'))
    assert.equal(arrowColumns[0], arrowColumns[1], 'both arrows land in the same column despite differently-sized left sides')
  })

  await t.test('excludes records outside the day window and from other timeframes — treated the same as no activity', () => {
    const dayStart = wibTime(2026, 8, 11, 0, 0)
    const history = [
      closedRecord({ closedAt: dayStart - 1 }), // just before the window
      closedRecord({ closedAt: dayStart + DAY_MS }), // the exclusive end
      closedRecord({ tf: 'H4', closedAt: dayStart + 1000 }), // wrong timeframe, never posted to Telegram
    ]
    assert.equal(buildDailyReportMessage(history, dayStart), null)
  })
})

test('buildWeeklyReportMessage', async (t) => {
  await t.test('returns null when neither symbol closed anything all week — no "nothing happened" spam', () => {
    const weekStart = wibTime(2026, 8, 10, 0, 0) // Monday
    assert.equal(buildWeeklyReportMessage([], weekStart), null)
  })

  await t.test('includes only the symbol that actually closed something, omitting the other entirely', () => {
    const weekStart = wibTime(2026, 8, 10, 0, 0)
    const history = [closedRecord({ symbolKey: 'XAUUSD', status: 'win', entry: 4300, exitPrice: 4320, closedAt: weekStart + 1000 })]
    const msg = buildWeeklyReportMessage(history, weekStart)
    assert.match(msg, /XAUUSD/)
    assert.doesNotMatch(msg, /BTCUSD/)
  })

  await t.test('omits quiet days entirely (no placeholder line), and totals the days that had activity', () => {
    const weekStart = wibTime(2026, 8, 10, 0, 0) // Monday 10 Aug
    const history = [
      closedRecord({ status: 'win', entry: 4300, exitPrice: 4320, hitTpIndex: 0, closedAt: weekStart + 1000 }),
      closedRecord({ status: 'loss', entry: 4300, exitPrice: 4290, closedAt: weekStart + DAY_MS + 1000 }),
    ]
    const msg = buildWeeklyReportMessage(history, weekStart)
    assert.match(msg, /✅ Mon 10 Aug: \+200/)
    assert.match(msg, /❌ Tue 11 Aug: -100/)
    assert.doesNotMatch(msg, /Wed 12 Aug/)
    assert.doesNotMatch(msg, /No closed trades/)
    assert.doesNotMatch(msg, /pips/)
    assert.doesNotMatch(msg, /1W|1L|0W|0L/)
    assert.match(msg, /Win rate: 50% · Net: \+100/)
  })

  await t.test('right-aligns the daily net numbers so they line up despite differently-sized day labels', () => {
    const weekStart = wibTime(2026, 8, 10, 0, 0) // Monday 10 Aug
    const history = [
      // "Mon 10 Aug" vs "Sun 16 Aug" — same label length, but net widths differ (+2000 vs -5)
      closedRecord({ status: 'win', entry: 4300, exitPrice: 4500, hitTpIndex: 0, closedAt: weekStart + 1000 }),
      closedRecord({ status: 'loss', entry: 4300, exitPrice: 4299.5, closedAt: weekStart + 6 * DAY_MS + 1000 }),
    ]
    const msg = buildWeeklyReportMessage(history, weekStart)
    // Strip the leading <code> tag — Telegram renders it as pure formatting, not
    // visible text, so its own characters don't count toward what a reader sees lined up.
    const dayLines = msg
      .split('\n')
      .map((line) => line.replace(/^<code>/, ''))
      .filter((line) => /^[✅❌] (Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ Aug:/.test(line))
    assert.equal(dayLines.length, 2)
    assert.equal(dayLines[0].length, dayLines[1].length, 'both lines end at the same column — the net number is right-aligned')
  })

  await t.test('the header range covers the correct 7-day span', () => {
    const weekStart = wibTime(2026, 8, 10, 0, 0)
    const history = [closedRecord({ status: 'win', entry: 4300, exitPrice: 4320, closedAt: weekStart + 1000 })]
    const msg = buildWeeklyReportMessage(history, weekStart)
    assert.match(msg, /10 – 16 Aug 2026/)
  })
})

test('maybeSendDailyReport', async (t) => {
  await t.test('does nothing outside the 00:00-00:59 WIB hour', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const state = {}
      const result = await maybeSendDailyReport([], wibTime(2026, 8, 11, 12, 0), state)
      assert.equal(result, false)
      assert.equal(sent.length, 0)
      assert.equal(state.lastDailyReportDate, undefined)
    } finally {
      restore()
    }
  })

  await t.test('still sends on a late tick within the same hour (tolerates cron jitter/delay)', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const state = {}
      const history = [closedRecord({ status: 'win', entry: 4300, exitPrice: 4320, closedAt: wibTime(2026, 8, 10, 14, 0) })]
      const result = await maybeSendDailyReport(history, wibTime(2026, 8, 11, 0, 45), state)
      assert.equal(result, true)
      assert.equal(sent.length, 1)
    } finally {
      restore()
    }
  })

  await t.test('sends inside the window, reporting on yesterday (WIB) — only the symbol that had activity', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const state = {}
      const history = [
        closedRecord({
          status: 'win',
          entry: 4300,
          exitPrice: 4320,
          hitTpIndex: 0,
          closedAt: wibTime(2026, 8, 10, 14, 0), // Monday afternoon WIB
        }),
      ]
      // Tuesday 00:05 WIB -> reports on Monday (yesterday), a weekday
      const result = await maybeSendDailyReport(history, wibTime(2026, 8, 11, 0, 5), state)
      assert.equal(result, true)
      // ONE Telegram call, not a separate text message followed by a separate image —
      // the report text is the photo's own caption, same as the weekly report.
      assert.equal(sent.length, 1)
      const form = sent[0]
      assert.match(form.get('caption'), /XAUUSD/)
      assert.doesNotMatch(form.get('caption'), /BTCUSD/)
      assert.match(form.get('caption'), /TP1 \+200/)
      assert.equal(form.get('parse_mode'), 'HTML')
      assert.ok(form.get('photo'), 'a real image file, not just text')
      assert.equal(state.lastDailyReportDate, '2026-08-11')
    } finally {
      restore()
    }
  })

  await t.test('nothing happened yesterday — state still advances (no re-check this hour), but no message is sent', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const state = {}
      const result = await maybeSendDailyReport([], wibTime(2026, 8, 10, 0, 5), state) // Monday 00:05 WIB
      assert.equal(result, true, 'state changed even though nothing was sent')
      assert.equal(sent.length, 0)
      assert.equal(state.lastDailyReportDate, '2026-08-10')
    } finally {
      restore()
    }
  })

  await t.test('does not send twice for the same WIB day, even if called again inside the window', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const state = { lastDailyReportDate: '2026-08-11' }
      const result = await maybeSendDailyReport([], wibTime(2026, 8, 11, 0, 10), state)
      assert.equal(result, false)
      assert.equal(sent.length, 0)
    } finally {
      restore()
    }
  })
})

test('maybeSendWeeklyReport', async (t) => {
  await t.test('does nothing on a non-Monday, even inside the daily window', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const state = {}
      const result = await maybeSendWeeklyReport([], wibTime(2026, 8, 11, 0, 5), state) // Tuesday
      assert.equal(result, false)
      assert.equal(sent.length, 0)
    } finally {
      restore()
    }
  })

  await t.test('sends on Monday inside the window as ONE photo: report text as its caption', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const state = {}
      const history = [
        closedRecord({
          symbolKey: 'BTCUSD',
          status: 'win',
          entry: 63000,
          exitPrice: 64200,
          hitTpIndex: 0,
          closedAt: wibTime(2026, 8, 8, 10, 0), // the Saturday of the week just finished
        }),
      ]
      const result = await maybeSendWeeklyReport(history, wibTime(2026, 8, 10, 0, 5), state) // Monday 00:05 WIB
      assert.equal(result, true)
      assert.equal(state.lastWeeklyReportDate, '2026-08-10')

      // ONE Telegram call, not a separate text message followed by a separate image —
      // the report text is the photo's own caption.
      assert.equal(sent.length, 1)
      const form = sent[0]
      assert.match(form.get('caption'), /Weekly Performance/)
      assert.match(form.get('caption'), /BTCUSD/)
      assert.match(form.get('caption'), /\+1200/)
      assert.equal(form.get('parse_mode'), 'HTML')

      const perfFile = form.get('photo')
      assert.equal(perfFile.name, 'weekly-performance.png')
      // A real PNG, not a placeholder — starts with the PNG magic bytes.
      const perfBytes = Buffer.from(await perfFile.arrayBuffer())
      assert.deepEqual(perfBytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    } finally {
      restore()
    }
  })

  await t.test('sends nothing at all (no text, no chart) when nothing closed all week', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const state = {}
      const result = await maybeSendWeeklyReport([], wibTime(2026, 8, 10, 0, 5), state)
      assert.equal(result, true, 'state still advances so this Monday is not re-checked all hour')
      assert.equal(sent.length, 0)
      assert.equal(state.lastWeeklyReportDate, '2026-08-10')
    } finally {
      restore()
    }
  })

  await t.test('does not send twice for the same Monday', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const state = { lastWeeklyReportDate: '2026-08-10' }
      const result = await maybeSendWeeklyReport([], wibTime(2026, 8, 10, 0, 10), state)
      assert.equal(result, false)
      assert.equal(sent.length, 0)
    } finally {
      restore()
    }
  })
})

test('main()', async (t) => {
  const goldValues = (base) =>
    Array.from({ length: 20 }, (_, i) => ({
      datetime: toTwelveDataDatetime(Date.now() - (20 - i) * 3600000),
      open: base + i,
      high: base + i + 1,
      low: base + i - 1,
      close: base + i + 0.5,
    }))
  const binanceKlines = (base) =>
    Array.from({ length: 20 }, (_, i) => [Date.now() - (20 - i) * 3600000, base + i, base + i + 1, base + i - 1, base + i + 0.5])

  // Routes every URL main() actually calls to controlled fixture data — Twelve Data
  // (gold), Binance.US (BTC), and the ForexFactory-style calendar feed — so a real
  // run-through of main() never touches the real network.
  function mockAllSources() {
    const original = global.fetch
    global.fetch = async (url) => {
      const u = String(url)
      if (u.includes('api.telegram.org')) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }
      }
      if (u.includes('api.twelvedata.com')) {
        return { ok: true, json: async () => ({ status: 'ok', values: goldValues(4300) }) }
      }
      if (u.includes('api.binance.us')) {
        return { ok: true, json: async () => binanceKlines(63000) }
      }
      if (u.includes('ff_calendar_thisweek')) {
        return { ok: true, json: async () => [] }
      }
      throw new Error(`unexpected fetch in main() test: ${u}`)
    }
    return () => (global.fetch = original)
  }

  await t.test('a full run writes a readable signal-history.json and does not throw', async () => {
    // FAILURES/FAILURE_LABELS are module-level state that persists across this whole
    // test file — an earlier, unrelated test (fetchWithFallback's own failure test)
    // can leave a stale entry sitting there, which would make main()'s own
    // `if (FAILURES.length)` branch fire for real and write to the real, shared
    // data/last-alert.json. Reset first, and back that file up too just in case.
    resetFailures()
    await withBackedUpHistoryFile(async () => {
      await withClearAlertState(async () => {
        await withClearReportState(async () => {
          const restoreFetch = mockAllSources()
          const savedKey = process.env.TWELVE_DATA_API_KEY
          process.env.TWELVE_DATA_API_KEY = 'test-key'
          try {
            await assert.doesNotReject(() => main())
            const written = JSON.parse(await readFile(REAL_HISTORY_PATH, 'utf8'))
            assert.ok(Array.isArray(written), 'signal-history.json must still be a JSON array afterward')
          } finally {
            restoreFetch()
            process.env.TWELVE_DATA_API_KEY = savedKey
          }
        })
      })
    })
  })

  await t.test('throws immediately when TWELVE_DATA_API_KEY is not set, before touching the network', async () => {
    const savedKey = process.env.TWELVE_DATA_API_KEY
    delete process.env.TWELVE_DATA_API_KEY
    const restoreFetch = mockAllSources()
    try {
      await assert.rejects(() => main(), /TWELVE_DATA_API_KEY/)
    } finally {
      restoreFetch()
      process.env.TWELVE_DATA_API_KEY = savedKey
    }
  })
})
