import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  setupDom,
  teardownDom,
  MockNotification,
  MockServiceWorkerRegistration,
  installMockServiceWorker,
  removeMockServiceWorker,
} from '../test-helpers/setupDom.mjs'
import {
  isSupported,
  getPermission,
  isEnabled,
  enableNotifications,
  disableNotifications,
  checkZonesAndSignals,
} from '../src/lib/notifications.js'

beforeEach(() => setupDom())
afterEach(() => teardownDom())

test('isSupported / getPermission', async (t) => {
  await t.test('supported and default permission when Notification exists', () => {
    assert.equal(isSupported(), true)
    assert.equal(getPermission(), 'default')
  })

  await t.test('reports unsupported when Notification does not exist at all', () => {
    delete global.Notification
    assert.equal(isSupported(), false)
    assert.equal(getPermission(), 'unsupported')
  })
})

test('isEnabled', async (t) => {
  await t.test('false before permission is ever granted', () => {
    assert.equal(isEnabled(), false)
  })

  await t.test('true once granted and not explicitly turned off', () => {
    MockNotification.permission = 'granted'
    assert.equal(isEnabled(), true)
  })

  await t.test('false if permission is granted but the user toggled the bell off', () => {
    MockNotification.permission = 'granted'
    disableNotifications()
    assert.equal(isEnabled(), false)
  })

  await t.test('false if permission was revoked even though the app-level flag says on', () => {
    MockNotification.permission = 'granted'
    disableNotifications()
    localStorage.setItem('gold-sr-notify-enabled', 'on')
    MockNotification.permission = 'denied'
    assert.equal(isEnabled(), false)
  })
})

test('enableNotifications', async (t) => {
  await t.test('requests permission and turns the flag on when granted', async () => {
    MockNotification.requestResult = 'granted'
    const result = await enableNotifications()
    assert.equal(result, true)
    assert.equal(isEnabled(), true)
  })

  await t.test('returns false and leaves the flag off when the user denies', async () => {
    MockNotification.requestResult = 'denied'
    const result = await enableNotifications()
    assert.equal(result, false)
    assert.equal(isEnabled(), false)
  })

  await t.test("doesn't re-prompt if permission was already decided — just re-syncs the flag", async () => {
    MockNotification.permission = 'granted'
    let promptCalls = 0
    const originalRequest = MockNotification.requestPermission
    MockNotification.requestPermission = async () => {
      promptCalls++
      return 'granted'
    }
    try {
      await enableNotifications()
      assert.equal(promptCalls, 0, 'permission was already "granted", not "default" — no new prompt needed')
      assert.equal(isEnabled(), true)
    } finally {
      MockNotification.requestPermission = originalRequest
    }
  })

  await t.test('returns false immediately when notifications are unsupported', async () => {
    delete global.Notification
    assert.equal(await enableNotifications(), false)
  })
})

// checkZonesAndSignals's fire() is async but called without awaiting it (fire-and-
// forget) — its `new Notification(...)` only actually runs after a microtask tick, so
// checking MockNotification.instances synchronously right after calling
// checkZonesAndSignals would race it. flush() lets that tick pass first.
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

test('checkZonesAndSignals', async (t) => {
  function enable() {
    MockNotification.permission = 'granted'
  }

  // checkZonesAndSignals keys its "seen before" / "was near" state by symbolKey in
  // module-level state that isn't reset between tests (there's no exported reset hook,
  // and adding one just for tests isn't worth it) — a fresh, never-before-seen
  // symbolKey per test case keeps them from leaking into each other.
  let symbolCounter = 0
  const freshSymbol = () => `TESTSYM${symbolCounter++}`

  await t.test('does nothing when notifications are disabled', async () => {
    const sym = freshSymbol()
    const zones = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 0, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, zones, 100)
    await flush()
    assert.equal(MockNotification.instances.length, 0)
  })

  await t.test('does nothing when currentPrice is null', async () => {
    enable()
    const sym = freshSymbol()
    const zones = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 0, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, zones, null)
    await flush()
    assert.equal(MockNotification.instances.length, 0)
  })

  await t.test("never fires on a symbol's first look, even if a zone is already near", async () => {
    enable()
    const sym = freshSymbol()
    const zones = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 0, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, zones, 100)
    await flush()
    assert.equal(MockNotification.instances.length, 0, 'first look establishes a baseline silently')
  })

  await t.test('fires once a zone newly comes within threshold on a later look', async () => {
    enable()
    const sym = freshSymbol()
    const far = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 50, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, far, 150) // first look, far away
    await flush()
    const near = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 2, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, near, 102) // second look, now near
    await flush()
    assert.equal(MockNotification.instances.length, 1)
    assert.match(MockNotification.instances[0].title, /approaching Support/)
  })

  await t.test('does not re-fire on a subsequent look while the zone is still near', async () => {
    enable()
    const sym = freshSymbol()
    const far = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 50, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, far, 150)
    await flush()
    const near = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 2, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, near, 102)
    await flush()
    checkZonesAndSignals(sym, sym, near, 102) // still near, third look
    await flush()
    assert.equal(MockNotification.instances.length, 1, 'only the transition into "near" fires, not every tick it holds')
  })

  await t.test('fires once a brand-new signal appears on a later look', async () => {
    enable()
    const sym = freshSymbol()
    const noSignal = { H1: { zones: [], signals: [] } }
    checkZonesAndSignals(sym, sym, noSignal, 100)
    await flush()
    const withSignal = {
      H1: { zones: [], signals: [{ category: 'Support', direction: 'buy', orderType: 'LIMIT', entry: 100 }] },
    }
    checkZonesAndSignals(sym, sym, withSignal, 100)
    await flush()
    assert.equal(MockNotification.instances.length, 1)
    assert.match(MockNotification.instances[0].title, /new BUY signal/)
  })

  await t.test('tracks near-zone/signal state per symbol independently', async () => {
    enable()
    const symA = freshSymbol()
    const symB = freshSymbol()
    const far = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 50, threshold: 5 }] } }
    checkZonesAndSignals(symA, symA, far, 150) // symA first look
    checkZonesAndSignals(symB, symB, far, 150) // symB first look — independent baseline
    await flush()
    const near = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 2, threshold: 5 }] } }
    checkZonesAndSignals(symA, symA, near, 102)
    await flush()
    assert.equal(MockNotification.instances.length, 1, 'only symA (which just had a real second look) should fire')
  })

  await t.test('checks every timeframe in zonesByTimeframe, not just the first', async () => {
    enable()
    const sym = freshSymbol()
    const far = {
      H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 50, threshold: 5 }] },
      H4: { zones: [{ category: 'Resistance', price: 200, distanceFromPrice: 50, threshold: 5 }] },
    }
    checkZonesAndSignals(sym, sym, far, 150)
    await flush()
    const near = {
      H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 2, threshold: 5 }] },
      H4: { zones: [{ category: 'Resistance', price: 200, distanceFromPrice: 2, threshold: 5 }] },
    }
    checkZonesAndSignals(sym, sym, near, 150)
    await flush()
    assert.equal(MockNotification.instances.length, 2, 'both H1 and H4 zones newly went near — both should fire')
    const titles = MockNotification.instances.map((n) => n.title)
    assert.ok(titles.some((t) => t.includes('Support')))
    assert.ok(titles.some((t) => t.includes('Resistance')))
  })

  await t.test('never fires once permission is denied, even with a real transition into "near"', async () => {
    const sym = freshSymbol()
    MockNotification.permission = 'denied'
    const far = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 50, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, far, 150)
    await flush()
    const near = { H1: { zones: [{ category: 'Support', price: 100, distanceFromPrice: 2, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, near, 102)
    await flush()
    assert.equal(MockNotification.instances.length, 0, 'isEnabled() is false while denied, so this is a no-op throughout')
  })

  await t.test('a zone identified by its pivot (startTime), not rounded price, so drift across a rounding boundary does not re-fire', async () => {
    enable()
    const sym = freshSymbol()
    const far = { H1: { zones: [{ category: 'Support', price: 99.6, startTime: 111, distanceFromPrice: 50, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, far, 150)
    await flush()
    const near = { H1: { zones: [{ category: 'Support', price: 99.6, startTime: 111, distanceFromPrice: 2, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, near, 102)
    await flush()
    assert.equal(MockNotification.instances.length, 1)
    // Same pivot (startTime), price only drifts slightly across the 99.6 -> 100.4
    // rounding boundary a plain Math.round-based key would have treated as "new".
    const stillDrifted = { H1: { zones: [{ category: 'Support', price: 100.4, startTime: 111, distanceFromPrice: 2, threshold: 5 }] } }
    checkZonesAndSignals(sym, sym, stillDrifted, 102)
    await flush()
    assert.equal(MockNotification.instances.length, 1, 'still the same pivot — no duplicate fire from the price crossing a rounding boundary')
  })

  await t.test('prefers the service worker route when a registration is available, instead of new Notification()', async () => {
    enable()
    installMockServiceWorker()
    try {
      const sym = freshSymbol()
      const noSignal = { H1: { zones: [], signals: [] } }
      checkZonesAndSignals(sym, sym, noSignal, 100)
      await flush()
      const withSignal = {
        H1: { zones: [], signals: [{ category: 'Support', direction: 'buy', orderType: 'LIMIT', entry: 100 }] },
      }
      checkZonesAndSignals(sym, sym, withSignal, 100)
      await flush()
      assert.equal(MockNotification.instances.length, 0, 'the service-worker route was available — new Notification() was not used')
      assert.equal(MockServiceWorkerRegistration.instances.length, 1)
      assert.match(MockServiceWorkerRegistration.instances[0].title, /new BUY signal/)
    } finally {
      removeMockServiceWorker()
    }
  })

  await t.test('a rejected showNotification() is swallowed, same as any other fire() failure', async () => {
    enable()
    installMockServiceWorker()
    MockServiceWorkerRegistration.shouldReject = true
    try {
      const sym = freshSymbol()
      const noSignal = { H1: { zones: [], signals: [] } }
      checkZonesAndSignals(sym, sym, noSignal, 100)
      await flush()
      const withSignal = {
        H1: { zones: [], signals: [{ category: 'Support', direction: 'buy', orderType: 'LIMIT', entry: 100 }] },
      }
      assert.doesNotThrow(() => checkZonesAndSignals(sym, sym, withSignal, 100))
      await flush()
      assert.equal(MockServiceWorkerRegistration.instances.length, 0, 'rejected before it could record itself as fired')
    } finally {
      removeMockServiceWorker()
    }
  })
})
