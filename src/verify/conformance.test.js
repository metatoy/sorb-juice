// conformance.test.js — node:test suite for the P1 conformance diff.
//
// All fixtures are inline — no file I/O, no Playwright, no external deps.
// Zero LLM calls in the diff path.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diffConformance, toDeclaredMap } from './conformance.js'

// ─── Shared fixture data ──────────────────────────────────────────────────────

// Flat declared map (cssVar → {value, tier, type}).
// Represents the design-system source-of-truth as declared in the DTCG set.
const DECLARED = {
  '--color-action-primary':      { value: '#0f65ef', tier: 'semantic',  type: 'color' },
  '--color-text-primary':        { value: '#222222', tier: 'semantic',  type: 'color' },
  '--color-blue-500':            { value: '#0f65ef', tier: 'primitive', type: 'color' },
  '--radius-control':            { value: '4px',     tier: 'semantic',  type: 'dimension' },
  '--button-radius':             { value: '4px',     tier: 'component', type: 'dimension' },
  '--button-primary-bg-default': { value: '#0f65ef', tier: 'component', type: 'color' },
}

// Matching resolved map (cssVar → value) — represents healthy production.
const RESOLVED_CLEAN = {
  '--color-action-primary':      '#0f65ef',
  '--color-text-primary':        '#222222',
  '--color-blue-500':            '#0f65ef',
  '--radius-control':            '4px',
  '--button-radius':             '4px',
  '--button-primary-bg-default': '#0f65ef',
}

// ─── Test 1: declared === resolved → empty drift ──────────────────────────────

describe('diffConformance', () => {
  it('Test 1: all tokens match → drifted/missing/extra all empty', () => {
    const result = diffConformance(DECLARED, RESOLVED_CLEAN)

    assert.equal(result.drifted.length, 0, 'expected no drift')
    assert.equal(result.missing.length, 0, 'expected no missing')
    assert.equal(result.extra.length, 0, 'expected no extra')
  })

  // ─── Test 2: one value drifted ──────────────────────────────────────────────

  it('Test 2: one token resolved to a different value → appears in drifted', () => {
    // Simulate production divergence: the running app renders a darker primary colour.
    const resolved = {
      ...RESOLVED_CLEAN,
      '--color-action-primary': '#083884', // drifted from declared #0f65ef
    }

    const result = diffConformance(DECLARED, resolved)

    assert.equal(result.drifted.length, 1, 'expected exactly 1 drifted token')
    const entry = result.drifted[0]
    assert.equal(entry.cssVar, '--color-action-primary')
    assert.equal(entry.declared, '#0f65ef')
    assert.equal(entry.resolved, '#083884')
    assert.equal(entry.tier, 'semantic')
    assert.equal(entry.type, 'color')

    assert.equal(result.missing.length, 0)
    assert.equal(result.extra.length, 0)
  })

  // ─── Test 3: declared token absent from resolved → missing ─────────────────

  it('Test 3: declared token not in resolved → appears in missing', () => {
    // Simulate a token that was declared but never shipped to the running app.
    const resolved = { ...RESOLVED_CLEAN }
    delete resolved['--button-radius']

    const result = diffConformance(DECLARED, resolved)

    assert.equal(result.missing.length, 1, 'expected 1 missing token')
    const entry = result.missing[0]
    assert.equal(entry.cssVar, '--button-radius')
    assert.equal(entry.declared, '4px')
    assert.equal(entry.tier, 'component')

    assert.equal(result.drifted.length, 0)
    assert.equal(result.extra.length, 0)
  })

  // ─── Test 4: extra cssVar in resolved not in declared ──────────────────────

  it('Test 4: resolved has cssVar not in declared → appears in extra', () => {
    // Simulate the app resolving an undeclared/experimental token.
    const resolved = {
      ...RESOLVED_CLEAN,
      '--color-debug-overlay': 'hotpink', // not in DECLARED
    }

    const result = diffConformance(DECLARED, resolved)

    assert.equal(result.extra.length, 1, 'expected 1 extra token')
    const entry = result.extra[0]
    assert.equal(entry.cssVar, '--color-debug-overlay')
    assert.equal(entry.resolved, 'hotpink')

    assert.equal(result.drifted.length, 0)
    assert.equal(result.missing.length, 0)
  })

  // ─── Test 5: mixed — drift + missing + extra ────────────────────────────────

  it('Test 5: mixed — drift + missing + extra all present together', () => {
    // Constructed scenario:
    //   drifted  : --color-action-primary resolved to wrong value
    //   missing  : --button-primary-bg-default not in resolved
    //   extra    : --color-bg-page appears in resolved but undeclared
    const resolved = {
      '--color-action-primary':      '#999999',   // drifted
      '--color-text-primary':        '#222222',   // correct
      '--color-blue-500':            '#0f65ef',   // correct
      '--radius-control':            '4px',       // correct
      '--button-radius':             '4px',       // correct
      // '--button-primary-bg-default' omitted → missing
      '--color-bg-page':             '#f4f4f4',   // extra, not declared
    }

    const result = diffConformance(DECLARED, resolved)

    // Drifted
    assert.equal(result.drifted.length, 1)
    assert.equal(result.drifted[0].cssVar, '--color-action-primary')
    assert.equal(result.drifted[0].declared, '#0f65ef')
    assert.equal(result.drifted[0].resolved, '#999999')
    assert.equal(result.drifted[0].tier, 'semantic')

    // Missing
    assert.equal(result.missing.length, 1)
    assert.equal(result.missing[0].cssVar, '--button-primary-bg-default')
    assert.equal(result.missing[0].declared, '#0f65ef')
    assert.equal(result.missing[0].tier, 'component')

    // Extra
    assert.equal(result.extra.length, 1)
    assert.equal(result.extra[0].cssVar, '--color-bg-page')
    assert.equal(result.extra[0].resolved, '#f4f4f4')
  })

  // ─── Edge: null/undefined inputs ───────────────────────────────────────────

  it('edge: null/undefined inputs produce empty results without throwing', () => {
    const result = diffConformance(null, undefined)
    assert.deepEqual(result.drifted, [])
    assert.deepEqual(result.missing, [])
    assert.deepEqual(result.extra, [])
  })
})

// ─── toDeclaredMap helper ─────────────────────────────────────────────────────

describe('toDeclaredMap', () => {
  it('converts a resolved.json array to a flat declared map', () => {
    const input = [
      { cssVar: '--color-action-primary', value: '#0f65ef', tier: 'semantic',  type: 'color' },
      { cssVar: '--button-radius',        value: '4px',     tier: 'component', type: 'dimension' },
    ]
    const map = toDeclaredMap(input)

    assert.deepEqual(map['--color-action-primary'], { value: '#0f65ef', tier: 'semantic',  type: 'color' })
    assert.deepEqual(map['--button-radius'],        { value: '4px',     tier: 'component', type: 'dimension' })
    assert.equal(Object.keys(map).length, 2)
  })

  it('returns {} for non-array input', () => {
    assert.deepEqual(toDeclaredMap(null), {})
    assert.deepEqual(toDeclaredMap(undefined), {})
    assert.deepEqual(toDeclaredMap({}), {})
  })

  it('skips entries missing cssVar', () => {
    const input = [
      { id: 'color.x', value: '#fff', tier: 'primitive', type: 'color' }, // no cssVar
      { cssVar: '--color-y', value: '#000', tier: 'primitive', type: 'color' },
    ]
    const map = toDeclaredMap(input)
    assert.deepEqual(Object.keys(map), ['--color-y'])
  })

  it('defaults tier and type to "unknown" when absent', () => {
    const input = [{ cssVar: '--x', value: 'val' }]
    const map = toDeclaredMap(input)
    assert.equal(map['--x'].tier, 'unknown')
    assert.equal(map['--x'].type, 'unknown')
  })
})
