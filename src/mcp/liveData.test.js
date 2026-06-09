// Self-contained `node --test` suite for the LIVE-app read accessors
// (`./liveData.js`, roadmap §3 "sees the running app").
//
// NO MCP SDK, NO network: every test injects a fake `fetch` so the accessors are
// exercised fully offline. The fake maps `path → { status, body }`; a `null`
// mapping makes `fetch` THROW (simulating an unreachable bridge). Runnable with:
//   node --test src/mcp/liveData.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bridgeStatus,
  liveResolvedMap,
  listTokensLive,
  resolveValueLive,
  getActivePreview,
} from './liveData.js'

const BRIDGE = 'http://127.0.0.1:7777'

// Build a fake fetch from a { path: {status, body} | 'NETWORK_ERROR' } routes map.
const fakeFetch = (routes) => async (url) => {
  const path = url.replace(BRIDGE, '')
  const r = routes[path]
  if (r === 'NETWORK_ERROR') throw new Error('ECONNREFUSED')
  if (!r) throw new Error(`fake fetch: no route for ${path}`)
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => {
      if (r.body === '__BAD_JSON__') throw new Error('Unexpected end of JSON input')
      return r.body
    },
  }
}

const RESOLVED = [
  { id: 'button.primary.bg.default', cssVar: '--btn-primary-bg', value: '#f26722', tier: 'component', type: 'color' },
  { id: 'color.brand.500', cssVar: '--color-brand-500', value: '#f26722', tier: 'primitive', type: 'color' },
  { id: 'space.md', cssVar: '--space-md', value: '16px', tier: 'semantic', type: 'dimension' },
]

// ── bridgeStatus ────────────────────────────────────────────────────────────
test('bridgeStatus: healthy + ready → reachable, ready true, counts passed through', async () => {
  const fetch = fakeFetch({
    '/health': { status: 200, body: { ok: true, namespace: 'demo', activePreviews: 2, verifications: 7 } },
    '/ready': { status: 200, body: { ok: true, checks: { store: true } } },
  })
  const s = await bridgeStatus(BRIDGE, { fetch })
  assert.equal(s.reachable, true)
  assert.equal(s.namespace, 'demo')
  assert.equal(s.activePreviews, 2)
  assert.equal(s.verifications, 7)
  assert.equal(s.ready, true)
  assert.deepEqual(s.readyChecks, { store: true })
})

test('bridgeStatus: /ready 503 is tolerated → ready false, checks captured (no throw)', async () => {
  const fetch = fakeFetch({
    '/health': { status: 200, body: { ok: true, namespace: 'demo', activePreviews: 0, verifications: 0 } },
    '/ready': { status: 503, body: { ok: false, checks: { store: true, db: false } } },
  })
  const s = await bridgeStatus(BRIDGE, { fetch })
  assert.equal(s.ready, false)
  assert.deepEqual(s.readyChecks, { store: true, db: false })
})

test('bridgeStatus: unreachable bridge throws a loud, actionable error naming the failed path', async () => {
  // Stub BOTH routes so the assertion can't pass on a "no route" error if the
  // two getBridge calls were ever reordered; /health must be the one that throws.
  const fetch = fakeFetch({ '/health': 'NETWORK_ERROR', '/ready': { status: 200, body: { ok: true } } })
  await assert.rejects(
    () => bridgeStatus(BRIDGE, { fetch }),
    /GET \/health\): ECONNREFUSED\. Is `sorb dev` running/s,
  )
})

test('a 2xx response with an unparseable JSON body is LOUD, not silently degraded', async () => {
  const fetch = fakeFetch({ '/tokens/resolved': { status: 200, body: '__BAD_JSON__' } })
  await assert.rejects(() => liveResolvedMap(BRIDGE, { fetch }), /returned 200 with an unparseable JSON body/)
})

// ── liveResolvedMap ─────────────────────────────────────────────────────────
test('liveResolvedMap: 200 array → returned verbatim', async () => {
  const fetch = fakeFetch({ '/tokens/resolved': { status: 200, body: RESOLVED } })
  assert.deepEqual(await liveResolvedMap(BRIDGE, { fetch }), RESOLVED)
})

test('liveResolvedMap: 404 (map not built) → loud error with the bridge detail', async () => {
  const fetch = fakeFetch({
    '/tokens/resolved': { status: 404, body: { error: 'No resolved token map. Run `sorb-seed resolve`.' } },
  })
  await assert.rejects(() => liveResolvedMap(BRIDGE, { fetch }), /returned 404 — No resolved token map/)
})

test('liveResolvedMap: non-array body → loud "mid-build" error', async () => {
  const fetch = fakeFetch({ '/tokens/resolved': { status: 200, body: { not: 'an array' } } })
  await assert.rejects(() => liveResolvedMap(BRIDGE, { fetch }), /did not return a token array/)
})

// ── listTokensLive (filtering parity with static list_tokens) ────────────────
test('listTokensLive: no filter → all live tokens', async () => {
  const fetch = fakeFetch({ '/tokens/resolved': { status: 200, body: RESOLVED } })
  assert.equal((await listTokensLive(BRIDGE, {}, { fetch })).length, 3)
})

test('listTokensLive: tier + type + q filters compose', async () => {
  const fetch = fakeFetch({ '/tokens/resolved': { status: 200, body: RESOLVED } })
  assert.deepEqual((await listTokensLive(BRIDGE, { tier: 'primitive' }, { fetch })).map((t) => t.id), ['color.brand.500'])
  assert.deepEqual((await listTokensLive(BRIDGE, { type: 'dimension' }, { fetch })).map((t) => t.id), ['space.md'])
  // q matches over id/cssVar/value, case-insensitive
  assert.deepEqual((await listTokensLive(BRIDGE, { q: 'BRAND' }, { fetch })).map((t) => t.id), ['color.brand.500'])
  assert.deepEqual((await listTokensLive(BRIDGE, { q: '#f26722' }, { fetch })).map((t) => t.id).sort(), [
    'button.primary.bg.default',
    'color.brand.500',
  ])
})

test('listTokensLive: null entries in the live map are skipped, not crashed on (parity w/ static)', async () => {
  const fetch = fakeFetch({ '/tokens/resolved': { status: 200, body: [RESOLVED[0], null, RESOLVED[1]] } })
  const out = await listTokensLive(BRIDGE, { tier: 'primitive' }, { fetch })
  assert.deepEqual(out.map((t) => t.id), ['color.brand.500'])
})

test('listTokensLive: q matches across the joined id\\ncssVar\\nvalue haystack (parity w/ static)', async () => {
  const fetch = fakeFetch({ '/tokens/resolved': { status: 200, body: RESOLVED } })
  // substring of cssVar
  assert.deepEqual((await listTokensLive(BRIDGE, { q: 'space-md' }, { fetch })).map((t) => t.id), ['space.md'])
})

// ── resolveValueLive ────────────────────────────────────────────────────────
test('resolveValueLive: found → the live entry', async () => {
  const fetch = fakeFetch({ '/tokens/resolved': { status: 200, body: RESOLVED } })
  const t = await resolveValueLive(BRIDGE, 'space.md', { fetch })
  assert.equal(t.value, '16px')
  assert.equal(t.cssVar, '--space-md')
})

test('resolveValueLive: missing id → loud not-found naming the id + count', async () => {
  const fetch = fakeFetch({ '/tokens/resolved': { status: 200, body: RESOLVED } })
  await assert.rejects(() => resolveValueLive(BRIDGE, 'nope.token', { fetch }), /"nope\.token".*3 tokens/s)
})

test('resolveValueLive: no id → loud arg error (no fetch made)', async () => {
  await assert.rejects(() => resolveValueLive(BRIDGE, '', { fetch: () => { throw new Error('should not fetch') } }), /requires a token `id`/)
})

// ── getActivePreview ────────────────────────────────────────────────────────
test('getActivePreview: 200 → the live override map', async () => {
  const fetch = fakeFetch({ '/preview/abc123': { status: 200, body: { '--btn-primary-bg': '#0af' } } })
  assert.deepEqual(await getActivePreview(BRIDGE, 'abc123', { fetch }), { '--btn-primary-bg': '#0af' })
})

test('getActivePreview: 404 (expired/never active) → loud error', async () => {
  const fetch = fakeFetch({ '/preview/gone': { status: 404, body: { error: 'Preview not found or expired' } } })
  await assert.rejects(() => getActivePreview(BRIDGE, 'gone', { fetch }), /returned 404 — Preview not found or expired/)
})

test('getActivePreview: id is URL-encoded into the path', async () => {
  const fetch = fakeFetch({ '/preview/a%2Fb': { status: 200, body: { ok: 1 } } })
  assert.deepEqual(await getActivePreview(BRIDGE, 'a/b', { fetch }), { ok: 1 })
})

// ── no-bridge guard ─────────────────────────────────────────────────────────
test('every accessor throws a friendly "No live bridge configured" when bridge is empty', async () => {
  for (const call of [
    () => bridgeStatus('', { fetch: () => {} }),
    () => liveResolvedMap(undefined, { fetch: () => {} }),
    () => listTokensLive('', {}, { fetch: () => {} }),
    () => resolveValueLive('', 'x', { fetch: () => {} }),
    () => getActivePreview('', 'x', { fetch: () => {} }),
  ]) {
    await assert.rejects(call, /No live bridge configured/)
  }
})
