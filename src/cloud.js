// Cloud reader adapter for @sorb/juice — the `sorb dev --cloud` mode.
//
// North-star "cloud replaces the CLI" (spec/cloud-codebase-analysis.md · P3).
//
// In the FREE local default the bridge serves the resolved bindable map from
// the on-disk `.sorb/resolved.json` (built by `sorb-seed resolve`). This module
// is the ADDITIVE, opt-in alternative: when `--cloud` (or the cloud env vars)
// are set, the bridge instead serves a project's PUBLISHED HEAD by fetching
// sorb-cloud's `GET <base>/api/token-sets/:id/head`, which returns the SAME
// `ResolvedToken[]` contract { id, cssVar, value, tier, type } the local file
// holds. The Figma plugin (sorb-canopy) and `@sorb/leaf` are byte-for-byte
// unaffected — only the *source* of the resolved map changes.
//
// Design constraints honored:
//   - JavaScript only (JSDoc typedefs). No new deps — uses global `fetch`
//     (Node 20+). No TypeScript anywhere.
//   - The server's `getResolvedTokens()` is called SYNCHRONOUSLY per request.
//     A network round-trip can't happen inside that call, so this adapter keeps
//     a cached snapshot, refreshed on an interval (and once eagerly at startup),
//     and `getResolvedTokens()` returns the latest snapshot synchronously
//     (or null until the first successful fetch — same null contract the local
//     reader uses before `resolve` has run, which the route already 404s on).
//   - Local mode is never touched; this code only runs when `--cloud` is on.

/**
 * @typedef {Object} CloudReaderOptions
 * @property {string} baseUrl
 *   sorb-cloud base URL, e.g. `https://sorbcloud.com` or `http://localhost:3000`.
 *   The HEAD path is appended as `<baseUrl>/api/token-sets/<setId>/head`.
 * @property {string} setId
 *   The token-set id whose PUBLISHED HEAD to serve.
 * @property {string} [apiKey]
 *   Optional API key, sent as `Authorization: Bearer <key>`. HEAD read is free
 *   in the cloud, but a key scopes the request to the caller's tenant when set.
 * @property {number} [refreshMs]
 *   Poll interval for re-fetching HEAD, in ms. Default 15000 (15s). The HEAD
 *   only changes on a new publish, so a modest poll keeps the local preview
 *   fresh without hammering the cloud.
 * @property {number} [timeoutMs]
 *   Per-fetch timeout in ms. Default 10000 (10s).
 * @property {(err: unknown, context?: Record<string, unknown>) => void} [onError]
 *   Optional error sink (mirrors the server's `onError`). Defaults to a no-op;
 *   the CLI passes a console-warning sink so a transient cloud outage is visible
 *   but never crashes the bridge (the last good snapshot keeps serving).
 * @property {typeof fetch} [fetchImpl]
 *   Injectable fetch (defaults to the global). Lets tests drive the adapter
 *   without a real network.
 */

/**
 * One entry of the resolved bindable map — IDENTICAL to the local
 * `.sorb/resolved.json` contract and sorb-cloud's `ResolvedToken`.
 * @typedef {Object} ResolvedToken
 * @property {string} id      dotted token id, e.g. `color.action.primary`
 * @property {string} cssVar  css custom property, e.g. `--color-action-primary`
 * @property {*}      value   resolved value (refs followed), e.g. `#0f65ef`
 * @property {string} tier    `primitive | semantic | component | unknown`
 * @property {*}      type    DTCG `$type`, e.g. `color | dimension | fontWeight`
 * @property {true}   [deprecated]
 * @property {string} [replacedBy]
 */

/**
 * @typedef {Object} CloudReader
 * @property {() => (ResolvedToken[] | null)} getResolvedTokens
 *   The synchronous snapshot accessor wired into createServer's
 *   `getResolvedTokens`. Returns the last successfully-fetched HEAD, or null
 *   until the first fetch completes (or if every fetch has failed).
 * @property {() => Promise<ResolvedToken[] | null>} refresh
 *   Fetch HEAD once and update the snapshot. Resolves to the new snapshot (or
 *   the prior one on failure). Called eagerly at startup and on the interval.
 * @property {() => void} start
 *   Begin the background refresh loop (idempotent).
 * @property {() => void} stop
 *   Stop the refresh loop and release the timer (mirrors watchSources().stop).
 */

/**
 * Build the HEAD URL for a token set. Tolerates a `baseUrl` with or without a
 * trailing slash and (defensively) one that already ends in `/api`.
 * @param {string} baseUrl
 * @param {string} setId
 * @returns {string}
 */
export const headUrl = (baseUrl, setId) => {
  const trimmed = String(baseUrl).replace(/\/+$/, '')
  const base = /\/api$/.test(trimmed) ? trimmed : trimmed + '/api'
  return `${base}/token-sets/${encodeURIComponent(setId)}/head`
}

/**
 * Validate that a fetched payload is a `ResolvedToken[]`. The cloud HEAD route
 * returns the array directly; we accept either the bare array or a
 * `{ tokens: [...] }` envelope (matching the local reader's tolerance in
 * cli.js `readResolvedArray`). Returns the array, or null when the shape is
 * unusable (treated as "no resolved map yet", same as the local 404 path).
 * @param {unknown} data
 * @returns {ResolvedToken[] | null}
 */
export const coerceResolvedArray = (data) => {
  if (Array.isArray(data)) return /** @type {ResolvedToken[]} */ (data)
  if (data && typeof data === 'object' && Array.isArray(/** @type {any} */ (data).tokens)) {
    return /** @type {ResolvedToken[]} */ (/** @type {any} */ (data).tokens)
  }
  return null
}

/**
 * Create a cloud HEAD reader. Pure factory — no side effects until `start()`
 * (or the first `refresh()`) is called.
 *
 * @param {CloudReaderOptions} options
 * @returns {CloudReader}
 */
export const createCloudReader = (options) => {
  const {
    baseUrl,
    setId,
    apiKey,
    refreshMs = 15_000,
    timeoutMs = 10_000,
    onError = () => {},
    fetchImpl = globalThis.fetch,
  } = options

  if (!baseUrl) throw new Error('createCloudReader: baseUrl is required')
  if (!setId) throw new Error('createCloudReader: setId is required')
  if (typeof fetchImpl !== 'function') {
    throw new Error('createCloudReader: global fetch is unavailable (need Node 20+) and no fetchImpl provided')
  }

  const url = headUrl(baseUrl, setId)
  /** @type {ResolvedToken[] | null} */
  let snapshot = null
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null

  /** @returns {ResolvedToken[] | null} */
  const getResolvedTokens = () => snapshot

  /** @returns {Promise<ResolvedToken[] | null>} */
  const refresh = async () => {
    // AbortController bounds the request so a hung cloud never wedges the loop.
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      /** @type {Record<string, string>} */
      const headers = { accept: 'application/json' }
      if (apiKey) headers.authorization = `Bearer ${apiKey}`

      const res = await fetchImpl(url, { headers, signal: ac.signal })
      if (!res.ok) {
        // 404 = HEAD not published yet → keep the prior snapshot (likely null),
        // which the /tokens/resolved route already turns into its 404. Non-OK
        // is reported but never throws to the loop.
        onError(new Error(`cloud HEAD ${res.status} ${res.statusText}`), {
          at: 'cloud.refresh',
          url,
          status: res.status,
        })
        return snapshot
      }
      const arr = coerceResolvedArray(await res.json())
      if (arr) snapshot = arr
      return snapshot
    } catch (e) {
      // Network error / timeout / abort: keep the last good snapshot so the
      // bridge keeps serving the previously-published HEAD through a blip.
      onError(e, { at: 'cloud.refresh', url })
      return snapshot
    } finally {
      clearTimeout(t)
    }
  }

  const start = () => {
    if (timer) return
    // Kick an eager fetch so the first request can be served promptly; ignore
    // the promise (errors are routed through onError inside refresh()).
    void refresh()
    timer = setInterval(() => void refresh(), refreshMs)
    // Don't keep the event loop alive solely for the poll (the HTTP server does
    // that); lets `sorb dev` exit cleanly on SIGINT.
    if (typeof timer.unref === 'function') timer.unref()
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { getResolvedTokens, refresh, start, stop }
}

/**
 * Resolve cloud-reader settings from CLI flags + env, returning null when cloud
 * mode is NOT requested (so the caller stays on the local default).
 *
 * Precedence: explicit CLI flags win over env. Cloud mode is "on" when either
 * `--cloud` is passed OR a `SORB_CLOUD_URL`/`CLOUD_API` base is present.
 *
 * @param {{ cloud?: boolean, cloudUrl?: string, cloudSet?: string, cloudKey?: string }} flags
 *   Parsed commander options (camelCased: `--cloud-url` → `cloudUrl`, etc.).
 * @param {NodeJS.ProcessEnv} [env] Defaults to process.env.
 * @returns {{ baseUrl: string, setId: string, apiKey: string | undefined } | null}
 */
export const resolveCloudConfig = (flags = {}, env = process.env) => {
  const baseUrl =
    flags.cloudUrl ||
    env.SORB_CLOUD_URL ||
    env.CLOUD_API ||
    undefined
  const setId = flags.cloudSet || env.SORB_CLOUD_SET || env.CLOUD_SET || undefined
  const apiKey = flags.cloudKey || env.SORB_CLOUD_KEY || env.CLOUD_API_KEY || undefined

  const requested = Boolean(flags.cloud) || Boolean(baseUrl)
  if (!requested) return null

  if (!baseUrl) {
    throw new Error(
      '--cloud requires a cloud URL. Pass --cloud-url <url> or set SORB_CLOUD_URL.',
    )
  }
  if (!setId) {
    throw new Error(
      '--cloud requires a token-set id. Pass --cloud-set <id> or set SORB_CLOUD_SET.',
    )
  }

  return { baseUrl, setId, apiKey }
}
