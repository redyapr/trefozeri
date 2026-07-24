const STORAGE_KEY = 'gold-sr-last-known'

// Snapshots the last successfully-fetched state per symbol so a cold start (or an
// offline reload) can show real data immediately instead of a blank "Loading..."
// while the network request is still in flight or failing.
export function saveLastKnown(symbolKey, zonesByTimeframe, currentPrice) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    all[symbolKey] = { zonesByTimeframe, currentPrice, savedAt: Date.now() }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Storage full/unavailable — worst case is just no offline snapshot to restore.
  }
}

export function loadLastKnown(symbolKey) {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return all[symbolKey] ?? null
  } catch {
    return null
  }
}
