// Browser push notifications for two events: price closing in on a S/R zone, and a
// new BUY/SELL LIMIT signal forming. Gated behind the Notification API's permission
// prompt plus a separate on/off flag (below) so a user can mute alerts again without
// having to revoke the browser permission itself.
const ENABLED_KEY = 'gold-sr-notify-enabled'

export function isSupported() {
  return typeof Notification !== 'undefined'
}

export function getPermission() {
  return isSupported() ? Notification.permission : 'unsupported'
}

export function isEnabled() {
  return isSupported() && Notification.permission === 'granted' && localStorage.getItem(ENABLED_KEY) !== 'off'
}

export async function enableNotifications() {
  if (!isSupported()) return false
  const permission =
    Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') return false
  localStorage.setItem(ENABLED_KEY, 'on')
  return true
}

export function disableNotifications() {
  localStorage.setItem(ENABLED_KEY, 'off')
}

async function fire(title, body, tag) {
  try {
    // Prefer the service worker route — Android Chrome refuses to construct
    // Notification directly from page script, only via a registration. Desktop
    // browsers support either; this just picks whichever is actually available.
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg?.showNotification) {
      reg.showNotification(title, { body, tag, icon: `${import.meta.env.BASE_URL}icon-192.png` })
    } else {
      new Notification(title, { body, tag })
    }
  } catch {
    // Permission revoked mid-session, or the platform doesn't support either route —
    // skip silently, there's no user-facing fallback for a notification that can't fire.
  }
}

// Per-symbol state: which zones currently count as "near" price and which signals are
// currently standing, so a 5-minute poll only fires on a *change* (price freshly
// entering a zone, a signal freshly appearing) instead of re-notifying every tick a
// condition happens to still hold.
const nearZonesBySymbol = {}
const signalKeysBySymbol = {}
// Skip notifying on each symbol's first snapshot after a page load or symbol switch —
// otherwise every zone/signal already standing at that moment would fire at once.
const seenSymbols = new Set()

// "Near" = within one breakout-threshold of the level — that threshold is already
// ATR-scaled per timeframe/instrument (see srDetector.js), so this self-calibrates
// instead of using one fixed price distance across H1/H4/D1 and gold/BTC alike.
const NEAR_ZONE_THRESHOLD_MULT = 1

const zoneKey = (tf, zone) => `${tf}-${zone.category}-${Math.round(zone.price)}`
const signalKey = (tf, signal) => `${tf}-${signal.category}-${signal.direction}`

export function checkZonesAndSignals(symbolKey, symbolLabel, zonesByTimeframe, currentPrice) {
  if (!isEnabled() || currentPrice == null) return

  const isFirstLook = !seenSymbols.has(symbolKey)
  seenSymbols.add(symbolKey)

  const prevNear = nearZonesBySymbol[symbolKey] ?? new Set()
  const nextNear = new Set()
  const prevSignals = signalKeysBySymbol[symbolKey] ?? new Set()
  const nextSignals = new Set()

  for (const [tf, result] of Object.entries(zonesByTimeframe)) {
    for (const zone of result.zones ?? []) {
      if (zone.distanceFromPrice > zone.threshold * NEAR_ZONE_THRESHOLD_MULT) continue
      const key = zoneKey(tf, zone)
      nextNear.add(key)
      if (!isFirstLook && !prevNear.has(key)) {
        fire(
          `${symbolLabel}: approaching ${zone.category}`,
          `${tf} ${zone.category} at ${Math.round(zone.price)} — price is ${Math.round(zone.distanceFromPrice)} away`,
          `zone-${symbolKey}-${key}`
        )
      }
    }

    for (const signal of result.signals ?? []) {
      const key = signalKey(tf, signal)
      nextSignals.add(key)
      if (!isFirstLook && !prevSignals.has(key)) {
        fire(
          `${symbolLabel} ${tf}: new ${signal.direction === 'buy' ? 'BUY' : 'SELL'} signal`,
          `${signal.category} ${signal.orderType} at ${Math.round(signal.entry)}`,
          `signal-${symbolKey}-${key}`
        )
      }
    }
  }

  nearZonesBySymbol[symbolKey] = nextNear
  signalKeysBySymbol[symbolKey] = nextSignals
}
