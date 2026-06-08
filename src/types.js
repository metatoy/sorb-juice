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
 * @property {number} previewTtlMs TTL for previews + verifications, in ms.
 * @property {number} pruneIntervalMs In-memory prune interval, in ms.
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
 * @property {(id: string, entry: { storyId: string, bbox: object, meta: object }) => Promise<void>} putVerification
 * @property {(id: string) => Promise<VerificationEntry | null>} getVerification
 * @property {() => Promise<VerificationEntry | null>} getLatestVerification
 * @property {() => Promise<number>} countVerifications
 * @property {() => Promise<boolean>} ping
 * @property {() => Promise<void>} close
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
