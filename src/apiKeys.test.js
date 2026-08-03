// apiKeys.test.js — node:test suite for the per-environment API-key model (E4).
//
// Uses an in-memory FAKE db (query + tx) so no Postgres is required. Asserts:
//   • staging-first default env
//   • prod-protected issuance/revocation (allowProd gate)
//   • hash-only storage (raw key never persisted)
//   • audit rows written for issue/revoke
//   • per-env resolution + assertKeyForEnvironment isolation

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { hashKey, resolveApiKey } from './auth.js'
import {
  ENVIRONMENTS,
  ENV_RANK,
  DEFAULT_ENVIRONMENT,
  ProdProtectedError,
  isValidEnvironment,
  assertValidEnvironment,
  issueApiKey,
  revokeApiKey,
  listApiKeys,
  assertKeyForEnvironment,
} from './apiKeys.js'

// ─── fake db ─────────────────────────────────────────────────────────────────
// Tables are plain arrays; query() routes on SQL text (same style as server.test).

function makeFakeDb() {
  const apiKeys = [] // { id, project_id, type, environment, hash, last4, revoked_at }
  const auditLog = [] // { org_id, actor, action, target }
  let seq = 0
  const client = {
    async query(text, params) {
      return route(text, params)
    },
  }
  async function route(text, params) {
    if (text.startsWith('INSERT INTO api_keys')) {
      const [project_id, type, environment, hash, last4] = params
      const row = { id: `key-${++seq}`, project_id, type, environment, hash, last4, revoked_at: null }
      apiKeys.push(row)
      return { rows: [{ id: row.id, environment: row.environment, type: row.type, last4: row.last4 }] }
    }
    if (text.startsWith('INSERT INTO audit_log')) {
      const [org_id, actor, action, target] = params
      auditLog.push({ org_id, actor, action, target })
      return { rows: [] }
    }
    if (text.includes('FROM api_keys') && text.includes('WHERE id =')) {
      const row = apiKeys.find((k) => k.id === params[0])
      return { rows: row ? [{ id: row.id, environment: row.environment, revoked_at: row.revoked_at }] : [] }
    }
    if (text.startsWith('UPDATE api_keys SET revoked_at')) {
      const row = apiKeys.find((k) => k.id === params[0] && k.revoked_at === null)
      if (row) row.revoked_at = 'now'
      return { rows: [] }
    }
    if (text.includes('FROM api_keys') && text.includes('project_id = $1')) {
      // listApiKeys OR the auth JOIN — distinguish by SELECT shape.
      if (text.includes('JOIN projects')) {
        const hash = params[0]
        const row = apiKeys.find((k) => k.hash === hash && k.revoked_at === null)
        if (!row) return { rows: [] }
        return {
          rows: [
            {
              key_id: row.id,
              type: row.type,
              environment: row.environment,
              project_id: row.project_id,
              org_id: 'org-1',
              namespace: 'proj-a',
              allowed_origins: [],
            },
          ],
        }
      }
      const rows = apiKeys
        .filter((k) => k.project_id === params[0] && k.revoked_at === null)
        .map((k) => ({ id: k.id, type: k.type, environment: k.environment, last4: k.last4 }))
      return { rows }
    }
    // auth JOIN path (hash lookup)
    if (text.includes('FROM api_keys k')) {
      const hash = params[0]
      const row = apiKeys.find((k) => k.hash === hash && k.revoked_at === null)
      if (!row) return { rows: [] }
      return {
        rows: [
          {
            key_id: row.id,
            type: row.type,
            environment: row.environment,
            project_id: row.project_id,
            org_id: 'org-1',
            namespace: 'proj-a',
            allowed_origins: [],
          },
        ],
      }
    }
    return { rows: [] }
  }
  return {
    apiKeys,
    auditLog,
    query: route,
    async tx(fn) {
      return fn(client)
    },
  }
}

// ─── constants / validators ──────────────────────────────────────────────────

describe('environment constants', () => {
  it('defines dev < stage < prod and staging-first default', () => {
    assert.deepEqual([...ENVIRONMENTS], ['dev', 'stage', 'prod'])
    assert.equal(ENV_RANK.dev < ENV_RANK.stage, true)
    assert.equal(ENV_RANK.stage < ENV_RANK.prod, true)
    assert.equal(DEFAULT_ENVIRONMENT, 'stage')
  })

  it('validates environment names', () => {
    assert.equal(isValidEnvironment('dev'), true)
    assert.equal(isValidEnvironment('prod'), true)
    assert.equal(isValidEnvironment('production'), false)
    assert.equal(isValidEnvironment(null), false)
    assert.throws(() => assertValidEnvironment('nope'), /invalid environment/)
    assert.equal(assertValidEnvironment('stage'), 'stage')
  })
})

// ─── issuance ────────────────────────────────────────────────────────────────

describe('issueApiKey', () => {
  let db
  beforeEach(() => { db = makeFakeDb() })

  it('defaults to the stage environment (staging-first)', async () => {
    const out = await issueApiKey(db, { projectId: 'p1', type: 'secret', rawKey: 'sk_test_abcd1234' })
    assert.equal(out.environment, 'stage')
    assert.equal(out.type, 'secret')
    assert.equal(out.last4, '1234')
    assert.equal(db.apiKeys.length, 1)
  })

  it('stores only the hash, never the raw key', async () => {
    const raw = 'sk_test_supersecretvalue'
    await issueApiKey(db, { projectId: 'p1', type: 'secret', environment: 'dev', rawKey: raw })
    const stored = db.apiKeys[0]
    assert.equal(stored.hash, hashKey(raw))
    assert.notEqual(stored.hash, raw)
    // No column anywhere holds the raw value.
    assert.equal(JSON.stringify(stored).includes(raw), false)
  })

  it('writes an audit row on issuance (transactional path)', async () => {
    await issueApiKey(db, { projectId: 'p1', orgId: 'org-1', type: 'publishable', environment: 'dev', rawKey: 'pk_test_wxyz9876', actor: 'user-1' })
    assert.equal(db.auditLog.length, 1)
    assert.equal(db.auditLog[0].action, 'api_key.issued')
    assert.match(db.auditLog[0].target, /env=dev/)
    assert.match(db.auditLog[0].target, /key=key-1/)
  })

  it('REFUSES a prod key without allowProd (prod-protected)', async () => {
    await assert.rejects(
      () => issueApiKey(db, { projectId: 'p1', type: 'secret', environment: 'prod', rawKey: 'sk_live_zzzz0000' }),
      (e) => e instanceof ProdProtectedError && e.code === 'PROD_PROTECTED',
    )
    assert.equal(db.apiKeys.length, 0) // nothing minted
  })

  it('ALLOWS a prod key with allowProd:true', async () => {
    const out = await issueApiKey(db, { projectId: 'p1', type: 'secret', environment: 'prod', rawKey: 'sk_live_zzzz0000', allowProd: true })
    assert.equal(out.environment, 'prod')
    assert.equal(db.apiKeys.length, 1)
  })

  it('rejects invalid type / environment / missing rawKey', async () => {
    await assert.rejects(() => issueApiKey(db, { projectId: 'p1', type: 'bogus', rawKey: 'x' }), /invalid type/)
    await assert.rejects(() => issueApiKey(db, { projectId: 'p1', type: 'secret', environment: 'qa', rawKey: 'x' }), /invalid environment/)
    await assert.rejects(() => issueApiKey(db, { projectId: 'p1', type: 'secret', rawKey: '' }), /rawKey is required/)
    await assert.rejects(() => issueApiKey(db, { projectId: '', type: 'secret', rawKey: 'x' }), /projectId is required/)
  })

  it('falls back to two writes when the db handle has no tx', async () => {
    const noTx = makeFakeDb()
    delete noTx.tx
    await issueApiKey(noTx, { projectId: 'p1', type: 'secret', environment: 'dev', rawKey: 'sk_test_notx1234' })
    assert.equal(noTx.apiKeys.length, 1)
    assert.equal(noTx.auditLog.length, 1)
  })
})

// ─── revocation ──────────────────────────────────────────────────────────────

describe('revokeApiKey', () => {
  let db
  beforeEach(() => { db = makeFakeDb() })

  it('revokes a stage key and audits it', async () => {
    const { keyId } = await issueApiKey(db, { projectId: 'p1', type: 'secret', environment: 'stage', rawKey: 'sk_test_stage1234' })
    const out = await revokeApiKey(db, { keyId, orgId: 'org-1', actor: 'user-1' })
    assert.equal(out.revoked, true)
    assert.equal(out.environment, 'stage')
    assert.equal(db.apiKeys[0].revoked_at, 'now')
    assert.ok(db.auditLog.some((a) => a.action === 'api_key.revoked'))
  })

  it('REFUSES to revoke a prod key without allowProd', async () => {
    const { keyId } = await issueApiKey(db, { projectId: 'p1', type: 'secret', environment: 'prod', rawKey: 'sk_live_prod0000', allowProd: true })
    await assert.rejects(
      () => revokeApiKey(db, { keyId }),
      (e) => e instanceof ProdProtectedError,
    )
    assert.equal(db.apiKeys[0].revoked_at, null) // untouched
  })

  it('revokes a prod key with allowProd:true', async () => {
    const { keyId } = await issueApiKey(db, { projectId: 'p1', type: 'secret', environment: 'prod', rawKey: 'sk_live_prod0000', allowProd: true })
    const out = await revokeApiKey(db, { keyId, allowProd: true })
    assert.equal(out.revoked, true)
  })

  it('is a no-op for an unknown key id', async () => {
    const out = await revokeApiKey(db, { keyId: 'nope' })
    assert.equal(out.revoked, false)
  })
})

// ─── listing + per-env resolution + isolation ────────────────────────────────

describe('listApiKeys + resolution', () => {
  it('lists active keys per environment without exposing the hash', async () => {
    const db = makeFakeDb()
    await issueApiKey(db, { projectId: 'p1', type: 'secret', environment: 'dev', rawKey: 'sk_test_dev00001' })
    await issueApiKey(db, { projectId: 'p1', type: 'publishable', environment: 'stage', rawKey: 'pk_test_stage001' })
    const list = await listApiKeys(db, 'p1')
    assert.equal(list.length, 2)
    for (const k of list) {
      assert.ok(ENVIRONMENTS.includes(k.environment))
      assert.equal('hash' in k, false)
    }
  })

  it('resolveApiKey carries the environment through to the AuthContext', async () => {
    const db = makeFakeDb()
    await issueApiKey(db, { projectId: 'p1', type: 'secret', environment: 'dev', rawKey: 'sk_test_devauth1' })
    const ctx = await resolveApiKey(db, 'Bearer sk_test_devauth1')
    assert.ok(ctx)
    assert.equal(ctx.environment, 'dev')
  })

  it('assertKeyForEnvironment isolates environments', () => {
    const devCtx = { environment: 'dev' }
    assert.equal(assertKeyForEnvironment(devCtx, 'dev'), true)
    assert.throws(() => assertKeyForEnvironment(devCtx, 'prod'), /scoped to environment/)
    assert.throws(() => assertKeyForEnvironment(devCtx, 'prod'), (e) => e.code === 'ENV_MISMATCH')
  })
})
