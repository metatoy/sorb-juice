// Self-contained `node --test` suite for the Sorb MCP read layer (`./sorbData.js`).
//
// Verifies the 7 read operations (roadmap §3 / spec/day/mcp-smart-connect.md §5)
// against a synthetic `.sorb/` fixture built in a temp dir — NO external deps.
//
// IMPORTANT (Worker C / QA contract): this file imports neither `./server.js`
// (which needs the un-installed `@modelcontextprotocol/sdk`) nor the SDK itself.
// It exercises the pure data layer `./sorbData.js`, and — when present — a couple
// of the `./tools.js` handlers that wrap it. Runnable once those modules exist:
//   node --test src/mcp/sorbData.test.js

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  loadResolved,
  loadIndex,
  loadArtifact,
  loadArtifactTyped,
  unwrapArtifact,
  listTokens,
  getToken,
  resolveValue,
  listComponents,
  getComponentBindings,
  findTokenUsages,
  findComponentsByToken,
  buildReverseIndex,
} from './sorbData.js'

// Optionally exercise the tool handlers if the sibling `./tools.js` exists.
// Kept dynamic so this suite still runs (and proves the data layer) before
// `tools.js` lands. We assert on its handlers only when it imports cleanly.
let tools = null
try {
  ;({ tools } = await import('./tools.js'))
} catch (e) {
  // tools.js not built yet (or its deps absent) — skip the wrapper assertions.
  tools = null
}

const findTool = (name) => (tools || []).find((t) => t.name === name)

// ─── Fixture ────────────────────────────────────────────────────────────────

const STORY_ID = 'components-button--primary'
// The index stores the artifact path RELATIVE TO THE PROJECT ROOT (not `.sorb/`)
// — matching how cli.js resolves it: `resolve(process.cwd(), entry.artifact)`,
// and sorbData.loadArtifact: `resolve(resolve(dir), entry.artifact)`. The file
// itself still lives under `.sorb/`, so the relpath carries the `.sorb/` prefix.
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
        tokens: { fill: 'button.primary.text.default' },
        candidates: { fill: ['button.primary.text.default'] },
      },
    },
  ],
}

const INDEX = { stories: { [STORY_ID]: { artifact: ARTIFACT_REL } } }

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'sorb-mcp-test-'))
  const sorbDir = join(dir, '.sorb')
  mkdirSync(sorbDir, { recursive: true })
  writeFileSync(join(sorbDir, 'resolved.json'), JSON.stringify(RESOLVED, null, 2))
  writeFileSync(join(sorbDir, 'index.json'), JSON.stringify(INDEX, null, 2))
  // Artifact lives at the path the index points to (`<dir>/.sorb/Button.sorb.json`),
  // which the loader resolves from the project root via the `.sorb/`-prefixed relpath.
  writeFileSync(join(sorbDir, ARTIFACT_FILE), JSON.stringify(ARTIFACT, null, 2))
})

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// ─── Loaders ──────────────────────────────────────────────────────────────────

test('loadResolved reads the resolved.json ARRAY', () => {
  const r = loadResolved(dir)
  assert.ok(Array.isArray(r), 'resolved map is an array')
  assert.equal(r.length, 5)
  const bg = r.find((t) => t.id === 'button.primary.bg.default')
  assert.equal(bg.cssVar, '--button-primary-bg-default')
  assert.equal(bg.value, '#0F65EF')
})

test('loadIndex reads the story index', () => {
  const idx = loadIndex(dir)
  assert.ok(idx.stories[STORY_ID], 'story present in index')
  assert.equal(idx.stories[STORY_ID].artifact, ARTIFACT_REL)
})

test('loadArtifact resolves the index-relative path to the LayerNode tree', () => {
  const art = loadArtifact(dir, STORY_ID)
  assert.ok(art, 'artifact loaded')
  assert.equal(art.type, 'FRAME')
  assert.equal(art.children[0].type, 'TEXT')
})

// path-safety / missing-story: must not throw, returns null
test('loadArtifact(nonexistent) → null (path-safety, no throw)', () => {
  assert.equal(loadArtifact(dir, 'nonexistent'), null)
})

// ─── Tool 1: list_tokens (filters) ─────────────────────────────────────────────

test('listTokens filters by tier / type / q', () => {
  // all 5, no filter
  assert.equal(listTokens(dir, {}).length, 5)

  // tier:component → the 4 button.* tokens
  const byTier = listTokens(dir, { tier: 'component' })
  assert.equal(byTier.length, 4)
  assert.ok(byTier.every((t) => t.tier === 'component'))

  // type:color → 4 (3 button colors + color.action.primary; radius excluded)
  const byType = listTokens(dir, { type: 'color' })
  assert.equal(byType.length, 4)
  assert.ok(byType.every((t) => t.type === 'color'))

  // q:radius → finds button.radius
  const byQ = listTokens(dir, { q: 'radius' })
  assert.ok(
    byQ.some((t) => t.id === 'button.radius'),
    'q=radius surfaces button.radius',
  )
})

// ─── Tool 2: get_token (+ usages) ──────────────────────────────────────────────

test('getToken returns the token plus its component usages', () => {
  const res = getToken(dir, 'button.primary.bg.default')
  assert.ok(res, 'token resolved')
  // The ResolvedToken fields are present (shape-agnostic to wrapping).
  const token = res.token || res
  assert.equal(token.id, 'button.primary.bg.default')
  assert.equal(token.cssVar, '--button-primary-bg-default')
  assert.equal(token.value, '#0F65EF')
  // usages includes the binding component/story.
  const usages = res.usages || []
  assert.ok(
    usages.some((u) => u === STORY_ID || u.id === STORY_ID || u.componentId === STORY_ID),
    'usages include components-button--primary',
  )
})

// ─── Tool 3: resolve_value ─────────────────────────────────────────────────────

test('resolveValue resolves by cssVar and by id', () => {
  assert.equal(resolveValue(dir, { cssVar: '--color-action-primary' }), '#0F65EF')
  assert.equal(resolveValue(dir, { id: 'button.radius' }), '4px')
})

// ─── Tool 4: list_components ───────────────────────────────────────────────────

test('listComponents returns the single captured component', () => {
  const comps = listComponents(dir)
  assert.equal(comps.length, 1)
  const id = comps[0].id || comps[0].componentId || comps[0]
  assert.equal(id, STORY_ID)
})

// ─── Tool 5: get_component_bindings (full-tree walk) ───────────────────────────

test('getComponentBindings merges root + child bindings (full-tree walk)', () => {
  const res = getComponentBindings(dir, STORY_ID)
  assert.ok(res, 'bindings returned')
  // Contract: `{ bindings, candidates }`, each a role→… map merged across the
  // whole tree with LAST-WRITE-PER-ROLE (deeper, depth-first nodes win).
  const bindings = res.bindings || res

  // Non-colliding root roles survive verbatim.
  assert.equal(bindings.stroke, 'button.primary.border.default', 'root stroke merged')
  assert.equal(bindings.cornerRadius, 'button.radius', 'root cornerRadius merged')

  // The `fill` role collides (FRAME + TEXT both bind it). Per the documented
  // last-write-per-role merge, the deeper TEXT child wins — which is itself proof
  // the walk descended into children rather than stopping at the root.
  assert.equal(
    bindings.fill,
    'button.primary.text.default',
    'child TEXT fill wins the role collision (proves full-tree descent)',
  )

  // Candidates are likewise merged role-keyed and survive the walk.
  const candidates = res.candidates || {}
  assert.ok(Array.isArray(candidates.cornerRadius), 'cornerRadius candidates present')
  assert.ok(
    candidates.cornerRadius.includes('button.radius'),
    'cornerRadius candidate list carries button.radius',
  )
})

// ─── Tool 6: find_token_usages (child-node binding found) ──────────────────────

test('findTokenUsages finds the component binding a child-node token', () => {
  // text token is bound ONLY on the TEXT child — proves the reverse index walks
  // the whole tree, not just the root node.
  const usages = findTokenUsages(dir, 'button.primary.text.default')
  assert.ok(Array.isArray(usages) || usages, 'usages returned')
  const list = Array.isArray(usages) ? usages : usages.usages || []
  assert.ok(
    list.some((u) => u === STORY_ID || u.id === STORY_ID || u.componentId === STORY_ID),
    'child-node token usage maps back to components-button--primary',
  )
})

// ─── Tool 7: find_components_by_token (cssVar → id → usage) ─────────────────────

test('findComponentsByToken maps cssVar → token id → component usage', () => {
  const res = findComponentsByToken(dir, '--button-primary-bg-default')
  assert.ok(res, 'result returned')
  const list = Array.isArray(res) ? res : res.components || res.usages || []
  assert.ok(
    list.some((u) => u === STORY_ID || u.id === STORY_ID || u.componentId === STORY_ID),
    '--button-primary-bg-default resolves to components-button--primary',
  )
})

// ─── Reverse index (backs tools 2/6/7) ─────────────────────────────────────────

test('buildReverseIndex maps token ids → the components that bind them', () => {
  const rev = buildReverseIndex(dir)
  assert.ok(rev, 'reverse index built')
  // Contract: `{ byTokenId: Map<id, [{componentId,key}]>, byCssVar: Map<cssVar,id> }`.
  assert.ok(rev.byTokenId instanceof Map, 'byTokenId is a Map')
  assert.ok(rev.byCssVar instanceof Map, 'byCssVar is a Map')

  // Child-only token id resolves back to the component (proves tree-wide indexing).
  const forText = rev.byTokenId.get('button.primary.text.default')
  assert.ok(Array.isArray(forText) && forText.length, 'reverse entry for child-bound token exists')
  assert.ok(
    forText.some((u) => u.componentId === STORY_ID && u.key === 'fill'),
    'reverse index links text token → components-button--primary on role fill',
  )

  // cssVar → token id mapping is populated from the resolved map.
  assert.equal(
    rev.byCssVar.get('--button-primary-bg-default'),
    'button.primary.bg.default',
    'byCssVar maps the bg cssVar to its token id',
  )
})

// ─── Optional: a couple of `./tools.js` handler smoke checks (no SDK) ──────────

test('tools.js list_tokens handler filters like the data layer', { skip: !tools }, async () => {
  const t = findTool('list_tokens')
  assert.ok(t, 'list_tokens tool registered')
  const out = await t.handler({ tier: 'component' }, { dir })
  const list = Array.isArray(out) ? out : out.tokens || out.result || []
  assert.equal(list.length, 4, 'handler returns the 4 component tokens')
})

test('tools.js resolve_value handler resolves a cssVar', { skip: !tools }, async () => {
  const t = findTool('resolve_value')
  assert.ok(t, 'resolve_value tool registered')
  const out = await t.handler({ cssVar: '--color-action-primary' }, { dir })
  const value = typeof out === 'object' && out !== null ? out.value ?? out.result : out
  assert.equal(value, '#0F65EF')
})

// ════════════════════════════════════════════════════════════════════════════
// B16 — binding-pipeline loud failures (REC-5 unwrap · REC-3 conflicts · REC-4
// typed loadArtifact). Each spins its own temp `.sorb/` so the shared fixture
// above is untouched. spec/day/binding-pipeline-loud-failures.md §3–§6.
// ════════════════════════════════════════════════════════════════════════════

/** Build a throwaway project dir with one artifact + index entry, return dir. */
const mkProject = (artifact, { rel = '.sorb/Art.sorb.json', file = 'Art.sorb.json', storyId = 'comp--story' } = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'sorb-b16-'))
  const sorbDir = join(d, '.sorb')
  mkdirSync(sorbDir, { recursive: true })
  writeFileSync(join(sorbDir, 'index.json'), JSON.stringify({ stories: { [storyId]: { artifact: rel } } }))
  if (artifact !== undefined) writeFileSync(join(sorbDir, file), JSON.stringify(artifact))
  return { d, storyId }
}

// ─── REC-5: unwrap the story-wrapper / root-wrapper / bare shapes ──────────────

test('unwrapArtifact: bare LayerNode → [node], shape "bare"', () => {
  const { roots, shape } = unwrapArtifact({ type: 'FRAME', sorb: { tokens: { fill: 't' } } })
  assert.equal(shape, 'bare')
  assert.equal(roots.length, 1)
  assert.equal(roots[0].type, 'FRAME')
})

test('unwrapArtifact: { root } → [root], shape "root-wrapper"', () => {
  const { roots, shape } = unwrapArtifact({ root: { type: 'FRAME', sorb: { tokens: { fill: 't' } } } })
  assert.equal(shape, 'root-wrapper')
  assert.equal(roots.length, 1)
  assert.equal(roots[0].type, 'FRAME')
})

test('unwrapArtifact: { stories:[{root}] } → roots, shape "story-wrapper"', () => {
  const { roots, shape } = unwrapArtifact({
    stories: [{ root: { type: 'FRAME' } }, { root: { type: 'TEXT' } }],
  })
  assert.equal(shape, 'story-wrapper')
  assert.deepEqual(roots.map((r) => r.type), ['FRAME', 'TEXT'])
})

test('unwrapArtifact: THROWS "unexpected artifact shape: <keys>" on unknown shape', () => {
  assert.throws(() => unwrapArtifact({ foo: 1, bar: 2 }), /unexpected artifact shape: \{foo,bar\}/)
  assert.throws(() => unwrapArtifact(42), /unexpected artifact shape: number/)
  assert.throws(() => unwrapArtifact([1, 2]), /unexpected artifact shape: array/)
  assert.throws(() => unwrapArtifact(null), /unexpected artifact shape: null/)
})

test('REC-5: story-wrapper artifact reads its fill binding (the real bug)', () => {
  // The exact shape sorb-demo/.sorb/Button.sorb.json uses: { stories:[{ root }] }.
  const { d, storyId } = mkProject({
    stories: [
      {
        id: 'components-button--primary',
        root: {
          type: 'FRAME',
          sorb: { tokens: { fill: 'button.primary.bg.default', cornerRadius: 'button.radius' } },
          children: [{ type: 'TEXT', sorb: { tokens: { fill: 'button.primary.text.default' } } }],
        },
      },
    ],
  })
  const { bindings } = getComponentBindings(d, storyId)
  // Pre-fix this returned {} (walk saw `{stories}`, never the node). Now it reads.
  assert.equal(bindings.cornerRadius, 'button.radius', 'story-wrapper root binding read')
  assert.equal(bindings.fill, 'button.primary.text.default', 'descends into child of unwrapped root')
  rmSync(d, { recursive: true, force: true })
})

test('REC-5: root-wrapper artifact reads its bindings', () => {
  const { d, storyId } = mkProject({
    root: { type: 'FRAME', sorb: { tokens: { stroke: 'x.border' } } },
  })
  const { bindings } = getComponentBindings(d, storyId)
  assert.equal(bindings.stroke, 'x.border')
  rmSync(d, { recursive: true, force: true })
})

test('REC-5: a present-but-unparseable artifact THROWS loudly (not silent null)', () => {
  const { d, storyId } = mkProject({ totally: 'bogus', shape: true })
  assert.throws(() => loadArtifactTyped(d, storyId), /unexpected artifact shape/)
  assert.throws(() => getComponentBindings(d, storyId), /unexpected artifact shape/)
  rmSync(d, { recursive: true, force: true })
})

// ─── REC-4: typed loadArtifact (missing vs escaped vs ok) ──────────────────────

test('REC-4: loadArtifactTyped → error:"missing" when no index entry', () => {
  const { d } = mkProject({ type: 'FRAME' })
  const res = loadArtifactTyped(d, 'no-such-story')
  assert.equal(res.error, 'missing')
  assert.equal(res.artifact, null)
  assert.equal(res.shape, null)
  rmSync(d, { recursive: true, force: true })
})

test('REC-4: loadArtifactTyped → error:"missing" when file absent', () => {
  // index points at an artifact path, but we never wrote the file.
  const { d, storyId } = mkProject(undefined)
  const res = loadArtifactTyped(d, storyId)
  assert.equal(res.error, 'missing')
  rmSync(d, { recursive: true, force: true })
})

test('REC-4: loadArtifactTyped → error:"escaped-project-dir" on traversal', () => {
  const { d, storyId } = mkProject({ type: 'FRAME' }, { rel: '../../../etc/passwd' })
  const res = loadArtifactTyped(d, storyId)
  assert.equal(res.error, 'escaped-project-dir')
  assert.equal(res.artifact, null)
  rmSync(d, { recursive: true, force: true })
})

test('REC-4: loadArtifactTyped → error:null + shape on a good read', () => {
  const { d, storyId } = mkProject({ type: 'FRAME', sorb: { tokens: { fill: 't' } } })
  const res = loadArtifactTyped(d, storyId)
  assert.equal(res.error, null)
  assert.equal(res.shape, 'bare')
  assert.equal(res.artifact.type, 'FRAME')
  rmSync(d, { recursive: true, force: true })
})

test('REC-4: getComponentBindings surfaces a missing read via diagnostics[]', () => {
  const { d } = mkProject({ type: 'FRAME' })
  const res = getComponentBindings(d, 'no-such-story')
  assert.deepEqual(res.bindings, {})
  assert.ok(Array.isArray(res.diagnostics))
  assert.ok(
    res.diagnostics.some((x) => x.kind === 'artifact-missing'),
    'missing artifact surfaced in diagnostics, not silent {}',
  )
  rmSync(d, { recursive: true, force: true })
})

// ─── REC-3: conflicts[] on nested clobber + variant-chain collapse ─────────────

test('REC-3: nested-override clobber recorded in conflicts[role]', () => {
  // Two nested nodes bind `fill` — last-write keeps the child, conflicts keeps both.
  const { d, storyId } = mkProject({
    type: 'FRAME',
    name: 'Root',
    sorb: { tokens: { fill: 'root.fill', stroke: 'root.stroke' } },
    children: [{ type: 'RECTANGLE', name: 'Inner', sorb: { tokens: { fill: 'child.fill' } } }],
  })
  const { bindings, conflicts, diagnostics } = getComponentBindings(d, storyId)
  // last-write (deeper) still wins — unchanged contract.
  assert.equal(bindings.fill, 'child.fill')
  // …but the loss is now VISIBLE.
  assert.ok(conflicts.fill, 'fill role flagged as conflict')
  assert.equal(conflicts.fill.length, 2, 'both contributing nodes retained')
  assert.deepEqual(
    conflicts.fill.map((c) => c.tokenId).sort(),
    ['child.fill', 'root.fill'],
  )
  assert.ok(conflicts.fill.every((c) => typeof c.nodePath === 'string' && c.nodePath.length))
  // non-colliding role is NOT a conflict.
  assert.equal(conflicts.stroke, undefined)
  assert.ok(diagnostics.some((x) => x.kind === 'role-conflict'))
  rmSync(d, { recursive: true, force: true })
})

test('REC-3: variant-chain collapse across stories surfaces as a conflict', () => {
  // A story-wrapper with TWO variant roots both binding `fill` — the cross-root
  // collapse used to silently keep only the last. Now it's a recorded conflict.
  const { d, storyId } = mkProject({
    stories: [
      { id: 'btn--default', root: { type: 'FRAME', name: 'Default', sorb: { tokens: { fill: 'fill.default' } } } },
      { id: 'btn--hover', root: { type: 'FRAME', name: 'Hover', sorb: { tokens: { fill: 'fill.hover' } } } },
    ],
  })
  const { bindings, conflicts } = getComponentBindings(d, storyId)
  assert.equal(bindings.fill, 'fill.hover', 'last variant root wins (last-write)')
  assert.ok(conflicts.fill && conflicts.fill.length === 2, 'variant collapse visible as conflict')
  rmSync(d, { recursive: true, force: true })
})

test('REC-3: no conflicts when each role bound once (additive, clean case)', () => {
  const { d, storyId } = mkProject({
    type: 'FRAME',
    sorb: { tokens: { fill: 'a', stroke: 'b' } },
  })
  const { bindings, conflicts, candidates, diagnostics } = getComponentBindings(d, storyId)
  assert.deepEqual(bindings, { fill: 'a', stroke: 'b' })
  assert.deepEqual(conflicts, {})
  assert.deepEqual(candidates, {})
  assert.deepEqual(diagnostics, [])
  rmSync(d, { recursive: true, force: true })
})

// ─── REC-5: the unwrap also feeds findTokenUsages / buildReverseIndex ──────────

test('REC-5: findTokenUsages + buildReverseIndex read through the story-wrapper', () => {
  const { d, storyId } = mkProject({
    stories: [
      {
        id: 'comp--story',
        root: {
          type: 'FRAME',
          sorb: { tokens: { fill: 'tok.fill' } },
          children: [{ type: 'TEXT', sorb: { tokens: { fill: 'tok.text' } } }],
        },
      },
    ],
  })
  const usages = findTokenUsages(d, 'tok.text')
  assert.ok(usages.some((u) => u.componentId === storyId), 'child token found through wrapper')

  const rev = buildReverseIndex(d)
  const forFill = rev.byTokenId.get('tok.fill')
  assert.ok(forFill && forFill.some((u) => u.componentId === storyId && u.key === 'fill'))
  rmSync(d, { recursive: true, force: true })
})

// ─── Acceptance: the REAL sorb-demo Button reads its fill via the unwrap ────────

test('ACCEPTANCE: real sorb-demo Button reads fill/stroke/cornerRadius (B16 gone)', () => {
  const demoDir = join(import.meta.dirname, '..', '..', '..', 'sorb-demo')
  if (!existsSync(join(demoDir, '.sorb', 'index.json'))) {
    return // demo not present in this checkout — skip without failing.
  }
  const { bindings } = getComponentBindings(demoDir, 'components-button--primary')
  assert.equal(bindings.stroke, 'button.primary.border.default')
  assert.equal(bindings.cornerRadius, 'button.radius')
  // fill collides FRAME vs TEXT child → child wins (proves descent past unwrap).
  assert.equal(bindings.fill, 'button.primary.text.default')
})
