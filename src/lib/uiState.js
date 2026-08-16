const STORAGE_KEY = 'gold-sr-ui-state'

export function loadUiState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY))
    // Guard against valid-but-wrong-shaped JSON (a stray primitive or array somehow
    // stored under this key) — spreading a non-object in saveUiState below would
    // silently discard it, so this is treated the same as "nothing saved" up front
    // rather than passing an unverified shape on to callers.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
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
