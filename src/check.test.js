// check.test.js — node:test suite for the `sorb check` core (src/check.js).
//
// All fixtures inline. Zero file I/O, zero LLM. Asserts the exit-code contract
// (0 clean / 1 findings / build failure) and that each finding category is wired
// to the right verify-suite lib.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCheck, detectDeprecated, formatCheckText, EXIT, CHECK_CATEGORIES } from './check.js'

// A small resolved snapshot (the .sorb/resolved.json array shape).
const BASE = [
  { id: 'color.action.primary', cssVar: '--color-action-primary', value: '#0f65ef', tier: 'semantic', type: 'color' },
  { id: 'color.text.primary', cssVar: '--color-text-primary', value: '#222222', tier: 'semantic', type: 'color' },
  { id: 'radius.control', cssVar: '--radius-control', value: '4px', tier: 'semantic', type: 'dimension' },
]

describe('runCheck — clean', () => {
  it('exits 0 when the new snapshot equals the baseline and has no anomalies', () => {
    const r = runCheck({ resolved: BASE, baseline: BASE })
    assert.equal(r.ok, true)
    assert.equal(r.exitCode, EXIT.CLEAN)
    assert.equal(r.fatalTotal, 0)
    for (const c of CHECK_CATEGORIES) assert.equal(r.counts[c], 0)
  })

  it('with no baseline, skips drift/binding checks and notes it', () => {
    const r = runCheck({ resolved: BASE })
    assert.equal(r.exitCode, EXIT.CLEAN)
    assert.ok(r.notes.some((n) => /No baseline/i.test(n)))
    assert.equal(r.counts.drift, 0)
    assert.equal(r.counts['binding-mismatch'], 0)
  })
})

describe('runCheck — drift', () => {
  it('flags a changed value as drift and exits 1', () => {
    const after = BASE.map((t) =>
      t.cssVar === '--color-action-primary' ? { ...t, value: '#0a5be0' } : t,
    )
    const r = runCheck({ resolved: after, baseline: BASE })
    assert.equal(r.exitCode, EXIT.FINDINGS)
    assert.equal(r.counts.drift, 1)
    assert.equal(r.findings.drifted[0].cssVar, '--color-action-primary')
    assert.equal(r.findings.drifted[0].declared, '#0f65ef')
    assert.equal(r.findings.drifted[0].resolved, '#0a5be0')
  })
})

describe('runCheck — binding-mismatch', () => {
  it('flags a removed (previously-bound) token and exits 1', () => {
    const after = BASE.filter((t) => t.cssVar !== '--radius-control')
    const r = runCheck({ resolved: after, baseline: BASE })
    assert.equal(r.exitCode, EXIT.FINDINGS)
    assert.equal(r.counts['binding-mismatch'], 1)
    assert.equal(r.findings.lostBindings[0].cssVar, '--radius-control')
    assert.equal(r.findings.lostBindings[0].was, '4px')
  })

  it('a newly-added token is informational (gained), not fatal', () => {
    const after = [...BASE, { id: 'x', cssVar: '--color-new', value: '#fff', tier: 'semantic', type: 'color' }]
    const r = runCheck({ resolved: after, baseline: BASE })
    assert.equal(r.exitCode, EXIT.CLEAN)
    assert.ok(r.findings.gained.some((g) => g.cssVar === '--color-new'))
  })
})

describe('runCheck — off-role', () => {
  it('flags a color token in a radius slot and exits 1', () => {
    const resolved = [
      { id: 'r', cssVar: '--button-radius', value: '#ff0000', tier: 'component', type: 'color' },
    ]
    const r = runCheck({ resolved, baseline: resolved })
    assert.equal(r.exitCode, EXIT.FINDINGS)
    assert.equal(r.counts['off-role'], 1)
    assert.equal(r.findings.offRole[0].reason, 'color-token-in-radius-slot')
  })
})

describe('runCheck — deprecation', () => {
  it('flags a token flagged deprecated (boolean and message forms)', () => {
    const resolved = [
      { id: 'a', cssVar: '--color-legacy', value: '#111', tier: 'semantic', type: 'color', deprecated: true },
      { id: 'b', cssVar: '--color-old', value: '#222', tier: 'semantic', type: 'color', $deprecated: 'use --color-action-primary' },
      ...BASE,
    ]
    const r = runCheck({ resolved, baseline: resolved })
    assert.equal(r.exitCode, EXIT.FINDINGS)
    assert.equal(r.counts.deprecation, 2)
    const msg = r.findings.deprecated.find((d) => d.cssVar === '--color-old')
    assert.equal(msg.note, 'use --color-action-primary')
  })

  it('detectDeprecated ignores falsy/empty flags', () => {
    const out = detectDeprecated([
      { cssVar: '--a', deprecated: false },
      { cssVar: '--b', deprecated: '' },
      { cssVar: '--c' },
    ])
    assert.equal(out.length, 0)
  })
})

describe('runCheck — build failure', () => {
  it('exits 1 when buildOk is false even with no findings', () => {
    const r = runCheck({ resolved: BASE, baseline: BASE, buildOk: false })
    assert.equal(r.exitCode, EXIT.FINDINGS)
    assert.equal(r.buildOk, false)
    assert.equal(r.fatalTotal, 0)
  })
})

describe('runCheck — conformance vs live capture', () => {
  it('flags build-vs-running-app drift and missing bindings', () => {
    const resolved = BASE
    const live = {
      '--color-action-primary': '#0f65ef', // matches
      '--color-text-primary': '#000000', // drifted in the running app
      // --radius-control missing from the running app
    }
    const r = runCheck({ resolved, baseline: BASE, live })
    assert.equal(r.exitCode, EXIT.FINDINGS)
    assert.equal(r.findings.liveDrifted.length, 1)
    assert.equal(r.findings.liveDrifted[0].cssVar, '--color-text-primary')
    assert.equal(r.findings.liveMissing.length, 1)
    assert.equal(r.findings.liveMissing[0].cssVar, '--radius-control')
  })
})

describe('runCheck — heat map (informational)', () => {
  it('surfaces high-confidence hardcoded values without affecting the exit code', () => {
    const computedStyles = new Map([
      ['background-color', '#abcdef'], // not a token → hardcoded, high confidence
      ['color', '#222222'], // matches --color-text-primary → tokenized
    ])
    const r = runCheck({ resolved: BASE, baseline: BASE, computedStyles })
    assert.equal(r.exitCode, EXIT.CLEAN) // hardcoded is never fatal
    assert.ok(r.findings.hardcoded.length >= 1)
    assert.ok(r.findings.hardcoded.some((h) => h.value === '#abcdef'))
  })
})

describe('formatCheckText', () => {
  it('is codex-safe: no compliance/enforcement/guarantee wording', () => {
    const after = BASE.map((t) =>
      t.cssVar === '--color-action-primary' ? { ...t, value: '#0a5be0' } : t,
    )
    const text = formatCheckText(runCheck({ resolved: after, baseline: BASE })).toLowerCase()
    for (const banned of ['complian', 'enforc', 'guarantee', 'warrant', 'accessib', 'ensures']) {
      assert.ok(!text.includes(banned), `output must not contain "${banned}"`)
    }
    // It DOES report measured evidence.
    assert.ok(text.includes('drift'))
    assert.ok(text.includes('exit 1'))
  })

  it('reports a clean run with an exit-0 summary', () => {
    const text = formatCheckText(runCheck({ resolved: BASE, baseline: BASE }))
    assert.ok(/exit 0/.test(text))
    assert.ok(/no drift/i.test(text))
  })
})
