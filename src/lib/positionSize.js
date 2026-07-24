const STORAGE_KEY = 'gold-sr-position-settings'

function loadAll() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}
  } catch {
    return {}
  }
}

// Balance/risk carry over sensibly across instruments, but unitsPerLot (contract
// size) is instrument-specific — 100oz/lot for gold vs. 1 BTC/lot for crypto are
// wildly different numbers, so settings are namespaced per symbol.
export function loadPositionSettings(symbol) {
  const defaults = { balance: 10000, riskPercent: 1, unitsPerLot: symbol.unitsPerLot }
  return { ...defaults, ...loadAll()[symbol.key] }
}

export function savePositionSettings(symbol, settings) {
  const all = loadAll()
  all[symbol.key] = settings
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

// Gold CFDs quote price in $/oz; a "lot" is a broker-defined number of ounces
// (100 for a standard lot, but mini/micro brokers vary, so it's configurable).
export function calculatePositionSize({ balance, riskPercent, unitsPerLot }, entry, sl) {
  const riskAmount = balance * (riskPercent / 100)
  const priceDistance = Math.abs(entry - sl)
  if (!priceDistance || !unitsPerLot) return { lots: 0, riskAmount }
  return { lots: riskAmount / (priceDistance * unitsPerLot), riskAmount }
}
