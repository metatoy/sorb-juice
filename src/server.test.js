import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from './server.js'
import { createMemoryStore } from './store/memory.js'
import { loadConfig } from './config.js'

// Uses node:test (zero new deps) so `node --test` runs it in free local mode
// without installing vitest. Hono's `app.request()` is runner-agnostic.

// Track stores created per test so afterEach can clear their prune timers
// (otherwise the unref()'d setInterval would linger between tests).
const openStores = []

const makeApp = async () => {
  const config = loadConfig()
  const store = await createMemoryStore(config)
  openStores.push(store)
  return createServer({
    store,
    config,
    getLatestTokens: () => ({}),
    getResolvedTokens: () => null,
    getArtifactIndex: () => null,
    getArtifact: () => null,
  })
}

afterEach(async () => {
  while (openStores.length) {
    const store = openStores.pop()
    await store.close()
  }
})

const jsonInit = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const TIGHT_BUTTON = { storyId: 'kit-button--primary', bbox: { width: 82, height: 38, x: 0, y: 0 } }

describe('bridge /verify', () => {
  it('POST /verify stores a tight-button geometry and returns a string id', async () => {
    const app = await makeApp()
    const res = await app.request('/verify', jsonInit(TIGHT_BUTTON))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.id, 'string')
    assert.ok(body.id.length > 0)
  })
  it('GET /verify/latest reflects the most recent POST', async () => {
    const app = await makeApp()
    await app.request('/verify', jsonInit(TIGHT_BUTTON))
    const res = await app.request('/verify/latest')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.storyId, 'kit-button--primary')
    assert.equal(body.bbox.width, 82)
    assert.equal(body.bbox.height, 38)
  })
  it('GET /verify/:id returns the same entry that was POSTed', async () => {
    const app = await makeApp()
    const postRes = await app.request('/verify', jsonInit(TIGHT_BUTTON))
    const { id } = await postRes.json()
    const res = await app.request(`/verify/${id}`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.storyId, 'kit-button--primary')
    assert.equal(body.bbox.width, 82)
    assert.equal(body.bbox.height, 38)
  })
  it('GET /verify/:id returns 404 for an unknown id', async () => {
    const app = await makeApp()
    const res = await app.request('/verify/does-not-exist')
    assert.equal(res.status, 404)
  })
  it('tracks "latest" across multiple POSTs (newer wins)', async () => {
    const app = await makeApp()
    await app.request('/verify', jsonInit(TIGHT_BUTTON))
    await app.request('/verify', jsonInit({ storyId: 'kit-card--wide', bbox: { width: 1248, height: 320, x: 0, y: 0 } }))
    const res = await app.request('/verify/latest')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.bbox.width, 1248)
    assert.equal(body.storyId, 'kit-card--wide')
  })
  it('GET /health includes a numeric verifications count', async () => {
    const app = await makeApp()
    const res = await app.request('/health')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.verifications, 'number')
  })
  it('does not regress POST /preview — still returns { id, url }', async () => {
    const app = await makeApp()
    const res = await app.request('/preview', jsonInit({ '--btn-bg': '#abc' }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.id, 'string')
    assert.equal(typeof body.url, 'string')
    assert.ok(body.url.includes(body.id))
  })
})

describe('verify 404 before any report', () => {
  it('GET /verify/latest returns 404 on a fresh server with no verifications', async () => {
    const app = await makeApp()
    const res = await app.request('/verify/latest')
    assert.equal(res.status, 404)
  })
})
