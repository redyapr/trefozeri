// Read-only client for the shared signal track record: a JSON file the CI cron job
// (scripts/fetch-data.mjs) maintains and commits to the repo, exactly like the price
// quote snapshots — see .github/workflows/deploy.yml. Every visitor fetches the same
// file, so everyone sees the same track record instead of each browser building up
// its own private one. There is no client-side write path anymore: recording and
// evaluating signals only ever happens in the cron job.
import { getHistory as coreGetHistory, getStats as coreGetStats } from './signalHistoryCore.js'

const DATA_ENDPOINT = `${import.meta.env.BASE_URL}data`
// Cache-busts the static JSON so the browser doesn't keep serving a snapshot from
// before the last cron refresh.
const cacheBust = () => `?v=${Date.now()}`

let records = []

// Fetches the latest shared track record. Safe to call repeatedly (e.g. on every
// refresh cycle, alongside price data) — on failure it just keeps whatever was
// already loaded rather than wiping the display out over a transient network hiccup.
export async function loadHistory() {
  try {
    const res = await fetch(`${DATA_ENDPOINT}/signal-history.json${cacheBust()}`)
    if (!res.ok) throw new Error(`signal history fetch failed (${res.status})`)
    const json = await res.json()
    if (Array.isArray(json)) records = json
  } catch (err) {
    console.error('[signalHistory] failed to load shared track record', err)
  }
  return records
}

export function getHistory(symbolKey, tf) {
  return coreGetHistory(records, symbolKey, tf)
}

export function getStats(symbolKey, tf) {
  return coreGetStats(records, symbolKey, tf)
}
