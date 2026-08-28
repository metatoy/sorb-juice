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
//   preview:latest -> the newest preview id              (PX = config.previewTtlMs)
//   verify:{id}    -> JSON { storyId, bbox, meta, createdAt } (PX = config.previewTtlMs)
//   verify:latest  -> the newest verify id              (PX = config.previewTtlMs)
//
// Counting uses SCAN over the namespaced key prefix (DBSIZE/KEYS avoided so we
// don't block Redis and don't miscount when sharing a db). Redis' own PX TTL
// handles expiry, so counts are naturally "active" (expired keys are gone).
const PREVIEW_PREFIX = 'preview:'
const PREVIEW_LATEST_KEY = 'preview:latest'
const VERIFY_PREFIX = 'verify:'
const VERIFY_LATEST_KEY = 'verify:latest'
// Single "latest" snapshot (no TTL, no history) — mirrors the memory store.
const FIGMA_ARTIFACT_KEY = 'figma:artifact'

const previewKey = (id) => PREVIEW_PREFIX + id
const verifyKey = (id) => VERIFY_PREFIX + id
// E1 push channel — one pub/sub channel per preview id, namespaced off the
// same key so ops tooling (redis-cli) has one pattern to grep for both the
// value and its event stream.
const previewEventsChannel = (id) => previewKey(id) + ':events'

// GOTCHA (ported from experiments/sorb-bridge-modes/relay-spike/NOTES.md #8):
// Redis key-expiry (our PX TTL) is NOT observable as a publish/subscribe
// message unless `notify-keyspace-events` is enabled on the server — a
// preview that dies of natural TTL expiry does NOT push a `delete` event to
// SSE subscribers the way the memory store's setTimeout-based expiry does.
// Deliberately not fixed here (would require a deployment-side Redis config
// change, out of scope for this port): subscribers on an expired preview
// just go quiet (still get pings) rather than seeing an explicit `delete`.

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
 * @param {Object} [deps] Dependency injection, TEST-ONLY. Production call
 *   sites (store/index.js) always call `createRedisStore(config)` with no
 *   second argument, so this is purely additive — it exists so
 *   src/store/redis.test.js can exercise the real pub/sub wiring below
 *   against a Redis-shaped fake client instead of only code review (this
 *   repo has no live Redis to test against — see NOTES.md in the E1 spike
 *   this was ported from).
 * @param {import('ioredis').Redis} [deps.client] Pre-built client (skips
 *   `new Redis(...)` + `.connect()` — the fake is already "connected").
 * @returns {Promise<import('../types').Store>}
 */
export const createRedisStore = async (config, deps = {}) => {
  const ttlMs = config.previewTtlMs

  let client = deps.client
  if (!client) {
    // lazyConnect so construction never throws on an unreachable Redis; we
    // connect explicitly and surface failures through ping() / the /ready check.
    client = new Redis(config.redisUrl, {
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
  }

  // ─── PUSH (onUpdate) ──────────────────────────────────────────────────────
  // A SEPARATE connection for SUBSCRIBE — a redis client can't issue normal
  // commands on a connection that's in subscribe mode (ioredis convention:
  // client.duplicate()). Created LAZILY on the first onUpdate() call so a
  // deployment that never uses SSE (e.g. Mode C / poll-only consumers) never
  // opens the second connection.
  /** @type {import('ioredis').Redis | null} */
  let subscriberClient = null
  /** @type {Map<string, Set<(evt: import('../types').PreviewUpdateEvent) => void>>} */
  const listenersByChannel = new Map()

  const ensureSubscriber = () => {
    if (subscriberClient) return subscriberClient
    subscriberClient = client.duplicate()
    subscriberClient.on('error', () => {
      // Swallowed — same posture as the primary client; a dead subscriber
      // connection surfaces as subscribers stalling, not a process crash.
    })
    subscriberClient.on('message', (channel, message) => {
      const set = listenersByChannel.get(channel)
      if (!set || set.size === 0) return
      let payload
      try {
        payload = JSON.parse(message)
      } catch (e) {
        return
      }
      for (const listener of set) listener(payload)
    })
    return subscriberClient
  }

  /** @param {string} id @param {'put'|'update'|'delete'} type @param {unknown} tokens */
  const publishUpdate = async (id, type, tokens) => {
    await client.publish(previewEventsChannel(id), JSON.stringify({ type, tokens }))
  }

  /** @type {import('../types').Store['onUpdate']} */
  const onUpdate = (id, listener) => {
    const sub = ensureSubscriber()
    const channel = previewEventsChannel(id)
    if (!listenersByChannel.has(channel)) {
      listenersByChannel.set(channel, new Set())
      sub.subscribe(channel).catch(() => {})
    }
    listenersByChannel.get(channel).add(listener)
    return () => {
      const set = listenersByChannel.get(channel)
      if (!set) return
      set.delete(listener)
      if (set.size === 0) {
        listenersByChannel.delete(channel)
        sub.unsubscribe(channel).catch(() => {})
      }
    }
  }

  // ─── PREVIEWS ─────────────────────────────────────────────────────────────

  /** @type {import('../types').Store['putPreview']} */
  const putPreview = async (id, tokens) => {
    const entry = { tokens, createdAt: Date.now() }
    // Set the entry and advance the latest pointer together; same TTL so a
    // stale "latest" pointer expires alongside its entry (mirrors verify:latest).
    const pipeline = client.multi()
    pipeline.set(previewKey(id), JSON.stringify(entry), 'PX', ttlMs)
    pipeline.set(PREVIEW_LATEST_KEY, id, 'PX', ttlMs)
    await pipeline.exec()
    await publishUpdate(id, 'put', tokens)
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
    const pipeline = client.multi()
    pipeline.set(previewKey(id), JSON.stringify(entry), 'PX', ttlMs)
    pipeline.set(PREVIEW_LATEST_KEY, id, 'PX', ttlMs)
    await pipeline.exec()
    await publishUpdate(id, 'update', tokens)
    return true
  }

  /** @type {import('../types').Store['deletePreview']} */
  const deletePreview = async (id) => {
    // Leave preview:latest as-is on an explicit delete (matches verify:latest's
    // posture — no deleteVerification exists either): getLatestPreview() below
    // re-checks the entry's own existence at read time, so a pointer left
    // dangling after a delete just resolves to null rather than lying.
    const n = await client.del(previewKey(id))
    if (n) await publishUpdate(id, 'delete', null)
  }

  /** @type {import('../types').Store['countPreviews']} */
  const countPreviews = async () => {
    // preview:latest shares the preview: prefix; subtract it so the count
    // matches the number of real preview entries (mirrors countVerifications).
    const total = await scanCount(client, PREVIEW_PREFIX + '*')
    const hasLatest = (await client.exists(PREVIEW_LATEST_KEY)) === 1
    return hasLatest ? Math.max(0, total - 1) : total
  }

  /** @type {import('../types').Store['getLatestPreview']} */
  const getLatestPreview = async () => {
    const id = await client.get(PREVIEW_LATEST_KEY)
    if (id == null) return null
    const entry = await getPreview(id)
    if (!entry) return null
    return { id, tokens: entry.tokens, createdAt: entry.createdAt }
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

  // ─── FIGMA ARTIFACT ───────────────────────────────────────────────────────

  /** @type {import('../types').Store['putFigmaArtifact']} */
  const putFigmaArtifact = async (artifact) => {
    // No PX: the export persists until the next one replaces it (unlike
    // previews/verifications, this is a durable "latest known state", not a
    // TTL'd ephemeral entry).
    await client.set(FIGMA_ARTIFACT_KEY, JSON.stringify(artifact))
  }

  /** @type {import('../types').Store['getFigmaArtifact']} */
  const getFigmaArtifact = async () => {
    const raw = await client.get(FIGMA_ARTIFACT_KEY)
    if (raw == null) return null
    return JSON.parse(raw)
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
    if (subscriberClient) {
      try {
        await subscriberClient.quit()
      } catch (e) {
        void e
      }
    }
  }

  return {
    putPreview,
    getPreview,
    hasPreview,
    updatePreview,
    deletePreview,
    countPreviews,
    getLatestPreview,
    putVerification,
    getVerification,
    getLatestVerification,
    countVerifications,
    putFigmaArtifact,
    getFigmaArtifact,
    onUpdate,
    ping,
    close,
  }
}

export default createRedisStore
