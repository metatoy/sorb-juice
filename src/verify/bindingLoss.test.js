// bindingLoss.test.js — node:test suite for the P0 binding-loss detector.
//
// All fixtures are inline — no file I/O, no Playwright, no external deps.
// Zero LLM calls in the detect path.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectLost, buildBindingIndex } from './bindingLoss.js'

// ─── Shared fixture data ──────────────────────────────────────────────────────

// A minimal resolved.json-style array modelled on the sorb-demo fixture.
const BASE_RESOLVED = [
  { id: 'color.action.primary',       cssVar: '--color-action-primary',       value: '#0f65ef', tier: 'semantic',   type: 'color' },
  { id: 'color.action.primary-hover', cssVar: '--color-action-primary-hover', value: '#083884', tier: 'semantic',   type: 'color' },
  { id: 'color.text.primary',         cssVar: '--color-text-primary',         value: '#222222', tier: 'semantic',   type: 'color' },
  { id: 'button.radius',              cssVar: '--button-radius',              value: '4px',     tier: 'component',  type: 'dimension' },
  { id: 'button.primary.bg.default',  cssVar: '--button-primary-bg-default',  value: '#0f65ef', tier: 'component',  type: 'color' },
]

// A richer binding index: simulates what buildReverseIndex (sorbData.js) would produce
// after processing Button.sorb.json — cssVar → component names that use it.
const BUTTON_BINDING_INDEX = {
  '--color-action-primary':       ['Button'],
  '--color-action-primary-hover': ['Button'],
  '--color-text-primary':         ['Button', 'Heading'],
  '--button-radius':              ['Button'],
  '--button-primary-bg-default':  ['Button'],
}

// Convenience: resolved map derived from BASE_RESOLVED.
const baseMap = Object.fromEntries(BASE_RESOLVED.map(t => [t.cssVar, t.value]))

// ─── buildBindingIndex helper ─────────────────────────────────────────────────

describe('buildBindingIndex', () => {
  it('produces a cssVar → [tokenId] index from a resolved array', () => {
    const index = buildBindingIndex(BASE_RESOLVED)
    assert.deepEqual(index['--color-action-primary'], ['color.action.primary'])
    assert.deepEqual(index['--button-radius'], ['button.radius'])
    assert.equal(Object.keys(index).length, BASE_RESOLVED.length)
  })

  it('returns {} for non-array input', () => {
    assert.deepEqual(buildBindingIndex(null), {})
    assert.deepEqual(buildBindingIndex(undefined), {})
    assert.deepEqual(buildBindingIndex({}), {})
  })

  it('skips entries with missing cssVar', () => {
    const sparse = [{ id: 'x', value: 'y' }, { id: 'ok', cssVar: '--ok', value: 'z' }]
    const index = buildBindingIndex(sparse)
    assert.deepEqual(Object.keys(index), ['--ok'])
  })
})

// ─── detectLost — core scenarios ─────────────────────────────────────────────

describe('detectLost', () => {
  // Test 1: Rename — a cssVar disappears from the after map (simulating a token rename).
  it('Test 1: rename — detects a lost binding when a cssVar disappears after rename', () => {
    // Simulate renaming --color-action-primary → --color-cta-primary.
    const afterMap = { ...baseMap }
    delete afterMap['--color-action-primary']
    afterMap['--color-cta-primary'] = '#0f65ef' // the renamed cssVar

    const { lost, gained } = detectLost(baseMap, afterMap, BUTTON_BINDING_INDEX)

    // The old cssVar must be flagged as lost.
    assert.equal(lost.length, 1, 'expected exactly 1 lost binding')
    assert.equal(lost[0].cssVar, '--color-action-primary')
    assert.deepEqual(lost[0].components, ['Button'])
    assert.equal(lost[0].was, '#0f65ef')

    // The new cssVar must appear in gained.
    assert.ok(gained.some(g => g.cssVar === '--color-cta-primary'), 'renamed cssVar should be in gained')
  })

  // Test 2: Delete — a token is simply removed with no replacement.
  it('Test 2: delete — detects a lost binding when a bound token is deleted entirely', () => {
    const afterMap = { ...baseMap }
    delete afterMap['--button-radius']
    // No replacement added.

    const { lost, gained } = detectLost(baseMap, afterMap, BUTTON_BINDING_INDEX)

    assert.equal(lost.length, 1)
    assert.equal(lost[0].cssVar, '--button-radius')
    assert.deepEqual(lost[0].components, ['Button'])
    assert.equal(lost[0].was, '4px')
    assert.equal(gained.length, 0, 'nothing was gained')
  })

  // Test 3: Add a new token — appears in gained, not in lost.
  it('Test 3: add — a brand-new cssVar appears only in gained, never in lost', () => {
    const afterMap = {
      ...baseMap,
      '--color-bg-page': '#f4f4f4', // new token not in before
    }

    const { lost, gained } = detectLost(baseMap, afterMap, BUTTON_BINDING_INDEX)

    assert.equal(lost.length, 0, 'nothing was lost')
    assert.equal(gained.length, 1)
    assert.equal(gained[0].cssVar, '--color-bg-page')
    assert.equal(gained[0].value, '#f4f4f4')
  })

  // Test 4: No change — empty lost + empty gained.
  it('Test 4: no change — both lost and gained are empty when maps are identical', () => {
    const { lost, gained } = detectLost(baseMap, { ...baseMap }, BUTTON_BINDING_INDEX)
    assert.equal(lost.length, 0)
    assert.equal(gained.length, 0)
  })

  // Test 5: Multiple tokens, one lost, rest stable.
  it('Test 5: partial loss — only the lost binding is reported when most tokens are stable', () => {
    // Remove only --color-text-primary; everything else stays.
    const afterMap = { ...baseMap }
    delete afterMap['--color-text-primary']

    const { lost, gained } = detectLost(baseMap, afterMap, BUTTON_BINDING_INDEX)

    assert.equal(lost.length, 1, 'exactly one loss expected')
    assert.equal(lost[0].cssVar, '--color-text-primary')
    // This token was bound to both Button and Heading in our fixture index.
    assert.deepEqual(lost[0].components, ['Button', 'Heading'])
    assert.equal(lost[0].was, '#222222')
    assert.equal(gained.length, 0)
  })

  // Edge: a removed cssVar that is NOT in the binding index is silently ignored.
  it('edge: removed unbound cssVar is not reported as lost', () => {
    const beforeMap = { ...baseMap, '--color-debug-only': 'hotpink' }
    // '--color-debug-only' is absent from BUTTON_BINDING_INDEX.
    const { lost } = detectLost(beforeMap, { ...baseMap }, BUTTON_BINDING_INDEX)
    assert.ok(!lost.some(l => l.cssVar === '--color-debug-only'), 'unbound removal should not appear in lost')
  })

  // Edge: gracefully handles null/undefined inputs.
  it('edge: null inputs produce empty results without throwing', () => {
    const { lost, gained } = detectLost(null, null, null)
    assert.deepEqual(lost, [])
    assert.deepEqual(gained, [])
  })
})
