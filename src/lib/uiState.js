const STORAGE_KEY = 'gold-sr-ui-state'

export function loadUiState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}
  } catch {
    return {}
  }
}

// Merges into whatever's already stored so callers can save one field (e.g. just
// the theme) without clobbering the others (e.g. the last-viewed symbol/timeframe).
export function saveUiState(partial) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadUiState(), ...partial }))
  } catch {
    // storage unavailable — the choice just won't persist, harmless
  }
}
