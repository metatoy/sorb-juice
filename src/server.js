import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { nanoid } from 'nanoid'
import { resolveApiKey, SCOPE } from './auth.js'
import { getEntitlements, effectiveEntitlements, FREE } from './entitlements.js'
import {
  isFeedEnabled,
  composeAppCheckEvent,
  composeTelemetryEvent,
  composeSignalEvent,
  recordEvidenceEvent,
  listEvidenceEvents,
  FEED_KIND,
  FEED_FRAMING,
  FEED_DISCLAIMER,
} from './enterprise/evidenceFeed.js'
import { buildBindingGraph, usagesOf, idsForCssVar, blastRadius, graftPlan } from './graph/index.js'
import {
  mintChainId,
  lookupChainId,
  recordProposal,
  recordVerifyResult,
  recordAcceptReject,
  recordConformanceSnapshotRef,
} from './sensor.js'

// E4 (Mode C result-sync) sentinel default for `onLocalResultSync` — a plain
// `() => {}` default param is indistinguishable from a caller explicitly
// passing a no-op, so identity-checking THIS constant is how createServer
// below decides whether to pay for the extra local bookkeeping (chain-id
// tracking + a store.onUpdate subscription per preview) at all. Anyone who
// didn't wire an account (cli.js only passes a real hook once
// resolveResultSyncConfig() found an org key) gets ZERO extra listeners
// registered — the free local bridge stays byte-for-byte unchanged, not just
// response-shape-unchanged.
const NOOP_LOCAL_RESULT_SYNC = () => {}

/**
 * Build the Hono bridge app. All preview/verify state lives in the injected
 * `store` (see storeInterface) — this module keeps NO in-memory Maps and no
 * prune timers (pruning now lives in the store). Id generation (nanoid(8))
 * stays here; the store never mints ids.
 *
 * ## Two modes — gated entirely on `config.databaseUrl`
 *
 * **LOCAL mode** (`config.databaseUrl` UNSET): behaves EXACTLY as the free local
 * bridge always has — no auth, open CORS ('*' or CORS_ORIGINS), in-memory store,
 * all routes open and un-tenant-scoped. Zero new behavior is registered.
 *
 * **HOSTED mode** (`config.databaseUrl` SET): the bridge reads sorb-cloud's
 * shared Postgres for auth + entitlements:
 *   - scoped CORS sourced from the project's `allowed_origins`,
 *   - a Bearer API key is required on every route except `/health` + `/ready`,
 *   - publishable keys are read-only ONLY for POST /verify and POST
 *     /tokens/figma (403 `read_only`, via requireWrite) — every other route,
 *     including the /preview writes, accepts any authenticated key, since
 *     the account-pairing front door mints a read-only key for the Figma
 *     plugin and previews are ephemeral/non-destructive (requirePreviewWrite
 *     is a deliberate no-op; see its comment below),
 *   - entitlements are enforced (maxActivePreviews → 402, preview TTL,
 *     sharing-gated actions → 402), with past_due/canceled orgs degraded to Free.
 *
 * @param {Object} options
 * @param {import('./types').Store} options.store
 *   Required. A Store instance from src/store/index.js. All preview + verify
 *   handlers delegate to it (awaited).
 * @param {import('./types').Config} options.config
 *   Required. Config from src/config.js. Supplies `namespace` (surfaced in
 *   /health), `corsOrigins`, `databaseUrl` (the hosted-mode switch) and the
 *   TTL/prune windows the store honors.
 * @param {import('./types').DbHandle | null} [options.db]
 *   Optional Postgres handle (or null in local mode). /ready pings it only when
 *   it is non-null. In hosted mode it is the source for auth + entitlements +
 *   the per-project active-preview count, and MUST be non-null.
 * @param {() => import('./types').TokenSet} [options.getLatestTokens]
 *   Latest committed tokens for /tokens/latest. Defaults to () => ({}).
 * @param {() => (Array<{id:string,cssVar:string,value:string,tier:string,type:string}> | null)} [options.getResolvedTokens]
 *   Resolved bindable token map (.sorb/resolved.json), or null. Defaults to () => null.
 * @param {() => (object | null)} [options.getArtifactIndex]
 *   Captured-component index (.sorb/index.json), or null. Defaults to () => null.
 * @param {(storyId: string) => (object | null)} [options.getArtifact]
 *   Artifact JSON for a story id (looked up via the index — never a raw path),
 *   or null. Defaults to () => null.
 * @param {(err: unknown, context?: Record<string, unknown>) => void} [options.onError]
 *   Optional error sink for the DB-error / best-effort catch paths. Threaded in
 *   (dependency-injection style, mirroring db/store) so this module stays
 *   Sentry-import-free and fake-db testable. Defaults to a no-op; cli.js `serve`
 *   passes `captureError` from src/sentry.js (itself a no-op when SENTRY_DSN is
 *   unset). The test harness omits it, so capture stays a no-op under `node --test`.
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
  onError = () => {},
  // E4 (Mode C result-sync): optional hook, ADDITIVE + opt-in. Called ONLY in
  // LOCAL mode (never `hosted` — that path already has its own DB-backed E2
  // sensor recording above) with `(type, args)` matching one of
  // resultSync.js's build*Event() arg shapes. Default no-op means the free
  // local bridge is byte-for-byte unchanged for anyone who didn't wire an
  // account (cli.js only passes a real hook when SORB_ORG_KEY/config.orgKey
  // resolved — see resultSync.resolveResultSyncConfig). Never awaited, always
  // wrapped in try/catch at each call site — a sync failure can't affect the
  // response.
  onLocalResultSync = NOOP_LOCAL_RESULT_SYNC,
}) => {
  const namespace = config.namespace
  const corsOrigin =
    config.corsOrigins && config.corsOrigins !== '*' ? config.corsOrigins : '*'

  // The ONE switch. Everything new lives behind `hosted`; when it is false the
  // server is byte-for-byte the free local bridge it has always been.
  const hosted = Boolean(config.databaseUrl)

  // E5 (HELD/DARK): the continuous conformance-EVIDENCE feed. DEFAULT OFF. When
  // false — the only supported state today — nothing is recorded to
  // evidence_events and the feed endpoint answers 404 (dormant). Requires hosted
  // mode too (evidence rows are tenant-scoped). Three human hard gates
  // (E&O+Cyber · GA-ToS · SOC 2) must ALL clear before this is set on a deployed
  // environment. See src/enterprise/evidenceFeed.js.
  const feedOn = hosted && isFeedEnabled(config)

  // Where to send a user who hits a paid gate (402). Relative '/billing' by
  // default; overridable for the hosted control-plane host.
  const upgradeUrl = process.env.SORB_UPGRADE_URL || '/billing'

  // Preview TTL for persistent (paid) previews. null = no expiry; otherwise the
  // configured (default 24h) window for Free orgs.
  const previewTtlMs = config.previewTtlMs || 86_400_000

  // E1: SSE heartbeat interval for GET /preview/:id/events. Periodic pings are
  // load-bearing, not decorative (ported finding from the relay-spike) — they
  // let the server detect a half-dead connection isn't hung, and stop
  // intermediary proxies (Traefik/Coolify) or node-server's own idle timeout
  // from killing an otherwise-idle stream.
  const sseHeartbeatMs = config.sseHeartbeatMs || 20_000

  // Activity log: namespace → [{displayName, verifiedAt}], max 20 entries, 24h TTL.
  const activityLog = new Map()
  const ACTIVITY_MAX = 20
  const ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000
  const pruneActivity = (entries) => {
    const cutoff = Date.now() - ACTIVITY_TTL_MS
    return entries.filter((e) => Date.parse(e.verifiedAt) > cutoff).slice(-ACTIVITY_MAX)
  }

  // E2 (sensor spine) — preview ids that were explicitly DELETEd, so the
  // terminal store.onUpdate('delete') listener registered in POST /preview
  // (below) can tell "designer discarded it" (explicit_discard) apart from
  // "it just aged out" (ttl_expiry). Marked in DELETE /preview/:id BEFORE the
  // store write, consumed (and removed) the moment the listener fires. Only
  // ever populated in hosted mode.
  const explicitDiscards = new Set()

  // E4 (Mode C result-sync) — preview id -> chain_id, minted locally so a
  // later /verify or DELETE /preview/:id can correlate its result-sync event
  // back to the originating proposal. Mirrors the hosted mode's
  // `previews.chain_id` column, but in-memory (this process's lifetime is the
  // correlation window — same bound as the local store's own preview TTL).
  // Only ever populated when !hosted.
  const localChainIds = new Map()

  // E4 (Mode C result-sync): whether a REAL hook was wired (see
  // NOOP_LOCAL_RESULT_SYNC's doc comment) — gates every extra bit of local
  // bookkeeping (chain-id map writes, store.onUpdate subscriptions) so the
  // free local bridge pays zero cost when no account is configured.
  const resultSyncActive = onLocalResultSync !== NOOP_LOCAL_RESULT_SYNC

  const app = new Hono()

  // ───────────────────────────────────────────────────────────────────────────
  // E1 — GET /orgs/:orgId/preview/:id/subscribe (SSE push)
  //
  // The leaf SDK subscribes here to receive live preview updates instead of
  // polling GET /preview/:id. Ported/promoted from the relay-spike
  // (experiments/sorb-bridge-modes/relay-spike). Registered FIRST — before the
  // hosted header-auth + CORS middleware below — because the browser
  // EventSource API cannot set request headers, so this route authenticates
  // via a ?key= query param and must not be 401'd by the header middleware.
  // Being registered first, its Response short-circuits the middleware chain.
  //
  // AUTH (hosted mode): ?key=<publishable-or-secret-key>. Missing/invalid →
  // 401. Any tenant mismatch → 404 (never 403) so cross-tenant existence is
  // never revealed — same posture as GET /preview/:id. LOCAL mode (no
  // databaseUrl): OPEN, no key required, :orgId is ignored — byte-for-byte the
  // free bridge's no-auth behavior.
  //
  // FRAME CONTRACT (each SSE frame's `data:` is a JSON object):
  //   - on connect:      { type: 'snapshot', tokens }
  //   - on store change:  { type: 'update', tokens }   (put + update both → 'update')
  //                       { type: 'delete', tokens: null }
  //   - idle keepalive:   { type: 'ping' }  every sseHeartbeatMs
  //   Frames use the default (message) SSE event so EventSource.onmessage
  //   receives them; each carries a monotonically increasing `id:` from 1.
  app.get('/orgs/:orgId/preview/:id/subscribe', async (c) => {
    const pathOrgId = c.req.param('orgId')
    const id = c.req.param('id')

    if (hosted) {
      const key = c.req.query('key')
      let ctx
      try {
        ctx = await resolveApiKey(db, key ? `Bearer ${key}` : null)
      } catch (e) {
        onError(e, { at: 'subscribe.auth', id })
        return c.json({ error: 'Service unavailable', code: 'db_unavailable' }, 503)
      }
      if (!ctx) {
        return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401)
      }
      // Tenant scope: authed org must match the path org AND the preview must
      // belong to the authed project. Any mismatch ⇒ 404 (existence hidden).
      if (ctx.orgId !== pathOrgId) {
        return c.json({ error: 'Preview not found or expired' }, 404)
      }
      let owned = false
      try {
        const res = await db.query(
          'SELECT 1 FROM previews WHERE id = $1 AND project_id = $2 LIMIT 1',
          [id, ctx.projectId],
        )
        owned = Boolean(res && res.rows && res.rows.length)
      } catch (e) {
        onError(e, { at: 'preview.owner', method: 'subscribe', id })
        return c.json({ error: 'Service unavailable', code: 'db_unavailable' }, 503)
      }
      if (!owned) {
        return c.json({ error: 'Preview not found or expired' }, 404)
      }
    }

    const existing = await store.getPreview(id)
    if (!existing) {
      return c.json({ error: 'Preview not found or expired' }, 404)
    }

    // This route bypasses the global CORS middleware (registered after it), so
    // reflect the caller's Origin for the EventSource fetch. Safe: the route is
    // ?key=-authenticated in hosted mode (and a read), open in local mode.
    const origin = c.req.header('Origin')
    if (origin) c.header('Access-Control-Allow-Origin', origin)

    return streamSSE(c, async (stream) => {
      let closed = false
      let seq = 0

      const send = async (payload) => {
        if (closed || stream.closed) return
        seq += 1
        try {
          await stream.writeSSE({ data: JSON.stringify(payload), id: String(seq) })
        } catch (e) {
          // Write to a closed/reset socket — treat as disconnect.
          closed = true
        }
      }

      await send({ type: 'snapshot', tokens: existing.tokens })

      const unsubscribe = store.onUpdate(id, (evt) => {
        if (evt.type === 'delete') send({ type: 'delete', tokens: null })
        else send({ type: 'update', tokens: evt.tokens })
      })

      stream.onAbort(() => {
        closed = true
        unsubscribe()
      })

      // Hold the connection open with periodic pings until the client
      // disconnects (onAbort flips `closed`) or the stream otherwise closes.
      while (!closed && !stream.closed) {
        await stream.sleep(sseHeartbeatMs)
        if (!closed && !stream.closed) {
          await send({ type: 'ping' })
        }
      }
      unsubscribe()
    })
  })

  // ───────────────────────────────────────────────────────────────────────────
  // Binding graph (roadmap §7 copy/paste theming) — lazy-built + cached.
  // READ/COMPUTE only: this index never mutates source, tokens, or main.
  //
  // Lazy-with-cache (spec default for the spike): the graph is built on first
  // /usages|/graft request from the existing accessors and reused thereafter.
  // The cache key is the identity of the resolved array + the artifact index
  // object, so a watchSources rebuild (which swaps those refs) transparently
  // invalidates us without wiring an explicit watcher.
  // ───────────────────────────────────────────────────────────────────────────
  let graphCache = null // { keyResolved, keyIndex, graph }

  const getBindingGraph = () => {
    const resolved = getResolvedTokens()
    const index = getArtifactIndex()
    if (graphCache && graphCache.keyResolved === resolved && graphCache.keyIndex === index) {
      return graphCache.graph
    }
    // Gather every story artifact via the index (id → artifact). getArtifact
    // returns the whole *.sorb.json (may carry multiple stories); buildBindingGraph
    // walks each artifact's stories[].root. Dedupe artifact files so a multi-story
    // file is only walked once.
    const artifacts = []
    const seen = new Set()
    const stories = (index && index.stories) || {}
    for (const storyId of Object.keys(stories)) {
      const art = getArtifact(storyId)
      if (!art) continue
      // Identity-dedupe: getArtifact may return the same object for sibling
      // stories sharing one file.
      if (seen.has(art)) continue
      seen.add(art)
      artifacts.push(art)
    }
    const graph = buildBindingGraph(resolved, artifacts)
    graphCache = { keyResolved: resolved, keyIndex: index, graph }
    return graph
  }

  // ───────────────────────────────────────────────────────────────────────────
  // HOSTED middleware (registered ONLY when a database is configured)
  // ───────────────────────────────────────────────────────────────────────────
  if (hosted) {
    // 1) Auth — resolve the Bearer key on every route except infra probes and
    //    CORS preflight. MUST run BEFORE the CORS middleware: Hono's `cors`
    //    evaluates its `origin` callback at the TOP of its handler (before
    //    `next()`), so the authed context it scopes against has to already be on
    //    the request. Registering auth first guarantees `c.get('auth')` is
    //    populated by the time CORS decides the Access-Control-Allow-Origin
    //    header for real (keyed) requests. Preflight (OPTIONS) carries no
    //    Authorization header, so we skip auth for it and let CORS answer it.
    // Auth early-returns (401/503) happen BEFORE the CORS middleware runs, so
    // without this they'd carry no Access-Control-Allow-Origin header and a
    // browser would surface them as an opaque "Failed to fetch" instead of a
    // readable status — masking auth/DB errors for the null-origin Figma plugin
    // (canopy). Echo the request Origin on these error responses so the client
    // can read the real status. Safe: a 401/503 body carries no tenant data, and
    // no cookies/credentials are involved (Bearer-token auth only).
    const echoErrorCors = (c) => {
      const o = c.req.header('Origin')
      if (o) c.header('Access-Control-Allow-Origin', o)
    }

    app.use('*', async (c, next) => {
      const path = c.req.path
      if (path === '/health' || path === '/ready') return next()
      // Preflight: no body, no key. Let the CORS middleware (registered next)
      // answer it; never 401 a preflight.
      if (c.req.method === 'OPTIONS') return next()

      let ctx
      try {
        ctx = await resolveApiKey(db, c.req.header('Authorization'))
      } catch (e) {
        // DB outage during auth lookup — fail CLOSED, never fall through to
        // open/local behavior.
        onError(e, { at: 'auth' })
        echoErrorCors(c)
        return c.json({ error: 'Service unavailable', code: 'db_unavailable' }, 503)
      }
      if (!ctx) {
        echoErrorCors(c)
        return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401)
      }
      c.set('auth', ctx)

      // Resolve + degrade entitlements once per request, behind the same DB.
      let ent
      try {
        ent = effectiveEntitlements(await getEntitlements(db, ctx.orgId))
      } catch (e) {
        onError(e, { at: 'entitlements' })
        echoErrorCors(c)
        return c.json({ error: 'Service unavailable', code: 'db_unavailable' }, 503)
      }
      c.set('ent', ent)

      return next()
    })

    // 2) Scoped CORS — defense-in-depth on top of auth + tenant scoping.
    //    NEVER '*' in hosted mode. Preflight (OPTIONS) carries no Authorization
    //    header so it cannot be project-scoped; we echo the Origin permissively
    //    for preflight (it reveals nothing — the real request is still auth +
    //    tenant gated). For real (keyed) requests auth has already run, so we
    //    echo the Origin only when it is a member of the authed project's
    //    allowed_origins.
    app.use(
      '*',
      cors({
        origin: (origin, c) => {
          if (!origin) return origin
          // Figma plugin (canopy) runs in a sandboxed iframe with an opaque
          // `null` origin — allow it so the plugin can read /health, /tokens,
          // /verify. Safe: the pk key still gates all data; /health is public.
          // Mirrors the /preview crossSiteWriteGuard's plugin allowance.
          if (origin === 'null') return origin
          // Preflight: no body, no key — echo so the browser proceeds to the
          // real (authoritative) request.
          if (c.req.method === 'OPTIONS') return origin
          const ctx = c.get('auth')
          if (ctx && Array.isArray(ctx.allowedOrigins) && ctx.allowedOrigins.includes(origin)) {
            return origin
          }
          // Deny: returning undefined omits the ACAO header. Empty
          // allowed_origins ⇒ deny all cross-origin (never '*').
          return undefined
        },
      }),
    )
  } else {
    // LOCAL mode — today's open CORS, unchanged.
    app.use('*', cors({ origin: corsOrigin }))

    // C2 (P0.3b): reject cross-site browser WRITES to /preview*. The local
    // bridge is no-auth + open CORS, so a web page the dev visits while
    // `sorb dev` runs could POST/PUT/DELETE a preview that the leaf SDK then
    // injects into the running app (CSRF drive-by repaint / CSS-exfil).
    //
    // We allow the two LEGITIMATE writers and reject everything else:
    //   - leaf SDK   (app localhost:5173 → bridge localhost:7777): same-site,
    //     Sec-Fetch-Site: same-site → ALLOW.
    //   - Figma plugin (canopy sandboxed iframe): Origin: null (opaque) or
    //     https://www.figma.com → ALLOW (the one legit cross-site writer).
    //   - curl / server-side SDK: no Origin header → ALLOW.
    //   - a drive-by site (https://evil.com): Sec-Fetch-Site: cross-site +
    //     a real Origin not on the allowlist → REJECT 403.
    //
    // Scoped to LOCAL mode only: the hosted bridge has remoteAuth + scoped CORS
    // and registers a different middleware stack, so this never runs there.
    const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE'])

    // Default allowlist: localhost/127.0.0.1 (any scheme/port) + Figma origins.
    // Consumers may extend via config.allowedWriteOrigins (array of origins).
    const extraAllowed = Array.isArray(config.allowedWriteOrigins)
      ? config.allowedWriteOrigins
      : []
    const allowedWriteOrigins = new Set([
      'https://www.figma.com',
      'https://figma.com',
      ...extraAllowed,
    ])

    /**
     * Is this an allowed write origin? Accepts the static allowlist plus any
     * localhost / 127.0.0.1 / [::1] origin on any scheme + port (the SDK + the
     * dev's own app live there).
     * @param {string} origin
     * @returns {boolean}
     */
    const isAllowedWriteOrigin = (origin) => {
      if (allowedWriteOrigins.has(origin)) return true
      let host
      try {
        host = new URL(origin).hostname
      } catch (e) {
        return false
      }
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
    }

    app.use('/preview', crossSiteWriteGuard)
    app.use('/preview/:id', crossSiteWriteGuard)

    /**
     * Hono middleware: 403 a cross-site browser write to /preview*. READS (GET)
     * and non-write methods pass straight through.
     * @param {import('hono').Context} c
     * @param {() => Promise<void>} next
     */
    async function crossSiteWriteGuard(c, next) {
      if (!WRITE_METHODS.has(c.req.method)) return next()

      const origin = c.req.header('Origin')
      const fetchSite = c.req.header('Sec-Fetch-Site')

      // No Origin (curl / server-side SDK) ⇒ not a browser cross-site write.
      if (origin === undefined || origin === null) return next()
      // Opaque origin (sandboxed Figma plugin iframe) ⇒ allow.
      if (origin === 'null') return next()
      // Same-origin / same-site / direct navigation ⇒ allow (leaf SDK is
      // same-site: localhost:5173 → localhost:7777).
      if (fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none') {
        return next()
      }
      // Explicitly allowlisted origin (localhost/127.0.0.1/Figma/extra) ⇒ allow.
      if (isAllowedWriteOrigin(origin)) return next()
      // A real cross-site write from an untrusted web origin ⇒ block.
      if (fetchSite === 'cross-site') {
        return c.json({ error: 'cross-site write blocked' }, 403)
      }
      // No Sec-Fetch-Site header (older clients / non-browser) but a real,
      // non-allowlisted Origin: be conservative but non-breaking — allow,
      // since legitimate non-browser writers may set Origin without Sec-Fetch-*.
      // The cross-site case above is the CSRF drive-by we must block; browsers
      // that omit Sec-Fetch-Site are pre-2020 and out of scope here.
      return next()
    }
  }

  // Scope guard: WRITE ops require a 'secret' key. Returns a Response (the 403)
  // when the key is read-only, or null when the caller may proceed. In local
  // mode there is no auth context, so this is a no-op.
  const requireWrite = (c) => {
    if (!hosted) return null
    const ctx = c.get('auth')
    if (ctx.scope !== SCOPE.WRITE) {
      return c.json({ error: 'Publishable keys are read-only', code: 'read_only' }, 403)
    }
    return null
  }

  // Preview surface is EPHEMERAL and non-destructive: creating/updating/clearing
  // a preview never mutates the committed token set (that is `POST /tokens/figma`,
  // which stays `requireWrite`/secret-gated). The account-pairing front door mints
  // a READ-ONLY publishable key, so the Figma plugin (and any cloud-side push)
  // holds a `pk_`; requiring a secret key here made the whole preview payoff 403.
  // We therefore accept ANY authenticated key for the preview routes — auth
  // middleware still guarantees a valid, project-scoped key in hosted mode, and
  // previews remain TTL-bounded, count-capped, and only render on apps that opt
  // into preview mode with an allowlisted bridge origin. In local mode there is
  // no auth context, so this is a no-op (parity with requireWrite).
  const requirePreviewWrite = (_c) => null

  // Count the authed project's currently-active previews from the DB previews
  // table (project-scoped + TTL-aware). Owned by juice (001_core.sql).
  const activePreviewCount = async (projectId) => {
    const res = await db.query(
      'SELECT count(*)::int AS n FROM previews WHERE project_id = $1 AND (expires_at IS NULL OR expires_at > now())',
      [projectId],
    )
    const row = res && res.rows && res.rows[0]
    return row ? Number(row.n) || 0 : 0
  }

  // Sharing gate (frozen for the future share route). Returns the 402 Response
  // when sharing is locked, else null.
  const requireSharing = (c) => {
    const ent = c.get('ent')
    if (!ent || ent.previewSharing !== true) {
      return c.json({ error: 'Preview sharing is not available on your plan', code: 'sharing_locked', upgradeUrl }, 402)
    }
    return null
  }

  // ─── POST /preview ────────────────────────────────────────────────────────
  // Figma plugin POSTs a proposed token set here.
  // Returns a short preview ID the React app can use via ?preview=<id>
  //
  // BODY SHAPE (phase-2 dark mode): EITHER
  //   - legacy flat  — a plain map { "--token": "value", ... } (today's shape), OR
  //   - mode-aware   — { tokens: {...}, darkTokens?: {...}, darkMode?: {...} },
  //     a wrapper object carrying a `tokens` key (detection: presence of a
  //     `tokens` key on the body means mode-aware; a flat map never has one,
  //     since CSS custom-property names always start with `--`).
  // The bridge stores + returns the body VERBATIM in either shape — it never
  // inspects, flattens, or strips fields. Store + routes are shape-agnostic by
  // construction (see src/store/memory.js / redis.js: `tokens` is opaque JSON
  // to both), so this needed no store change. Detection/interpretation of the
  // shape is entirely a leaf/cloud-side concern.
  app.post('/preview', async (c) => {
    if (hosted) {
      const denied = requirePreviewWrite(c)
      if (denied) return denied

      const ctx = c.get('auth')
      const ent = c.get('ent')

      // Sharing-gated when explicitly requested via ?share=1 (frozen contract).
      if (c.req.query('share') === '1') {
        const locked = requireSharing(c)
        if (locked) return locked
      }

      // Active-preview cap. -1 = unlimited (Free gate is TTL+sharing, not count).
      if (ent.maxActivePreviews !== -1) {
        let active
        try {
          active = await activePreviewCount(ctx.projectId)
        } catch (e) {
          onError(e, { at: 'preview.count' })
          return c.json({ error: 'Service unavailable', code: 'db_unavailable' }, 503)
        }
        if (active >= ent.maxActivePreviews) {
          return c.json(
            {
              error: `Active preview limit reached (${ent.maxActivePreviews}). Upgrade for more concurrent previews.`,
              code: 'preview_limit',
              upgradeUrl,
            },
            402,
          )
        }
      }

      const tokens = await c.req.json()
      const id = nanoid(8)
      // Persistent (paid) ⇒ no expiry; otherwise 24h TTL.
      const ttlMs = ent.previewPersistence ? null : previewTtlMs
      await store.putPreview(id, tokens, ttlMs)

      // E2 (sensor spine): mint the chain_id that threads proposal ->
      // verify_result -> accept_reject for this preview's whole cycle. Minted
      // HERE (not in sensor.js's insert path) so it can be persisted alongside
      // the preview bookkeeping row below and looked up later by id.
      const chainId = mintChainId()

      // Bookkeeping row for the per-project count + TTL (juice owns previews).
      const expiresAt = ttlMs == null ? null : new Date(Date.now() + ttlMs)
      try {
        await db.query(
          'INSERT INTO previews (id, project_id, expires_at, chain_id) VALUES ($1, $2, $3, $4)',
          [id, ctx.projectId, expiresAt, chainId],
        )
      } catch (e) {
        // Best-effort bookkeeping: the preview is already in the store. A failed
        // insert only affects future counting; do not fail the request. Report
        // it so silent bookkeeping drift is observable.
        onError(e, { at: 'preview.bookkeeping.insert', id })
      }

      // E2 (sensor spine): emit `proposal` — best-effort, never blocks the
      // response. isConsented() is checked inside recordProposal(); when the
      // org hasn't consented this is a silent no-op.
      recordProposal(db, { chainId, orgId: ctx.orgId, appId: ctx.projectId, previewId: id, tokens }, onError).catch(
        (e) => onError(e, { at: 'sensor.proposal', id }),
      )

      // E2 (sensor spine): `accept_reject` is inferred, not explicit — there is
      // no dedicated route. Subscribe to this ONE preview's terminal delete so
      // whichever happens first (DELETE /preview/:id or TTL-expiry) emits a
      // `rejected` event with the right `signal`. Unsubscribes itself the
      // moment it fires (bounded lifetime = this preview's lifetime, itself
      // bounded by entitlements.maxActivePreviews). 'accepted' /
      // 'explicit_commit' is NOT wired here — see recordAcceptReject's doc
      // comment: no route in this repo writes token_commits today.
      const unsubscribeTerminal = store.onUpdate(id, (evt) => {
        if (evt.type !== 'delete') return
        unsubscribeTerminal()
        const signal = explicitDiscards.has(id) ? 'explicit_discard' : 'ttl_expiry'
        explicitDiscards.delete(id)
        recordAcceptReject(
          db,
          { chainId, orgId: ctx.orgId, appId: ctx.projectId, previewId: id, outcome: 'rejected', signal },
          onError,
        ).catch((e) => onError(e, { at: 'sensor.acceptReject', id }))
      })

      const url = `?preview=${id}`
      return c.json({ id, url })
    }

    // LOCAL mode — unchanged, PLUS the optional E4 result-sync hook below
    // (a strict no-op when onLocalResultSync wasn't wired — see its doc
    // comment above — so this stays byte-for-byte the free local bridge).
    const tokens = await c.req.json()
    const id = nanoid(8)
    await store.putPreview(id, tokens)

    // E4 (Mode C result-sync): emit `proposal`, then subscribe to this ONE
    // preview's terminal delete to emit `accept_reject` (rejected —
    // explicit_discard or ttl_expiry), mirroring the hosted branch's E2
    // wiring above but routed through the local hook instead of a DB insert.
    // chainId is minted + tracked here (not in resultSync.js) so it's stable
    // across the whole proposal -> verify -> accept/reject cycle for this id.
    // Entirely skipped (zero extra listeners/bookkeeping) when no account is
    // configured — see resultSyncActive's doc comment.
    if (resultSyncActive) {
      const chainId = mintChainId()
      localChainIds.set(id, chainId)
      try {
        onLocalResultSync('proposal', { chainId, previewId: id, tokens })
      } catch (e) {
        onError(e, { at: 'resultSync.proposal', id })
      }
      const unsubscribeLocalTerminal = store.onUpdate(id, (evt) => {
        if (evt.type !== 'delete') return
        unsubscribeLocalTerminal()
        const signal = explicitDiscards.has(id) ? 'explicit_discard' : 'ttl_expiry'
        explicitDiscards.delete(id)
        localChainIds.delete(id)
        try {
          onLocalResultSync('accept_reject', { chainId, previewId: id, outcome: 'rejected', signal })
        } catch (e) {
          onError(e, { at: 'resultSync.acceptReject', id })
        }
      })
    }

    const url = `?preview=${id}`
    return c.json({ id, url })
  })

  // ─── GET /preview/latest ──────────────────────────────────────────────────
  // The project's most-recently-pushed live preview (#4b dependency — lets
  // sorb-cloud snapshot "what's currently being previewed" without knowing an
  // id up front). MUST be registered before /preview/:id or Hono treats
  // "latest" as an :id param. Read-only: allowed for BOTH publishable and
  // secret scope in hosted mode (mirrors GET /preview/:id).
  //
  // Response contract (matched to the cloud agent's toResolved()):
  //   200 { id, tokens } — `tokens` is exactly the shape POST/PUT /preview
  //     stored (whatever the plugin pushed), under a `tokens` field.
  //   404 { error: 'no_preview' } — no current preview for the caller.
  //
  // DARK-MODE ENVELOPE SEAM (phase-2): the stored body may itself be either a
  // legacy flat map ({ "--token": "value" }) or a mode-aware wrapper
  // ({ tokens, darkTokens, darkMode }) — see server.js's POST /preview comment.
  // This route does NOT special-case that: `tokens` here is always the WHOLE
  // stored body, unmodified — for a mode-aware preview that means the response
  // is { id, tokens: { tokens, darkTokens, darkMode } }, i.e. this route's
  // outer `tokens` field is "the preview body", not "the light-mode token map".
  // Chosen over introducing a new top-level field (e.g. `preview`) to keep this
  // route's response shape byte-for-byte unchanged for legacy flat previews
  // (today's only consumers). Downstream (leaf/cloud): apply the SAME
  // mode-aware detection (`'tokens' in body`) to this route's `tokens` field
  // that you'd apply to a GET /preview/:id body directly.
  app.get('/preview/latest', async (c) => {
    if (hosted) {
      const ctx = c.get('auth')
      let row
      try {
        // Tenant-scoped "latest": the store itself has no per-project concept
        // (see store.getLatestPreview's doc comment), so hosted mode sources
        // the newest non-expired id from the same `previews` bookkeeping table
        // GET/PUT/DELETE /preview/:id already use for tenant ownership.
        const res = await db.query(
          'SELECT id FROM previews WHERE project_id = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 1',
          [ctx.projectId],
        )
        row = res && res.rows && res.rows[0]
      } catch (e) {
        onError(e, { at: 'preview.latest.owner' })
        return c.json({ error: 'Service unavailable', code: 'db_unavailable' }, 503)
      }
      if (!row) {
        return c.json({ error: 'no_preview' }, 404)
      }
      const entry = await store.getPreview(row.id)
      if (!entry) {
        // DB bookkeeping row outlived the store entry (store TTL raced the DB
        // row) — treat it the same as "no preview", never leak a stale id.
        return c.json({ error: 'no_preview' }, 404)
      }
      return c.json({ id: row.id, tokens: entry.tokens })
    }

    // LOCAL mode — no auth, single global "latest" tracked by the store.
    const latest = await store.getLatestPreview()
    if (!latest) {
      return c.json({ error: 'no_preview' }, 404)
    }
    return c.json({ id: latest.id, tokens: latest.tokens })
  })

  // ─── GET /preview/:id ─────────────────────────────────────────────────────
  // React app polls this while a preview is active. Allowed for BOTH read
  // (publishable) and write (secret) scope in hosted mode.
  app.get('/preview/:id', async (c) => {
    const id = c.req.param('id')
    const entry = await store.getPreview(id)
    if (!entry) {
      return c.json({ error: 'Preview not found or expired' }, 404)
    }
    if (hosted) {
      // Tenant isolation: never reveal a cross-tenant preview's existence.
      const ctx = c.get('auth')
      let owned = false
      try {
        const res = await db.query(
          'SELECT 1 FROM previews WHERE id = $1 AND project_id = $2 LIMIT 1',
          [id, ctx.projectId],
        )
        owned = Boolean(res && res.rows && res.rows.length)
      } catch (e) {
        onError(e, { at: 'preview.owner', method: 'GET', id })
        return c.json({ error: 'Service unavailable', code: 'db_unavailable' }, 503)
      }
      if (!owned) {
        return c.json({ error: 'Preview not found or expired' }, 404)
      }
    }
    return c.json(entry.tokens)
  })

  // ─── PUT /preview/:id ─────────────────────────────────────────────────────
  // Plugin updates an existing preview in-place (live edit mode). WRITE op.
  app.put('/preview/:id', async (c) => {
    const id = c.req.param('id')
    if (hosted) {
      const denied = requirePreviewWrite(c)
      if (denied) return denied
      // Tenant scope: a cross-tenant id is "not found".
      const ctx = c.get('auth')
      let owned = false
      try {
        const res = await db.query(
          'SELECT 1 FROM previews WHERE id = $1 AND project_id = $2 LIMIT 1',
          [id, ctx.projectId],
        )
        owned = Boolean(res && res.rows && res.rows.length)
      } catch (e) {
        onError(e, { at: 'preview.owner', method: 'PUT', id })
        return c.json({ error: 'Service unavailable', code: 'db_unavailable' }, 503)
      }
      if (!owned) {
        return c.json({ error: 'Preview not found' }, 404)
      }
    }
    const tokens = await c.req.json()
    const updated = await store.updatePreview(id, tokens)
    if (!updated) {
      return c.json({ error: 'Preview not found' }, 404)
    }
    return c.json({ id, updated: true })
  })

  // ─── DELETE /preview/:id ──────────────────────────────────────────────────
  // Plugin clears a preview when designer exits without committing. WRITE op.
  app.delete('/preview/:id', async (c) => {
    const id = c.req.param('id')
    if (hosted) {
      const denied = requirePreviewWrite(c)
      if (denied) return denied
      // Tenant scope: only delete (and report deleted) when it belongs to the
      // tenant. A cross-tenant id is treated as already-absent.
      const ctx = c.get('auth')
      let owned = false
      try {
        const res = await db.query(
          'SELECT 1 FROM previews WHERE id = $1 AND project_id = $2 LIMIT 1',
          [id, ctx.projectId],
        )
        owned = Boolean(res && res.rows && res.rows.length)
      } catch (e) {
        onError(e, { at: 'preview.owner', method: 'DELETE', id })
        return c.json({ error: 'Service unavailable', code: 'db_unavailable' }, 503)
      }
      if (!owned) {
        return c.json({ error: 'Preview not found' }, 404)
      }
      // E2 (sensor spine): mark BEFORE the store write so the terminal
      // store.onUpdate('delete') listener (registered in POST /preview) sees
      // this as an explicit discard rather than a TTL-expiry — see server.js's
      // `explicitDiscards` comment.
      explicitDiscards.add(id)
      await store.deletePreview(id)
      try {
        await db.query('DELETE FROM previews WHERE id = $1 AND project_id = $2', [id, ctx.projectId])
      } catch (e) {
        // Best-effort: the store entry is gone; a stale bookkeeping row only
        // affects future counting and will TTL out. Report so drift is visible.
        onError(e, { at: 'preview.bookkeeping.delete', id })
      }
      return c.json({ deleted: true })
    }
    // E4 (Mode C result-sync): mark explicit-discard BEFORE the store write —
    // same ordering requirement as the hosted branch's explicitDiscards.add()
    // above — so the terminal store.onUpdate('delete') listener registered in
    // POST /preview (only present when resultSyncActive) reports
    // 'explicit_discard' rather than 'ttl_expiry'. A no-op Set.add() when no
    // listener will ever consume it.
    if (resultSyncActive) explicitDiscards.add(id)
    await store.deletePreview(id)
    return c.json({ deleted: true })
  })

  // ─── POST /verify ─────────────────────────────────────────────────────────
  // Plugin posts the post-layout geometry of an inserted component so the
  // canvas can be reconciled against the captured artifact. Returns a short id.
  // WRITE op.
  //
  // In hosted mode: a best-effort INSERT into verify_events is written after
  // the store write so the beta can measure weekly active verify runs per
  // project (moat-proof retention metric R-0607-16). Like preview bookkeeping,
  // a failed insert does not fail the request.
  app.post('/verify', async (c) => {
    if (hosted) {
      const denied = requireWrite(c)
      if (denied) return denied
    }
    // `previewId` (E2, sensor spine): OPTIONAL, additive field — existing
    // callers that omit it are unaffected. When present (and in hosted mode)
    // it correlates this verify_result back to the proposal's chain_id via
    // previews.chain_id (see sensor.js lookupChainId).
    const { storyId, bbox, meta, previewId } = await c.req.json()
    const id = nanoid(8)
    await store.putVerification(id, { storyId, bbox, meta })

    if (hosted) {
      const ctx = c.get('auth')
      const boundFields = (meta && typeof meta.boundFields === 'number') ? meta.boundFields : null
      try {
        await db.query(
          'INSERT INTO verify_events (project_id, story_id, bound_fields) VALUES ($1, $2, $3)',
          [ctx.projectId, storyId ?? null, boundFields],
        )
        // E5 (DARK): compose this telemetry row into the conformance-evidence
        // stream — ONLY when the feed flag is on. Default off ⇒ this never runs
        // and no evidence row is written. Best-effort; never fails the request.
        if (feedOn) {
          await recordEvidenceEvent(
            db,
            ctx.projectId,
            composeTelemetryEvent({ storyId, boundFields, environment: ctx.environment }),
            onError,
          )
        }
      } catch (e) {
        // Best-effort: the verify is already recorded in the store. A failed
        // insert only affects telemetry; do not fail the request.
        onError(e, { at: 'verify.telemetry.insert', id })
        // E5 (DARK): capture the operational signal onto the evidence stream —
        // the Sentry leg. Only when the feed is on; carries a coarse tag, no
        // error detail. Best-effort within the catch.
        if (feedOn) {
          await recordEvidenceEvent(
            db,
            ctx.projectId,
            composeSignalEvent({ at: 'verify.telemetry.insert', environment: ctx.environment }),
            onError,
          )
        }
      }

      // E2 (sensor spine): `verify_result` (check: 'figma_geometry'). Only
      // emitted when the caller passed `previewId` (correlation is required —
      // see sensor-events.schema.json Envelope.chain_id) and it resolves to a
      // chain_id. Best-effort; never blocks the response.
      //
      // ASSUMPTION (flagged, not silently papered over): POST /verify has NO
      // real comparison logic today — it just stores the plugin's self-reported
      // {bbox, meta}, it never diffs against an expected geometry. There is
      // therefore no real ok/checked/matched to report for this check. Until a
      // real figma_geometry diff lands (that's a separate, larger feature),
      // this reports a PROXY: `ok: true`, `checked`/`matched` = boundFields (a
      // self-report count, not a verified match count), `mismatch_count: 0`.
      // This is a documented gap, not a designed metric — the alternative
      // (schema requires ok/checked/matched to be present) would be to skip
      // this check type entirely, which seemed worse than a clearly-flagged
      // proxy. Revisit once GET /verify/figma's real diff logic (or an
      // equivalent) is available at this call site.
      if (previewId) {
        try {
          const chainId = await lookupChainId(db, previewId, ctx.projectId)
          if (chainId) {
            const proxyCount = Number.isFinite(boundFields) ? boundFields : 0
            recordVerifyResult(
              db,
              {
                chainId,
                orgId: ctx.orgId,
                appId: ctx.projectId,
                check: 'figma_geometry',
                ok: true,
                checked: proxyCount,
                matched: proxyCount,
                mismatchCount: 0,
              },
              onError,
            ).catch((e) => onError(e, { at: 'sensor.verifyResult', id }))
          }
        } catch (e) {
          onError(e, { at: 'sensor.verifyResult.lookup', id })
        }
      }
    }

    // E4 (Mode C result-sync): the LOCAL-mode mirror of the `!hosted` proxy
    // reported above — same PROXY caveat (POST /verify has no real geometry
    // diff yet). Only fires when previewId correlates to a chain_id this
    // process minted (POST /preview) — i.e. only for previews created in
    // THIS local-bridge session, and only when resultSyncActive.
    if (!hosted && resultSyncActive && previewId) {
      const chainId = localChainIds.get(previewId)
      if (chainId) {
        const boundFields = (meta && typeof meta.boundFields === 'number') ? meta.boundFields : null
        const proxyCount = Number.isFinite(boundFields) ? boundFields : 0
        try {
          onLocalResultSync('verify_result', {
            chainId,
            check: 'figma_geometry',
            ok: true,
            checked: proxyCount,
            matched: proxyCount,
            mismatchCount: 0,
          })
        } catch (e) {
          onError(e, { at: 'resultSync.verifyResult', id })
        }
      }
    }

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

  // ─── GET /verify/figma ──────────────────────────────────────────────────────
  // FIGMA-vs-DTCG drift check: diffs the latest Figma Variables export (POST
  // /tokens/figma) against the committed resolved map (GET /tokens/resolved),
  // matched by cssVar. This route only FLAGS drift — it never resolves it: the
  // DTCG token source is truth, the Figma export is a mirror. Compares
  // format-insensitively (lowercase + collapse whitespace), same as
  // POST /verify/app. `ok` mirrors /verify/app's contract (mismatches-only);
  // missingInFigma/extraInFigma are reported but don't themselves flip `ok`,
  // since a partial/in-progress export is a normal transient state.
  // MUST be registered before /verify/:id or Hono treats "figma" as :id.
  app.get('/verify/figma', async (c) => {
    const resolved = getResolvedTokens()
    if (!resolved) {
      return c.json(
        { error: 'No resolved token map. Run `sorb-seed resolve` (Style Dictionary build).' },
        404,
      )
    }
    const artifact = await store.getFigmaArtifact()
    if (!artifact) {
      return c.json(
        { error: 'No Figma export yet. Run "Export variables" in the Sorb plugin.' },
        404,
      )
    }

    // Every entry here is expected to already carry a cssVar (both the SD build
    // and the plugin exporter produce one); the id-derived fallback only
    // protects against a malformed/partial artifact.
    const cssVarOf = (t) => t.cssVar || '--' + String(t.id || '').split('.').join('-')
    const want = new Map(resolved.map((t) => [cssVarOf(t), t.value]))
    const got = new Map(artifact.tokens.map((t) => [cssVarOf(t), t.value]))

    const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ')

    const mismatches = []
    const missingInFigma = []
    let matched = 0
    for (const [cssVar, expected] of want) {
      if (!got.has(cssVar)) {
        missingInFigma.push(cssVar)
        continue
      }
      const figmaValue = got.get(cssVar)
      if (norm(expected) === norm(figmaValue)) matched++
      else mismatches.push({ cssVar, tokens: expected, figma: figmaValue })
    }
    const extraInFigma = [...got.keys()].filter((cssVar) => !want.has(cssVar))
    const checked = want.size

    return c.json({
      ok: mismatches.length === 0 && checked > 0,
      checked,
      matched,
      mismatches,
      missingInFigma,
      extraInFigma,
      fileKey: artifact.fileKey ?? null,
      configuredFileKey: config.figmaFileKey ?? null,
    })
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

  // ─── POST /verify/activity ───────────────────────────────────────────────
  // Record that the current Figma user just ran a preview. Non-critical — no
  // auth gate (same as /health) since it carries no secrets (display name only).
  app.post('/verify/activity', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 64) : null
    if (!displayName) return c.json({ error: 'displayName required' }, 400)
    const ns = c.get('namespace') || namespace
    const entries = pruneActivity(activityLog.get(ns) || [])
    entries.push({ displayName, verifiedAt: new Date().toISOString() })
    activityLog.set(ns, entries)
    return c.json({ ok: true })
  })

  // ─── GET /verify/activity ────────────────────────────────────────────────
  // Returns the most recent *other* user's activity entry (exclude= self).
  app.get('/verify/activity', (c) => {
    const ns = c.get('namespace') || namespace
    const exclude = c.req.query('exclude') || null
    const entries = pruneActivity(activityLog.get(ns) || [])
    const others = exclude ? entries.filter((e) => e.displayName !== exclude) : entries
    const latest = others.length > 0 ? others[others.length - 1] : null
    return c.json({ latest })
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

  // ─── POST /verify/app ──────────────────────────────────────────────────────
  // RUNNING-APP token verification (roadmap §3 / e2e-fix W2): the app reports the
  // values it actually resolved for a set of tokens (`@sorb/leaf`'s `verifyResolved`
  // reads them off `:root`), and the bridge diffs them against the committed
  // resolved map. "verified" = the LIVE app resolves to the bound token values —
  // not the Figma-side bbox geometry that POST /verify records. Reads the same
  // resolved map as GET /tokens/resolved and writes nothing; in hosted mode the
  // global auth middleware still gates it (only /health + /ready are open).
  // NOTE: getResolvedTokens() is a single global map (no tenant scope) — fine for
  // the local bridge; revisit before any multi-tenant hosted rollout.
  app.post('/verify/app', async (c) => {
    let body
    try {
      body = await c.req.json()
    } catch (e) {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const values = body && body.values
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return c.json({ error: 'Missing { values: { "--token": "value" } }' }, 400)
    }
    const resolved = getResolvedTokens()
    if (!resolved) {
      return c.json(
        { error: 'No resolved token map. Run `sorb-seed resolve` (Style Dictionary build).' },
        404,
      )
    }
    // cssVar -> resolved value, for O(1) lookup.
    const want = new Map(resolved.map((t) => [t.cssVar, t.value]))
    // Compare format-insensitively (lowercase + collapse whitespace) so e.g.
    // `#0F65EF` matches `#0f65ef`. Exact-format MVP; richer color/dimension
    // canonicalization (hex↔rgb, unit math) is a documented follow-up.
    const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ')
    const mismatches = []
    const unknown = []
    let matched = 0
    for (const [cssVar, got] of Object.entries(values)) {
      if (!want.has(cssVar)) {
        unknown.push(cssVar)
        continue
      }
      const expected = want.get(cssVar)
      if (norm(got) === norm(expected)) matched++
      else mismatches.push({ cssVar, expected, got })
    }
    const checked = matched + mismatches.length
    const result = {
      ok: mismatches.length === 0 && checked > 0,
      checked,
      matched,
      mismatches,
      unknown,
    }

    // E5 (DARK): compose this running-app check into the conformance-evidence
    // stream — ONLY when the feed flag is on AND in hosted mode (evidence rows
    // are tenant-scoped). Default off ⇒ this never runs and no evidence row is
    // written. Records COUNTS only (no token names/values). Best-effort.
    if (feedOn) {
      const ctx = c.get('auth')
      if (ctx && ctx.projectId) {
        await recordEvidenceEvent(
          db,
          ctx.projectId,
          composeAppCheckEvent({ result, environment: ctx.environment }),
          onError,
        )
      }
    }

    // E2 (sensor spine): `verify_result` (check: 'app_values') — this route DOES
    // compute real ok/checked/matched (unlike POST /verify above), so the counts
    // here are genuine, not a proxy. `previewId` is an OPTIONAL, additive field
    // on the body (existing callers that omit `values`-only bodies still work);
    // without it there is no chain_id to correlate against, so nothing is
    // emitted. Best-effort; never blocks the response.
    if (hosted) {
      const ctx = c.get('auth')
      const previewId = body && body.previewId
      if (ctx && ctx.projectId && previewId) {
        try {
          const chainId = await lookupChainId(db, previewId, ctx.projectId)
          if (chainId) {
            recordVerifyResult(
              db,
              {
                chainId,
                orgId: ctx.orgId,
                appId: ctx.projectId,
                check: 'app_values',
                ok: result.ok,
                checked: result.checked,
                matched: result.matched,
                mismatchCount: result.mismatches.length,
              },
              onError,
            ).catch((e) => onError(e, { at: 'sensor.verifyResult' }))
          }
        } catch (e) {
          onError(e, { at: 'sensor.verifyResult.lookup' })
        }
      }
    }

    // E4 (Mode C result-sync): the LOCAL-mode mirror — genuine (non-proxy)
    // counts, same as the hosted branch above. Only fires for a previewId
    // this local-bridge session minted a chain_id for.
    if (!hosted && resultSyncActive) {
      const previewId = body && body.previewId
      if (previewId) {
        const chainId = localChainIds.get(previewId)
        if (chainId) {
          try {
            onLocalResultSync('verify_result', {
              chainId,
              check: 'app_values',
              ok: result.ok,
              checked: result.checked,
              matched: result.matched,
              mismatchCount: result.mismatches.length,
            })
          } catch (e) {
            onError(e, { at: 'resultSync.verifyResult' })
          }
        }
      }
    }

    return c.json(result)
  })

  // ─── GET /enterprise/evidence/feed ─────────────────────────────────────────
  // E5 (HELD/DARK): the continuous conformance-EVIDENCE feed READ path. Returns
  // the tenant's recent descriptive evidence events (running-app checks, verify
  // telemetry, captured signals) across environments.
  //
  // DORMANT BY DEFAULT: unless `feedOn` (hosted mode AND SORB_ENTERPRISE_FEED
  // explicitly enabled), this answers 404 — indistinguishable from a route that
  // does not exist. The customer-facing feed does NOT exist on any deployed
  // environment: the three E5 hard gates (E&O+Cyber · GA-ToS · SOC 2) must ALL
  // clear before the flag is ever set. The auth middleware still gates this
  // route in hosted mode (a Bearer key is required), so even when enabled it is
  // tenant-scoped, never public.
  app.get('/enterprise/evidence/feed', async (c) => {
    if (!feedOn) {
      // Dark: reveal nothing. Same shape a non-existent route would 404 with.
      return c.json({ error: 'Not found' }, 404)
    }
    const ctx = c.get('auth')
    if (!ctx || !ctx.projectId) {
      return c.json({ error: 'Not found' }, 404)
    }
    const envFilter = c.req.query('environment')
    const events = await listEvidenceEvents(
      db,
      { projectId: ctx.projectId, environment: envFilter || undefined },
      onError,
    )
    return c.json({
      kind: FEED_KIND,
      framing: FEED_FRAMING,
      disclaimer: FEED_DISCLAIMER,
      events,
    })
  })

  // ─── POST /tokens/figma ────────────────────────────────────────────────────
  // The Figma plugin (sorb-canopy "Export variables" action) POSTs its exported
  // Variables here as a resolved-map artifact:
  //   { fileKey: string|null, exportedAt: string|null, tokens: [{id,cssVar,value,tier,type}] }
  // Stored as the single latest Figma-side snapshot (no history) — GET
  // /tokens/figma and GET /verify/figma read it back. WRITE op, same gate as
  // /preview and /verify.
  app.post('/tokens/figma', async (c) => {
    if (hosted) {
      const denied = requireWrite(c)
      if (denied) return denied
    }
    let body
    try {
      body = await c.req.json()
    } catch (e) {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const tokens = body && body.tokens
    if (!Array.isArray(tokens)) {
      return c.json({ error: 'Missing { tokens: [...] } array' }, 400)
    }
    const artifact = {
      fileKey: body.fileKey ?? null,
      exportedAt: body.exportedAt ?? null,
      tokens,
      receivedAt: Date.now(),
    }
    await store.putFigmaArtifact(artifact)

    // E2 (sensor spine): `conformance_snapshot_ref` — a POINTER only
    // (storage_ref), never the snapshot payload itself (sensor-spine.md
    // Exclusions: the actual `tokens` array never rides this event). Not part
    // of any proposal->verify->accept cycle, so there is no preview to
    // correlate against — mints its own standalone chain_id (documented
    // assumption; the schema requires a chain_id on every event and this is
    // the only event type with no natural chain to join). Best-effort; never
    // blocks the response.
    if (hosted) {
      const ctx = c.get('auth')
      if (ctx && ctx.projectId) {
        recordConformanceSnapshotRef(
          db,
          {
            chainId: mintChainId(),
            orgId: ctx.orgId,
            appId: ctx.projectId,
            snapshotId: nanoid(8),
            // Pointer into juice's own Figma-artifact store (single latest
            // snapshot per project today — see putFigmaArtifact above), never
            // the DOM/tokens payload itself.
            storageRef: `juice:tokens-figma:${ctx.projectId}:${artifact.receivedAt}`,
          },
          onError,
        ).catch((e) => onError(e, { at: 'sensor.conformanceSnapshotRef' }))
      }
    }

    // E4 (Mode C result-sync): LOCAL-mode mirror — same standalone-chain-id
    // assumption as the hosted branch above (no preview to correlate
    // against). storageRef stays a pointer into juice's own local Figma-
    // artifact store, never the tokens payload itself.
    if (!hosted && resultSyncActive) {
      try {
        onLocalResultSync('conformance_snapshot_ref', {
          chainId: mintChainId(),
          snapshotId: nanoid(8),
          storageRef: `juice:tokens-figma:local:${artifact.receivedAt}`,
        })
      } catch (e) {
        onError(e, { at: 'resultSync.conformanceSnapshotRef' })
      }
    }

    return c.json({ ok: true, count: tokens.length, fileKey: artifact.fileKey })
  })

  // ─── GET /tokens/figma ──────────────────────────────────────────────────────
  // The latest Figma Variables export, as posted by the plugin. 404 until the
  // plugin has exported at least once.
  app.get('/tokens/figma', async (c) => {
    const artifact = await store.getFigmaArtifact()
    if (!artifact) {
      return c.json(
        { error: 'No Figma export yet. Run "Export variables" in the Sorb plugin.' },
        404,
      )
    }
    return c.json(artifact)
  })

  // GET /verify/figma lives above, registered before /verify/:id (Hono route
  // ordering — see that route's comment).

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

  // ─── GET /usages?id=<tokenId> | ?cssVar=<var> ─────────────────────────────
  // Reverse query over the binding graph: which captured components/roles render
  // a token. READ-ONLY blast radius (roadmap §7 P1). 400 on missing/both params.
  // An unknown token returns count:0 + components:[] (NOT a 404 — "rendered
  // nowhere" is a valid answer).
  //
  // Response (pinned): { id, cssVar, count, components: [{storyId, role}] }
  //   - ?id=  → id is the queried token id, cssVar resolved from the map.
  //   - ?cssVar= → id is the resolved token id (first match), cssVar echoes the
  //     queried var; when a cssVar maps to multiple ids the components UNION and
  //     count reflects the union.
  app.get('/usages', (c) => {
    const id = c.req.query('id')
    const cssVar = c.req.query('cssVar')
    if ((id && cssVar) || (!id && !cssVar)) {
      return c.json({ error: 'Provide exactly one of ?id= or ?cssVar=' }, 400)
    }
    const graph = getBindingGraph()

    if (id) {
      return c.json(usagesOf(graph, id))
    }

    // ?cssVar= — resolve to token id(s), then union their usages.
    const ids = idsForCssVar(graph, cssVar)
    /** @type {Map<string, {storyId:string, role:string}>} */
    const union = new Map()
    for (const tid of ids) {
      for (const u of usagesOf(graph, tid).components) {
        union.set(u.storyId + ' ' + u.role, u)
      }
    }
    const components = Array.from(union.values())
    return c.json({
      id: ids.length ? ids[0] : null,
      cssVar,
      count: components.length,
      components,
    })
  })

  // ─── GET /blast?id=<tokenId> ──────────────────────────────────────────────
  // Like /usages but expands the alias chain: editing a primitive reports the
  // semantic/component tokens that alias it (same resolved value+type) AND their
  // bound components. READ-ONLY (roadmap §7 P2).
  // Response (pinned): { id, aliasGroup:[tokenId], count, components:[{storyId, role, via}] }
  app.get('/blast', (c) => {
    const id = c.req.query('id')
    if (!id) return c.json({ error: 'Missing ?id=' }, 400)
    const graph = getBindingGraph()
    return c.json(blastRadius(graph, id))
  })

  // ─── POST /graft/plan ─────────────────────────────────────────────────────
  // Plan a theme graft from one component onto another, reconciled BY ROLE
  // (same role key; tie-break by TIER_RANK). COMPUTE-ONLY: returns a changeset +
  // conflict list, never writes (apply is canopy P4 via /preview).
  //
  // Body: { from, to, roles? }  (from/to = storyId)
  // Response (pinned):
  //   { from, to,
  //     changeset: [{role, sourceTokenId, targetTokenId}],
  //     conflicts: [{role, reason}] }
  // A target role with no compatible token, or a type mismatch (e.g. color onto
  // a dimension role), appears in `conflicts` — never silently dropped.
  app.post('/graft/plan', async (c) => {
    let body
    try {
      body = await c.req.json()
    } catch (e) {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    const from = body && body.from
    const to = body && body.to
    const roles = body && body.roles
    if (typeof from !== 'string' || typeof to !== 'string') {
      return c.json({ error: 'Body requires string `from` and `to` (story ids)' }, 400)
    }
    if (roles !== undefined && !Array.isArray(roles)) {
      return c.json({ error: '`roles` must be an array of role keys when present' }, 400)
    }
    const graph = getBindingGraph()
    if (!graph.stories.has(from)) {
      return c.json({ error: 'Unknown source story id: ' + from }, 404)
    }
    if (!graph.stories.has(to)) {
      return c.json({ error: 'Unknown target story id: ' + to }, 404)
    }
    return c.json(graftPlan(graph, from, to, roles))
  })

  // ─── GET /health ──────────────────────────────────────────────────────────
  // Infra probe — open in ALL modes (no auth, no tenant scope).
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
  // Open in ALL modes (no auth). The in-memory store always pings true; a null
  // db (local mode) is "not configured" and skipped. Returns 503 with
  // { ok:false, checks } when any configured backend is unreachable.
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
