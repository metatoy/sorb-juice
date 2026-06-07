// @ts-check
/**
 * Tests for the portable MCP AI-tools module (`src/mcp/aiTools.js`).
 *
 * Runner: Node's built-in test runner — `node --test src/mcp/aiTools.test.js`.
 * ZERO dependencies (no node_modules needed). ESM `.js`; Node 20 auto-detects
 * the module syntax even without `"type":"module"` in package.json.
 *
 * NO REAL NETWORK: every test that exercises a handler stubs `globalThis.fetch`.
 * The real fetch is saved in `beforeEach` and restored in `afterEach`, so a
 * leaked stub can never reach the network in a later test.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { aiTools, AI_WRITE_TOOLS, callCloud } from './aiTools.js'

// --- Shared fixtures --------------------------------------------------------

const TEST_KEY = 'sk-test-SUPERSECRET-must-never-leak-0xdeadbeef'
const BASE = 'https://cloud.example.test'
const CLOUD_CTX = { dir: '/tmp/x', bridge: {}, github: {}, cloud: { baseUrl: BASE, key: TEST_KEY } }

/** Find a tool by name (throws a helpful message if absent). */
const tool = (name) => {
  const t = aiTools.find((x) => x.name === name)
  assert.ok(t, `expected a tool named "${name}" to exist`)
  return t
}

const READ_NAMES = [
  'explain_blast_radius',
  'explain_drift',
  'scan_a11y',
  'generate_reskin',
  'suggest_names',
]
const WRITE_NAMES = ['apply_a11y_fix', 'apply_reskin_variant', 'apply_rename']

/**
 * Install a `fetch` stub. `impl` receives (url, init) and must resolve a
 * Response-ish object. Captures every call's args on `calls`.
 * @param {(url: string, init: any) => Promise<any>} impl
 */
const stubFetch = (impl) => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return impl(url, init)
  }
  return calls
}

/** A fake 2xx JSON Response. */
const ok = (json) => ({
  ok: true,
  status: 200,
  json: async () => json,
})

/** A fake non-2xx JSON Response. */
const fail = (status, json) => ({
  ok: false,
  status,
  json: async () => json,
})

// Save/restore the real fetch around every test so no stub can leak.
let realFetch
beforeEach(() => {
  realFetch = globalThis.fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

// ===========================================================================
// 1. SHAPE
// ===========================================================================

test('shape: exactly 8 tools, each a well-formed McpTool', () => {
  assert.equal(aiTools.length, 8, 'expected 8 AI tools')
  for (const t of aiTools) {
    assert.equal(typeof t.name, 'string', `name should be a string`)
    assert.ok(t.name.length > 0, `name should be non-empty`)
    assert.equal(typeof t.description, 'string', `${t.name}: description should be a string`)
    assert.ok(t.description.length > 0, `${t.name}: description should be non-empty`)
    assert.equal(typeof t.inputSchema, 'object', `${t.name}: inputSchema should be an object`)
    assert.ok(t.inputSchema !== null, `${t.name}: inputSchema should not be null`)
    assert.equal(t.inputSchema.type, 'object', `${t.name}: inputSchema.type should be 'object'`)
    assert.equal(typeof t.handler, 'function', `${t.name}: handler should be a function`)
  }
})

test('shape: tool names are unique', () => {
  const names = aiTools.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, `duplicate tool name(s): ${names.join(', ')}`)
})

test('shape: tool set is exactly the 5 read + 3 write names we expect', () => {
  const names = aiTools.map((t) => t.name).sort()
  const expected = [...READ_NAMES, ...WRITE_NAMES].sort()
  assert.deepEqual(names, expected)
})

test('shape: AI_WRITE_TOOLS is exactly the 3 apply_* names', () => {
  assert.deepEqual([...AI_WRITE_TOOLS].sort(), [...WRITE_NAMES].sort())
  // The 3 apply tools really exist in aiTools.
  for (const n of AI_WRITE_TOOLS) assert.ok(tool(n), `${n} should be a registered tool`)
})

test('shape: the 3 write tool names all start with apply_', () => {
  for (const n of AI_WRITE_TOOLS) {
    assert.match(n, /^apply_/, `write tool ${n} should start with apply_`)
  }
})

test('shape: NO read tool is listed in AI_WRITE_TOOLS', () => {
  for (const n of READ_NAMES) {
    assert.ok(!AI_WRITE_TOOLS.includes(n), `${n} is read-only and must NOT be gated as a write tool`)
  }
})

test('shape: AI_WRITE_TOOLS is frozen (immutable gate list)', () => {
  assert.ok(Object.isFrozen(AI_WRITE_TOOLS), 'AI_WRITE_TOOLS should be frozen')
})

// ===========================================================================
// 2. ROUTING — each READ tool hits the correct URL + method + auth + body
// ===========================================================================

/**
 * Drive one read tool and return the single captured fetch call, asserting the
 * shared transport invariants (method, content-type, Bearer auth).
 */
const driveRead = async (name, args) => {
  const calls = stubFetch(async () => ok({ narrative: 'ok', usage: { tokens: 1 } }))
  const res = await tool(name).handler(args, CLOUD_CTX)
  assert.equal(calls.length, 1, `${name}: should make exactly one fetch call`)
  const { url, init } = calls[0]
  assert.equal(init.method, 'POST', `${name}: method should be POST`)
  // Auth header forwarded as Bearer <key> (header name is case-insensitive in HTTP;
  // the module emits lowercase 'authorization').
  assert.equal(init.headers.authorization, `Bearer ${TEST_KEY}`, `${name}: Bearer auth header`)
  assert.equal(init.headers['content-type'], 'application/json', `${name}: JSON content-type`)
  return { url, body: JSON.parse(init.body), res }
}

test('routing: explain_blast_radius -> POST /api/ai/explainers/blast with {projectId,tokenId}', async () => {
  const { url, body } = await driveRead('explain_blast_radius', { projectId: 'p1', tokenId: 'color.bg' })
  assert.equal(url, `${BASE}/api/ai/explainers/blast`)
  assert.deepEqual(body, { projectId: 'p1', tokenId: 'color.bg' })
})

test('routing: explain_drift -> POST /api/ai/explainers/drift with {setId,fromVersion,toVersion}', async () => {
  const { url, body } = await driveRead('explain_drift', {
    setId: 's1',
    fromVersion: 'v1',
    toVersion: 'v2',
  })
  assert.equal(url, `${BASE}/api/ai/explainers/drift`)
  assert.deepEqual(body, { setId: 's1', fromVersion: 'v1', toVersion: 'v2' })
})

test('routing: scan_a11y -> POST /api/ai/a11y/scan, only projectId when optionals omitted', async () => {
  const { url, body } = await driveRead('scan_a11y', { projectId: 'p1' })
  assert.equal(url, `${BASE}/api/ai/a11y/scan`)
  assert.deepEqual(body, { projectId: 'p1' })
})

test('routing: scan_a11y forwards optional setId + targetLevel when provided', async () => {
  const { body } = await driveRead('scan_a11y', { projectId: 'p1', setId: 's1', targetLevel: 'AA' })
  assert.deepEqual(body, { projectId: 'p1', setId: 's1', targetLevel: 'AA' })
})

test('routing: generate_reskin -> POST /api/ai/reskin/generate (projectId only by default)', async () => {
  const { url, body } = await driveRead('generate_reskin', { projectId: 'p1' })
  assert.equal(url, `${BASE}/api/ai/reskin/generate`)
  assert.deepEqual(body, { projectId: 'p1' })
})

test('routing: generate_reskin forwards optional setId + direction', async () => {
  const { body } = await driveRead('generate_reskin', { projectId: 'p1', setId: 's1', direction: 'dark' })
  assert.deepEqual(body, { projectId: 'p1', setId: 's1', direction: 'dark' })
})

test('routing: suggest_names -> POST /api/ai/naming/suggest (projectId only by default)', async () => {
  const { url, body } = await driveRead('suggest_names', { projectId: 'p1' })
  assert.equal(url, `${BASE}/api/ai/naming/suggest`)
  assert.deepEqual(body, { projectId: 'p1' })
})

test('routing: suggest_names forwards optional setId', async () => {
  const { body } = await driveRead('suggest_names', { projectId: 'p1', setId: 's1' })
  assert.deepEqual(body, { projectId: 'p1', setId: 's1' })
})

test('routing: read tools surface the cloud JSON verbatim on success', async () => {
  const payload = { topology: { nodes: 3 }, narrative: 'depends on 3 things', usage: { tokens: 42 } }
  stubFetch(async () => ok(payload))
  const res = await tool('explain_blast_radius').handler({ projectId: 'p1', tokenId: 't' }, CLOUD_CTX)
  assert.deepEqual(res, payload)
})

// ===========================================================================
// 3. WRITE tools — proxy correct apply endpoint with a valid accept[]
// ===========================================================================

test('write: apply_a11y_fix -> POST /api/token-sets/{id}/apply-proposal with {accept}', async () => {
  const accept = [{ tokenId: 'color.fg', value: '#111' }]
  const calls = stubFetch(async () => ok({ versionId: 'v9', usage: {} }))
  const res = await tool('apply_a11y_fix').handler({ setId: 'set-1', accept }, CLOUD_CTX)
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, `${BASE}/api/token-sets/set-1/apply-proposal`)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, `Bearer ${TEST_KEY}`)
  assert.deepEqual(JSON.parse(init.body), { accept })
  assert.deepEqual(res, { versionId: 'v9', usage: {} })
})

test('write: apply_reskin_variant -> POST /api/token-sets/{id}/apply-variant with {accept,variantMode}', async () => {
  const accept = [{ tokenId: 'color.bg', value: '#000' }]
  const calls = stubFetch(async () => ok({ versionId: 'v10' }))
  await tool('apply_reskin_variant').handler({ setId: 'set-2', accept, variantMode: 'dark' }, CLOUD_CTX)
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, `${BASE}/api/token-sets/set-2/apply-variant`)
  assert.deepEqual(JSON.parse(init.body), { accept, variantMode: 'dark' })
})

test('write: apply_rename -> POST /api/token-sets/{id}/apply-rename with {accept:[{currentId,newId}]}', async () => {
  const accept = [{ currentId: 'old.id', newId: 'new.id' }]
  const calls = stubFetch(async () => ok({ versionId: 'v11' }))
  await tool('apply_rename').handler({ setId: 'set-3', accept }, CLOUD_CTX)
  assert.equal(calls.length, 1)
  const { url, init } = calls[0]
  assert.equal(url, `${BASE}/api/token-sets/set-3/apply-rename`)
  assert.deepEqual(JSON.parse(init.body), { accept })
})

test('write: setId is URL-encoded into the apply path', async () => {
  const accept = [{ tokenId: 't', value: 1 }]
  const calls = stubFetch(async () => ok({}))
  await tool('apply_a11y_fix').handler({ setId: 'a/b c', accept }, CLOUD_CTX)
  assert.equal(calls[0].url, `${BASE}/api/token-sets/a%2Fb%20c/apply-proposal`)
})

// --- never auto-apply: missing/empty accept[] must NOT call fetch ----------

test('write: apply_a11y_fix with MISSING accept -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('apply_a11y_fix').handler({ setId: 'set-1' }, CLOUD_CTX)
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0, 'must NOT call fetch when accept is missing (never auto-apply)')
})

test('write: apply_a11y_fix with EMPTY accept[] -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('apply_a11y_fix').handler({ setId: 'set-1', accept: [] }, CLOUD_CTX)
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0)
})

test('write: apply_reskin_variant with empty accept[] -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('apply_reskin_variant').handler(
    { setId: 'set-2', accept: [], variantMode: 'dark' },
    CLOUD_CTX,
  )
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0)
})

test('write: apply_reskin_variant with valid accept but MISSING variantMode -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('apply_reskin_variant').handler(
    { setId: 'set-2', accept: [{ tokenId: 't', value: 1 }] },
    CLOUD_CTX,
  )
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0)
})

test('write: apply_rename with missing accept -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('apply_rename').handler({ setId: 'set-3' }, CLOUD_CTX)
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0)
})

test('write: apply_* with non-array accept -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('apply_a11y_fix').handler({ setId: 's', accept: 'not-an-array' }, CLOUD_CTX)
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0)
})

test('write: apply_* with missing setId -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('apply_rename').handler({ accept: [{ currentId: 'a', newId: 'b' }] }, CLOUD_CTX)
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0)
})

// ===========================================================================
// 4. READ-tool arg validation — missing required args -> invalid_args, NO fetch
// ===========================================================================

test('read: explain_blast_radius missing tokenId -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('explain_blast_radius').handler({ projectId: 'p1' }, CLOUD_CTX)
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0)
})

test('read: explain_drift missing toVersion -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('explain_drift').handler({ setId: 's', fromVersion: 'v1' }, CLOUD_CTX)
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0)
})

test('read: scan_a11y missing projectId -> invalid_args, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('scan_a11y').handler({}, CLOUD_CTX)
  assert.equal(res.code, 'invalid_args')
  assert.equal(calls.length, 0)
})

// ===========================================================================
// 5. HONESTY — cloud errors / unreachable / not-configured are surfaced
// ===========================================================================

test('honesty: cloud non-2xx (402 ai-cap-exceeded) is surfaced as a structured error, NOT fake success', async () => {
  stubFetch(async () => fail(402, { error: 'AI usage cap exceeded', code: 'ai-cap-exceeded' }))
  const res = await tool('explain_blast_radius').handler({ projectId: 'p1', tokenId: 't' }, CLOUD_CTX)
  assert.equal(res.code, 'ai-cap-exceeded', 'cloud-supplied code passes through')
  assert.equal(res.status, 402, 'HTTP status is surfaced')
  assert.equal(res.error, 'AI usage cap exceeded')
  // It is NOT a success payload.
  assert.ok(!('narrative' in res), 'must not fabricate a narrative on error')
})

test('honesty: non-2xx without a JSON body falls back to a generic cloud_error + status', async () => {
  stubFetch(async () => ({
    ok: false,
    status: 500,
    json: async () => {
      throw new Error('not json')
    },
  }))
  const res = await tool('scan_a11y').handler({ projectId: 'p1' }, CLOUD_CTX)
  assert.equal(res.code, 'cloud_error')
  assert.equal(res.status, 500)
  assert.match(res.error, /HTTP 500/)
})

test('honesty: a fetch throw -> {code:cloud_unreachable}, no exception bubbles', async () => {
  stubFetch(async () => {
    throw new Error('ECONNREFUSED 127.0.0.1:443')
  })
  const res = await tool('generate_reskin').handler({ projectId: 'p1' }, CLOUD_CTX)
  assert.equal(res.code, 'cloud_unreachable')
  assert.match(res.error, /ECONNREFUSED/)
})

test('honesty: a write tool also surfaces cloud_unreachable on a fetch throw', async () => {
  stubFetch(async () => {
    throw new Error('socket hang up')
  })
  const res = await tool('apply_rename').handler(
    { setId: 's', accept: [{ currentId: 'a', newId: 'b' }] },
    CLOUD_CTX,
  )
  assert.equal(res.code, 'cloud_unreachable')
})

test('honesty: missing ctx.cloud -> {code:cloud_not_configured} with NO fetch call', async () => {
  const calls = stubFetch(async () => ok({}))
  const ctxNoCloud = { dir: '/tmp/x', bridge: {}, github: {} }
  const res = await tool('explain_blast_radius').handler({ projectId: 'p1', tokenId: 't' }, ctxNoCloud)
  assert.equal(res.code, 'cloud_not_configured')
  assert.equal(calls.length, 0, 'must not touch the network when cloud is unconfigured')
})

test('honesty: a WRITE tool with a valid accept but no ctx.cloud -> cloud_not_configured, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await tool('apply_a11y_fix').handler(
    { setId: 's', accept: [{ tokenId: 't', value: 1 }] },
    { dir: '/tmp' },
  )
  assert.equal(res.code, 'cloud_not_configured')
  assert.equal(calls.length, 0)
})

test('honesty: every tool returns cloud_not_configured when ctx is wholly undefined', async () => {
  // Use a never-call stub: if any handler reaches fetch, the test fails loudly.
  const calls = stubFetch(async () => {
    throw new Error('fetch should not be called with no ctx')
  })
  // Minimal valid args per tool so we get PAST arg-validation to the cloud check.
  const argsByName = {
    explain_blast_radius: { projectId: 'p', tokenId: 't' },
    explain_drift: { setId: 's', fromVersion: 'a', toVersion: 'b' },
    scan_a11y: { projectId: 'p' },
    generate_reskin: { projectId: 'p' },
    suggest_names: { projectId: 'p' },
    apply_a11y_fix: { setId: 's', accept: [{ tokenId: 't', value: 1 }] },
    apply_reskin_variant: { setId: 's', accept: [{ tokenId: 't', value: 1 }], variantMode: 'dark' },
    apply_rename: { setId: 's', accept: [{ currentId: 'a', newId: 'b' }] },
  }
  for (const t of aiTools) {
    const res = await t.handler(argsByName[t.name], undefined)
    assert.equal(res.code, 'cloud_not_configured', `${t.name}: undefined ctx -> cloud_not_configured`)
  }
  assert.equal(calls.length, 0, 'no tool should call fetch with an undefined ctx')
})

// callCloud is exported for direct transport tests.
test('honesty: callCloud(undefined ctx) short-circuits to cloud_not_configured, NO fetch', async () => {
  const calls = stubFetch(async () => ok({}))
  const res = await callCloud(undefined, '/api/ai/a11y/scan', { projectId: 'p' })
  assert.equal(res.code, 'cloud_not_configured')
  assert.equal(calls.length, 0)
})

// ===========================================================================
// 6. SECURITY — the Bearer key never leaks into any RETURNED object
// ===========================================================================

test('security: the API key never appears in any returned result object', async () => {
  // Exercise the full matrix of outcomes (success, http-error, throw, no-cloud,
  // invalid-args) and assert the secret key is in none of the serialized results.
  const results = []

  // success
  stubFetch(async () => ok({ narrative: 'fine', usage: { tokens: 1 } }))
  results.push(await tool('explain_blast_radius').handler({ projectId: 'p', tokenId: 't' }, CLOUD_CTX))

  // http error (cloud might echo headers in a real bug — assert it doesn't here)
  stubFetch(async () => fail(402, { error: 'cap', code: 'ai-cap-exceeded' }))
  results.push(await tool('scan_a11y').handler({ projectId: 'p' }, CLOUD_CTX))

  // fetch throw
  stubFetch(async () => {
    throw new Error('boom')
  })
  results.push(await tool('generate_reskin').handler({ projectId: 'p' }, CLOUD_CTX))

  // not configured
  results.push(await tool('suggest_names').handler({ projectId: 'p' }, { dir: '/tmp' }))

  // invalid args (write, never-apply)
  results.push(await tool('apply_rename').handler({ setId: 's' }, CLOUD_CTX))

  // write success
  stubFetch(async () => ok({ versionId: 'v1' }))
  results.push(
    await tool('apply_a11y_fix').handler(
      { setId: 's', accept: [{ tokenId: 't', value: 1 }] },
      CLOUD_CTX,
    ),
  )

  for (const r of results) {
    const serialized = JSON.stringify(r)
    assert.ok(
      !serialized.includes(TEST_KEY),
      `the API key must never appear in a returned object; got: ${serialized}`,
    )
    assert.ok(
      !serialized.toLowerCase().includes('bearer'),
      `no Authorization/Bearer material should leak into results; got: ${serialized}`,
    )
  }
})

test('security: the key is sent only in the Authorization header, never in the body or URL', async () => {
  const calls = stubFetch(async () => ok({}))
  await tool('explain_blast_radius').handler({ projectId: 'p', tokenId: 't' }, CLOUD_CTX)
  const { url, init } = calls[0]
  assert.ok(!url.includes(TEST_KEY), 'key must not be in the URL')
  assert.ok(!init.body.includes(TEST_KEY), 'key must not be in the request body')
  assert.equal(init.headers.authorization, `Bearer ${TEST_KEY}`, 'key travels only in the auth header')
})
