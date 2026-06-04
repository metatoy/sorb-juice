/**
 * Hosted-mode API-key authentication for the bridge.
 *
 * BACK-COMPAT IS SACRED: this module is imported only inside the hosted branch
 * of createServer (when config.databaseUrl is set). It has ZERO new deps — it
 * needs only `node:crypto` and takes the db handle as an injected argument, so
 * it stays pure/testable with a FAKE db and never reaches Postgres in local
 * mode.
 *
 * Keys are validated by sha256-hashing the raw bearer token and looking up
 * api_keys.hash (which stores the sha256 hex, UNIQUE) where revoked_at IS NULL.
 * The raw key is never stored anywhere — only its hash.
 *
 * @module auth
 */

import { createHash } from 'node:crypto'

/**
 * Authorization scope derived from an API key's type.
 *
 * `publishable` keys are read-only (`read`); `secret` keys may write (`write`).
 * @type {Readonly<{ READ: 'read', WRITE: 'write' }>}
 */
export const SCOPE = Object.freeze({ READ: 'read', WRITE: 'write' })

/**
 * The authenticated tenant context resolved from a valid API key. Frozen so
 * downstream middleware/handlers can't mutate the tenant identity mid-request.
 *
 * `scope` is DERIVED from `type`: publishable → 'read', secret → 'write'.
 * `allowedOrigins` is always an array (defaults to [] when the column is null).
 *
 * @typedef {Object} AuthContext
 * @property {string} keyId The api_keys.id (uuid) of the matched key.
 * @property {'secret' | 'publishable'} type The key type.
 * @property {string} projectId projects.id (uuid) the key belongs to.
 * @property {string} orgId projects.org_id (uuid) — the owning organization.
 * @property {string} namespace projects.namespace.
 * @property {string[]} allowedOrigins projects.allowed_origins (text[]); [] if null.
 * @property {'read' | 'write'} scope Derived from `type`.
 */

/**
 * sha256-hash a raw API key to its hex digest.
 *
 * Matches the storage format of api_keys.hash (sha256 hex). Pure and
 * synchronous — no db, no I/O.
 *
 * @param {string} raw The raw bearer token (the user-supplied key).
 * @returns {string} Lowercase hex sha256 digest of `raw`.
 */
export function hashKey(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * Parse an `Authorization` header value into its raw bearer token.
 *
 * Accepts a case-insensitive `Bearer` scheme and trims surrounding whitespace.
 * Returns null when the header is missing, malformed, or carries an empty token.
 *
 * @param {string | null | undefined} authHeader The raw Authorization header.
 * @returns {string | null} The raw token, or null when absent/malformed.
 */
function parseBearer(authHeader) {
  if (typeof authHeader !== 'string') return null
  const trimmed = authHeader.trim()
  if (trimmed === '') return null
  // Split on the first run of whitespace into scheme + remainder.
  const match = /^(\S+)\s+(.*)$/.exec(trimmed)
  if (!match) return null
  const scheme = match[1]
  if (scheme.toLowerCase() !== 'bearer') return null
  const token = match[2].trim()
  if (token === '') return null
  return token
}

/**
 * Resolve an `Authorization` header to an {@link AuthContext}, or null.
 *
 * Parses `Bearer <raw>` (case-insensitive scheme), hashes the token, and runs a
 * single JOIN of api_keys against projects, filtering out revoked keys. An
 * unknown OR a revoked key both yield null (the two cases are never
 * distinguished, so a revoked key reveals nothing).
 *
 * db errors are NOT swallowed — they propagate so the server can map them to a
 * 503 (fail-closed) rather than silently falling through to open behavior.
 *
 * @param {import('./types.js').DbHandle} db Injected db handle (FAKE in tests).
 * @param {string | null | undefined} authHeader The raw Authorization header.
 * @returns {Promise<AuthContext | null>} The tenant context, or null when the
 *   header is missing/malformed/empty or the key is unknown/revoked.
 */
export async function resolveApiKey(db, authHeader) {
  const raw = parseBearer(authHeader)
  if (raw === null) return null

  const hash = hashKey(raw)

  const result = await db.query(
    `SELECT k.id AS key_id, k.type, k.project_id, p.org_id, p.namespace, p.allowed_origins
       FROM api_keys k
       JOIN projects p ON p.id = k.project_id
      WHERE k.hash = $1 AND k.revoked_at IS NULL
      LIMIT 1`,
    [hash]
  )

  const rows = (result && result.rows) || []
  if (rows.length === 0) return null

  const row = rows[0]
  const type = row.type
  const scope = type === 'publishable' ? SCOPE.READ : SCOPE.WRITE
  const allowedOrigins = Array.isArray(row.allowed_origins) ? row.allowed_origins : []

  return Object.freeze({
    keyId: row.key_id,
    type,
    projectId: row.project_id,
    orgId: row.org_id,
    namespace: row.namespace,
    allowedOrigins,
    scope
  })
}
