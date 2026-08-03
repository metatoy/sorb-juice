/**
 * tierAffinity.test.js — Tests for the P2 tier-affinity anomaly detector.
 * Uses node:test (no vitest, no TypeScript).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectOffRole, studyFrequency } from './tierAffinity.js'

// ---------------------------------------------------------------------------
// Test 1: all tokens in-role → offRole empty
// ---------------------------------------------------------------------------
describe('detectOffRole', () => {
  it('returns empty offRole when all tokens are in-role', () => {
    const tokens = [
      { cssVar: '--color-bg-surface', value: '#ffffff', type: 'color' },
      { cssVar: '--color-text-primary', value: '#222222', type: 'color' },
      { cssVar: '--color-border-default', value: '#0f65ef', type: 'color' },
      { cssVar: '--radius-control', value: '4px', type: 'dimension' },
      { cssVar: '--radius-pill', value: '9999px', type: 'dimension' },
    ]
    const result = detectOffRole(tokens)
    assert.equal(result.offRole.length, 0, 'no off-role bindings expected')
    assert.equal(result.total, tokens.length)
    assert.equal(result.offRoleRate, 0)
  })

  // -------------------------------------------------------------------------
  // Test 2: one color token with a radius cssVar name → detected as off-role
  // -------------------------------------------------------------------------
  it('detects a color token bound to a radius slot', () => {
    const tokens = [
      { cssVar: '--color-bg-surface', value: '#ffffff', type: 'color' },
      // Off-role: a color type but the cssVar name implies a radius slot.
      { cssVar: '--button-radius', value: '#0f65ef', type: 'color' },
      { cssVar: '--radius-control', value: '4px', type: 'dimension' },
    ]
    const result = detectOffRole(tokens)
    assert.equal(result.offRole.length, 1, 'exactly one off-role binding expected')
    assert.equal(result.offRole[0].cssVar, '--button-radius')
    assert.equal(result.offRole[0].reason, 'color-token-in-radius-slot')
    assert.equal(result.total, tokens.length)
    assert.ok(result.offRoleRate > 0, 'offRoleRate should be > 0')
  })

  // -------------------------------------------------------------------------
  // Test 3: mixed — 2 off-role in 10 total → offRoleRate = 0.2
  // -------------------------------------------------------------------------
  it('calculates offRoleRate correctly for 2 violations in 10 tokens', () => {
    const tokens = [
      // 8 in-role
      { cssVar: '--color-bg-surface', value: '#ffffff', type: 'color' },
      { cssVar: '--color-text-primary', value: '#222222', type: 'color' },
      { cssVar: '--color-border-default', value: '#0f65ef', type: 'color' },
      { cssVar: '--color-feedback-danger', value: '#ee3322', type: 'color' },
      { cssVar: '--radius-100', value: '2px', type: 'dimension' },
      { cssVar: '--radius-200', value: '4px', type: 'dimension' },
      { cssVar: '--radius-300', value: '8px', type: 'dimension' },
      { cssVar: '--button-radius', value: '4px', type: 'dimension' },
      // 2 off-role
      { cssVar: '--border-radius-control', value: '#0f65ef', type: 'color' },   // color in radius slot
      { cssVar: '--color-fill-primary', value: '8px', type: 'dimension' },       // dimension in color slot
    ]
    const result = detectOffRole(tokens)
    assert.equal(result.total, 10)
    assert.equal(result.offRole.length, 2)
    assert.equal(result.offRoleRate, 0.2)
  })
})

// ---------------------------------------------------------------------------
// Test 4: studyFrequency on inline fixture → returns object with offRole + verdict
// ---------------------------------------------------------------------------
describe('studyFrequency', () => {
  it('returns offRole array and a verdict on a small inline fixture', () => {
    const fixture = [
      { id: 'color.bg.surface', cssVar: '--color-bg-surface', value: '#ffffff', tier: 'semantic', type: 'color' },
      { id: 'color.text.primary', cssVar: '--color-text-primary', value: '#222222', tier: 'semantic', type: 'color' },
      { id: 'radius.control', cssVar: '--radius-control', value: '4px', tier: 'semantic', type: 'dimension' },
      // Deliberate off-role injection: text color token given radius cssVar naming
      { id: 'radius.injected', cssVar: '--radius-injected', value: '#ff0000', tier: 'component', type: 'color' },
    ]
    const result = studyFrequency(fixture)
    assert.ok('offRole' in result, 'result must have offRole')
    assert.ok('total' in result, 'result must have total')
    assert.ok('offRoleRate' in result, 'result must have offRoleRate')
    assert.ok('verdict' in result, 'result must have verdict')
    assert.ok(result.verdict === 'GO' || result.verdict === 'NO-GO', 'verdict must be GO or NO-GO')
    // The injected off-role token should be caught
    assert.equal(result.offRole.length, 1)
    assert.equal(result.offRole[0].cssVar, '--radius-injected')
    assert.equal(result.verdict, 'GO')
  })

  it('returns NO-GO for empty input', () => {
    const result = studyFrequency([])
    assert.equal(result.verdict, 'NO-GO')
    assert.equal(result.total, 0)
  })
})
