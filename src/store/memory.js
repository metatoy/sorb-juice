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
      if (isExpired(entry, now)) previews.delete(id)
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
  }

  /** @type {import('../types').Store['getPreview']} */
  const getPreview = async (id) => {
    const entry = previews.get(id)
    if (!entry) return null
    if (isExpired(entry, Date.now())) {
      previews.delete(id)
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
    return true
  }

  /** @type {import('../types').Store['deletePreview']} */
  const deletePreview = async (id) => {
    previews.delete(id)
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
    putVerification,
    getVerification,
    getLatestVerification,
    countVerifications,
    putFigmaArtifact,
    getFigmaArtifact,
    ping,
    close,
  }
}

export default createMemoryStore
