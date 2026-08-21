/**
 * Per-environment API-key model for the hosted bridge (E4).
 *
 * Extends main's Bearer(sha256) key plumbing (src/auth.js · api_keys table) with
 * a `dev | stage | prod` environment dimension, so one project can carry
 * separate keys per environment. Two safety properties are built into the model:
 *
 *   • **staging-first** — a new key defaults to `stage` when no environment is
 *     given, so the safe path is the default path.
 *   • **prod-protected** — issuing or revoking a `prod` key requires an explicit
 *     `allowProd: true`, so automated / default flows can never mint or drop prod
 *     credentials by accident. (The `prod` DB itself is untouchable — no data is
 *     read or written here beyond the api_keys row + its audit_log entry.)
 *
 * BACK-COMPAT IS SACRED: like src/auth.js and src/entitlements.js this module
 * takes the db handle as an INJECTED argument and imports nothing but node:crypto
 * (via hashKey). It is reachable only from hosted paths (DATABASE_URL set) and is
 * fully testable with a fake db.
 *
 * @module apiKeys
 */

import { hashKey } from './auth.js'

/**
 * The valid key environments, lowest → highest privilege.
 * @type {readonly ['dev','stage','prod']}
 */
export const ENVIRONMENTS = Object.freeze(['dev', 'stage', 'prod'])

/**
 * Rank per environment (dev < stage < prod). Used by {@link assertKeyForEnvironment}
 * and callers that want to reason about relative privilege.
 * @type {Readonly<{ dev: 0, stage: 1, prod: 2 }>}
 */
export const ENV_RANK = Object.freeze({ dev: 0, stage: 1, prod: 2 })

/**
 * The staging-first default: a key with no explicit environment is a `stage` key.
 * @type {'stage'}
 */
export const DEFAULT_ENVIRONMENT = 'stage'

/**
 * Thrown when a prod key op is attempted without `allowProd: true`. A distinct
 * class so callers (an admin endpoint / CLI) can map it to a specific refusal
 * instead of a generic 400.
 */
export class ProdProtectedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'ProdProtectedError'
    /** @type {string} */
    this.code = 'PROD_PROTECTED'
  }
}

/**
 * @param {*} env
 * @returns {env is 'dev'|'stage'|'prod'}
 */
export function isValidEnvironment(env) {
  return typeof env === 'string' && ENVIRONMENTS.includes(env)
}

/**
 * Throw if `env` is not one of {@link ENVIRONMENTS}.
 * @param {*} env
 * @returns {'dev'|'stage'|'prod'}
 */
export function assertValidEnvironment(env) {
  if (!isValidEnvironment(env)) {
    throw new Error(
      `invalid environment ${JSON.stringify(env)} — expected one of: ${ENVIRONMENTS.join(', ')}`,
    )
  }
  return env
}

/**
 * Best-effort audit-log write, used only on the non-transactional fallback path
 * (a db handle without `tx`). A failure here MUST NOT break the key op it
 * describes, mirroring the verify_events telemetry pattern. When the handle
 * supports `tx`, {@link issueApiKey} writes the audit row inside the same
 * transaction instead. Returns true on success.
 *
 * @param {import('./types.js').DbHandle} db
 * @param {{ orgId?: string|null, actor?: string|null, action: string, target?: string|null }} entry
 * @returns {Promise<boolean>}
 */
async function writeAudit(db, entry) {
  try {
    await db.query(
      `INSERT INTO audit_log (org_id, actor, action, target) VALUES ($1, $2, $3, $4)`,
      [entry.orgId ?? null, entry.actor ?? null, entry.action, entry.target ?? null],
    )
    return true
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[apiKeys] audit write failed:', e && e.message ? e.message : e)
    return false
  }
}

/**
 * Issue (mint) a new API key for a project in a given environment.
 *
 * The RAW key is never stored — only its sha256 hash (matching src/auth.js) and
 * the last 4 chars for display. The caller supplies the raw key (minted however
 * it likes, e.g. `sk_live_…` / `pk_test_…`); this function hashes + persists it
 * and records an audit entry. When the db handle exposes `tx`, the key insert +
 * audit row are written atomically.
 *
 * @param {import('./types.js').DbHandle} db Injected db handle (fake in tests).
 * @param {object} params
 * @param {string} params.projectId  projects.id the key belongs to.
 * @param {string} [params.orgId]    org id for the audit row.
 * @param {'secret'|'publishable'} params.type Key type (drives scope in auth.js).
 * @param {'dev'|'stage'|'prod'} [params.environment] Defaults to `stage` (staging-first).
 * @param {string} params.rawKey     The raw bearer token to hash + store.
 * @param {boolean} [params.allowProd] Must be `true` to mint a `prod` key.
 * @param {string|null} [params.actor] Actor for the audit row.
 * @returns {Promise<{ keyId: string, environment: 'dev'|'stage'|'prod', type: 'secret'|'publishable', last4: string }>}
 * @throws {ProdProtectedError} when environment is `prod` and allowProd !== true.
 */
export async function issueApiKey(db, params = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('issueApiKey: no db handle')
  const {
    projectId,
    orgId = null,
    type,
    environment = DEFAULT_ENVIRONMENT,
    rawKey,
    allowProd = false,
    actor = null,
  } = params

  if (typeof projectId !== 'string' || projectId === '') {
    throw new Error('issueApiKey: projectId is required')
  }
  if (type !== 'secret' && type !== 'publishable') {
    throw new Error(`issueApiKey: invalid type ${JSON.stringify(type)} — expected 'secret' | 'publishable'`)
  }
  assertValidEnvironment(environment)
  if (typeof rawKey !== 'string' || rawKey.trim() === '') {
    throw new Error('issueApiKey: rawKey is required')
  }
  // prod is protected — minting a prod credential requires an explicit opt-in.
  if (environment === 'prod' && allowProd !== true) {
    throw new ProdProtectedError('issuing a prod API key requires allowProd: true')
  }

  const hash = hashKey(rawKey)
  const last4 = rawKey.slice(-4)

  const insertSql =
    `INSERT INTO api_keys (project_id, type, environment, hash, last4)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, environment, type, last4`
  const insertParams = [projectId, type, environment, hash, last4]
  const auditEntry = {
    orgId,
    actor,
    action: 'api_key.issued',
    target: `project=${projectId} env=${environment} type=${type}`,
  }

  let row
  if (typeof db.tx === 'function') {
    // Atomic: the key and its audit record land together or not at all.
    row = await db.tx(async (client) => {
      const res = await client.query(insertSql, insertParams)
      const r = (res && res.rows && res.rows[0]) || {}
      await client.query(
        `INSERT INTO audit_log (org_id, actor, action, target) VALUES ($1, $2, $3, $4)`,
        [auditEntry.orgId, auditEntry.actor, auditEntry.action, `${auditEntry.target} key=${r.id}`],
      )
      return r
    })
  } else {
    const res = await db.query(insertSql, insertParams)
    row = (res && res.rows && res.rows[0]) || {}
    await writeAudit(db, { ...auditEntry, target: `${auditEntry.target} key=${row.id}` })
  }

  return {
    keyId: row.id,
    environment: row.environment ?? environment,
    type: row.type ?? type,
    last4: row.last4 ?? last4,
  }
}

/**
 * Revoke an existing API key by id. Revoking a `prod` key requires
 * `allowProd: true`, matching the issuance guard.
 *
 * @param {import('./types.js').DbHandle} db
 * @param {object} params
 * @param {string} params.keyId api_keys.id to revoke.
 * @param {string} [params.orgId] org id for the audit row.
 * @param {boolean} [params.allowProd] Must be `true` to revoke a `prod` key.
 * @param {string|null} [params.actor]
 * @returns {Promise<{ keyId: string, environment: string, revoked: boolean }>}
 * @throws {ProdProtectedError} when the target key is `prod` and allowProd !== true.
 */
export async function revokeApiKey(db, params = {}) {
  if (!db || typeof db.query !== 'function') throw new Error('revokeApiKey: no db handle')
  const { keyId, orgId = null, allowProd = false, actor = null } = params
  if (typeof keyId !== 'string' || keyId === '') {
    throw new Error('revokeApiKey: keyId is required')
  }

  // Look up the key's environment first so the prod guard can fire BEFORE any write.
  const lookup = await db.query(
    `SELECT id, environment, revoked_at FROM api_keys WHERE id = $1 LIMIT 1`,
    [keyId],
  )
  const existing = (lookup && lookup.rows && lookup.rows[0]) || null
  if (!existing) {
    return { keyId, environment: 'unknown', revoked: false }
  }
  const environment = existing.environment ?? 'prod'
  if (environment === 'prod' && allowProd !== true) {
    throw new ProdProtectedError('revoking a prod API key requires allowProd: true')
  }
  // Already revoked → idempotent no-op.
  if (existing.revoked_at) {
    return { keyId, environment, revoked: true }
  }

  await db.query(`UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [keyId])
  await writeAudit(db, {
    orgId,
    actor,
    action: 'api_key.revoked',
    target: `key=${keyId} env=${environment}`,
  })
  return { keyId, environment, revoked: true }
}

/**
 * List a project's active (non-revoked) keys with their environment + display
 * metadata. Never returns the hash.
 *
 * @param {import('./types.js').DbHandle} db
 * @param {string} projectId
 * @returns {Promise<Array<{ keyId: string, type: string, environment: string, last4: string }>>}
 */
export async function listApiKeys(db, projectId) {
  if (!db || typeof db.query !== 'function') throw new Error('listApiKeys: no db handle')
  if (typeof projectId !== 'string' || projectId === '') {
    throw new Error('listApiKeys: projectId is required')
  }
  const res = await db.query(
    `SELECT id, type, environment, last4
       FROM api_keys
      WHERE project_id = $1 AND revoked_at IS NULL
      ORDER BY environment, created_at`,
    [projectId],
  )
  const rows = (res && res.rows) || []
  return rows.map((r) => ({
    keyId: r.id,
    type: r.type,
    environment: r.environment ?? 'prod',
    last4: r.last4 ?? null,
  }))
}

/**
 * Assert that an authenticated key is scoped to the environment a request
 * targets. A `dev`/`stage` key must not act against `prod`, and vice-versa — the
 * environments are isolated. Throws on mismatch so callers can map it to a 403.
 *
 * @param {{ environment?: string } | null | undefined} authContext The AuthContext from resolveApiKey.
 * @param {'dev'|'stage'|'prod'} requiredEnv The environment the request targets.
 * @returns {true}
 * @throws {Error} when the key's environment does not match `requiredEnv`.
 */
export function assertKeyForEnvironment(authContext, requiredEnv) {
  assertValidEnvironment(requiredEnv)
  const keyEnv = authContext && authContext.environment
  if (keyEnv !== requiredEnv) {
    const err = new Error(
      `this key is scoped to environment ${JSON.stringify(keyEnv)}, but the request targets ${JSON.stringify(requiredEnv)}`,
    )
    // @ts-ignore augment for callers mapping to HTTP status
    err.code = 'ENV_MISMATCH'
    throw err
  }
  return true
}
