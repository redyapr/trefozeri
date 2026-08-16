import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hexToRgba } from '../src/lib/priceChart.js'

// renderZoneChart/ZoneRectangle themselves need a real canvas + a lightweight-charts
// instance to exercise meaningfully — not worth a test-only canvas shim for this
// codebase's needs. hexToRgba is the one pure, easily-verifiable piece of logic in
// this module (see its own comment for why it's exported), so that's what's covered
// here — including the two edge cases this file's own review turned up.
test('hexToRgba', async (t) => {
  await t.test('parses a standard 6-digit hex color', () => {
    assert.equal(hexToRgba('#279058', 0.5), 'rgba(39, 144, 88, 0.5)')
  })

  await t.test('works without the leading #', () => {
    assert.equal(hexToRgba('279058', 0.5), 'rgba(39, 144, 88, 0.5)')
  })

  await t.test('expands the 3-digit shorthand form', () => {
    assert.equal(hexToRgba('#0f0', 1), 'rgba(0, 255, 0, 1)')
  })

  await t.test('falls back to gray instead of producing NaN channels for an unrecognized value', () => {
    assert.equal(hexToRgba('not-a-color', 0.5), 'rgba(128, 128, 128, 0.5)')
    assert.equal(hexToRgba('#zzzzzz', 0.5), 'rgba(128, 128, 128, 0.5)')
  })
})
