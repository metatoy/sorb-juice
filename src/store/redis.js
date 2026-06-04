// Redis-backed Store implementation.
//
// IMPORTANT: ioredis is imported at MODULE TOP — this is ALLOWED *only* because
// this file is reachable solely via a dynamic `await import('./redis.js')` from
// store/index.js, gated on REDIS_URL being set. Nothing reachable from
// src/index.js or src/cli.js may static-import this file. Free local users who
// never set REDIS_URL never load this module and never need ioredis installed.
import Redis from 'ioredis'

// Key layout:
//   preview:{id}   -> JSON { tokens, createdAt }        (PX = config.previewTtlMs)
//   verify:{id}    -> JSON { storyId, bbox, meta, createdAt } (PX = config.previewTtlMs)
//   verify:latest  -> the newest verify id              (PX = config.previewTtlMs)
//
// Counting uses SCAN over the namespaced key prefix (DBSIZE/KEYS avoided so we
// don't block Redis and don't miscount when sharing a db). Redis' own PX TTL
// handles expiry, so counts are naturally "active" (expired keys are gone).
const PREVIEW_PREFIX = 'preview:'
const VERIFY_PREFIX = 'verify:'
const VERIFY_LATEST_KEY = 'verify:latest'

const previewKey = (id) => PREVIEW_PREFIX + id
const verifyKey = (id) => VERIFY_PREFIX + id

/**
 * Count keys matching a glob pattern via non-blocking SCAN.
 * @param {import('ioredis').Redis} client
 * @param {string} match
 * @returns {Promise<number>}
 */
const scanCount = async (client, match) => {
  let cursor = '0'
  let total = 0
  do {
    // COUNT is a hint; 100 keeps each round-trip small.
    const [next, keys] = await client.scan(cursor, 'MATCH', match, 'COUNT', 100)
    cursor = next
    total += keys.length
  } while (cursor !== '0')
  return total
}

/**
 * Create the Redis-backed Store.
 *
 * @param {import('../types').Config} config
 * @returns {Promise<import('../types').Store>}
 */
export const createRedisStore = async (config) => {
  const ttlMs = config.previewTtlMs

  // lazyConnect so construction never throws on an unreachable Redis; we connect
  // explicitly and surface failures through ping() / the /ready check.
  const client = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  })

  // ioredis emits 'error' asynchronously; without a listener an unreachable
  // server would crash the process with an unhandled 'error' event.
  client.on('error', () => {
    // Swallowed — surfaced via ping(); reconnection is handled by ioredis.
  })

  try {
    await client.connect()
  } catch (e) {
    // Defer hard failure to ping()/usage rather than crashing the factory.
    void e
  }

  // ─── PREVIEWS ─────────────────────────────────────────────────────────────

  /** @type {import('../types').Store['putPreview']} */
  const putPreview = async (id, tokens) => {
    const entry = { tokens, createdAt: Date.now() }
    await client.set(previewKey(id), JSON.stringify(entry), 'PX', ttlMs)
  }

  /** @type {import('../types').Store['getPreview']} */
  const getPreview = async (id) => {
    const raw = await client.get(previewKey(id))
    if (raw == null) return null
    return JSON.parse(raw)
  }

  /** @type {import('../types').Store['hasPreview']} */
  const hasPreview = async (id) => {
    return (await client.exists(previewKey(id))) === 1
  }

  /** @type {import('../types').Store['updatePreview']} */
  const updatePreview = async (id, tokens) => {
    // Match today's PUT semantics: refuse to create, only refresh an existing
    // entry. Re-setting with a fresh PX refreshes the TTL.
    if (!(await hasPreview(id))) return false
    const entry = { tokens, createdAt: Date.now() }
    await client.set(previewKey(id), JSON.stringify(entry), 'PX', ttlMs)
    return true
  }

  /** @type {import('../types').Store['deletePreview']} */
  const deletePreview = async (id) => {
    await client.del(previewKey(id))
  }

  /** @type {import('../types').Store['countPreviews']} */
  const countPreviews = async () => {
    return scanCount(client, PREVIEW_PREFIX + '*')
  }

  // ─── VERIFICATIONS ────────────────────────────────────────────────────────

  /** @type {import('../types').Store['putVerification']} */
  const putVerification = async (id, { storyId, bbox, meta }) => {
    const entry = { storyId, bbox, meta, createdAt: Date.now() }
    // Set the entry and advance the latest pointer atomically-ish; both carry
    // the same TTL so a stale "latest" pointer expires alongside its entry.
    const pipeline = client.multi()
    pipeline.set(verifyKey(id), JSON.stringify(entry), 'PX', ttlMs)
    pipeline.set(VERIFY_LATEST_KEY, id, 'PX', ttlMs)
    await pipeline.exec()
  }

  /** @type {import('../types').Store['getVerification']} */
  const getVerification = async (id) => {
    const raw = await client.get(verifyKey(id))
    if (raw == null) return null
    return JSON.parse(raw)
  }

  /** @type {import('../types').Store['getLatestVerification']} */
  const getLatestVerification = async () => {
    const id = await client.get(VERIFY_LATEST_KEY)
    if (id == null) return null
    // The pointer may outlive nothing here (same TTL), but the entry could have
    // been explicitly deleted — fall through to null in that case.
    return getVerification(id)
  }

  /** @type {import('../types').Store['countVerifications']} */
  const countVerifications = async () => {
    // verify:latest shares the verify: prefix; subtract it so the count matches
    // the number of real verification entries (memory store counts entries only).
    const total = await scanCount(client, VERIFY_PREFIX + '*')
    const hasLatest = (await client.exists(VERIFY_LATEST_KEY)) === 1
    return hasLatest ? Math.max(0, total - 1) : total
  }

  // ─── LIFECYCLE / HEALTH ───────────────────────────────────────────────────

  /** @type {import('../types').Store['ping']} */
  const ping = async () => {
    try {
      return (await client.ping()) === 'PONG'
    } catch (e) {
      void e
      return false
    }
  }

  /** @type {import('../types').Store['close']} */
  const close = async () => {
    // Idempotent: quit() on an already-ended client throws "Connection is
    // closed." — swallow it so close() can be called repeatedly.
    try {
      await client.quit()
    } catch (e) {
      void e
    }
  }

  return {
    putPreview,
    getPreview,
    hasPreview,
    updatePreview,
    deletePreview,
    countPreviews,
    putVerification,
    getVerification,
    getLatestVerification,
    countVerifications,
    ping,
    close,
  }
}

export default createRedisStore
