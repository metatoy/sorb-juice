// liveData.js — LIVE-app MCP read accessors (roadmap §3: "what's the resolved
// value in the running app *right now*?").
//
// sorbData.js reads the STATIC `.sorb/` files on disk — the last *committed*
// state. These accessors instead query the RUNNING bridge over HTTP, so the
// answer reflects what the app is actually serving this moment (and how many
// previews are live). This is the literal "MCP that sees the running app"
// moat-extension: the file is history; the bridge is ground truth for the live
// app. (spec/sorb-feature-roadmap.md §3 · spec/day/mcp-smart-connect.md.)
//
// Every accessor takes the bridge base URL + an injectable `fetch` (default
// `globalThis.fetch`) so the unit tests stay fully offline. Failures are LOUD
// (the B16 ethos): an unreachable bridge or a 404 resolved-map throws a clear,
// actionable Error rather than silently returning empty.

/** Strip trailing slashes so `${base}${path}` never double-slashes. */
const trimBase = (bridge) => String(bridge || '').replace(/\/+$/, '')

/**
 * Resolve + validate the configured bridge base URL, or throw a friendly error.
 * @param {string|undefined} bridge
 * @returns {string}
 */
const requireBridge = (bridge) => {
  const b = trimBase(bridge)
  if (!b) {
    throw new Error(
      'No live bridge configured. Start the running app with `sorb dev` and pass ' +
        '--bridge <url> (e.g. http://127.0.0.1:7777) so the live-app tools can reach it.',
    )
  }
  return b
}

/**
 * GET `path` on the bridge and parse JSON. Loud on network failure or an
 * unexpected status; `tolerate` lists non-2xx statuses to return normally
 * (with the parsed body) instead of throwing — used by `/ready` (503 is a
 * legitimate "not ready" answer, not a transport error).
 * @param {string} bridge
 * @param {string} path
 * @param {typeof globalThis.fetch | undefined} fetchImpl
 * @param {{ tolerate?: number[] }} [opts]
 * @returns {Promise<{ status: number, body: any }>}
 */
const getBridge = async (bridge, path, fetchImpl, { tolerate = [] } = {}) => {
  const base = requireBridge(bridge)
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') {
    throw new Error('No fetch implementation available for live-bridge reads (Node 20+ or pass { fetch }).')
  }
  let res
  try {
    res = await f(`${base}${path}`)
  } catch (e) {
    throw new Error(
      `Live bridge unreachable at ${base} (GET ${path}): ${e && e.message}. Is \`sorb dev\` running?`,
    )
  }
  let body = null
  let parsed = true
  try {
    body = await res.json()
  } catch {
    parsed = false
    body = null
  }
  if (!res.ok && !tolerate.includes(res.status)) {
    const detail = body && body.error ? ` — ${body.error}` : ''
    throw new Error(`Live bridge GET ${path} returned ${res.status}${detail}`)
  }
  // A 2xx whose body won't parse is a real failure, not a degraded read — be loud
  // rather than silently yielding `undefined` fields downstream.
  if (res.ok && !parsed) {
    throw new Error(`Live bridge GET ${path} returned ${res.status} with an unparseable JSON body.`)
  }
  return { status: res.status, body }
}

/**
 * Live bridge health + readiness for the running app. `/health` is open in all
 * modes; `/ready` may answer 503 (a real "a backend is down" signal we surface
 * rather than throw on).
 * @param {string} bridge
 * @param {{ fetch?: typeof globalThis.fetch }} [opts]
 * @returns {Promise<{bridge:string, reachable:true, namespace:any, activePreviews:any, verifications:any, ready:boolean, readyChecks:any}>}
 */
export const bridgeStatus = async (bridge, { fetch: fetchImpl } = {}) => {
  const base = requireBridge(bridge)
  const { body: health } = await getBridge(base, '/health', fetchImpl)
  const { body: ready } = await getBridge(base, '/ready', fetchImpl, { tolerate: [503] })
  return {
    bridge: base,
    reachable: true,
    namespace: health && health.namespace,
    activePreviews: health && health.activePreviews,
    verifications: health && health.verifications,
    ready: !!(ready && ready.ok === true),
    readyChecks: ready && ready.checks,
  }
}

/**
 * The running app's LIVE resolved token map (GET /tokens/resolved) — one entry
 * per token `{ id, cssVar, value, tier, type }`, exactly as the app is serving
 * it now. Loud if the map hasn't been built (404) or is malformed.
 * @param {string} bridge
 * @param {{ fetch?: typeof globalThis.fetch }} [opts]
 * @returns {Promise<Array<{id:string,cssVar:string,value:any,tier:string,type:string}>>}
 */
export const liveResolvedMap = async (bridge, { fetch: fetchImpl } = {}) => {
  const { body } = await getBridge(bridge, '/tokens/resolved', fetchImpl)
  if (!Array.isArray(body)) {
    throw new Error('Live /tokens/resolved did not return a token array — the running app may be mid-build.')
  }
  return body
}

/**
 * List the running app's live tokens, optionally filtered by tier / DTCG type /
 * substring `q` (over id, cssVar, value) — same filter semantics as the static
 * `list_tokens`, but sourced from the live bridge.
 * @param {string} bridge
 * @param {{ tier?: string, type?: string, q?: string }} [filter]
 * @param {{ fetch?: typeof globalThis.fetch }} [opts]
 * @returns {Promise<Array<object>>}
 */
export const listTokensLive = async (bridge, { tier, type, q } = {}, { fetch: fetchImpl } = {}) => {
  const all = await liveResolvedMap(bridge, { fetch: fetchImpl })
  // Exact parity with the static `listTokens` filter (sorbData.js): null-guard
  // each entry, and match `q` against ONE joined `id\ncssVar\nvalue` haystack.
  const needle = q != null ? String(q).toLowerCase() : null
  return all.filter((t) => {
    if (!t) return false
    if (tier && t.tier !== tier) return false
    if (type && t.type !== type) return false
    if (needle) {
      const hay = `${t.id ?? ''}\n${t.cssVar ?? ''}\n${t.value ?? ''}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
}

/**
 * The live resolved entry for one token id, as the running app serves it now.
 * Loud if the id is absent from the live map (uncommitted / renamed).
 * @param {string} bridge
 * @param {string} id  Dotted token id, e.g. `button.primary.bg.default`.
 * @param {{ fetch?: typeof globalThis.fetch }} [opts]
 * @returns {Promise<{id:string,cssVar:string,value:any,tier:string,type:string}>}
 */
export const resolveValueLive = async (bridge, id, { fetch: fetchImpl } = {}) => {
  if (!id) throw new Error('resolve_value_live requires a token `id`.')
  const map = await liveResolvedMap(bridge, { fetch: fetchImpl })
  const tok = map.find((t) => t.id === id)
  if (!tok) {
    throw new Error(
      `Token "${id}" is not in the running app's live resolved map (${map.length} tokens). ` +
        'It may be uncommitted, renamed, or the app is serving an older build.',
    )
  }
  return tok
}

/**
 * The live override currently applied for an active preview (GET /preview/:id →
 * the `{ cssVar: value }` map the running app is rendering for it). Loud (404)
 * if the preview is not active / has expired. This is the difference between
 * "what's committed" and "what the designer is previewing right now."
 * @param {string} bridge
 * @param {string} id  Preview id.
 * @param {{ fetch?: typeof globalThis.fetch }} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export const getActivePreview = async (bridge, id, { fetch: fetchImpl } = {}) => {
  if (!id) throw new Error('get_active_preview requires a preview `id`.')
  const { body } = await getBridge(bridge, `/preview/${encodeURIComponent(id)}`, fetchImpl)
  return body
}
