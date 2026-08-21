// remoteAuth.test.js — unit tests for the hosted-MCP tenant-scoping core.
//
// Pure: NO MCP SDK, NO ./server.js, NO ./httpServer.js. We exercise only the
// pure functions in remoteAuth.js plus a single round-trip from auth.js's
// resolveApiKey fed a FAKE db (mirrors the auth-test style) — no real Postgres.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'path'

import {
  isValidProjectId,
  resolveProjectDir,
  buildSessionCtx
} from './remoteAuth.js'
import { resolveApiKey } from '../auth.js'

// Two distinct canonical UUIDs for the org-isolation checks.
const UUID_A = '7f3a1c2e-4b5d-6e7f-8a9b-0c1d2e3f4a5b'
const UUID_B = '1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809'

// ─── 1. isValidProjectId ──────────────────────────────────────────────────────

test('isValidProjectId accepts a canonical UUID', () => {
  assert.equal(isValidProjectId(UUID_A), true)
  assert.equal(isValidProjectId(UUID_B), true)
})

test('isValidProjectId rejects traversal / non-uuid / empty input', () => {
  assert.equal(isValidProjectId('../etc'), false)
  assert.equal(isValidProjectId('a/b'), false)
  assert.equal(isValidProjectId(''), false)
  assert.equal(isValidProjectId('..'), false)
  // A real UUID with a trailing path segment is NOT a bare uuid → rejected.
  assert.equal(isValidProjectId(UUID_A + '/x'), false)
  // Non-string input is rejected without throwing.
  assert.equal(isValidProjectId(null), false)
  assert.equal(isValidProjectId(undefined), false)
  assert.equal(isValidProjectId(42), false)
  // Whitespace / NUL are screened.
  assert.equal(isValidProjectId(UUID_A + ' '), false)
  assert.equal(isValidProjectId(UUID_A + '\0'), false)
})

// ─── 2. resolveProjectDir ───────────────────────────────────────────────────────

test('resolveProjectDir returns base joined with the uuid', () => {
  const base = '/tmp/snapshots'
  assert.equal(resolveProjectDir(base, UUID_A), join(base, UUID_A))
})

test('resolveProjectDir returns null on traversal / separators / bad base', () => {
  const base = '/tmp/snapshots'
  assert.equal(resolveProjectDir(base, '../evil'), null)
  assert.equal(resolveProjectDir(base, 'a/b'), null)
  assert.equal(resolveProjectDir(base, ''), null)
  assert.equal(resolveProjectDir('', UUID_A), null)
  assert.equal(resolveProjectDir(null, UUID_A), null)
})

// ─── 3. buildSessionCtx ─────────────────────────────────────────────────────────

test('buildSessionCtx binds the ctx to the tenant in the AuthContext', () => {
  const authContext = {
    keyId: 'k1',
    type: 'secret',
    projectId: UUID_A,
    orgId: 'orgA',
    namespace: 'ns',
    allowedOrigins: [],
    scope: 'write'
  }
  const ctx = buildSessionCtx(authContext, { baseDir: '/tmp/x', bridge: 'http://b' })
  assert.ok(ctx)
  assert.ok(ctx.dir.endsWith('/' + UUID_A))
  assert.equal(ctx.orgId, 'orgA')
  assert.equal(ctx.scope, 'write')
  assert.equal(ctx.namespace, 'ns')
  assert.equal(ctx.bridge, 'http://b')
  // Hosted path never carries github creds from the key.
  assert.equal(ctx.github, null)
})

test('buildSessionCtx isolates orgs: different projectId → different dir', () => {
  const base = { baseDir: '/tmp/x', bridge: 'http://b' }
  const ctxA = buildSessionCtx(
    { projectId: UUID_A, orgId: 'orgA', namespace: 'ns', scope: 'write' },
    base
  )
  const ctxB = buildSessionCtx(
    { projectId: UUID_B, orgId: 'orgB', namespace: 'ns', scope: 'write' },
    base
  )
  assert.ok(ctxA)
  assert.ok(ctxB)
  assert.notEqual(ctxA.dir, ctxB.dir)
  assert.equal(ctxA.orgId, 'orgA')
  assert.equal(ctxB.orgId, 'orgB')
})

test('buildSessionCtx returns null for a null/falsy AuthContext', () => {
  assert.equal(buildSessionCtx(null, { baseDir: '/tmp/x' }), null)
  assert.equal(buildSessionCtx(undefined, { baseDir: '/tmp/x' }), null)
})

test('buildSessionCtx returns null when the projectId does not resolve', () => {
  // A hostile/invalid projectId on the AuthContext yields no dir → null ctx.
  const bad = { projectId: '../evil', orgId: 'orgA', namespace: 'ns', scope: 'write' }
  assert.equal(buildSessionCtx(bad, { baseDir: '/tmp/x' }), null)
})

// ─── 4. Isolation invariant: tool-arg projectId is IGNORED ──────────────────────

test('buildSessionCtx ignores any projectId from tool args — ctx is bound to the key', () => {
  // The isolation boundary (spec §7 "hard line"): the session projectId comes
  // from the validated key, NEVER from tool input. There is no path by which a
  // tool argument can change ctx.projectId — buildSessionCtx only reads the
  // AuthContext, so ctx.projectId ALWAYS equals authContext.projectId.
  const authContext = { projectId: UUID_A, orgId: 'orgA', namespace: 'ns', scope: 'write' }
  // Even if a malicious tool call later supplied UUID_B, the session ctx built
  // here is fixed to UUID_A and the tool handlers read THIS ctx.dir.
  const ctx = buildSessionCtx(authContext, { baseDir: '/tmp/x' })
  assert.ok(ctx)
  assert.equal(ctx.projectId, UUID_A)
  assert.notEqual(ctx.projectId, UUID_B)
  assert.ok(ctx.dir.endsWith('/' + UUID_A))
  assert.ok(!ctx.dir.endsWith('/' + UUID_B))
})

// ─── 5. resolveApiKey round-trip with a FAKE db → scoped ctx ─────────────────────

test('resolveApiKey (fake db) → buildSessionCtx scopes to the row project', async () => {
  const fakeDb = {
    query: async () => ({
      rows: [
        {
          key_id: 'k-123',
          type: 'secret',
          project_id: UUID_A,
          org_id: 'orgA',
          namespace: 'ns',
          allowed_origins: null
        }
      ]
    })
  }
  const authContext = await resolveApiKey(fakeDb, 'Bearer sk_test_raw')
  assert.ok(authContext)
  assert.equal(authContext.projectId, UUID_A)
  assert.equal(authContext.scope, 'write') // secret → write

  const ctx = buildSessionCtx(authContext, { baseDir: '/tmp/snap' })
  assert.ok(ctx)
  assert.equal(ctx.projectId, UUID_A)
  assert.equal(ctx.orgId, 'orgA')
  assert.ok(ctx.dir.endsWith('/' + UUID_A))
})
