const NOTIFIED_KEY = 'gold-sr-notified-signals'
const RENOTIFY_MS = 30 * 60 * 1000 // don't repeat the same signal alert more than once per 30 min

function loadNotified() {
  try {
    return JSON.parse(localStorage.getItem(NOTIFIED_KEY)) || {}
  } catch {
    return {}
  }
}

function saveNotified(map) {
  localStorage.setItem(NOTIFIED_KEY, JSON.stringify(map))
}

export function notificationsSupported() {
  return typeof Notification !== 'undefined'
}

export function notificationPermission() {
  return notificationsSupported() ? Notification.permission : 'unsupported'
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported'
  return Notification.requestPermission()
}

// A pending order "fills" when price reaches its trigger side: a LIMIT waits for
// price to come back to a better level, a STOP waits for price to break through.
function wouldFill(signal, price) {
  const isBuy = signal.direction === 'buy'
  return signal.orderType === 'LIMIT'
    ? isBuy
      ? price <= signal.entry
      : price >= signal.entry
    : isBuy
      ? price >= signal.entry
      : price <= signal.entry
}

// Fires a browser notification the first time price would fill an active signal,
// then stays quiet on that same signal for RENOTIFY_MS so it doesn't spam every
// refresh cycle while price lingers past the trigger.
export function checkEntryAlerts(zonesByTimeframe, currentPrice) {
  if (notificationPermission() !== 'granted' || currentPrice == null) return

  const notified = loadNotified()
  const now = Date.now()

  for (const [tfKey, result] of Object.entries(zonesByTimeframe)) {
    for (const signal of result.signals ?? []) {
      const key = `${tfKey}:${signal.zoneType}:${signal.direction}:${signal.orderType}:${Math.round(signal.entry)}`
      if (!wouldFill(signal, currentPrice)) continue
      if (notified[key] && now - notified[key] < RENOTIFY_MS) continue

      notified[key] = now
      const label = `${signal.direction === 'buy' ? 'BUY' : 'SELL'} ${signal.orderType}`
      new Notification('Gold S/R alert', {
        body: `${tfKey} ${label} triggered near ${Math.round(signal.entry)}`,
        tag: key,
      })
    }
  }

  saveNotified(notified)
}
