// conformanceReport.test.js — node:test suite for the E2 conformance-evidence renderer.
//
// Covers: (1) golden-file diffs for HTML/JSON/MD over a fixed diffConformance
// input; (2) the baked disclaimer is present in ALL three formats and CANNOT be
// omitted or overridden by the caller; (3) empty/clean input still carries the
// disclaimer; (4) escaping; (5) the dispatcher.
//
// No file I/O beyond reading the committed golden fixtures. Deterministic.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { diffConformance } from '../verify/conformance.js'
import {
  CONFORMANCE_DISCLAIMER,
  CONFORMANCE_SCOPE,
  renderConformanceReport,
  renderConformanceReportHTML,
  renderConformanceReportJSON,
  renderConformanceReportMarkdown,
} from './conformanceReport.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIX = join(HERE, '__fixtures__')
const readFix = (name) => readFileSync(join(FIX, name), 'utf-8')

const INPUT = JSON.parse(readFix('conformance-input.json'))
const RESULT = diffConformance(INPUT.declared, INPUT.resolved)
const META = INPUT.meta

// ─── 1. Golden-file diffs ─────────────────────────────────────────────────────

describe('conformance report — golden files', () => {
  it('JSON render matches the golden file byte-for-byte', () => {
    assert.equal(renderConformanceReportJSON(RESULT, META), readFix('conformance-report.json'))
  })

  it('Markdown render matches the golden file byte-for-byte', () => {
    assert.equal(renderConformanceReportMarkdown(RESULT, META), readFix('conformance-report.md'))
  })

  it('HTML render matches the golden file byte-for-byte', () => {
    assert.equal(renderConformanceReportHTML(RESULT, META), readFix('conformance-report.html'))
  })

  it('the dispatcher routes to each format identically', () => {
    assert.equal(renderConformanceReport(RESULT, 'json', META), renderConformanceReportJSON(RESULT, META))
    assert.equal(renderConformanceReport(RESULT, 'md', META), renderConformanceReportMarkdown(RESULT, META))
    assert.equal(renderConformanceReport(RESULT, 'markdown', META), renderConformanceReportMarkdown(RESULT, META))
    assert.equal(renderConformanceReport(RESULT, 'html', META), renderConformanceReportHTML(RESULT, META))
  })

  it('renders deterministically regardless of input key order (stable sort)', () => {
    // Rebuild the declared/resolved maps with reversed key insertion order.
    const reverseKeys = (obj) =>
      Object.fromEntries(Object.keys(obj).reverse().map((k) => [k, obj[k]]))
    const shuffled = diffConformance(reverseKeys(INPUT.declared), reverseKeys(INPUT.resolved))
    assert.equal(renderConformanceReportJSON(shuffled, META), readFix('conformance-report.json'))
    assert.equal(renderConformanceReportMarkdown(shuffled, META), readFix('conformance-report.md'))
    assert.equal(renderConformanceReportHTML(shuffled, META), readFix('conformance-report.html'))
  })
})

// ─── 2. The baked disclaimer is present + unmodifiable ────────────────────────

describe('conformance report — baked disclaimer (present in every format)', () => {
  const formats = {
    json: renderConformanceReportJSON,
    md: renderConformanceReportMarkdown,
    html: renderConformanceReportHTML,
  }

  for (const [name, render] of Object.entries(formats)) {
    it(`${name}: contains the exact codex disclaimer verbatim`, () => {
      assert.ok(
        render(RESULT, META).includes(CONFORMANCE_DISCLAIMER),
        `${name} render must contain the baked disclaimer`,
      )
    })

    it(`${name}: contains the scope qualifier`, () => {
      assert.ok(render(RESULT, META).includes(CONFORMANCE_SCOPE))
    })

    it(`${name}: disclaimer CANNOT be overridden via meta`, () => {
      // A caller trying to swap the disclaimer must be ignored: the canonical
      // string still appears and the injected string does not.
      const out = render(RESULT, {
        ...META,
        disclaimer: 'HACKED — this product guarantees WCAG compliance',
      })
      assert.ok(out.includes(CONFORMANCE_DISCLAIMER), `${name}: canonical disclaimer must survive an override attempt`)
      assert.ok(!out.includes('HACKED'), `${name}: caller-supplied disclaimer must be ignored`)
    })

    it(`${name}: disclaimer CANNOT be omitted (no opts suppress it)`, () => {
      // Whatever the caller passes as meta — empty, null, or junk — the
      // disclaimer is always emitted. There is no suppression option by design.
      for (const meta of [undefined, {}, null, { app: 'x' }, { verbose: false }]) {
        assert.ok(
          render(RESULT, meta).includes(CONFORMANCE_DISCLAIMER),
          `${name}: disclaimer must survive meta=${JSON.stringify(meta)}`,
        )
      }
    })
  }
})

// ─── 3. Empty / clean input still carries the disclaimer ──────────────────────

describe('conformance report — clean (no divergences) still an evidence artifact', () => {
  const CLEAN = { drifted: [], missing: [], extra: [] }

  for (const [name, render] of [
    ['json', renderConformanceReportJSON],
    ['md', renderConformanceReportMarkdown],
    ['html', renderConformanceReportHTML],
  ]) {
    it(`${name}: a zero-divergence report still bakes in the disclaimer`, () => {
      const out = render(CLEAN, META)
      assert.ok(out.includes(CONFORMANCE_DISCLAIMER))
    })
  }

  it('json: zero-divergence summary reports all-zero counts', () => {
    const doc = JSON.parse(renderConformanceReportJSON(CLEAN, META))
    assert.deepEqual(doc.summary, {
      drifted: 0,
      missing: 0,
      extra: 0,
      divergences: 0,
      byTier: {},
    })
    assert.deepEqual(doc.findings, { drifted: [], missing: [], extra: [] })
  })

  it('defensive: a null/garbage result renders (empty) rather than throwing', () => {
    assert.ok(renderConformanceReportJSON(null, META).includes(CONFORMANCE_DISCLAIMER))
    assert.ok(renderConformanceReportMarkdown(undefined).includes(CONFORMANCE_DISCLAIMER))
    assert.ok(renderConformanceReportHTML({ drifted: 'nope' }).includes(CONFORMANCE_DISCLAIMER))
  })
})

// ─── 4. Escaping ──────────────────────────────────────────────────────────────

describe('conformance report — escaping', () => {
  const NASTY = {
    drifted: [
      { cssVar: '--x<b>', declared: 'a & b', resolved: '"q"', tier: 'semantic', type: 'color' },
    ],
    missing: [],
    extra: [{ cssVar: '--pipe|var', resolved: 'a|b' }],
  }

  it('HTML escapes &, <, >, "', () => {
    const html = renderConformanceReportHTML(NASTY)
    assert.ok(html.includes('--x&lt;b&gt;'))
    assert.ok(html.includes('a &amp; b'))
    assert.ok(html.includes('&quot;q&quot;'))
    // No raw unescaped tag from the data leaked into the document body.
    assert.ok(!html.includes('--x<b>'))
  })

  it('Markdown escapes table-breaking pipes', () => {
    const md = renderConformanceReportMarkdown(NASTY)
    assert.ok(md.includes('--pipe\\|var'))
    assert.ok(md.includes('a\\|b'))
  })
})

// ─── 5. Dispatcher error path ─────────────────────────────────────────────────

describe('conformance report — dispatcher', () => {
  it('throws on an unknown format', () => {
    assert.throws(() => renderConformanceReport(RESULT, 'pdf', META), /unknown conformance report format/)
  })
})
