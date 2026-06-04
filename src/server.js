import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { nanoid } from 'nanoid'

/**
 * Build the Hono bridge app. All preview/verify state lives in the injected
 * `store` (see storeInterface) — this module keeps NO in-memory Maps and no
 * prune timers (pruning now lives in the store). Id generation (nanoid(8))
 * stays here; the store never mints ids.
 *
 * @param {Object} options
 * @param {import('./types').Store} options.store
 *   Required. A Store instance from src/store/index.js. All preview + verify
 *   handlers delegate to it (awaited).
 * @param {import('./types').Config} options.config
 *   Required. Config from src/config.js. Supplies `namespace` (surfaced in
 *   /health), `corsOrigins`, and the TTL/prune windows the store honors.
 * @param {import('./types').DbHandle | null} [options.db]
 *   Optional Postgres handle (or null in local mode). /ready pings it only when
 *   it is non-null (a configured backend).
 * @param {() => import('./types').TokenSet} [options.getLatestTokens]
 *   Latest committed tokens for /tokens/latest. Defaults to () => ({}).
 * @param {() => (Array<{id:string,cssVar:string,value:string,tier:string,type:string}> | null)} [options.getResolvedTokens]
 *   Resolved bindable token map (.sorb/resolved.json), or null. Defaults to () => null.
 * @param {() => (object | null)} [options.getArtifactIndex]
 *   Captured-component index (.sorb/index.json), or null. Defaults to () => null.
 * @param {(storyId: string) => (object | null)} [options.getArtifact]
 *   Artifact JSON for a story id (looked up via the index — never a raw path),
 *   or null. Defaults to () => null.
 * @returns {import('hono').Hono} the Hono app (synchronous — /ready does its
 *   async backend checks per-request).
 */
export const createServer = ({
  store,
  config,
  db = null,
  getLatestTokens = () => ({}),
  getResolvedTokens = () => null,
  getArtifactIndex = () => null,
  getArtifact = () => null,
}) => {
  const namespace = config.namespace
  const corsOrigin =
    config.corsOrigins && config.corsOrigins !== '*' ? config.corsOrigins : '*'

  const app = new Hono()

  // Allow requests from the configured origins — the plugin UI and the React
  // app are on different origins from the local server. Local default is '*'.
  app.use('*', cors({ origin: corsOrigin }))

  // ─── POST /preview ────────────────────────────────────────────────────────
  // Figma plugin POSTs a proposed token set here.
  // Returns a short preview ID the React app can use via ?preview=<id>
  app.post('/preview', async (c) => {
    const tokens = await c.req.json()
    const id = nanoid(8)
    await store.putPreview(id, tokens)
    const url = `?preview=${id}`
    return c.json({ id, url })
  })

  // ─── GET /preview/:id ─────────────────────────────────────────────────────
  // React app polls this while a preview is active.
  app.get('/preview/:id', async (c) => {
    const entry = await store.getPreview(c.req.param('id'))
    if (!entry) {
      return c.json({ error: 'Preview not found or expired' }, 404)
    }
    return c.json(entry.tokens)
  })

  // ─── PUT /preview/:id ─────────────────────────────────────────────────────
  // Plugin updates an existing preview in-place (live edit mode).
  app.put('/preview/:id', async (c) => {
    const id = c.req.param('id')
    const tokens = await c.req.json()
    const updated = await store.updatePreview(id, tokens)
    if (!updated) {
      return c.json({ error: 'Preview not found' }, 404)
    }
    return c.json({ id, updated: true })
  })

  // ─── DELETE /preview/:id ──────────────────────────────────────────────────
  // Plugin clears a preview when designer exits without committing.
  app.delete('/preview/:id', async (c) => {
    await store.deletePreview(c.req.param('id'))
    return c.json({ deleted: true })
  })

  // ─── POST /verify ─────────────────────────────────────────────────────────
  // Plugin posts the post-layout geometry of an inserted component so the
  // canvas can be reconciled against the captured artifact. Returns a short id.
  app.post('/verify', async (c) => {
    const { storyId, bbox, meta } = await c.req.json()
    const id = nanoid(8)
    await store.putVerification(id, { storyId, bbox, meta })
    return c.json({ id })
  })

  // ─── GET /verify/latest ───────────────────────────────────────────────────
  // The most recently reported verification. MUST be registered before
  // /verify/:id or Hono treats "latest" as an :id param.
  app.get('/verify/latest', async (c) => {
    const entry = await store.getLatestVerification()
    if (!entry) {
      return c.json({ error: 'No verification reported yet' }, 404)
    }
    return c.json(entry)
  })

  // ─── GET /verify/:id ──────────────────────────────────────────────────────
  // A specific verification by id.
  app.get('/verify/:id', async (c) => {
    const entry = await store.getVerification(c.req.param('id'))
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
    const resolved = getResolvedTokens()
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
    const idx = getArtifactIndex()
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
    const art = getArtifact(storyId)
    if (!art) return c.json({ error: 'Artifact not found for id: ' + storyId }, 404)
    return c.json(art)
  })

  // ─── GET /health ──────────────────────────────────────────────────────────
  app.get('/health', async (c) => {
    return c.json({
      ok: true,
      namespace,
      activePreviews: await store.countPreviews(),
      verifications: await store.countVerifications(),
    })
  })

  // ─── GET /ready ───────────────────────────────────────────────────────────
  // Readiness probe: 200 only when every *configured* backend is reachable.
  // The in-memory store always pings true; a null db (local mode) is "not
  // configured" and skipped. Returns 503 with { ok:false, checks } when any
  // configured backend is unreachable.
  app.get('/ready', async (c) => {
    /** @type {Record<string, boolean>} */
    const checks = {}

    try {
      checks.store = await store.ping()
    } catch (e) {
      checks.store = false
    }

    if (db) {
      try {
        checks.db = await db.ping()
      } catch (e) {
        checks.db = false
      }
    }

    const ok = Object.values(checks).every(Boolean)
    return c.json({ ok, checks }, ok ? 200 : 503)
  })

  return app
}
