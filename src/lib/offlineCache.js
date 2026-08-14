// v3: bumped again — zones gained `atr`/`structureAnchor` (structural SL sizing).
// main.js reruns buildSignals() on every cached timeframe on each refresh, not just
// freshly-refetched ones (H4/D1 can go a while between refetches), so a v2 zone
// missing those fields would compute `undefined * x` -> NaN straight into the SL.
// Bumping the key makes a stale pre-v3 cache miss entirely and get replaced by a
// fresh fetch instead of being fed to code that expects the new shape.
const STORAGE_KEY = 'gold-sr-last-known-v3'

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
