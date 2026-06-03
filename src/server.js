import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { nanoid } from 'nanoid'

const PREVIEW_TTL_MS = 1000 * 60 * 60 * 24 // 24 hours

/**
 * @param {string} namespace
 * @param {() => import('./types').TokenSet} getLatestTokens
 * @param {() => (Array<{id:string,cssVar:string,value:string,tier:string,type:string}> | null)} [getResolvedTokens]
 *   Returns the resolved bindable token map (from .sorb/resolved.json,
 *   produced by Style Dictionary's `sorb/resolved-map` format), or null if
 *   it hasn't been generated.
 * @param {() => (object | null)} [getArtifactIndex]
 *   Returns the captured-component index (.sorb/index.json), or null.
 * @param {(storyId: string) => (object | null)} [getArtifact]
 *   Returns the artifact JSON for a story id (looked up via the index — never
 *   accepts a raw path), or null if not found.
 */
export const createServer = (
  namespace,
  getLatestTokens,
  getResolvedTokens,
  getArtifactIndex,
  getArtifact,
) => {
  /** @type {Map<string, import('./types').PreviewEntry>} */
  const previews = new Map()

  // Prune expired previews every hour
  setInterval(() => {
    const now = Date.now()
    for (const [id, entry] of previews) {
      if (now - entry.createdAt > PREVIEW_TTL_MS) {
        previews.delete(id)
      }
    }
  }, 1000 * 60 * 60)

  // Plugin self-reports each inserted component's post-layout geometry here:
  // { storyId, bbox, meta, createdAt }. `latestVerifyId` tracks the newest so
  // the canvas verifier can poll /verify/latest without knowing the id.
  /** @type {Map<string, { storyId: string, bbox: object, meta: object, createdAt: number }>} */
  const verifications = new Map()
  let latestVerifyId = null

  // Prune expired verifications every hour (same TTL as previews)
  setInterval(() => {
    const now = Date.now()
    for (const [id, entry] of verifications) {
      if (now - entry.createdAt > PREVIEW_TTL_MS) {
        verifications.delete(id)
      }
    }
  }, 1000 * 60 * 60)

  const app = new Hono()

  // Allow requests from any origin — the plugin UI and the React app
  // are on different origins from the local server
  app.use('*', cors({ origin: '*' }))

  // ─── POST /preview ────────────────────────────────────────────────────────
  // Figma plugin POSTs a proposed token set here.
  // Returns a short preview ID the React app can use via ?preview=<id>
  app.post('/preview', async (c) => {
    const tokens = await c.req.json()
    const id = nanoid(8)
    previews.set(id, { tokens, createdAt: Date.now() })
    const url = `?preview=${id}`
    return c.json({ id, url })
  })

  // ─── GET /preview/:id ─────────────────────────────────────────────────────
  // React app polls this while a preview is active.
  app.get('/preview/:id', (c) => {
    const entry = previews.get(c.req.param('id'))
    if (!entry) {
      return c.json({ error: 'Preview not found or expired' }, 404)
    }
    return c.json(entry.tokens)
  })

  // ─── PUT /preview/:id ─────────────────────────────────────────────────────
  // Plugin updates an existing preview in-place (live edit mode).
  app.put('/preview/:id', async (c) => {
    const id = c.req.param('id')
    if (!previews.has(id)) {
      return c.json({ error: 'Preview not found' }, 404)
    }
    const tokens = await c.req.json()
    previews.set(id, { tokens, createdAt: Date.now() })
    return c.json({ id, updated: true })
  })

  // ─── DELETE /preview/:id ──────────────────────────────────────────────────
  // Plugin clears a preview when designer exits without committing.
  app.delete('/preview/:id', (c) => {
    previews.delete(c.req.param('id'))
    return c.json({ deleted: true })
  })

  // ─── POST /verify ─────────────────────────────────────────────────────────
  // Plugin posts the post-layout geometry of an inserted component so the
  // canvas can be reconciled against the captured artifact. Returns a short id.
  app.post('/verify', async (c) => {
    const { storyId, bbox, meta } = await c.req.json()
    const id = nanoid(8)
    verifications.set(id, { storyId, bbox, meta, createdAt: Date.now() })
    latestVerifyId = id
    return c.json({ id })
  })

  // ─── GET /verify/latest ───────────────────────────────────────────────────
  // The most recently reported verification. MUST be registered before
  // /verify/:id or Hono treats "latest" as an :id param.
  app.get('/verify/latest', (c) => {
    const entry = latestVerifyId ? verifications.get(latestVerifyId) : null
    if (!entry) {
      return c.json({ error: 'No verification reported yet' }, 404)
    }
    return c.json(entry)
  })

  // ─── GET /verify/:id ──────────────────────────────────────────────────────
  // A specific verification by id.
  app.get('/verify/:id', (c) => {
    const entry = verifications.get(c.req.param('id'))
    if (!entry) {
      return c.json({ error: 'Verification not found or expired' }, 404)
    }
    return c.json(entry)
  })

  // ─── GET /tokens/latest ───────────────────────────────────────────────────
  // Returns the latest committed tokens from disk.
  // Plugin fetches this on open to pre-populate the editor.
  app.get('/tokens/latest', (c) => {
    return c.json(getLatestTokens())
  })

  // ─── GET /tokens/resolved ──────────────────────────────────────────────────
  // The resolved *bindable* token map produced by Style Dictionary — one entry
  // per token: { id, cssVar, value, tier, type }. The plugin uses it to create
  // grouped Variables and to bind captured values; capture annotates against
  // it. 404 if it hasn't been built yet.
  app.get('/tokens/resolved', (c) => {
    const resolved = getResolvedTokens ? getResolvedTokens() : null
    if (!resolved) {
      return c.json(
        { error: 'No resolved token map. Run `sorb-seed resolve` (Style Dictionary build).' },
        404,
      )
    }
    return c.json(resolved)
  })

  // ─── GET /artifacts ───────────────────────────────────────────────────────
  // The captured-component index — list of components/stories with hashes,
  // produced by `sorb-seed capture`. 404 until seed has run.
  app.get('/artifacts', (c) => {
    const idx = getArtifactIndex ? getArtifactIndex() : null
    if (!idx) {
      return c.json(
        { error: 'No artifact index. Run `sorb-seed capture`.' },
        404,
      )
    }
    return c.json(idx)
  })

  // ─── GET /artifact?id=<storyId> ───────────────────────────────────────────
  // Lookup by id in the index — never accepts an arbitrary filesystem path.
  app.get('/artifact', (c) => {
    const storyId = c.req.query('id')
    if (!storyId) return c.json({ error: 'Missing ?id=' }, 400)
    const art = getArtifact ? getArtifact(storyId) : null
    if (!art) return c.json({ error: 'Artifact not found for id: ' + storyId }, 404)
    return c.json(art)
  })

  // ─── GET /health ──────────────────────────────────────────────────────────
  app.get('/health', (c) => {
    return c.json({
      ok: true,
      namespace,
      activePreviews: previews.size,
      verifications: verifications.size,
    })
  })

  return app
}
