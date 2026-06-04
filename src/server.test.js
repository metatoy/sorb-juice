import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from './server.js'
import { createMemoryStore } from './store/memory.js'
import { loadConfig } from './config.js'
import { hashKey } from './auth.js'

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

// ─── HOSTED MODE ─────────────────────────────────────────────────────────────
// config.databaseUrl set ⇒ auth + entitlements enforced. We never touch a real
// Postgres: a FAKE db routes on SQL text and returns canned api_keys/projects/
// entitlements/previews rows. The auth + entitlements modules take the db as an
// injected arg, so this is exact.

const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const SECRET_KEY = 'sk_secret_test'
const PUBLISHABLE_KEY = 'pk_publishable_test'
const SECRET_HASH = hashKey(SECRET_KEY)
const PUBLISHABLE_HASH = hashKey(PUBLISHABLE_KEY)

/**
 * Build a FAKE db whose query() routes on the SQL text. Overrides let each test
 * tune the entitlements row + active preview count.
 *
 * @param {Object} [opts]
 * @param {{plan:string,status:string,data:object}|null} [opts.entitlementsRow]
 *   Row returned by the entitlements SELECT, or null ⇒ 0 rows ⇒ FREE.
 * @param {number} [opts.activeCount] count(*) returned for the previews count.
 * @param {boolean} [opts.throwOnAuth] make the api_keys lookup throw (DB outage).
 * @param {string[]} [opts.allowedOrigins] projects.allowed_origins.
 */
const makeFakeDb = (opts = {}) => {
  const {
    entitlementsRow = null,
    activeCount = 0,
    throwOnAuth = false,
    allowedOrigins = [],
  } = opts
  // Ids of previews INSERTed during the test, so ownership SELECTs can succeed.
  const ownedPreviews = new Set()
  return {
    ownedPreviews,
    async ping() {
      return true
    },
    async query(text, params) {
      if (throwOnAuth && text.includes('FROM api_keys')) {
        throw new Error('connection refused')
      }
      // ── auth: api_keys JOIN projects ──
      if (text.includes('FROM api_keys')) {
        const hash = params[0]
        if (hash === SECRET_HASH) {
          return {
            rows: [
              {
                key_id: 'key-secret',
                type: 'secret',
                project_id: PROJECT_A,
                org_id: ORG_A,
                namespace: 'proj-a',
                allowed_origins: allowedOrigins,
              },
            ],
          }
        }
        if (hash === PUBLISHABLE_HASH) {
          return {
            rows: [
              {
                key_id: 'key-pub',
                type: 'publishable',
                project_id: PROJECT_A,
                org_id: ORG_A,
                namespace: 'proj-a',
                allowed_origins: allowedOrigins,
              },
            ],
          }
        }
        return { rows: [] } // unknown / revoked
      }
      // ── entitlements lookup ──
      if (text.includes('FROM entitlements')) {
        return { rows: entitlementsRow ? [entitlementsRow] : [] }
      }
      // ── active preview count ──
      if (text.includes('count(*)') && text.includes('FROM previews')) {
        return { rows: [{ n: activeCount }] }
      }
      // ── preview ownership check ──
      if (text.startsWith('SELECT 1 FROM previews')) {
        const id = params[0]
        const proj = params[1]
        return { rows: ownedPreviews.has(id) && proj === PROJECT_A ? [{ '?column?': 1 }] : [] }
      }
      // ── bookkeeping INSERT ──
      if (text.startsWith('INSERT INTO previews')) {
        ownedPreviews.add(params[0])
        return { rows: [] }
      }
      // ── bookkeeping DELETE ──
      if (text.startsWith('DELETE FROM previews')) {
        ownedPreviews.delete(params[0])
        return { rows: [] }
      }
      return { rows: [] }
    },
  }
}

const makeHostedApp = async (dbOpts = {}) => {
  // databaseUrl is the hosted switch; loadConfig reads it from env.
  const config = loadConfig({ ...process.env, DATABASE_URL: 'postgres://fake/db' })
  const store = await createMemoryStore(config)
  openStores.push(store)
  const db = makeFakeDb(dbOpts)
  const app = createServer({ store, config, db })
  return { app, db }
}

const bearer = (key) => ({ Authorization: `Bearer ${key}` })
const jsonAuth = (body, key) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...bearer(key) },
  body: JSON.stringify(body),
})

describe('hosted mode — auth', () => {
  it('infra probes stay open without a key', async () => {
    const { app } = await makeHostedApp()
    assert.equal((await app.request('/health')).status, 200)
    assert.equal((await app.request('/ready')).status, 200)
  })

  it('401 on a protected route with NO key', async () => {
    const { app } = await makeHostedApp()
    const res = await app.request('/preview', jsonInit({ '--btn-bg': '#abc' }))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.code, 'unauthorized')
  })

  it('401 on an unknown / revoked key', async () => {
    const { app } = await makeHostedApp()
    const res = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, 'sk_bogus'))
    assert.equal(res.status, 401)
  })

  it('200 with a valid SECRET key on POST /preview', async () => {
    const { app } = await makeHostedApp()
    const res = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.id, 'string')
    assert.ok(body.url.includes(body.id))
  })

  it('503 (fail closed) when the auth db lookup throws', async () => {
    const { app } = await makeHostedApp({ throwOnAuth: true })
    const res = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.code, 'db_unavailable')
  })
})

describe('hosted mode — scope (publishable = read-only)', () => {
  it('403 when a PUBLISHABLE key attempts a write (POST /preview)', async () => {
    const { app } = await makeHostedApp()
    const res = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, PUBLISHABLE_KEY))
    assert.equal(res.status, 403)
    const body = await res.json()
    assert.equal(body.code, 'read_only')
  })

  it('403 when a PUBLISHABLE key attempts POST /verify', async () => {
    const { app } = await makeHostedApp()
    const res = await app.request('/verify', jsonAuth(TIGHT_BUTTON, PUBLISHABLE_KEY))
    assert.equal(res.status, 403)
  })

  it('publishable key MAY GET its own /preview/:id', async () => {
    const { app, db } = await makeHostedApp()
    // Seed a preview via a secret key first.
    const post = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    const { id } = await post.json()
    assert.ok(db.ownedPreviews.has(id))
    const res = await app.request(`/preview/${id}`, { headers: bearer(PUBLISHABLE_KEY) })
    assert.equal(res.status, 200)
    const tokens = await res.json()
    assert.equal(tokens['--btn-bg'], '#abc')
  })
})

describe('hosted mode — entitlements enforcement', () => {
  it('402 (preview_limit) when over maxActivePreviews', async () => {
    // Team-ish row that caps active previews at 3, with 3 already active.
    const { app } = await makeHostedApp({
      entitlementsRow: {
        plan: 'team',
        status: 'active',
        data: { maxActivePreviews: 3, previewPersistence: true, previewSharing: true },
      },
      activeCount: 3,
    })
    const res = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    assert.equal(res.status, 402)
    const body = await res.json()
    assert.equal(body.code, 'preview_limit')
    assert.equal(typeof body.upgradeUrl, 'string')
  })

  it('allows POST /preview when under the cap', async () => {
    const { app } = await makeHostedApp({
      entitlementsRow: {
        plan: 'team',
        status: 'active',
        data: { maxActivePreviews: 3 },
      },
      activeCount: 2,
    })
    const res = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    assert.equal(res.status, 200)
  })

  it('FREE (no row) has unlimited count (-1) — never 402 on count', async () => {
    const { app } = await makeHostedApp({ activeCount: 9999 })
    const res = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    assert.equal(res.status, 200)
  })

  it('past_due Team degrades to Free gates (sharing locked → 402)', async () => {
    const { app } = await makeHostedApp({
      entitlementsRow: {
        plan: 'team',
        status: 'past_due',
        data: { previewSharing: true, maxActivePreviews: 10 },
      },
    })
    const res = await app.request('/preview?share=1', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    assert.equal(res.status, 402)
    const body = await res.json()
    assert.equal(body.code, 'sharing_locked')
  })
})

describe('hosted mode — scoped CORS', () => {
  // Regression: Hono's cors() evaluates its origin callback BEFORE next(), so
  // auth must run before cors or c.get('auth') is undefined and the real
  // (keyed) cross-origin response never gets an Access-Control-Allow-Origin
  // header. These assert the ACAO header on the actual request, not preflight.
  it('echoes ACAO for a keyed request from an allowed origin', async () => {
    const { app } = await makeHostedApp({ allowedOrigins: ['https://app.example.com'] })
    const res = await app.request('/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://app.example.com',
        ...bearer(SECRET_KEY),
      },
      body: JSON.stringify({ '--btn-bg': '#abc' }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com')
  })

  it('omits ACAO for a keyed request from a non-allowed origin', async () => {
    const { app } = await makeHostedApp({ allowedOrigins: ['https://app.example.com'] })
    const res = await app.request('/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
        ...bearer(SECRET_KEY),
      },
      body: JSON.stringify({ '--btn-bg': '#abc' }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })

  it('answers OPTIONS preflight without requiring a key (no 401)', async () => {
    const { app } = await makeHostedApp({ allowedOrigins: ['https://app.example.com'] })
    const res = await app.request('/preview', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    })
    assert.notEqual(res.status, 401)
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example.com')
  })
})

describe('hosted mode — tenant isolation', () => {
  it('GET /preview/:id returns 404 when the preview exists in the store but is NOT the tenant\'s', async () => {
    // The store HAS the entry (so the store check passes) but the db ownership
    // table does not (foreign tenant) ⇒ the tenant gate returns 404 without
    // revealing cross-tenant existence.
    const config = loadConfig({ ...process.env, DATABASE_URL: 'postgres://fake/db' })
    const store = await createMemoryStore(config)
    openStores.push(store)
    await store.putPreview('foreign-id', { '--x': '1' })
    const db = makeFakeDb() // ownedPreviews empty ⇒ not owned by PROJECT_A
    const app = createServer({ store, config, db })
    const res = await app.request('/preview/foreign-id', { headers: bearer(SECRET_KEY) })
    assert.equal(res.status, 404)
  })
})
