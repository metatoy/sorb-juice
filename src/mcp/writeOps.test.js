// Self-contained `node --test` suite for the P2 gated-write pure core (`./writeOps.js`).
//
// Verifies the changeset / blast-radius / validation logic behind the Phase-2
// write tools (spec/day/mcp-smart-connect.md §5 "Write — gated", §6 Phase 2) against
// a synthetic `.sorb/` fixture built in a temp dir — NO external deps.
//
// IMPORTANT: this file imports NEITHER the MCP SDK, NOR `./server.js`, NOR any
// network/github module. It exercises only the pure logic in `./writeOps.js`
// (which itself only reads the local `.sorb/` via `./sorbData.js`). Runnable with:
//   node --test src/mcp/writeOps.test.js
//
// The fixture shape mirrors `./sorbData.test.js`: a resolved.json ARRAY, an
// index.json with one story, and a FRAME→TEXT artifact carrying `sorb.tokens`.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  computeBlastRadius,
  validateTokenChange,
  buildTokenChangeset,
  buildRebindProposal,
} from './writeOps.js'

// ─── Fixture (same shape as sorbData.test.js) ───────────────────────────────────

const STORY_ID = 'components-button--primary'
const ARTIFACT_REL = '.sorb/Button.sorb.json'
const ARTIFACT_FILE = 'Button.sorb.json'

/** @type {string} project root holding the `.sorb/` fixture. */
let dir

/** The resolved token map (ARRAY of ResolvedToken {id,cssVar,value,tier,type}). */
const RESOLVED = [
  {
    id: 'button.primary.bg.default',
    cssVar: '--button-primary-bg-default',
    value: '#0F65EF',
    tier: 'component',
    type: 'color',
  },
  {
    id: 'button.primary.border.default',
    cssVar: '--button-primary-border-default',
    value: '#0B53C7',
    tier: 'component',
    type: 'color',
  },
  {
    id: 'button.primary.text.default',
    cssVar: '--button-primary-text-default',
    value: '#FFFFFF',
    tier: 'component',
    type: 'color',
  },
  {
    id: 'button.radius',
    cssVar: '--button-radius',
    value: '4px',
    tier: 'component',
    type: 'dimension',
  },
  {
    id: 'color.action.primary',
    cssVar: '--color-action-primary',
    value: '#0F65EF',
    tier: 'semantic',
    type: 'color',
  },
]

/** A captured LayerNode tree: FRAME root (3 bindings) → TEXT child (1 binding). */
const ARTIFACT = {
  type: 'FRAME',
  fills: [{ raw: 'rgb(15, 101, 239)' }],
  strokes: [{ raw: 'rgb(11, 83, 199)' }],
  cornerRadius: 4,
  sorb: {
    tokens: {
      fill: 'button.primary.bg.default',
      stroke: 'button.primary.border.default',
      cornerRadius: 'button.radius',
    },
    candidates: {
      fill: ['button.primary.bg.default', 'color.action.primary'],
      stroke: ['button.primary.border.default'],
      cornerRadius: ['button.radius'],
    },
  },
  children: [
    {
      type: 'TEXT',
      fills: [{ raw: 'rgb(255, 255, 255)' }],
      sorb: {
        tokens: { text: 'button.primary.text.default' },
        candidates: { text: ['button.primary.text.default'] },
      },
    },
  ],
}

const INDEX = { stories: { [STORY_ID]: { artifact: ARTIFACT_REL } } }

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'sorb-mcp-writeops-test-'))
  const sorbDir = join(dir, '.sorb')
  mkdirSync(sorbDir, { recursive: true })
  writeFileSync(join(sorbDir, 'resolved.json'), JSON.stringify(RESOLVED, null, 2))
  writeFileSync(join(sorbDir, 'index.json'), JSON.stringify(INDEX, null, 2))
  writeFileSync(join(sorbDir, ARTIFACT_FILE), JSON.stringify(ARTIFACT, null, 2))
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// ─── computeBlastRadius ─────────────────────────────────────────────────────────

test('computeBlastRadius surfaces the binding components + cssVar', () => {
  const br = computeBlastRadius(dir, 'button.primary.bg.default')
  assert.equal(br.tokenId, 'button.primary.bg.default')
  assert.equal(br.cssVar, '--button-primary-bg-default')
  assert.ok(br.count >= 1, 'at least one direct component')
  assert.equal(br.count, br.directComponents.length, 'count matches directComponents')
  assert.ok(
    br.directComponents.some((c) => c.componentId === STORY_ID),
    'directComponents includes components-button--primary',
  )
})

test('computeBlastRadius(unknown id) → empty, no throw', () => {
  const br = computeBlastRadius(dir, 'nope.token')
  assert.equal(br.cssVar, null)
  assert.equal(br.count, 0)
  assert.deepEqual(br.directComponents, [])
})

// ─── validateTokenChange ────────────────────────────────────────────────────────

test('validateTokenChange rejects an unknown id and accepts a known one', () => {
  const bad = validateTokenChange(dir, { id: 'nope.token', newValue: '#fff' })
  assert.equal(bad.ok, false)
  assert.equal(bad.token, null)
  assert.ok(bad.error, 'error message present')

  const good = validateTokenChange(dir, { id: 'button.primary.bg.default', newValue: '#FF0000' })
  assert.equal(good.ok, true)
  assert.equal(good.error, null)
  assert.ok(good.token, 'resolved token returned')
  assert.equal(good.token.id, 'button.primary.bg.default')
})

test('validateTokenChange enforces light color type sanity', () => {
  const bad = validateTokenChange(dir, { id: 'button.primary.bg.default', newValue: 123 })
  assert.equal(bad.ok, false)
  assert.ok(bad.error, 'color tokens expect a string value')
})

// ─── buildTokenChangeset ────────────────────────────────────────────────────────

test('buildTokenChangeset builds the diff + overridden tokenSet + blast radius', () => {
  const cs = buildTokenChangeset(dir, { id: 'button.primary.bg.default', newValue: '#FF0000' })
  assert.equal(cs.oldValue, '#0F65EF')
  assert.equal(cs.newValue, '#FF0000')
  assert.equal(cs.cssVar, '--button-primary-bg-default')
  assert.equal(cs.type, 'color')
  assert.equal(cs.tier, 'component')

  // tokenSet mirrors cli.js read(): cssVar minus leading dashes → value, with the
  // override applied for this id.
  assert.equal(cs.tokenSet['button-primary-bg-default'], '#FF0000', 'override applied')
  assert.equal(cs.tokenSet['button-radius'], '4px', 'untouched entries preserved')

  assert.ok(cs.blastRadius.count >= 1, 'blast radius computed')
  assert.equal(cs.blastRadius.cssVar, '--button-primary-bg-default')
})

// ─── buildRebindProposal ────────────────────────────────────────────────────────

test('buildRebindProposal proposes a valid fill rebind with from/to + affected', () => {
  const rb = buildRebindProposal(dir, {
    componentId: STORY_ID,
    role: 'fill',
    tokenId: 'color.action.primary',
  })
  assert.equal(rb.from, 'button.primary.bg.default', 'current fill binding')
  assert.equal(rb.to, 'color.action.primary')
  assert.equal(rb.valid, true)
  assert.equal(rb.error, null)
  assert.ok(rb.affected, 'affected blast radius present')
})

test('buildRebindProposal rejects an unknown target token id', () => {
  const rb = buildRebindProposal(dir, {
    componentId: STORY_ID,
    role: 'fill',
    tokenId: 'nope.token',
  })
  assert.equal(rb.valid, false)
  assert.ok(rb.error, 'error message present')
})
