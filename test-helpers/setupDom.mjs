import { JSDOM } from 'jsdom'

// uiState.js and notifications.js both reach for `localStorage` (and
// notifications.js also `Notification`/`navigator`) only inside their function bodies,
// never at module-load time — so it's safe to import those modules normally and just
// make sure these globals exist before actually *calling* anything, rather than before
// the import itself.
//
// jsdom implements the Storage API (window.localStorage) but explicitly does not
// implement the Notification API — MockNotification below stands in for it, tracking
// what would have fired and what permission has been "granted" so far, closely enough
// to exercise notifications.js's own gating logic (isSupported/getPermission/isEnabled)
// and its fire() call site (checkZonesAndSignals) without a real browser.
export class MockNotification {
  static permission = 'default'
  static instances = []
  static requestResult = 'granted' // what requestPermission() resolves to when called

  static async requestPermission() {
    MockNotification.permission = MockNotification.requestResult
    return MockNotification.permission
  }

  constructor(title, options) {
    this.title = title
    this.options = options
    MockNotification.instances.push(this)
  }
}

export function setupDom() {
  const dom = new JSDOM('', { url: 'http://localhost/' })
  global.window = dom.window
  global.document = dom.window.document
  global.localStorage = dom.window.localStorage
  // Node has its own built-in `navigator` since v21 (a read-only getter on
  // globalThis) — a plain assignment throws, so this has to go through
  // defineProperty to actually replace it with jsdom's.
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  MockNotification.permission = 'default'
  MockNotification.instances = []
  MockNotification.requestResult = 'granted'
  global.Notification = MockNotification
  return dom
}

export function teardownDom() {
  global.window?.close?.()
  delete global.window
  delete global.document
  delete global.localStorage
  delete global.navigator
  delete global.Notification
}
