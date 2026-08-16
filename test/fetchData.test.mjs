import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

// This module has top-level env-var reads inside its functions (not at import time),
// so setting them before import is enough — no need to mock process.env per-test.
process.env.TELEGRAM_BOT_TOKEN = 'fake-token'
process.env.TELEGRAM_CHAT_ID = '-100public'
process.env.TELEGRAM_PERSONAL_CHAT_ID = '999personal'

const {
  buildNewSignalMessage,
  buildFillMessage,
  buildCloseMessage,
  updateSignalHistoryForSymbol,
  notifyNewSignals,
  notifyFilledSignals,
  notifyClosedSignals,
  withRetry,
  fetchWithFallback,
  sendTelegramMessage,
  sendAdminAlert,
  sendAdminAlertDeduped,
  getFailures,
  resetFailures,
  toTwelveDataDatetime,
  parseUtc,
  toCandles,
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

// Intercepts calls to api.telegram.org and records them instead of hitting the network.
// Any other fetch() call (e.g. a real fallback snapshot fetch) is left to a caller-
// supplied handler so each test controls exactly what "the network" does.
function mockTelegram(otherHandler) {
  const sent = []
  const original = global.fetch
  global.fetch = async (url, opts) => {
    if (String(url).includes('api.telegram.org')) {
      const body = JSON.parse(opts.body)
      const messageId = sent.length + 1
      sent.push(body)
      return { ok: true, json: async () => ({ ok: true, result: { message_id: messageId } }) }
    }
    if (otherHandler) return otherHandler(url, opts)
    throw new Error(`unexpected fetch: ${url}`)
  }
  return { sent, restore: () => (global.fetch = original) }
}

function candle(t, o, h, l, c) {
  return { time: t, open: o, high: h, low: l, close: c }
}

function seriesWithLowPivot(base) {
  const candles = []
  let t = 0
  for (let i = 0; i < 10; i++) candles.push(candle(t++, base + 5, base + 6, base + 4, base + 5))
  candles.push(candle(t++, base + 1, base + 2, base - 5, base + 1))
  for (let i = 0; i < 5; i++) candles.push(candle(t++, base + 3, base + 4, base + 2, base + 3))
  for (let i = 0; i < 20; i++) candles.push(candle(t++, base + 3, base + 5, base + 2, base + 4))
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
    assert.match(buyMsg, /^🔵 BUY LIMIT/)
    assert.doesNotMatch(buyMsg, /<b>/)
    assert.doesNotMatch(buyMsg, /H1/)

    const sellMsg = buildNewSignalMessage('XAUUSD', [{ ...buySignal, direction: 'sell' }])
    assert.match(sellMsg, /^🔴 SELL LIMIT/)
  })

  await t.test('flags a Golden Zone (Strong) confluence level in the title and zone line', () => {
    const strong = { tf: 'H1', direction: 'buy', category: 'Support', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Strong' }
    const msg = buildNewSignalMessage('XAUUSD', [strong])
    assert.match(msg, /⭐ Golden Zone/)
    assert.match(msg, /Zone: Support \(Strong\)/)
  })

  await t.test('a non-golden level shows Medium and no star', () => {
    const medium = { tf: 'H1', direction: 'buy', category: 'Support', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Medium' }
    const msg = buildNewSignalMessage('XAUUSD', [medium])
    assert.doesNotMatch(msg, /⭐/)
    assert.match(msg, /Zone: Support \(Medium\)/)
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
    assert.match(msg, /Price: 4301\n/)
    assert.match(msg, /SL: 4296\.5/)
    assert.match(msg, /TP1: 4307\.8 \(1\.5R\)/)
    assert.match(msg, /TP2: 4312\.3 \(2\.5R\)/)
  })

  await t.test('a multi-member group uses the earliest timeframe (TF_ORDER) as primary', () => {
    const h4 = { tf: 'H4', direction: 'buy', category: 'Support', entry: 999, sl: 990, tp: [], strengthLabel: 'Medium' }
    const h1 = { tf: 'H1', direction: 'buy', category: 'Support', entry: 4301, sl: 4296.5, tp: [], strengthLabel: 'Medium' }
    const msg = buildNewSignalMessage('XAUUSD', [h4, h1]) // passed out of order on purpose
    assert.match(msg, /Price: 4301/, 'H1 (earlier in TF_ORDER) should be used, not H4')
  })
})

test('buildFillMessage', () => {
  assert.equal(buildFillMessage(), '🟡 ENTRY FILLED')
})

test('buildCloseMessage', async (t) => {
  await t.test('a win: green check, TP index + 1, pips, single line, no bold/price/symbol', () => {
    const record = { direction: 'buy', status: 'win', hitTpIndex: 0, entry: 4301, exitPrice: 4307.75 }
    const msg = buildCloseMessage('XAUUSD', record)
    assert.equal(msg, '✅ TP1 HIT +68 pips')
  })

  await t.test('a win crediting a farther TP shows the right index', () => {
    const record = { direction: 'buy', status: 'win', hitTpIndex: 1, entry: 4301, exitPrice: 4312.25 }
    const msg = buildCloseMessage('XAUUSD', record)
    assert.match(msg, /^✅ TP2 HIT/)
  })

  await t.test('a loss: red cross, negative pips', () => {
    const record = { direction: 'buy', status: 'loss', entry: 4301, exitPrice: 4296.5 }
    const msg = buildCloseMessage('XAUUSD', record)
    assert.equal(msg, '❌ SL HIT -45 pips')
  })

  await t.test('a sell result flips the sign correctly', () => {
    const win = { direction: 'sell', status: 'win', hitTpIndex: 0, entry: 4400, exitPrice: 4359 }
    assert.match(buildCloseMessage('XAUUSD', win), /^✅ TP1 HIT \+410 pips$/)
  })

  await t.test('BTCUSD (no pip convention) shows a raw $ move', () => {
    const record = { direction: 'buy', status: 'win', hitTpIndex: 0, entry: 65000, exitPrice: 66200 }
    assert.equal(buildCloseMessage('BTCUSD', record), '✅ TP1 HIT +1200.00')
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

test('sendTelegramMessage', async (t) => {
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

  await t.test('includes reply_to_message_id + allow_sending_without_reply only when replying', async () => {
    const { sent, restore } = mockTelegram()
    try {
      await sendTelegramMessage('a fresh message')
      await sendTelegramMessage('a reply', 42)
      assert.equal(sent[0].reply_to_message_id, undefined)
      assert.equal(sent[1].reply_to_message_id, 42)
      assert.equal(sent[1].allow_sending_without_reply, true)
    } finally {
      restore()
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
  await t.test("a signal that's real on H4 but doesn't exist on H1 never reaches Telegram (H1-only, per TELEGRAM_TIMEFRAMES)", async () => {
    const { sent, restore } = mockTelegram()
    try {
      // H1 is flat (no pivot at all -> no signal of its own), so currentPrice still
      // comes from H1, but the only actual signal this tick is on H4.
      // The high pivot's body lands at base-1 (see seriesWithHighPivot) — keep H1's flat
      // reference price safely below that, so the H4 resistance is legitimately still
      // above price (otherwise the wrong-side-of-price guard in buildSignals would
      // reject it too, for an unrelated reason).
      const seriesByTf = { H1: flatSeries(4290), H4: seriesWithHighPivot(4300) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', seriesByTf)
      assert.equal(sent.length, 0, 'an H4-only signal must never post, even though H1 (the reference price) is present')
      assert.ok(history.some((r) => r.tf === 'H4'), 'still tracked in the shared history')
      assert.equal(history.find((r) => r.tf === 'H4').telegramMessageId, undefined)
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
      assert.deepEqual(history, [], 'without a currentPrice reference (from H1), buildSignals produces nothing at all')
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

  await t.test('BTCUSD sends no new-signal message on a weekday, even for H1 (see the dedicated weekend-gating tests below)', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(60000)
      const weekday = Date.UTC(2026, 7, 12, 12, 0, 0) // Wednesday
      const seriesByTf = { H1: base.map((c, i) => ({ ...c, time: weekday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'BTCUSD', seriesByTf)
      assert.equal(sent.length, 0)
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
      assert.equal(sent[1].text, '🟡 ENTRY FILLED')
      assert.match(sent[2].text, /^✅ TP1 HIT/)
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
      assert.match(sent[0].text, /^❌ SL HIT/)
      assert.equal(sent[0].reply_to_message_id, 7)
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
      assert.equal(sent[1].text, '🟡 ENTRY FILLED')
    } finally {
      restore()
    }
  })

  await t.test('a pending SELL that fills exactly as its own resistance breaks is promoted, not silently dropped', async () => {
    // Reproduces a real production bug: a SELL entry sits right at a resistance level,
    // so price reaching that entry (rallying up to it) and price breaking that same
    // resistance (closing above it) are, for a level right at the fill point, often
    // the very same candle. recordSignals used to drop a still-`pending` record
    // whenever its level no longer matched any of the tick's fresh signals (the broken
    // resistance flips to a different category, RBS) — before evaluateSignals ever got
    // a chance to mark the fill, silently vanishing a signal that, from the price
    // action, plainly did fill. recordSignals now takes currentPrice and skips that
    // drop for a pending record whose own entry currentPrice already shows was reached
    // (see its own comment) — evaluateSignals then promotes it normally afterward.
    const { restore } = mockTelegram()
    try {
      const base = seriesWithHighPivot(4300) // forms a Resistance pivot
      const weekday = Date.UTC(2026, 7, 12, 12, 0, 0) // Wednesday — market open
      const openSeries = { H1: base.map((c, i) => ({ ...c, time: weekday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'XAUUSD', openSeries)

      const pending = history.find((r) => r.tf === 'H1' && r.direction === 'sell')
      assert.ok(pending, 'expected a pending SELL off the resistance pivot')

      // Next tick: a strong close well above the resistance both breaks it (flips it
      // to RBS in detectLevels' state machine, a different category/key entirely) and
      // reaches the sell entry itself (breaking a resistance means closing above it).
      const breakoutTime = weekday + openSeries.H1.length * 3600000
      const breakoutClose = pending.entry + 20
      const breakoutSeries = {
        H1: [
          ...openSeries.H1,
          candle(breakoutTime, breakoutClose - 2, breakoutClose + 3, breakoutClose - 3, breakoutClose),
        ],
      }
      await updateSignalHistoryForSymbol(history, 'XAUUSD', breakoutSeries)

      const record = history.find((r) => r.key === pending.key)
      assert.ok(record, 'the original record must still exist — not silently dropped')
      assert.notEqual(record.status, 'pending', 'must have been evaluated (running, or fell straight through to a close), not left behind')
    } finally {
      restore()
    }
  })

  await t.test('skips new-signal notifications for BTCUSD on a weekday (weekend-only, opposite of XAUUSD)', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(60000)
      const weekday = Date.UTC(2026, 7, 12, 12, 0, 0) // Wednesday
      const weekdaySeries = { H1: base.map((c, i) => ({ ...c, time: weekday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'BTCUSD', weekdaySeries)
      assert.equal(sent.length, 0, 'no new-signal message for BTCUSD on a weekday')
      assert.ok(history.length > 0, 'still tracked in the shared history')
    } finally {
      restore()
    }
  })

  await t.test('sends new-signal notifications for BTCUSD on the weekend', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(60000)
      const saturday = Date.UTC(2026, 7, 15, 12, 0, 0) // Saturday
      const weekendSeries = { H1: base.map((c, i) => ({ ...c, time: saturday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'BTCUSD', weekendSeries)
      assert.ok(sent.length > 0, 'BTCUSD signals do post on the weekend')
    } finally {
      restore()
    }
  })

  await t.test('still notifies BTCUSD fills/closes on a weekday, even though new signals are weekend-only', async () => {
    const { sent, restore } = mockTelegram()
    try {
      const base = seriesWithLowPivot(60000)
      const saturday = Date.UTC(2026, 7, 15, 12, 0, 0)
      const openSeries = { H1: base.map((c, i) => ({ ...c, time: saturday - (base.length - i) * 3600000 })) }
      const history = []
      await updateSignalHistoryForSymbol(history, 'BTCUSD', openSeries) // opens on the weekend

      const h1 = history.find((r) => r.tf === 'H1')
      const monday = Date.UTC(2026, 7, 17, 12, 0, 0) // Monday — back to a weekday
      const filledOnMonday = { H1: [...openSeries.H1, candle(monday, h1.entry, h1.entry + 1, h1.entry - 1, h1.entry)] }
      await updateSignalHistoryForSymbol(history, 'BTCUSD', filledOnMonday)

      assert.equal(sent.length, 2, 'open (weekend) + fill (weekday) — fills are never gated by the weekend-only rule')
      assert.equal(sent[1].text, '🟡 ENTRY FILLED')
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
