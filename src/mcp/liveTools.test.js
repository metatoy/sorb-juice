// Self-contained `node --test` suite for the LIVE-app tool DEFINITIONS
// (`./liveTools.js`). NO MCP SDK: validates the plain `{name,description,
// inputSchema,handler}` contract, the `needBridge` guard, and end-to-end handler
// wiring against a stubbed `globalThis.fetch` (the handlers call liveData with
// no injected fetch, so they use the global — we swap it here and restore).
//   node --test src/mcp/liveTools.test.js

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { liveTools } from './liveTools.js'
import { WRITE_TOOLS } from './entitlementGate.js'
import { tools as staticTools } from './tools.js'

const BRIDGE = 'http://127.0.0.1:7777'
const byName = (n) => liveTools.find((t) => t.name === n)

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})
const stubFetch = (routes) => {
  globalThis.fetch = async (url) => {
    const path = String(url).replace(BRIDGE, '')
    const r = routes[path]
    if (!r) throw new Error(`stub: no route for ${path}`)
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }
  }
}

// ── contract ────────────────────────────────────────────────────────────────
test('exposes exactly the 4 live read tools with valid plain-data shape', () => {
  assert.deepEqual(
    liveTools.map((t) => t.name).sort(),
    ['bridge_status', 'get_active_preview', 'list_tokens_live', 'resolve_value_live'],
  )
  for (const t of liveTools) {
    assert.equal(typeof t.name, 'string')
    assert.equal(typeof t.description, 'string')
    assert.equal(t.inputSchema.type, 'object')
    assert.equal(typeof t.handler, 'function')
  }
})

test('live tools are READS — none collide with the static tools and none are write-gated', () => {
  const staticNames = new Set(staticTools.map((t) => t.name))
  for (const t of liveTools) {
    assert.equal(staticNames.has(t.name), false, `${t.name} collides with a static tool`)
    assert.equal(WRITE_TOOLS.includes(t.name), false, `${t.name} must not be write-gated`)
  }
})

test('id-taking tools declare `id` required in their schema', () => {
  assert.deepEqual(byName('resolve_value_live').inputSchema.required, ['id'])
  assert.deepEqual(byName('get_active_preview').inputSchema.required, ['id'])
})

// ── needBridge guard ────────────────────────────────────────────────────────
test('every handler fails loudly when ctx.bridge is absent (no fetch attempted)', async () => {
  globalThis.fetch = () => {
    throw new Error('handler must not fetch without a bridge')
  }
  for (const t of liveTools) {
    await assert.rejects(() => t.handler({ id: 'x' }, {}), /LIVE-app tool — it needs a running bridge/)
    await assert.rejects(() => t.handler({ id: 'x' }, { bridge: '' }), /needs a running bridge/)
  }
})

// ── handler wiring (uses ctx.bridge + global fetch) ──────────────────────────
test('bridge_status handler returns live status from the bridge', async () => {
  stubFetch({
    '/health': { status: 200, body: { ok: true, namespace: 'demo', activePreviews: 1, verifications: 4 } },
    '/ready': { status: 200, body: { ok: true, checks: { store: true } } },
  })
  const s = await byName('bridge_status').handler({}, { bridge: BRIDGE })
  assert.equal(s.activePreviews, 1)
  assert.equal(s.ready, true)
})

test('list_tokens_live handler forwards filters to the live map', async () => {
  stubFetch({
    '/tokens/resolved': {
      status: 200,
      body: [
        { id: 'a.x', cssVar: '--ax', value: '#000', tier: 'primitive', type: 'color' },
        { id: 'b.y', cssVar: '--by', value: '8px', tier: 'semantic', type: 'dimension' },
      ],
    },
  })
  const out = await byName('list_tokens_live').handler({ tier: 'semantic' }, { bridge: BRIDGE })
  assert.deepEqual(out.map((t) => t.id), ['b.y'])
})

test('resolve_value_live handler returns the live entry', async () => {
  stubFetch({
    '/tokens/resolved': {
      status: 200,
      body: [{ id: 'space.md', cssVar: '--space-md', value: '16px', tier: 'semantic', type: 'dimension' }],
    },
  })
  const t = await byName('resolve_value_live').handler({ id: 'space.md' }, { bridge: BRIDGE })
  assert.equal(t.value, '16px')
})

test('get_active_preview handler returns the live override map', async () => {
  stubFetch({ '/preview/p1': { status: 200, body: { '--btn-primary-bg': '#0af' } } })
  const p = await byName('get_active_preview').handler({ id: 'p1' }, { bridge: BRIDGE })
  assert.deepEqual(p, { '--btn-primary-bg': '#0af' })
})
