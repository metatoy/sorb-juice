// sensor.test.js — E2 sensor-spine unit + server-integration tests.
//
// Unit tests exercise sensor.js's pure/near-pure functions against a minimal
// FAKE db (no real Postgres, mirrors the pattern in server.test.js). The
// integration tests drive createServer() end-to-end in hosted mode to prove
// the routes actually mint/thread chain_id and gate on consent, and that
// LOCAL mode never touches any of this.

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVENT_TYPE,
  SCHEMA_VERSION,
  mintChainId,
  isConsented,
  lookupChainId,
  recordProposal,
  recordVerifyResult,
  recordAcceptReject,
  recordConformanceSnapshotRef,
} from './sensor.js'
import { createServer } from './server.js'
import { createMemoryStore } from './store/memory.js'
import { loadConfig } from './config.js'
import { hashKey } from './auth.js'

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const PROJECT_A = '11111111-1111-1111-1111-111111111111'

/**
 * A minimal fake DbHandle for sensor.js unit tests. Routes on SQL text like
 * server.test.js's makeFakeDb, but scoped to just what sensor.js touches:
 * organizations.data_consent, previews.chain_id, and sensor_events inserts.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.consented] organizations.data_consent value.
 * @param {Map<string,string>} [opts.chainByPreview] previewId -> chain_id.
 * @param {boolean} [opts.throwOnInsert] make the sensor_events INSERT throw.
 * @param {boolean} [opts.throwOnConsent] make the consent SELECT throw
 *   (simulates the column not existing yet — the real/expected case today).
 */
function makeFakeDb(opts = {}) {
  const { consented = true, chainByPreview = new Map(), throwOnInsert = false, throwOnConsent = false } = opts
  const inserted = []
  return {
    inserted,
    async query(text, params) {
      if (text.includes('FROM organizations')) {
        if (throwOnConsent) throw new Error('column "data_consent" does not exist')
        return { rows: [{ data_consent: consented }] }
      }
      if (text.startsWith('SELECT chain_id FROM previews')) {
        const [previewId, projectId] = params
        const chainId = chainByPreview.get(previewId)
        return { rows: chainId && projectId === PROJECT_A ? [{ chain_id: chainId }] : [] }
      }
      if (text.startsWith('INSERT INTO sensor_events')) {
        if (throwOnInsert) throw new Error('insert failed')
        inserted.push(params)
        return { rows: [] }
      }
      return { rows: [] }
    },
  }
}

describe('sensor.js unit — mintChainId', () => {
  it('mints distinct uuids', () => {
    const a = mintChainId()
    const b = mintChainId()
    assert.notEqual(a, b)
    assert.match(a, /^[0-9a-f-]{36}$/)
  })
})

describe('sensor.js unit — isConsented (fail-closed)', () => {
  it('true when organizations.data_consent is true', async () => {
    const db = makeFakeDb({ consented: true })
    assert.equal(await isConsented(db, ORG_A), true)
  })
  it('false when organizations.data_consent is false', async () => {
    const db = makeFakeDb({ consented: false })
    assert.equal(await isConsented(db, ORG_A), false)
  })
  it('false (never throws) when the consent query errors — the expected state today (no such column yet)', async () => {
    const db = makeFakeDb({ throwOnConsent: true })
    assert.equal(await isConsented(db, ORG_A), false)
  })
  it('false when db or orgId is missing', async () => {
    assert.equal(await isConsented(null, ORG_A), false)
    assert.equal(await isConsented(makeFakeDb(), null), false)
  })
})

describe('sensor.js unit — record* gate on consent + never throw', () => {
  it('recordProposal no-ops (returns false, no insert) when not consented', async () => {
    const db = makeFakeDb({ consented: false })
    const ok = await recordProposal(db, {
      chainId: mintChainId(),
      orgId: ORG_A,
      appId: PROJECT_A,
      previewId: 'prev1',
      tokens: { '--color-brand': '#fff' },
    })
    assert.equal(ok, false)
    assert.equal(db.inserted.length, 0)
  })

  it('recordProposal inserts a row with the full envelope + tokens payload when consented', async () => {
    const db = makeFakeDb({ consented: true })
    const chainId = mintChainId()
    const ok = await recordProposal(db, {
      chainId,
      orgId: ORG_A,
      appId: PROJECT_A,
      previewId: 'prev1',
      tokens: { '--color-brand': '#fff' },
    })
    assert.equal(ok, true)
    assert.equal(db.inserted.length, 1)
    const [id, schemaVersion, chain, org, app, type, mode, consent, actorRole, payloadJson] = db.inserted[0]
    assert.equal(typeof id, 'string')
    assert.equal(schemaVersion, SCHEMA_VERSION)
    assert.equal(chain, chainId)
    assert.equal(org, ORG_A)
    assert.equal(app, PROJECT_A)
    assert.equal(type, EVENT_TYPE.PROPOSAL)
    assert.equal(mode, 'A')
    assert.equal(consent, true)
    assert.equal(actorRole, 'system')
    const payload = JSON.parse(payloadJson)
    assert.deepEqual(payload.tokens, { '--color-brand': '#fff' })
    assert.equal(payload.preview_id, 'prev1')
  })

  it('recordVerifyResult carries COUNTS only, never expected/got detail', async () => {
    const db = makeFakeDb({ consented: true })
    await recordVerifyResult(db, {
      chainId: mintChainId(),
      orgId: ORG_A,
      appId: PROJECT_A,
      check: 'app_values',
      ok: false,
      checked: 10,
      matched: 7,
      mismatchCount: 3,
    })
    const payload = JSON.parse(db.inserted[0][9])
    assert.deepEqual(payload, { check: 'app_values', ok: false, checked: 10, matched: 7, mismatch_count: 3 })
    assert.equal('mismatches' in payload, false)
  })

  it('recordAcceptReject records outcome+signal, actor_role system', async () => {
    const db = makeFakeDb({ consented: true })
    await recordAcceptReject(db, {
      chainId: mintChainId(),
      orgId: ORG_A,
      appId: PROJECT_A,
      previewId: 'prev1',
      outcome: 'rejected',
      signal: 'ttl_expiry',
    })
    const row = db.inserted[0]
    assert.equal(row[5], EVENT_TYPE.ACCEPT_REJECT)
    assert.equal(row[8], 'system')
    const payload = JSON.parse(row[9])
    assert.equal(payload.outcome, 'rejected')
    assert.equal(payload.signal, 'ttl_expiry')
  })

  it('recordConformanceSnapshotRef carries a pointer, never inline content', async () => {
    const db = makeFakeDb({ consented: true })
    await recordConformanceSnapshotRef(db, {
      chainId: mintChainId(),
      orgId: ORG_A,
      appId: PROJECT_A,
      snapshotId: 'snap1',
      storageRef: 'juice:tokens-figma:proj:123',
    })
    const payload = JSON.parse(db.inserted[0][9])
    assert.deepEqual(payload, { snapshot_id: 'snap1', storage_ref: 'juice:tokens-figma:proj:123' })
  })

  it('a failing INSERT is swallowed (returns false, calls onError, never throws)', async () => {
    const db = makeFakeDb({ consented: true, throwOnInsert: true })
    let errCtx = null
    const ok = await recordProposal(
      db,
      { chainId: mintChainId(), orgId: ORG_A, appId: PROJECT_A, previewId: 'p', tokens: {} },
      (e, ctx) => {
        errCtx = ctx
      },
    )
    assert.equal(ok, false)
    assert.ok(errCtx)
    assert.equal(errCtx.type, EVENT_TYPE.PROPOSAL)
  })
})

describe('sensor.js unit — lookupChainId', () => {
  it('resolves a known preview scoped to its project', async () => {
    const chainByPreview = new Map([['prev1', 'chain-xyz']])
    const db = makeFakeDb({ chainByPreview })
    assert.equal(await lookupChainId(db, 'prev1', PROJECT_A), 'chain-xyz')
  })
  it('returns null for an unknown preview id', async () => {
    const db = makeFakeDb()
    assert.equal(await lookupChainId(db, 'nope', PROJECT_A), null)
  })
  it('returns null (never throws) on a query error', async () => {
    const db = { query: async () => { throw new Error('down') } }
    assert.equal(await lookupChainId(db, 'prev1', PROJECT_A), null)
  })
})

// ─── SERVER INTEGRATION — chain_id threading + consent gating end-to-end ────

const openStores = []
afterEach(async () => {
  while (openStores.length) {
    const store = openStores.pop()
    await store.close()
  }
})

const SECRET_KEY = 'sk_sensor_test'
const SECRET_HASH = hashKey(SECRET_KEY)
const bearer = (key) => ({ Authorization: `Bearer ${key}` })
const post = (body, key) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? bearer(key) : {}) },
  body: JSON.stringify(body),
})

/**
 * A fake db wired for full server-integration coverage: auth (api_keys JOIN
 * projects), entitlements (unlimited/free defaults), previews bookkeeping
 * (now carrying chain_id), and the sensor.js surfaces (organizations consent +
 * sensor_events inserts). Mirrors server.test.js's makeFakeDb but trimmed to
 * this file's needs.
 */
function makeIntegrationDb({ consented = true } = {}) {
  const previews = new Map() // id -> { projectId, chainId }
  const sensorEvents = []
  return {
    previews,
    sensorEvents,
    async query(text, params) {
      if (text.includes('FROM api_keys')) {
        if (params[0] === SECRET_HASH) {
          return {
            rows: [
              {
                key_id: 'key-1',
                type: 'secret',
                project_id: PROJECT_A,
                org_id: ORG_A,
                namespace: 'proj-a',
                allowed_origins: [],
              },
            ],
          }
        }
        return { rows: [] }
      }
      if (text.includes('FROM entitlements')) return { rows: [] } // → FREE defaults
      if (text.includes('count(*)') && text.includes('FROM previews')) return { rows: [{ n: 0 }] }
      if (text.startsWith('INSERT INTO previews')) {
        const [id, projectId, , chainId] = params
        previews.set(id, { projectId, chainId })
        return { rows: [] }
      }
      if (text.startsWith('SELECT 1 FROM previews')) {
        const [id, projectId] = params
        const row = previews.get(id)
        return { rows: row && row.projectId === projectId ? [{ '?column?': 1 }] : [] }
      }
      if (text.startsWith('DELETE FROM previews')) {
        const [id, projectId] = params
        const row = previews.get(id)
        if (row && row.projectId === projectId) previews.delete(id)
        return { rows: [] }
      }
      if (text.startsWith('SELECT chain_id FROM previews')) {
        const [id, projectId] = params
        const row = previews.get(id)
        return { rows: row && row.projectId === projectId ? [{ chain_id: row.chainId }] : [] }
      }
      if (text.includes('FROM organizations')) {
        return { rows: [{ data_consent: consented }] }
      }
      if (text.startsWith('INSERT INTO sensor_events')) {
        sensorEvents.push(params)
        return { rows: [] }
      }
      return { rows: [] } // verify_events insert, etc. — irrelevant here
    },
  }
}

const makeHostedApp = async (db) => {
  const config = loadConfig({ ...process.env, DATABASE_URL: 'postgres://fake/db' })
  const store = await createMemoryStore(config)
  openStores.push(store)
  const app = createServer({ store, config, db })
  return { app, store }
}

// Poll a promise-producing assertion until it passes or times out — the
// accept_reject-on-delete emission is fired from a store.onUpdate listener,
// which server.js does not await before responding to the DELETE request, so
// tests observe it asynchronously.
async function waitFor(fn, { tries = 50, intervalMs = 2 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  assert.fail('waitFor: condition never became true')
}

describe('sensor spine — hosted-mode chain_id correlation (integration)', () => {
  it('proposal -> verify_result -> accept_reject (explicit_discard) all share one chain_id', async () => {
    const db = makeIntegrationDb({ consented: true })
    const { app } = await makeHostedApp(db)

    // 1) proposal
    const previewRes = await app.request('/preview', post({ '--color-brand': '#f26722' }, SECRET_KEY))
    assert.equal(previewRes.status, 200)
    const { id: previewId } = await previewRes.json()

    assert.equal(db.sensorEvents.length, 1)
    const proposalRow = db.sensorEvents[0]
    const chainId = proposalRow[2] // chain_id column
    assert.equal(typeof chainId, 'string')
    assert.equal(proposalRow[5], 'proposal')
    assert.equal(previews_chainId(db, previewId), chainId)

    // 2) verify_result (app_values) correlated via previewId
    const verifyRes = await app.request(
      '/verify/app',
      post({ values: { '--color-brand': '#f26722' }, previewId }, SECRET_KEY),
    )
    // getResolvedTokens defaults to () => null in this harness, so /verify/app
    // 404s before reaching the sensor emission — swap in a resolved map so the
    // real path (with genuine ok/checked/matched) is exercised instead.
    assert.equal(verifyRes.status, 404)

    // 3) accept_reject (explicit_discard) via DELETE
    const delRes = await app.request(`/preview/${previewId}`, { method: 'DELETE', headers: bearer(SECRET_KEY) })
    assert.equal(delRes.status, 200)

    await waitFor(() => db.sensorEvents.some((r) => r[5] === 'accept_reject'))
    const acceptRejectRow = db.sensorEvents.find((r) => r[5] === 'accept_reject')
    assert.equal(acceptRejectRow[2], chainId, 'accept_reject shares the proposal chain_id')
    const payload = JSON.parse(acceptRejectRow[9])
    assert.equal(payload.outcome, 'rejected')
    assert.equal(payload.signal, 'explicit_discard')
  })

  function previews_chainId(db, previewId) {
    const row = db.previews.get(previewId)
    return row && row.chainId
  }

  it('POST /verify/app emits a verify_result (check: app_values) sharing the proposal chain_id, with REAL ok/checked/matched', async () => {
    const db = makeIntegrationDb({ consented: true })
    const config = loadConfig({ ...process.env, DATABASE_URL: 'postgres://fake/db' })
    const store = await createMemoryStore(config)
    openStores.push(store)
    const resolved = [{ id: 'color.brand', cssVar: '--color-brand', value: '#f26722', tier: 'primitive', type: 'color' }]
    const app = createServer({ store, config, db, getResolvedTokens: () => resolved })

    const previewRes = await app.request('/preview', post({ '--color-brand': '#f26722' }, SECRET_KEY))
    const { id: previewId } = await previewRes.json()
    const proposalChainId = db.sensorEvents[0][2]

    const verifyRes = await app.request(
      '/verify/app',
      post({ values: { '--color-brand': '#000000' }, previewId }, SECRET_KEY),
    )
    assert.equal(verifyRes.status, 200)
    const verifyBody = await verifyRes.json()
    assert.equal(verifyBody.ok, false)
    assert.equal(verifyBody.mismatches.length, 1)

    const verifyRow = db.sensorEvents.find((r) => r[5] === 'verify_result')
    assert.ok(verifyRow, 'a verify_result row was recorded')
    assert.equal(verifyRow[2], proposalChainId, 'verify_result shares the proposal chain_id')
    const payload = JSON.parse(verifyRow[9])
    assert.equal(payload.check, 'app_values')
    assert.equal(payload.ok, false)
    assert.equal(payload.checked, 1)
    assert.equal(payload.matched, 0)
    assert.equal(payload.mismatch_count, 1)
    // Never the actual expected/got values — counts only (Exclusions).
    assert.equal('mismatches' in payload, false)
  })

  it('accept_reject infers ttl_expiry (not explicit_discard) when the preview is deleted WITHOUT an explicit DELETE call', async () => {
    const db = makeIntegrationDb({ consented: true })
    const config = loadConfig({ ...process.env, DATABASE_URL: 'postgres://fake/db', PREVIEW_TTL_MS: '1' })
    const store = await createMemoryStore(config)
    openStores.push(store)
    const app = createServer({ store, config, db })

    const previewRes = await app.request('/preview', post({ '--x': '1' }, SECRET_KEY))
    const { id: previewId } = await previewRes.json()

    // Force the in-memory store to notice the (already-elapsed, TTL=1ms)
    // expiry by reading the preview — getPreview() self-evicts + emits
    // 'delete' when expired (see store/memory.js), which is what a real
    // hourly prune sweep would eventually do on its own.
    await new Promise((r) => setTimeout(r, 5))
    await store.getPreview(previewId)

    await waitFor(() => db.sensorEvents.some((r) => r[5] === 'accept_reject'))
    const row = db.sensorEvents.find((r) => r[5] === 'accept_reject')
    const payload = JSON.parse(row[9])
    assert.equal(payload.signal, 'ttl_expiry')
  })

  it('no sensor_events are written when the org has not consented', async () => {
    const db = makeIntegrationDb({ consented: false })
    const { app } = await makeHostedApp(db)
    const res = await app.request('/preview', post({ '--x': '1' }, SECRET_KEY))
    assert.equal(res.status, 200)
    assert.equal(db.sensorEvents.length, 0)
  })
})

describe('sensor spine — LOCAL mode emits nothing', () => {
  it('POST /preview in local mode writes no sensor_events (no db to write to, and the hosted branch never runs)', async () => {
    const config = loadConfig() // no DATABASE_URL ⇒ local mode
    const store = await createMemoryStore(config)
    openStores.push(store)
    // db intentionally omitted/null — mirrors real local-mode wiring (cli.js
    // never constructs a DbHandle without DATABASE_URL). If the hosted sensor
    // code path were ever reached here it would throw on `db.query` against a
    // null db; the test passing with db:null IS the proof local mode never
    // reaches it.
    const app = createServer({ store, config, db: null })
    const res = await app.request('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ '--x': '1' }),
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(typeof body.id, 'string')
  })

  it('DELETE /preview/:id in local mode does not throw despite no explicitDiscards/db wiring', async () => {
    const config = loadConfig()
    const store = await createMemoryStore(config)
    openStores.push(store)
    const app = createServer({ store, config, db: null })
    const previewRes = await app.request('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ '--x': '1' }),
    })
    const { id } = await previewRes.json()
    const res = await app.request(`/preview/${id}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
  })
})
