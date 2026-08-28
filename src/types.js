// Type definitions for @sorb/juice, expressed as JSDoc typedefs.
// No runtime code — purely for editor tooling and docs.

/**
 * A flat map of token name → value.
 * @typedef {Object.<string, string | number>} TokenSet
 */

/**
 * @typedef {Object} PreviewEntry
 * @property {TokenSet} tokens
 * @property {number} createdAt
 */

/**
 * @typedef {Object} SorbCliConfig
 * @property {string} namespace
 *   Matches the namespace in your SorbProvider config.
 * @property {string[]} [tokenSources]
 *   DTCG token source files to watch (re-runs Style Dictionary on change).
 *   Preferred over `tokenPath` for the 3-tier taxonomy.
 * @property {string} [tokenPath]
 *   Legacy: path to a single flat tokens.json. If present, served at
 *   /tokens/latest; otherwise that endpoint derives a flat map from the
 *   SD-built .sorb/resolved.json. Also used as a fallback watch source.
 * @property {string} [styleDictionaryConfig]
 *   Optional path to style-dictionary config — runs build on startup + token change.
 * @property {number} [port] Port for the local server. Defaults to 7777.
 * @property {string} [appUrl]
 *   Optional. The running app page the preview opens (e.g. http://localhost:5173).
 *   Read by `sorb handshake` to assemble an invite; blank/absent is fine. Additive,
 *   back-compatible — configs without it still work.
 * @property {string} [gh]
 *   Optional. GitHub edit URL of the tokens file (the Open-PR target) baked into a
 *   handshake invite. When absent, `sorb handshake` derives it from `git remote`.
 * @property {string} [figmaFileKey]
 *   Optional. The Figma file key this project's Variables live in. Informational
 *   only — surfaced by GET /verify/figma as `configuredFileKey`, never enforced.
 *   The SORB_FIGMA_FILE_KEY env var takes precedence when both are set.
 */

/**
 * 12-factor runtime config produced by loadConfig() (src/config.js), merged
 * with sorb.config.json. Shared contract between the config, store, db and
 * server units.
 * @typedef {Object} Config
 * @property {number} port HTTP listen port (default 7777).
 * @property {string} namespace Tenant/app namespace surfaced in /health.
 * @property {string | undefined} redisUrl redis:// URL. Presence switches the
 *   store factory to the Redis impl; undefined → in-memory store.
 * @property {string | undefined} databaseUrl postgres:// URL. Presence makes
 *   createDb build a Pool; undefined → no DB (local mode).
 * @property {string[] | '*'} corsOrigins Allowed CORS origins, or '*' (open).
 * @property {string[]} [allowedWriteOrigins] Extra origins permitted to make
 *   cross-site WRITES to /preview* in LOCAL mode (on top of the built-in
 *   localhost/127.0.0.1 + Figma allowlist). Used by the P0.3b CSRF guard.
 * @property {number} previewTtlMs TTL for previews + verifications, in ms.
 * @property {number} pruneIntervalMs In-memory prune interval, in ms.
 * @property {number} [sseHeartbeatMs] Interval between `ping` frames on
 *   GET /preview/:id/events (E1). Defaults to 20_000 in server.js when unset
 *   — not currently sourced from env, just an injectable override for tests.
 * @property {string | undefined} figmaFileKey Optional Figma file key
 *   (SORB_FIGMA_FILE_KEY) this project's Variables live in. Informational
 *   only — surfaced by GET /verify/figma, never enforced.
 */

/**
 * A stored verification entry (post-layout geometry self-reported by the
 * Figma plugin), as returned by the store.
 * @typedef {Object} VerificationEntry
 * @property {string} storyId
 * @property {object} bbox
 * @property {object} meta
 * @property {number} createdAt
 */

/**
 * A single Figma-exported token, matching @sorb/core's ResolvedToken shape
 * (the same one returned by GET /tokens/resolved).
 * @typedef {Object} FigmaExportedToken
 * @property {string} id Dotted token id (e.g. "color.action.primary").
 * @property {string} cssVar CSS custom-property name (e.g. "--color-action-primary").
 * @property {string} value
 * @property {string} [tier] "primitive" | "semantic" | "component", when known.
 * @property {string} type
 */

/**
 * The latest Figma Variables export POSTed by the plugin (sorb-canopy) via
 * POST /tokens/figma. Stored as a single "latest" snapshot per store instance
 * (no history) — same persistence pattern as previews/verifications above.
 * @typedef {Object} FigmaArtifact
 * @property {string | null} fileKey Figma file key the export was taken from, or null.
 * @property {string | null} exportedAt ISO timestamp the plugin recorded at export time, or null.
 * @property {FigmaExportedToken[]} tokens
 * @property {number} receivedAt Server-side receipt timestamp (Date.now()) — juice's own bookkeeping.
 */

/**
 * The async Store surface shared by the in-memory and Redis impls. The server
 * only ever awaits these methods — it never reaches into internal maps. See the
 * frozen storeInterface contract.
 * @typedef {Object} Store
 * @property {(id: string, tokens: TokenSet) => Promise<void>} putPreview
 * @property {(id: string) => Promise<PreviewEntry | null>} getPreview
 * @property {(id: string) => Promise<boolean>} hasPreview
 * @property {(id: string, tokens: TokenSet) => Promise<boolean>} updatePreview
 * @property {(id: string) => Promise<void>} deletePreview
 * @property {() => Promise<number>} countPreviews
 * @property {() => Promise<({id: string} & PreviewEntry) | null>} getLatestPreview
 *   The most-recently put/updated preview (LOCAL mode only — this pointer is
 *   process-global, not tenant-scoped; hosted mode's GET /preview/latest
 *   derives "latest" from the tenant-scoped `previews` DB table instead and
 *   never calls this). Backs the cloud-snapshot dependency (#4b).
 * @property {(id: string, entry: { storyId: string, bbox: object, meta: object }) => Promise<void>} putVerification
 * @property {(id: string) => Promise<VerificationEntry | null>} getVerification
 * @property {() => Promise<VerificationEntry | null>} getLatestVerification
 * @property {() => Promise<number>} countVerifications
 * @property {(artifact: FigmaArtifact) => Promise<void>} putFigmaArtifact
 * @property {() => Promise<FigmaArtifact | null>} getFigmaArtifact
 * @property {(id: string, listener: (evt: PreviewUpdateEvent) => void) => (() => void)} onUpdate
 *   Subscribe to put/update/delete events for one preview id. Returns an
 *   unsubscribe function. This is the push primitive the SSE route (E1,
 *   `GET /preview/:id/events`) is built on — it replaces the leaf SDK's poll
 *   loop. Both the memory and Redis stores implement it (EventEmitter bus vs.
 *   Redis pub/sub over a duplicated connection), so callers never know which
 *   backend is behind it.
 * @property {() => Promise<boolean>} ping
 * @property {() => Promise<void>} close
 */

/**
 * An event pushed by {@link Store.onUpdate} when a preview is created,
 * updated, or deleted. `tokens` is null for a `delete` event.
 * @typedef {Object} PreviewUpdateEvent
 * @property {'put' | 'update' | 'delete'} type
 * @property {TokenSet | null} tokens
 */

/**
 * The in-memory binding-graph index built by buildBindingGraph (src/graph/index.js).
 * READ/COMPUTE only — never mutates source. Lazily built + cached in server.js.
 * @typedef {Object} BindingGraph
 * @property {Map<string, {id:string,cssVar:string,value:string|number,tier:string,type:string}>} tokenById
 *   tokenId → ResolvedToken (the resolved bindable token).
 * @property {Map<string, string[]>} idsByCssVar
 *   cssVar → token id(s) that emit it (normally 1:1; union defensively).
 * @property {Map<string, Array<{storyId:string, role:string}>>} usagesByToken
 *   tokenId → the (story, role) bindings that render it (the reverse edge set).
 * @property {Map<string, {storyId:string, component:string|undefined, name:string|undefined, bindings:Array<{role:string, tokenId:string}>}>} stories
 *   storyId → flattened bindings across that story's whole LayerNode tree.
 */

/**
 * The Postgres durable layer returned by createDb (src/db/index.js), or null in
 * local mode when DATABASE_URL is unset.
 * @typedef {Object} DbHandle
 * @property {(text: string, params?: any[]) => Promise<any>} query
 * @property {() => Promise<any>} getClient
 * @property {() => Promise<boolean>} ping
 * @property {() => Promise<void>} close
 * @property {() => Promise<void>} runMigrations
 */

export {}
