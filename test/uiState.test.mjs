import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { setupDom, teardownDom } from '../test-helpers/setupDom.mjs'
import { loadUiState, saveUiState } from '../src/lib/uiState.js'

beforeEach(() => setupDom())
afterEach(() => teardownDom())

test('uiState', async (t) => {
  await t.test('loadUiState defaults to {} when nothing has been saved', () => {
    assert.deepEqual(loadUiState(), {})
  })

  await t.test('saveUiState persists a field, loadUiState reads it back', () => {
    saveUiState({ theme: 'dark' })
    assert.deepEqual(loadUiState(), { theme: 'dark' })
  })

  await t.test('saveUiState merges into existing state rather than replacing it', () => {
    saveUiState({ theme: 'dark' })
    saveUiState({ symbolKey: 'BTCUSD' })
    assert.deepEqual(loadUiState(), { theme: 'dark', symbolKey: 'BTCUSD' })
  })

  await t.test('a later save overwrites just the field it names', () => {
    saveUiState({ theme: 'dark', tab: 'H1' })
    saveUiState({ theme: 'light' })
    assert.deepEqual(loadUiState(), { theme: 'light', tab: 'H1' })
  })

  await t.test('corrupt stored JSON falls back to {} rather than throwing', () => {
    localStorage.setItem('gold-sr-ui-state', 'not json at all')
    assert.deepEqual(loadUiState(), {})
  })

  await t.test('a storage write failure is swallowed, not thrown', () => {
    const original = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      assert.doesNotThrow(() => saveUiState({ theme: 'dark' }))
    } finally {
      localStorage.setItem = original
    }
  })
})
