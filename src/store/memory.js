// In-memory Store implementation — the zero-dependency default backend.
//
// Preserves today's exact behavior from server.js:
//   - two Maps (previews, verifications) + a `latestVerifyId` string
//   - 24h-default TTL via config.previewTtlMs
//   - hourly prune via setInterval (config.pruneIntervalMs), .unref()'d so it
//     never holds the process open or hangs vitest
//
// All methods are async (return Promises) so this is drop-in interchangeable
// with the Redis-backed store from the server's perspective.
//
// E1 (hosted-relay hardening, ported from experiments/sorb-bridge-modes/
// relay-spike/store.js): `onUpdate` adds a push primitive over an
// EventEmitter bus, keyed by preview id, so the SSE route can push
// put/update/delete events to subscribers instead of the leaf SDK polling
// GET /preview/:id. `bus.setMaxListeners(0)` is load-bearing, not decorative
// — Node's default max-10-listeners warning fires with realistic concurrent
// SSE subscriber counts on one preview (spike load-tested 50 on one id).

import { EventEmitter } from 'node:events'

/**
 * Create the in-memory Store.
 *
 * @param {import('../types').Config} config
 * @returns {import('../types').Store}
 */
export const createMemoryStore = (config) => {
  const ttlMs = config.previewTtlMs
  const pruneIntervalMs = config.pruneIntervalMs

  /** @type {Map<string, import('../types').PreviewEntry>} */
  const previews = new Map()

  // Most-recently put/updated preview id (LOCAL mode's "latest" pointer for
  // GET /preview/latest — the cloud-snapshot dependency). Mirrors
  // `latestVerifyId` below. Only meaningful in LOCAL mode: hosted mode derives
  // "latest" from the tenant-scoped `previews` DB table instead (this pointer
  // is process-global, not per-project).
  /** @type {string | null} */
  let latestPreviewId = null

  // Push bus for onUpdate() — one EventEmitter, events named by preview id.
  // Only previews get push events (verifications/Figma artifacts are polled).
  const bus = new EventEmitter()
  bus.setMaxListeners(0)

  // Plugin self-reports each inserted component's post-layout geometry here:
  // { storyId, bbox, meta, createdAt }. `latestVerifyId` tracks the newest so
  // the canvas verifier can poll /verify/latest without knowing the id.
  /** @type {Map<string, import('../types').VerificationEntry>} */
  const verifications = new Map()
  /** @type {string | null} */
  let latestVerifyId = null

  // Latest Figma Variables export posted by the plugin (POST /tokens/figma).
  // Single "latest" snapshot, no TTL/history — same shape as a preview, but
  // there's exactly one at a time (the most recent export replaces it).
  /** @type {import('../types').FigmaArtifact | null} */
  let figmaArtifact = null

  /** True once an entry's TTL has elapsed relative to now. */
  const isExpired = (entry, now) => now - entry.createdAt > ttlMs

  // Single hourly prune sweep across both maps (same TTL as today). Mirrors the
  // two setInterval sweeps in the original server.js, collapsed into one timer.
  const pruneTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, entry] of previews) {
      if (isExpired(entry, now)) {
        previews.delete(id)
        if (id === latestPreviewId) latestPreviewId = null
        bus.emit(id, { type: 'delete', tokens: null })
      }
    }
    for (const [id, entry] of verifications) {
      if (isExpired(entry, now)) {
        verifications.delete(id)
        if (id === latestVerifyId) latestVerifyId = null
      }
    }
  }, pruneIntervalMs)
  // Never keep the event loop alive just for pruning (matters for the CLI
  // shutdown path and for vitest, which would otherwise hang on a live timer).
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref()

  // ─── PREVIEWS ─────────────────────────────────────────────────────────────

  /** @type {import('../types').Store['putPreview']} */
  const putPreview = async (id, tokens) => {
    previews.set(id, { tokens, createdAt: Date.now() })
    latestPreviewId = id
    bus.emit(id, { type: 'put', tokens })
  }

  /** @type {import('../types').Store['getPreview']} */
  const getPreview = async (id) => {
    const entry = previews.get(id)
    if (!entry) return null
    if (isExpired(entry, Date.now())) {
      previews.delete(id)
      if (id === latestPreviewId) latestPreviewId = null
      bus.emit(id, { type: 'delete', tokens: null })
      return null
    }
    return entry
  }

  /** @type {import('../types').Store['hasPreview']} */
  const hasPreview = async (id) => {
    return (await getPreview(id)) !== null
  }

  /** @type {import('../types').Store['updatePreview']} */
  const updatePreview = async (id, tokens) => {
    // Match today's PUT semantics: refuse to create, only refresh an existing
    // (and non-expired) entry. Refreshes createdAt → refreshes TTL.
    if (!(await hasPreview(id))) return false
    previews.set(id, { tokens, createdAt: Date.now() })
    latestPreviewId = id
    bus.emit(id, { type: 'update', tokens })
    return true
  }

  /** @type {import('../types').Store['deletePreview']} */
  const deletePreview = async (id) => {
    const existed = previews.has(id)
    previews.delete(id)
    if (id === latestPreviewId) latestPreviewId = null
    if (existed) bus.emit(id, { type: 'delete', tokens: null })
  }

  /** @type {import('../types').Store['getLatestPreview']} */
  const getLatestPreview = async () => {
    const id = latestPreviewId
    if (!id) return null
    const entry = await getPreview(id)
    if (!entry) return null
    return { id, tokens: entry.tokens, createdAt: entry.createdAt }
  }

  /** @type {import('../types').Store['onUpdate']} */
  const onUpdate = (id, listener) => {
    bus.on(id, listener)
    return () => bus.off(id, listener)
  }

  /** @type {import('../types').Store['countPreviews']} */
  const countPreviews = async () => {
    const now = Date.now()
    let n = 0
    for (const entry of previews.values()) {
      if (!isExpired(entry, now)) n++
    }
    return n
  }

  // ─── VERIFICATIONS ────────────────────────────────────────────────────────

  /** @type {import('../types').Store['putVerification']} */
  const putVerification = async (id, { storyId, bbox, meta }) => {
    verifications.set(id, { storyId, bbox, meta, createdAt: Date.now() })
    latestVerifyId = id
  }

  /** @type {import('../types').Store['getVerification']} */
  const getVerification = async (id) => {
    const entry = verifications.get(id)
    if (!entry) return null
    if (isExpired(entry, Date.now())) {
      verifications.delete(id)
      if (id === latestVerifyId) latestVerifyId = null
      return null
    }
    return entry
  }

  /** @type {import('../types').Store['getLatestVerification']} */
  const getLatestVerification = async () => {
    if (!latestVerifyId) return null
    return getVerification(latestVerifyId)
  }

  /** @type {import('../types').Store['countVerifications']} */
  const countVerifications = async () => {
    const now = Date.now()
    let n = 0
    for (const entry of verifications.values()) {
      if (!isExpired(entry, now)) n++
    }
    return n
  }

  // ─── FIGMA ARTIFACT ───────────────────────────────────────────────────────

  /** @type {import('../types').Store['putFigmaArtifact']} */
  const putFigmaArtifact = async (artifact) => {
    figmaArtifact = artifact
  }

  /** @type {import('../types').Store['getFigmaArtifact']} */
  const getFigmaArtifact = async () => figmaArtifact

  // ─── LIFECYCLE / HEALTH ───────────────────────────────────────────────────

  /** @type {import('../types').Store['ping']} */
  const ping = async () => true

  /** @type {import('../types').Store['close']} */
  const close = async () => {
    // Idempotent: clearInterval is a no-op if already cleared.
    clearInterval(pruneTimer)
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

export default createMemoryStore
