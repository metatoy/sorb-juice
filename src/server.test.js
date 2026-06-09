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

// ── Project / org B: a SECOND, fully distinct tenant. Cross-tenant isolation
//    asserts that a key bound to A can never read/write/delete B's previews and
//    vice versa, and that B's usage never affects A's gates (and vice versa).
const PROJECT_B = '22222222-2222-2222-2222-222222222222'
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const SECRET_KEY = 'sk_secret_test'
const PUBLISHABLE_KEY = 'pk_publishable_test'
const SECRET_HASH = hashKey(SECRET_KEY)
const PUBLISHABLE_HASH = hashKey(PUBLISHABLE_KEY)

// Project-B keys (secret + publishable), distinct raw values ⇒ distinct hashes.
const SECRET_KEY_B = 'sk_secret_test_b'
const PUBLISHABLE_KEY_B = 'pk_publishable_test_b'
const SECRET_HASH_B = hashKey(SECRET_KEY_B)
const PUBLISHABLE_HASH_B = hashKey(PUBLISHABLE_KEY_B)

/**
 * Build a FAKE db whose query() routes on the SQL text. Overrides let each test
 * tune the entitlements row + active preview count, and force any tenant DB path
 * to throw so the server's fail-closed (503) behavior can be asserted.
 *
 * Ownership is recorded per-project as a Map<id, projectId> (NOT a Set), so the
 * `SELECT 1 FROM previews WHERE id=$1 AND project_id=$2` check is genuinely
 * tenant-scoped: an id owned by B is invisible to A and vice versa. INSERTs read
 * the project_id ($2) from the query params, so whichever key created a preview
 * is recorded as its owner.
 *
 * `query()` records every call into `db.calls` ([text, params] pairs) so tests
 * can assert that e.g. a revoked key never reaches the ownership SELECT.
 *
 * @param {Object} [opts]
 * @param {{plan:string,status:string,data:object}|null} [opts.entitlementsRow]
 *   Row returned by the entitlements SELECT, or null ⇒ 0 rows ⇒ FREE.
 * @param {number | ((projectId:string)=>number)} [opts.activeCount]
 *   count(*) for the previews count. A function is called with the project_id
 *   ($1) so per-tenant caps can be modeled independently.
 * @param {boolean} [opts.throwOnAuth] make the api_keys lookup throw (DB outage).
 * @param {boolean} [opts.throwOnEntitlements] make the entitlements lookup throw.
 * @param {boolean} [opts.throwOnCount] make the active-preview count throw.
 * @param {boolean} [opts.throwOnOwnership] make the `SELECT 1 FROM previews`
 *   ownership check throw (tenant-gate DB outage on GET/PUT/DELETE).
 * @param {boolean} [opts.throwOnVerifyTelemetry] make the verify_events INSERT
 *   throw — tests that best-effort telemetry failure does not fail the request.
 * @param {string[]} [opts.allowedOrigins] projects.allowed_origins.
 */
const makeFakeDb = (opts = {}) => {
  const {
    entitlementsRow = null,
    activeCount = 0,
    throwOnAuth = false,
    throwOnEntitlements = false,
    throwOnCount = false,
    throwOnOwnership = false,
    throwOnVerifyTelemetry = false,
    allowedOrigins = [],
  } = opts
  // Map<previewId, owningProjectId> — every preview's true tenant owner.
  const ownedPreviews = new Map()
  // Array of {projectId, storyId, boundFields} from verify_events INSERTs.
  const verifyEvents = []
  // Every query() invocation, for spying (e.g. "no ownership query was made").
  const calls = []
  return {
    ownedPreviews,
    verifyEvents,
    calls,
    async ping() {
      return true
    },
    async query(text, params) {
      calls.push([text, params])
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
        if (hash === SECRET_HASH_B) {
          return {
            rows: [
              {
                key_id: 'key-secret-b',
                type: 'secret',
                project_id: PROJECT_B,
                org_id: ORG_B,
                namespace: 'proj-b',
                allowed_origins: allowedOrigins,
              },
            ],
          }
        }
        if (hash === PUBLISHABLE_HASH_B) {
          return {
            rows: [
              {
                key_id: 'key-pub-b',
                type: 'publishable',
                project_id: PROJECT_B,
                org_id: ORG_B,
                namespace: 'proj-b',
                allowed_origins: allowedOrigins,
              },
            ],
          }
        }
        return { rows: [] } // unknown / revoked (indistinguishable by design)
      }
      // ── entitlements lookup ──
      if (text.includes('FROM entitlements')) {
        if (throwOnEntitlements) throw new Error('connection refused')
        return { rows: entitlementsRow ? [entitlementsRow] : [] }
      }
      // ── active preview count (project-scoped: params[0] = project_id) ──
      if (text.includes('count(*)') && text.includes('FROM previews')) {
        if (throwOnCount) throw new Error('connection refused')
        const n =
          typeof activeCount === 'function' ? activeCount(params[0]) : activeCount
        return { rows: [{ n }] }
      }
      // ── preview ownership check (tenant gate): id=$1 AND project_id=$2 ──
      if (text.startsWith('SELECT 1 FROM previews')) {
        if (throwOnOwnership) throw new Error('connection refused')
        const id = params[0]
        const proj = params[1]
        const owned = ownedPreviews.get(id) === proj
        return { rows: owned ? [{ '?column?': 1 }] : [] }
      }
      // ── bookkeeping INSERT: record (id → owning project_id from $2) ──
      if (text.startsWith('INSERT INTO previews')) {
        ownedPreviews.set(params[0], params[1])
        return { rows: [] }
      }
      // ── bookkeeping DELETE (tenant-scoped: only drop when project matches) ──
      if (text.startsWith('DELETE FROM previews')) {
        const id = params[0]
        const proj = params[1]
        if (ownedPreviews.get(id) === proj) ownedPreviews.delete(id)
        return { rows: [] }
      }
      // ── verify telemetry INSERT (best-effort; throwOnVerifyTelemetry tests
      //    that a failure here does not fail the /verify request itself) ──
      if (text.startsWith('INSERT INTO verify_events')) {
        if (throwOnVerifyTelemetry) throw new Error('verify_events insert failed')
        verifyEvents.push({ projectId: params[0], storyId: params[1], boundFields: params[2] })
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
const putAuth = (body, key) => ({
  method: 'PUT',
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

describe('hosted mode — cross-tenant isolation', () => {
  // A single hosted app + fake db shared by both tenants A and B. Key A and
  // key B hit the SAME server; the db ownership Map is the only thing that keeps
  // their previews apart, so this exercises the real tenant gate end to end.
  const A_BG = '#aaaaaa'
  const ORIGINAL_TOKENS = { '--btn-bg': A_BG }
  const seedAsA = async (app) => {
    const post = await app.request('/preview', jsonAuth(ORIGINAL_TOKENS, SECRET_KEY))
    assert.equal(post.status, 200)
    const { id } = await post.json()
    return id
  }

  it('READ isolation: B GET on A\'s preview → 404, byte-identical to a truly-absent id (no existence leak)', async () => {
    const { app } = await makeHostedApp()
    const id = await seedAsA(app)

    const foreign = await app.request(`/preview/${id}`, { headers: bearer(SECRET_KEY_B) })
    const absent = await app.request('/preview/totally-absent-id', { headers: bearer(SECRET_KEY_B) })

    assert.equal(foreign.status, 404)
    assert.equal(absent.status, 404)
    // Existence-leak parity: same status AND byte-identical body — B cannot tell
    // "A owns this" apart from "no such preview".
    assert.equal(foreign.status, absent.status)
    assert.deepEqual(await foreign.json(), await absent.json())
  })

  it('READ isolation: A still sees its OWN preview (200, original tokens)', async () => {
    const { app } = await makeHostedApp()
    const id = await seedAsA(app)
    const res = await app.request(`/preview/${id}`, { headers: bearer(SECRET_KEY) })
    assert.equal(res.status, 200)
    const tokens = await res.json()
    assert.equal(tokens['--btn-bg'], A_BG)
  })

  it('PUT isolation: B PUT on A\'s preview → 404 and A\'s tokens are UNCHANGED', async () => {
    const { app } = await makeHostedApp()
    const id = await seedAsA(app)

    const put = await app.request(`/preview/${id}`, putAuth({ '--btn-bg': '#000000' }, SECRET_KEY_B))
    assert.equal(put.status, 404)

    // No cross-tenant mutation: A reads its original value back.
    const after = await app.request(`/preview/${id}`, { headers: bearer(SECRET_KEY) })
    assert.equal(after.status, 200)
    assert.equal((await after.json())['--btn-bg'], A_BG)
  })

  it('DELETE isolation: B DELETE on A\'s preview → 404 and A\'s preview survives', async () => {
    const { app, db } = await makeHostedApp()
    const id = await seedAsA(app)

    const del = await app.request(`/preview/${id}`, { method: 'DELETE', headers: bearer(SECRET_KEY_B) })
    assert.equal(del.status, 404)

    // No cross-tenant deletion: ownership row intact + A can still read it.
    assert.equal(db.ownedPreviews.get(id), PROJECT_A)
    const after = await app.request(`/preview/${id}`, { headers: bearer(SECRET_KEY) })
    assert.equal(after.status, 200)
  })

  it('store-has-but-not-owned: GET/PUT/DELETE all 404 even when the store entry exists', async () => {
    // Store entry present, but no ownership row for B ⇒ the db gate (not the
    // store) decides. All three verbs must 404.
    const config = loadConfig({ ...process.env, DATABASE_URL: 'postgres://fake/db' })
    const store = await createMemoryStore(config)
    openStores.push(store)
    await store.putPreview('shared-id', { '--x': '1' })
    const db = makeFakeDb() // ownership Map empty
    const app = createServer({ store, config, db })

    const get = await app.request('/preview/shared-id', { headers: bearer(SECRET_KEY_B) })
    assert.equal(get.status, 404)
    const put = await app.request('/preview/shared-id', putAuth({ '--x': '2' }, SECRET_KEY_B))
    assert.equal(put.status, 404)
    const del = await app.request('/preview/shared-id', { method: 'DELETE', headers: bearer(SECRET_KEY_B) })
    assert.equal(del.status, 404)
  })

  it('scope vs tenancy compose: publishable-A on B\'s preview → 404 (tenant gate); publishable-A on A\'s own → 403 read_only (scope gate)', async () => {
    const { app } = await makeHostedApp()
    const id = await seedAsA(app)

    // A publishable key for project B reading A's preview: tenant gate ⇒ 404
    // (not 403, not 200) — tenancy is enforced independently of read scope.
    const crossTenantRead = await app.request(`/preview/${id}`, { headers: bearer(PUBLISHABLE_KEY_B) })
    assert.equal(crossTenantRead.status, 404)

    // A publishable key for project A WRITING A's own preview: scope gate ⇒ 403.
    const ownWrite = await app.request(`/preview/${id}`, putAuth({ '--btn-bg': '#111111' }, PUBLISHABLE_KEY))
    assert.equal(ownWrite.status, 403)
    assert.equal((await ownWrite.json()).code, 'read_only')
  })

  it('revoked / unknown key → 401 and never reaches the tenant ownership query', async () => {
    const { app, db } = await makeHostedApp()
    const id = await seedAsA(app)
    db.calls.length = 0 // reset spy after seeding

    const res = await app.request(`/preview/${id}`, { headers: bearer('sk_revoked_or_unknown') })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).code, 'unauthorized')

    // Auth failed up front: no ownership SELECT was ever attempted.
    const ownershipQueried = db.calls.some(([text]) => text.startsWith('SELECT 1 FROM previews'))
    assert.equal(ownershipQueried, false)
  })

  it('fail-closed: ownership SELECT throws → GET/PUT/DELETE all 503 db_unavailable (never 404/200, no cross-tenant open)', async () => {
    const config = loadConfig({ ...process.env, DATABASE_URL: 'postgres://fake/db' })
    const store = await createMemoryStore(config)
    openStores.push(store)
    await store.putPreview('some-id', { '--x': '1' })
    const db = makeFakeDb({ throwOnOwnership: true })
    const app = createServer({ store, config, db })

    const get = await app.request('/preview/some-id', { headers: bearer(SECRET_KEY) })
    assert.equal(get.status, 503)
    assert.equal((await get.json()).code, 'db_unavailable')

    const put = await app.request('/preview/some-id', putAuth({ '--x': '2' }, SECRET_KEY))
    assert.equal(put.status, 503)
    assert.equal((await put.json()).code, 'db_unavailable')

    const del = await app.request('/preview/some-id', { method: 'DELETE', headers: bearer(SECRET_KEY) })
    assert.equal(del.status, 503)
    assert.equal((await del.json()).code, 'db_unavailable')
  })

  it('fail-closed: entitlements lookup throws → POST /preview → 503 db_unavailable', async () => {
    const { app } = await makeHostedApp({ throwOnEntitlements: true })
    const res = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    assert.equal(res.status, 503)
    assert.equal((await res.json()).code, 'db_unavailable')
  })

  it('fail-closed: active-preview count throws → POST /preview → 503 db_unavailable', async () => {
    // Capped plan ⇒ the count path runs; force it to throw.
    const { app } = await makeHostedApp({
      entitlementsRow: { plan: 'team', status: 'active', data: { maxActivePreviews: 3 } },
      throwOnCount: true,
    })
    const res = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    assert.equal(res.status, 503)
    assert.equal((await res.json()).code, 'db_unavailable')
  })

  it('count isolation: A at its cap does NOT block B (count is project-scoped on $1)', async () => {
    // Same capped entitlements row for both orgs (FREE fallback would be -1 =
    // unlimited and skip the count entirely, so give both a finite cap). A is
    // already at the cap; B is empty. The count query reads project_id ($1), so
    // A → 3 (blocked), B → 0 (allowed).
    const { app, db } = await makeHostedApp({
      entitlementsRow: { plan: 'team', status: 'active', data: { maxActivePreviews: 3 } },
      activeCount: (projectId) => (projectId === PROJECT_A ? 3 : 0),
    })

    const aRes = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY))
    assert.equal(aRes.status, 402)
    assert.equal((await aRes.json()).code, 'preview_limit')

    const bRes = await app.request('/preview', jsonAuth({ '--btn-bg': '#abc' }, SECRET_KEY_B))
    assert.equal(bRes.status, 200)

    // Defense-in-depth: the count query that allowed B was scoped to B's project.
    const countCallForB = db.calls.some(
      ([text, params]) =>
        text.includes('count(*)') && text.includes('FROM previews') && params[0] === PROJECT_B,
    )
    assert.equal(countCallForB, true)
  })
})

// ─── LOCAL MODE — P0.3b cross-site write guard (C2 CSRF drive-by) ─────────────
// The local (no-auth, open-CORS) bridge must reject cross-site browser writes
// to /preview* from untrusted web origins, WITHOUT breaking the two legitimate
// writers: the leaf SDK (same-site localhost) and the Figma plugin (Origin:
// null / figma.com). Reads (GET) are never blocked. Hosted mode is unaffected.
describe('local mode — cross-site write guard (C2)', () => {
  // A write with explicit Origin + Sec-Fetch-Site headers, like a browser sends.
  const writeWith = (method, headers, body = { '--btn-bg': '#abc' }) => ({
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

  it('(a) POST /preview from a cross-site untrusted origin → 403', async () => {
    const app = await makeApp()
    const res = await app.request(
      '/preview',
      writeWith('POST', { Origin: 'https://evil.com', 'Sec-Fetch-Site': 'cross-site' }),
    )
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'cross-site write blocked')
  })

  it('(b) POST /preview with Origin: null (sandboxed Figma plugin) → allowed', async () => {
    const app = await makeApp()
    const res = await app.request(
      '/preview',
      writeWith('POST', { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }),
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.id, 'string')
  })

  it('(c1) POST /preview with Sec-Fetch-Site: same-site (leaf SDK) → allowed', async () => {
    const app = await makeApp()
    const res = await app.request(
      '/preview',
      writeWith('POST', { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-site' }),
    )
    assert.equal(res.status, 200)
  })

  it('(c2) POST /preview from a localhost origin (SDK) is allowlisted even if Sec-Fetch-Site says cross-site', async () => {
    const app = await makeApp()
    const res = await app.request(
      '/preview',
      writeWith('POST', { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'cross-site' }),
    )
    assert.equal(res.status, 200)
  })

  it('(d) POST /preview with NO Origin header (curl) → allowed', async () => {
    const app = await makeApp()
    const res = await app.request('/preview', jsonInit({ '--btn-bg': '#abc' }))
    assert.equal(res.status, 200)
  })

  it('(e) POST /preview with Origin: https://www.figma.com → allowed', async () => {
    const app = await makeApp()
    const res = await app.request(
      '/preview',
      writeWith('POST', { Origin: 'https://www.figma.com', 'Sec-Fetch-Site': 'cross-site' }),
    )
    assert.equal(res.status, 200)
  })

  it('(f) GET /preview/:id is NEVER blocked by the guard (cross-site read passes)', async () => {
    const app = await makeApp()
    // Seed a preview, then read it cross-site — read must not 403.
    const post = await app.request('/preview', jsonInit({ '--btn-bg': '#abc' }))
    const { id } = await post.json()
    const res = await app.request(`/preview/${id}`, {
      headers: { Origin: 'https://evil.com', 'Sec-Fetch-Site': 'cross-site' },
    })
    assert.equal(res.status, 200)
    assert.equal((await res.json())['--btn-bg'], '#abc')
  })

  it('PUT /preview/:id cross-site untrusted origin → 403', async () => {
    const app = await makeApp()
    const post = await app.request('/preview', jsonInit({ '--btn-bg': '#abc' }))
    const { id } = await post.json()
    const res = await app.request(
      `/preview/${id}`,
      writeWith('PUT', { Origin: 'https://evil.com', 'Sec-Fetch-Site': 'cross-site' }),
    )
    assert.equal(res.status, 403)
    assert.equal((await res.json()).error, 'cross-site write blocked')
  })

  it('DELETE /preview/:id cross-site untrusted origin → 403', async () => {
    const app = await makeApp()
    const post = await app.request('/preview', jsonInit({ '--btn-bg': '#abc' }))
    const { id } = await post.json()
    const res = await app.request(`/preview/${id}`, {
      method: 'DELETE',
      headers: { Origin: 'https://evil.com', 'Sec-Fetch-Site': 'cross-site' },
    })
    assert.equal(res.status, 403)
  })

  it('config.allowedWriteOrigins extends the allowlist (a staging origin is allowed)', async () => {
    const config = loadConfig()
    const store = await createMemoryStore({ ...config, allowedWriteOrigins: ['https://staging.example.com'] })
    openStores.push(store)
    const app = createServer({
      store,
      config: { ...config, allowedWriteOrigins: ['https://staging.example.com'] },
    })
    const res = await app.request(
      '/preview',
      writeWith('POST', { Origin: 'https://staging.example.com', 'Sec-Fetch-Site': 'cross-site' }),
    )
    assert.equal(res.status, 200)
  })

  it('(g) hosted mode is UNAFFECTED by the local guard (cross-site write reaches auth → 401, not the 403 guard)', async () => {
    // In hosted mode the guard is never registered. A cross-site write with NO
    // key hits the hosted auth middleware first → 401 unauthorized, proving the
    // local 403 "cross-site write blocked" guard did not run.
    const { app } = await makeHostedApp()
    const res = await app.request(
      '/preview',
      writeWith('POST', { Origin: 'https://evil.com', 'Sec-Fetch-Site': 'cross-site' }),
    )
    assert.equal(res.status, 401)
    assert.equal((await res.json()).code, 'unauthorized')
  })
})

// ─── HOSTED MODE — verify telemetry (R-0607-16 moat-proof instrumentation) ──
// POST /verify in hosted mode writes a best-effort verify_events row so the
// beta can measure weekly active verify runs per project. A DB failure on the
// telemetry INSERT must NOT fail the request (best-effort, like preview bookkeeping).
describe('hosted mode — verify telemetry', () => {
  const VERIFY_PAYLOAD = {
    storyId: 'kit-button--primary',
    bbox: { width: 82, height: 38, x: 0, y: 0 },
    meta: { boundFields: 3 },
  }

  it('POST /verify inserts a verify_events row with correct project_id and storyId', async () => {
    const { app, db } = await makeHostedApp()
    const res = await app.request('/verify', jsonAuth(VERIFY_PAYLOAD, SECRET_KEY))
    assert.equal(res.status, 200)
    assert.equal(db.verifyEvents.length, 1)
    assert.equal(db.verifyEvents[0].projectId, PROJECT_A)
    assert.equal(db.verifyEvents[0].storyId, 'kit-button--primary')
    assert.equal(db.verifyEvents[0].boundFields, 3)
  })

  it('POST /verify still returns 200 when the telemetry INSERT throws (best-effort)', async () => {
    const { app, db } = await makeHostedApp({ throwOnVerifyTelemetry: true })
    const res = await app.request('/verify', jsonAuth(VERIFY_PAYLOAD, SECRET_KEY))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.id, 'string')
    // No verify_events row recorded (insert threw before push).
    assert.equal(db.verifyEvents.length, 0)
  })

  it('POST /verify with null meta records null boundFields', async () => {
    const { app, db } = await makeHostedApp()
    const res = await app.request(
      '/verify',
      jsonAuth({ storyId: 'kit-icon', bbox: { width: 24, height: 24 } }, SECRET_KEY),
    )
    assert.equal(res.status, 200)
    assert.equal(db.verifyEvents.length, 1)
    assert.equal(db.verifyEvents[0].boundFields, null)
  })

  it('POST /verify does NOT write to verify_events in local (non-hosted) mode', async () => {
    // makeApp() creates a local (no DATABASE_URL) server — the db is null.
    const app = await makeApp()
    const res = await app.request(
      '/verify',
      jsonInit({ storyId: 'kit-button--primary', bbox: { width: 82, height: 38 } }),
    )
    assert.equal(res.status, 200)
    // No db in local mode — just checking the request succeeds without touching db.
    const body = await res.json()
    assert.equal(typeof body.id, 'string')
  })

  it('POST /verify requires write scope in hosted mode (publishable key → 403)', async () => {
    const { app } = await makeHostedApp()
    const res = await app.request('/verify', jsonAuth(VERIFY_PAYLOAD, PUBLISHABLE_KEY))
    assert.equal(res.status, 403)
    assert.equal((await res.json()).code, 'read_only')
  })
})
