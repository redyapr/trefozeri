const STORAGE_KEY = 'gold-sr-position-settings'

const DEFAULTS = { balance: 10000, riskPercent: 1, unitsPerLot: 100 }

export function loadPositionSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePositionSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

// Gold CFDs quote price in $/oz; a "lot" is a broker-defined number of ounces
// (100 for a standard lot, but mini/micro brokers vary, so it's configurable).
export function calculatePositionSize({ balance, riskPercent, unitsPerLot }, entry, sl) {
  const riskAmount = balance * (riskPercent / 100)
  const priceDistance = Math.abs(entry - sl)
  if (!priceDistance || !unitsPerLot) return { lots: 0, riskAmount }
  return { lots: riskAmount / (priceDistance * unitsPerLot), riskAmount }
}
