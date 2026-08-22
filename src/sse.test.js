// E1 (hosted-relay hardening) — end-to-end SSE tests for
// GET /orgs/:orgId/preview/:id/subscribe, promoted from the relay-spike
// (experiments/sorb-bridge-modes/relay-spike/test/). Uses a REAL HTTP server
// (@hono/node-server on an ephemeral port) rather than app.request(), so the
// tests exercise the actual streaming socket path the leaf's EventSource hits.
//
// Covers the three E1 blockers:
//   1. store→SSE push (snapshot on connect + live update frames)
//   2. org-key auth via ?key= (EventSource can't set headers)
//   3. tenant isolation (401 unauth, 404 cross-org, no cross-tenant leak)
//   + the HARD INVARIANT: LOCAL mode (no databaseUrl) subscribe is OPEN
//     (no key) and behaves like the free bridge.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { serve } from '@hono/node-server'
import { createServer } from './server.js'
import { createMemoryStore } from './store/memory.js'
import { loadConfig } from './config.js'
import { hashKey } from './auth.js'

// ── Fake tenants (mirrors src/server.test.js) ────────────────────────────────
const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const ORG_A = 'org-a'
const PROJECT_B = '22222222-2222-2222-2222-222222222222'
const ORG_B = 'org-b'

const SECRET_KEY = 'sk_secret_test'
const PUBLISHABLE_KEY = 'pk_publishable_test'
const SECRET_KEY_B = 'sk_secret_test_b'

const HASHES = {
  [hashKey(SECRET_KEY)]: { key_id: 'k-a', type: 'secret', project_id: PROJECT_A, org_id: ORG_A, namespace: 'proj-a', allowed_origins: [] },
  [hashKey(PUBLISHABLE_KEY)]: { key_id: 'k-a-pub', type: 'publishable', project_id: PROJECT_A, org_id: ORG_A, namespace: 'proj-a', allowed_origins: [] },
  [hashKey(SECRET_KEY_B)]: { key_id: 'k-b', type: 'secret', project_id: PROJECT_B, org_id: ORG_B, namespace: 'proj-b', allowed_origins: [] },
}

const makeFakeDb = () => {
  const ownedPreviews = new Map() // id -> projectId
  return {
    ownedPreviews,
    async ping() {
      return true
    },
    async query(text, params) {
      if (text.includes('FROM api_keys')) {
        const row = HASHES[params[0]]
        return { rows: row ? [row] : [] }
      }
      if (text.includes('FROM entitlements')) return { rows: [] } // ⇒ FREE
      if (text.includes('count(*)') && text.includes('FROM previews')) return { rows: [{ n: 0 }] }
      if (text.startsWith('SELECT 1 FROM previews')) {
        return { rows: ownedPreviews.get(params[0]) === params[1] ? [{ '?column?': 1 }] : [] }
      }
      if (text.startsWith('INSERT INTO previews')) {
        ownedPreviews.set(params[0], params[1])
        return { rows: [] }
      }
      if (text.startsWith('DELETE FROM previews')) {
        if (ownedPreviews.get(params[0]) === params[1]) ownedPreviews.delete(params[0])
        return { rows: [] }
      }
      return { rows: [] }
    },
  }
}

// ── Server + client harness ──────────────────────────────────────────────────
const running = []

const startServer = async ({ hosted = false } = {}) => {
  const base = hosted
    ? loadConfig({ ...process.env, DATABASE_URL: 'postgres://fake/db' })
    : loadConfig()
  const config = { ...base, sseHeartbeatMs: 80 } // fast pings for the keepalive test
  const store = createMemoryStore(config)
  const db = hosted ? makeFakeDb() : null
  const app = createServer({ store, config, db })
  const server = serve({ fetch: app.fetch, port: 0 })
  await new Promise((resolve, reject) => {
    server.on('listening', resolve)
    server.on('error', reject)
    if (server.address()) resolve()
  })
  const baseUrl = `http://localhost:${server.address().port}`
  const ctx = { baseUrl, store, db, server, close: () => new Promise((r) => server.close(() => r())) }
  running.push({ ctx, store })
  return ctx
}

afterEach(async () => {
  while (running.length) {
    const { ctx, store } = running.pop()
    await ctx.close()
    await store.close()
  }
})

const bearer = (key) => ({ Authorization: `Bearer ${key}` })

const createPreview = async (baseUrl, tokens, key) => {
  const res = await fetch(`${baseUrl}/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? bearer(key) : {}) },
    body: JSON.stringify(tokens),
  })
  return { status: res.status, body: await res.json() }
}

/**
 * Open an SSE subscription. `events` is a live array of parsed frame objects
 * (each frame's data JSON-parsed). Returns { status, events, close, done }.
 */
const subscribe = async (baseUrl, orgId, id, key) => {
  const controller = new AbortController()
  const qs = key ? `?key=${encodeURIComponent(key)}` : ''
  const res = await fetch(`${baseUrl}/orgs/${orgId}/preview/${id}/subscribe${qs}`, {
    signal: controller.signal,
  })
  const events = []
  let closed = false
  if (res.status !== 200 || !res.body) {
    return { status: res.status, events, close: () => controller.abort(), done: Promise.resolve() }
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const done = (async () => {
    try {
      while (!closed) {
        const { value, done: rdone } = await reader.read()
        if (rdone) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of raw.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                events.push(JSON.parse(line.slice(6)))
              } catch (e) {
                void e
              }
            }
          }
        }
      }
    } catch (e) {
      void e // aborted — expected on close()
    }
  })()
  return {
    status: res.status,
    events,
    close: () => {
      closed = true
      controller.abort()
    },
    done,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (fn, ms = 1000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await sleep(10)
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
describe('SSE subscribe — LOCAL mode (no databaseUrl): OPEN, byte-for-byte free bridge', () => {
  it('subscribes with NO key and receives snapshot + live update frames', async () => {
    const { baseUrl } = await startServer({ hosted: false })
    const { status, body } = await createPreview(baseUrl, { color: 'blue' })
    assert.equal(status, 200)
    const { id } = body

    // orgId is ignored in local mode; no ?key= supplied.
    const sub = await subscribe(baseUrl, 'ignored-org', id, null)
    assert.equal(sub.status, 200)
    assert.ok(await waitFor(() => sub.events.length >= 1))
    assert.deepEqual(sub.events[0], { type: 'snapshot', tokens: { color: 'blue' } })

    // A PUT (no auth in local mode) pushes an update frame.
    await fetch(`${baseUrl}/preview/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ color: 'navy' }),
    })
    assert.ok(await waitFor(() => sub.events.some((e) => e.type === 'update')))
    const upd = sub.events.find((e) => e.type === 'update')
    assert.deepEqual(upd.tokens, { color: 'navy' })

    sub.close()
    await sub.done
  })

  it('404 for an unknown preview id (local mode)', async () => {
    const { baseUrl } = await startServer({ hosted: false })
    const sub = await subscribe(baseUrl, 'any', 'no-such-id', null)
    assert.equal(sub.status, 404)
    assert.equal(sub.events.length, 0)
  })

  it('sends periodic ping keepalives while idle', async () => {
    const { baseUrl } = await startServer({ hosted: false })
    const { body } = await createPreview(baseUrl, { a: 1 })
    const sub = await subscribe(baseUrl, 'any', body.id, null)
    assert.equal(sub.status, 200)
    // Heartbeat is 80ms in the test config → at least one ping within ~1s.
    assert.ok(await waitFor(() => sub.events.some((e) => e.type === 'ping'), 1500))
    sub.close()
    await sub.done
  })
})

describe('SSE subscribe — HOSTED mode: org-key auth + tenant isolation', () => {
  it('no ?key= → 401, stream never opens', async () => {
    const { baseUrl } = await startServer({ hosted: true })
    const { body } = await createPreview(baseUrl, { c: 1 }, SECRET_KEY)
    const sub = await subscribe(baseUrl, ORG_A, body.id, null)
    assert.equal(sub.status, 401)
    assert.equal(sub.events.length, 0)
  })

  it('bogus ?key= → 401', async () => {
    const { baseUrl } = await startServer({ hosted: true })
    const { body } = await createPreview(baseUrl, { c: 1 }, SECRET_KEY)
    const sub = await subscribe(baseUrl, ORG_A, body.id, 'sk_not_real')
    assert.equal(sub.status, 401)
  })

  it('valid same-org publishable key → snapshot + live updates', async () => {
    const { baseUrl } = await startServer({ hosted: true })
    const { body } = await createPreview(baseUrl, { color: 'blue' }, SECRET_KEY)
    const { id } = body

    const sub = await subscribe(baseUrl, ORG_A, id, PUBLISHABLE_KEY)
    assert.equal(sub.status, 200)
    assert.ok(await waitFor(() => sub.events.length >= 1))
    assert.deepEqual(sub.events[0], { type: 'snapshot', tokens: { color: 'blue' } })

    await fetch(`${baseUrl}/preview/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bearer(SECRET_KEY) },
      body: JSON.stringify({ color: 'navy' }),
    })
    assert.ok(await waitFor(() => sub.events.some((e) => e.type === 'update')))
    assert.deepEqual(sub.events.find((e) => e.type === 'update').tokens, { color: 'navy' })

    sub.close()
    await sub.done
  })

  it('cross-org: key A on ORG_B path → 404 (no existence leak)', async () => {
    const { baseUrl } = await startServer({ hosted: true })
    const { body } = await createPreview(baseUrl, { color: 'blue' }, SECRET_KEY)
    // Authed as A but requesting under org-b in the path.
    const sub = await subscribe(baseUrl, ORG_B, body.id, SECRET_KEY)
    assert.equal(sub.status, 404)
    assert.equal(sub.events.length, 0)
  })

  it('cross-tenant: org B\'s key cannot subscribe to org A\'s preview → 404', async () => {
    const { baseUrl } = await startServer({ hosted: true })
    const { body } = await createPreview(baseUrl, { color: 'blue' }, SECRET_KEY)
    // Key B, requesting under org-b path, with A's preview id ⇒ not owned ⇒ 404.
    const sub = await subscribe(baseUrl, ORG_B, body.id, SECRET_KEY_B)
    assert.equal(sub.status, 404)
    assert.equal(sub.events.length, 0)
  })

  it('another org\'s writes never leak onto a legitimate subscriber\'s stream', async () => {
    const { baseUrl } = await startServer({ hosted: true })
    const a = await createPreview(baseUrl, { color: 'blue' }, SECRET_KEY)
    const b = await createPreview(baseUrl, { color: 'red' }, SECRET_KEY_B)

    const sub = await subscribe(baseUrl, ORG_A, a.body.id, PUBLISHABLE_KEY)
    assert.equal(sub.status, 200)
    assert.ok(await waitFor(() => sub.events.length >= 1))

    // Org B updates ITS preview — must not appear on A's stream.
    await fetch(`${baseUrl}/preview/${b.body.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bearer(SECRET_KEY_B) },
      body: JSON.stringify({ color: 'green' }),
    })
    // Org A updates its own — must appear.
    await fetch(`${baseUrl}/preview/${a.body.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bearer(SECRET_KEY) },
      body: JSON.stringify({ color: 'navy' }),
    })

    assert.ok(await waitFor(() => sub.events.some((e) => e.type === 'update')))
    await sleep(60) // give any (erroneous) cross-tenant frame time to arrive
    const updates = sub.events.filter((e) => e.type === 'update')
    assert.equal(updates.length, 1)
    assert.deepEqual(updates[0].tokens, { color: 'navy' })

    sub.close()
    await sub.done
  })

  it('multiple concurrent subscribers on one preview all get the snapshot + final update', async () => {
    const { baseUrl } = await startServer({ hosted: true })
    const { body } = await createPreview(baseUrl, { seq: 0 }, SECRET_KEY)
    const { id } = body

    const subs = await Promise.all(
      Array.from({ length: 12 }, () => subscribe(baseUrl, ORG_A, id, PUBLISHABLE_KEY)),
    )
    for (const s of subs) assert.equal(s.status, 200)
    assert.ok(await waitFor(() => subs.every((s) => s.events.length >= 1)))

    await fetch(`${baseUrl}/preview/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...bearer(SECRET_KEY) },
      body: JSON.stringify({ seq: 1 }),
    })
    assert.ok(
      await waitFor(() =>
        subs.every((s) => s.events.some((e) => e.type === 'update' && e.tokens.seq === 1)),
      ),
    )

    for (const s of subs) s.close()
    await Promise.all(subs.map((s) => s.done))
  })
})
