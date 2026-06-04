/**
 * Postgres durable access layer for the hosted bridge.
 *
 * ZERO-NEW-DEPS LOCAL MODE IS SACRED: `pg` is imported **dynamically**, and
 * ONLY when `config.databaseUrl` is set. When no DATABASE_URL is configured,
 * {@link createDb} returns `null` — exactly today's local-mode behavior with no
 * Postgres and no `pg` dependency required. Never static-import `pg` at module
 * top: this file is reachable from src/index.js / src/cli.js and must keep
 * working for free users who never install `pg`.
 *
 * @module db/index
 */

import { runMigrations } from './migrate.js'

/**
 * Create the Postgres durable layer over a connection pool.
 *
 * @param {import('../types.js').Config} config Loaded config (env + sorb.config.json).
 * @returns {Promise<import('../types.js').DbHandle | null>} A DbHandle when
 *   `config.databaseUrl` is set; `null` in local mode (no Postgres).
 */
export async function createDb(config) {
  const databaseUrl = config && config.databaseUrl
  if (!databaseUrl) {
    // Local mode: no Postgres. Caller (cli.js / server.js) treats null as
    // "not configured" and skips DB-dependent checks.
    return null
  }

  // Dynamic import — `pg` is only loaded when DATABASE_URL is present.
  const pgModule = await import('pg')
  // `pg` is a CommonJS module; the default export carries { Pool, Client, ... }.
  const pg = pgModule.default || pgModule
  const { Pool } = pg

  const pool = new Pool({
    connectionString: databaseUrl,
    // Keep the pool conservative; the bridge is mostly Redis-bound. These can
    // be tuned later via config if needed.
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  })

  // Surface idle-client errors instead of crashing the process. catch-binding
  // style (no bare catch) per sandbox rule.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[db] idle pool client error:', err && err.message ? err.message : err)
  })

  /**
   * Run a parameterized query against a pooled client.
   * @param {string} text SQL with `$1`-style placeholders.
   * @param {Array<*>} [params] Bound parameters.
   * @returns {Promise<import('pg').QueryResult>}
   */
  async function query(text, params) {
    return pool.query(text, params)
  }

  /**
   * Acquire a dedicated client for a multi-statement unit of work. The caller
   * MUST `client.release()` when done.
   * @returns {Promise<import('pg').PoolClient>}
   */
  async function getClient() {
    return pool.connect()
  }

  /**
   * Run `fn` inside a single transaction. Commits on success, rolls back on
   * throw, and always releases the client.
   * @template T
   * @param {(client: import('pg').PoolClient) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function tx(fn) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (e) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        // eslint-disable-next-line no-console
        console.error('[db] rollback failed:', rollbackErr && rollbackErr.message ? rollbackErr.message : rollbackErr)
      }
      throw e
    } finally {
      client.release()
    }
  }

  /**
   * Readiness ping. Round-trips `SELECT 1`. Returns false (never throws) on
   * failure so /ready can report a 503 cleanly.
   * @returns {Promise<boolean>}
   */
  async function ping() {
    try {
      const res = await pool.query('SELECT 1 AS ok')
      return Boolean(res && res.rows && res.rows.length === 1)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[db] ping failed:', e && e.message ? e.message : e)
      return false
    }
  }

  /** Close the pool. Idempotent. @returns {Promise<void>} */
  let closed = false
  async function close() {
    if (closed) return
    closed = true
    try {
      await pool.end()
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[db] close failed:', e && e.message ? e.message : e)
    }
  }

  /** @type {import('../types.js').DbHandle} */
  const handle = {
    pool,
    query,
    getClient,
    tx,
    ping,
    close,
    /** Apply pending SQL migrations in order. @returns {Promise<string[]>} */
    runMigrations: () => runMigrations(handle),
  }

  return handle
}

export default { createDb }
