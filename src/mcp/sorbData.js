// sorbData.js — pure data layer over a project's local `.sorb/` dir.
//
// This is the read model the MCP server (server.js, Worker B) and the tool
// definitions (tools.js) sit on top of. It owns NO MCP knowledge — just plain
// reads of the resolved token map + capture artifacts, plus a couple of derived
// reverse indexes (token → component). It mirrors the path-safe reading already
// in `src/cli.js` (the `dev` command): never trust a raw artifact path from the
// index — resolve it and confirm it stays INSIDE the project dir.
//
// Contract shapes come from `@sorb/core` (ResolvedToken / LayerNode /
// SorbAnnotation / StoryIndex), pulled in as JSDoc typedefs only — no runtime
// import, JS-only per the hard rules.
//
// Everything here is defensive: a missing file, a malformed JSON blob, or a
// missing field yields an empty result (null / [] / {}), never a throw.

import { readFileSync, existsSync } from 'fs'
import { resolve, sep } from 'path'

/** @typedef {import('@sorb/core').ResolvedToken} ResolvedToken */
/** @typedef {import('@sorb/core').LayerNode} LayerNode */
/** @typedef {import('@sorb/core').StoryIndex} StoryIndex */
/** @typedef {import('@sorb/core').SorbAnnotation} SorbAnnotation */

// ─── canonical artifact shape (B16 / REC-5) ──────────────────────────────────
//
// The capture/seed path writes a story-wrapper — `{ stories: [{ id, root }] }`
// (see sorb-demo/.sorb/Button.sorb.json). A bare `LayerNode` and a single
// `{ root }` wrapper are also accepted as legacy/alternate emissions. Anything
// else is a truly-unparseable shape and THROWS (loud failure, per the policy).
//
// Canonical-with-unwrap: the reader normalizes all three to the underlying
// LayerNode(s) before walking — so the demo Button reads its fill binding
// instead of silently returning null.
//
/**
 * A captured layer node. The `sorb` annotation carries the proposed token
 * `bindings`/`candidates` keyed by role (`fill`/`stroke`/`cornerRadius`/…).
 * @typedef {Object} LayerNode
 * @property {string} [type] Figma node type (`FRAME`/`TEXT`/…).
 * @property {string} [name]
 * @property {SorbAnnotation} [sorb] `{ tokens?, candidates? }` keyed by role.
 * @property {LayerNode[]} [children] Child layers (the walk recurses these).
 */
/**
 * The on-disk artifact, in any of its three accepted shapes. The reader
 * unwraps the two wrappers to the underlying LayerNode(s); any other top-level
 * shape throws `"unexpected artifact shape: <keys>"`.
 * @typedef {LayerNode
 *   | { root: LayerNode }
 *   | { stories: Array<{ root: LayerNode }> }} Artifact
 */
/**
 * @typedef {'bare'|'story-wrapper'|'root-wrapper'} ArtifactShape
 * @typedef {null|'missing'|'escaped-project-dir'} ArtifactError
 */

/**
 * Dev-gated warn — no-op in production, so serve-time isn't noisy. Surfaces
 * loud-failure diagnostics on the console for local debugging only. Enabled
 * when `SORB_DEBUG` is set OR `NODE_ENV !== 'production'`.
 * @param {...any} args
 * @returns {void}
 */
export const warn = (...args) => {
  const on = process.env.SORB_DEBUG || process.env.NODE_ENV !== 'production'
  if (on) console.warn('[sorb]', ...args)
}

/**
 * Normalize an artifact blob to its LayerNode root(s), unwrapping the two
 * legacy/alternate wrappers. Throws on a truly-unparseable top-level shape.
 *
 *   - bare LayerNode (`{ type, … }`)          → `[node]`,           shape 'bare'
 *   - `{ root: LayerNode }`                    → `[root]`,    shape 'root-wrapper'
 *   - `{ stories: [{ root }, …] }`             → `[root, …]`, shape 'story-wrapper'
 *
 * @param {any} data Parsed artifact JSON (already known non-null).
 * @returns {{ roots: LayerNode[], shape: ArtifactShape }}
 * @throws {Error} `unexpected artifact shape: <keys>` on anything else.
 */
export const unwrapArtifact = (data) => {
  if (!data || typeof data !== 'object') {
    throw new Error(`unexpected artifact shape: ${describeShape(data)}`)
  }
  // Story-wrapper: { stories: [{ root }, …] }.
  if (Array.isArray(data.stories)) {
    const roots = data.stories
      .map((s) => s && s.root)
      .filter((r) => r && typeof r === 'object')
    return { roots, shape: 'story-wrapper' }
  }
  // Root-wrapper: { root: LayerNode }.
  if (data.root && typeof data.root === 'object') {
    return { roots: [data.root], shape: 'root-wrapper' }
  }
  // Bare LayerNode: anything that looks like a node (has type/children/sorb/name).
  if (
    typeof data.type === 'string' ||
    Array.isArray(data.children) ||
    (data.sorb && typeof data.sorb === 'object')
  ) {
    return { roots: [data], shape: 'bare' }
  }
  throw new Error(`unexpected artifact shape: ${describeShape(data)}`)
}

/**
 * A short, safe description of a value's top-level shape for the throw message.
 * @param {any} data
 * @returns {string}
 */
const describeShape = (data) => {
  if (data === null) return 'null'
  if (Array.isArray(data)) return 'array'
  const t = typeof data
  if (t !== 'object') return t
  const keys = Object.keys(data)
  return keys.length ? `{${keys.join(',')}}` : '{}'
}

// ─── low-level reads ───────────────────────────────────────────────────────────

/**
 * Parse a JSON file, or null on missing/unreadable/malformed. Never throws.
 * @param {string} p Absolute path.
 * @returns {any|null}
 */
const readJson = (p) => {
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch (e) {
    // Malformed or unreadable → behave as if absent.
    return null
  }
}

/**
 * Load the resolved bindable token map from `.sorb/resolved.json`. The file is
 * written either as a bare array OR as `{ tokens: [...] }` (matches cli.js's
 * `readResolvedArray`). Returns null when absent/malformed.
 * @param {string} dir Project root (the dir that holds `.sorb/`).
 * @returns {ResolvedToken[] | null}
 */
export const loadResolved = (dir) => {
  const data = readJson(resolve(dir, '.sorb', 'resolved.json'))
  if (!data) return null
  const arr = Array.isArray(data) ? data : data.tokens
  return Array.isArray(arr) ? arr : null
}

/**
 * Load the capture index `.sorb/index.json` (`{ stories: { id: { artifact } } }`).
 * Returns null when absent/malformed.
 * @param {string} dir Project root.
 * @returns {StoryIndex | null}
 */
export const loadIndex = (dir) => {
  const idx = readJson(resolve(dir, '.sorb', 'index.json'))
  if (!idx || typeof idx !== 'object') return null
  return idx
}

/**
 * Load a captured artifact by story id and return a **typed** result (REC-4)
 * distinguishing the failure modes that used to both collapse to a bare null:
 *
 *   - `error:'missing'`          — no index entry / no artifact path / file absent.
 *   - `error:'escaped-project-dir'` — the index path escaped the project dir
 *                                     (path-traversal guard tripped).
 *   - `error:null`               — `ok`; `artifact` is the unwrapped LayerNode(s).
 *
 * On success the raw blob is unwrapped (REC-5) to its LayerNode root(s): a bare
 * node, a `{ root }` wrapper, and a `{ stories:[{root}] }` wrapper all read.
 * `roots` always holds every unwrapped LayerNode; `artifact` is the first root
 * (back-compat with the single-node consumers). A truly-unparseable shape
 * THROWS — that propagates as a loud failure.
 *
 * @param {string} dir Project root.
 * @param {string} storyId
 * @returns {{ artifact: LayerNode|null, roots: LayerNode[], shape: ArtifactShape|null, error: ArtifactError }}
 * @throws {Error} `unexpected artifact shape: <keys>` on an unparseable blob.
 */
export const loadArtifactTyped = (dir, storyId) => {
  const idx = loadIndex(dir)
  const entry = idx && idx.stories && idx.stories[storyId]
  if (!entry || !entry.artifact) {
    return { artifact: null, roots: [], shape: null, error: 'missing' }
  }
  const root = resolve(dir)
  const artPath = resolve(root, entry.artifact)
  // Containment check: artPath must be the root itself or sit beneath it.
  if (artPath !== root && !artPath.startsWith(root + sep)) {
    warn(`artifact path escaped project dir for story "${storyId}": ${entry.artifact}`)
    return { artifact: null, roots: [], shape: null, error: 'escaped-project-dir' }
  }
  const data = readJson(artPath)
  if (data == null) {
    return { artifact: null, roots: [], shape: null, error: 'missing' }
  }
  // Unwrap to LayerNode root(s). Throws (loud) on a truly-unparseable shape.
  const { roots, shape } = unwrapArtifact(data)
  return { artifact: roots[0] || null, roots, shape, error: null }
}

/**
 * Load a captured artifact (LayerNode tree) by story id, via the index. The
 * artifact path comes from the index entry and is path-traversal safe: it must
 * resolve to a location INSIDE `dir`, else we return null (mirrors cli.js's
 * `readArtifact`). Returns null when the story/artifact is missing.
 *
 * **Back-compat surface** — returns the (unwrapped, REC-5) **first** LayerNode
 * root or null. Callers wanting the typed missing/escaped/ok distinction or the
 * full multi-root set use {@link loadArtifactTyped}. Still throws on an
 * unparseable blob (REC-5 — the one truly-fatal case).
 * @param {string} dir Project root.
 * @param {string} storyId
 * @returns {LayerNode | null}
 */
export const loadArtifact = (dir, storyId) => loadArtifactTyped(dir, storyId).artifact

// ─── tree walk ─────────────────────────────────────────────────────────────────

/**
 * Single recursive walk over a LayerNode tree, visiting every node (root first,
 * then children depth-first). The one place we recurse `node.children` — all the
 * binding/candidate collection below funnels through here.
 * @param {LayerNode|null|undefined} node
 * @param {(n: LayerNode) => void} visit
 * @returns {void}
 */
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  visit(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit)
  }
}

/**
 * Walk every node across **all** roots of a story's artifact (a story-wrapper
 * may carry more than one root). Funnels through {@link walk}. Surfaces the
 * typed load failure via `warn()` rather than vanishing silently.
 * @param {string} dir Project root.
 * @param {string} storyId
 * @param {(n: LayerNode) => void} visit
 * @returns {void}
 */
const walkArtifact = (dir, storyId, visit) => {
  const { roots, error } = loadArtifactTyped(dir, storyId)
  if (error) {
    warn(`cannot walk artifact for story "${storyId}": ${error}`)
    return
  }
  for (const root of roots) walk(root, visit)
}

// ─── token reads ───────────────────────────────────────────────────────────────

/**
 * List resolved tokens, optionally filtered. All filters AND together; omit a
 * filter to ignore it.
 * @param {string} dir Project root.
 * @param {{ tier?: string, type?: string, q?: string }} [opts]
 *   `tier`/`type` are exact matches; `q` is a case-insensitive substring match on
 *   the token id OR cssVar OR (stringified) value.
 * @returns {ResolvedToken[]}
 */
export const listTokens = (dir, { tier, type, q } = {}) => {
  const all = loadResolved(dir)
  if (!all) return []
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
 * Fetch a single token by id plus the story ids that bind it. `token` is null
 * when the id is unknown; `usages` is always an array (possibly empty).
 * @param {string} dir Project root.
 * @param {string} id Dotted token id.
 * @returns {{ token: ResolvedToken|null, usages: string[] }}
 */
export const getToken = (dir, id) => {
  const all = loadResolved(dir)
  const token = (all && all.find((t) => t && t.id === id)) || null
  // usages = story ids whose artifact binds this token id in any node/role.
  const usages = findTokenUsages(dir, id).map((u) => u.componentId)
  return { token, usages }
}

/**
 * Resolve a token's rendered value by id OR cssVar (id wins if both given).
 * Returns null when neither matches.
 * @param {string} dir Project root.
 * @param {{ id?: string, cssVar?: string }} [sel]
 * @returns {string|number|null}
 */
export const resolveValue = (dir, { id, cssVar } = {}) => {
  const all = loadResolved(dir)
  if (!all) return null
  let hit = null
  if (id != null) hit = all.find((t) => t && t.id === id)
  if (!hit && cssVar != null) hit = all.find((t) => t && t.cssVar === cssVar)
  return hit ? hit.value : null
}

// ─── component reads ─────────────────────────────────────────────────────────────

/**
 * List captured components (stories) from the index, each with its artifact
 * relpath. Empty array when there's no index.
 * @param {string} dir Project root.
 * @returns {Array<{ id: string, artifact: string }>}
 */
export const listComponents = (dir) => {
  const idx = loadIndex(dir)
  const stories = idx && idx.stories
  if (!stories || typeof stories !== 'object') return []
  return Object.keys(stories).map((id) => ({
    id,
    artifact: (stories[id] && stories[id].artifact) || '',
  }))
}

/**
 * Merge every node's `sorb.tokens` / `sorb.candidates` across the whole artifact
 * tree into one flat bindings/candidates object, keyed by role
 * (`fill`/`stroke`/`cornerRadius`/`effect0`/…). When the same role appears on
 * more than one node, **later (deeper, depth-first) nodes win** — the merge is a
 * last-write per role. Returns empty objects when the component/artifact is missing.
 *
 * **B16 / REC-3 (additive):** the last-write merge silently discarded every
 * losing binding. We now also return `conflicts[role] = [{ nodePath, tokenId }]`
 * for every role bound on >1 node — so a nested-override clobber or a
 * variant-chain collapse is **visible**, not silent (aligns with
 * `buildReverseIndex`'s per-node retention). `diagnostics` surfaces the typed
 * load failure (missing / escaped) instead of a silent `{}`. Backward-compatible:
 * `{ bindings, candidates }` still destructure exactly as before.
 *
 * @param {string} dir Project root.
 * @param {string} componentId Story id.
 * @returns {{ bindings: Object.<string,string>, candidates: Object.<string,string[]>, conflicts: Object.<string, Array<{nodePath:string,tokenId:string}>>, diagnostics: Array<{kind:string,detail:string}> }}
 */
export const getComponentBindings = (dir, componentId) => {
  /** @type {Object.<string,string>} */
  const bindings = {}
  /** @type {Object.<string,string[]>} */
  const candidates = {}
  /** @type {Object.<string, Array<{nodePath:string,tokenId:string}>>} */
  const seen = {}
  /** @type {Array<{kind:string,detail:string}>} */
  const diagnostics = []

  const { roots, error } = loadArtifactTyped(dir, componentId)
  if (error) {
    warn(`getComponentBindings: ${error} for "${componentId}"`)
    diagnostics.push({ kind: 'artifact-' + error, detail: componentId })
    return { bindings, candidates, conflicts: {}, diagnostics }
  }

  // Walk all roots; track a human-readable node path so conflicts point at the
  // offending node (type[name] chain), mirroring buildReverseIndex retention.
  const walkPath = (node, path, visit) => {
    if (!node || typeof node !== 'object') return
    const seg = `${node.type || '?'}${node.name ? `[${node.name}]` : ''}`
    const here = path ? `${path}/${seg}` : seg
    visit(node, here)
    if (Array.isArray(node.children)) {
      for (const child of node.children) walkPath(child, here, visit)
    }
  }

  for (const root of roots) {
    walkPath(root, '', (n, nodePath) => {
      const s = n.sorb
      if (!s || typeof s !== 'object') return
      if (s.tokens && typeof s.tokens === 'object') {
        for (const key of Object.keys(s.tokens)) {
          const tokenId = s.tokens[key]
          bindings[key] = tokenId // last-write per role (unchanged contract)
          ;(seen[key] || (seen[key] = [])).push({ nodePath, tokenId })
        }
      }
      if (s.candidates && typeof s.candidates === 'object') {
        for (const key of Object.keys(s.candidates)) candidates[key] = s.candidates[key]
      }
    })
  }

  // A role is a conflict iff >1 node bound it. Retain every contributing node.
  /** @type {Object.<string, Array<{nodePath:string,tokenId:string}>>} */
  const conflicts = {}
  for (const role of Object.keys(seen)) {
    if (seen[role].length > 1) {
      conflicts[role] = seen[role]
      diagnostics.push({
        kind: 'role-conflict',
        detail: `${role} bound on ${seen[role].length} nodes (winner: ${bindings[role]})`,
      })
    }
  }

  return { bindings, candidates, conflicts, diagnostics }
}

/**
 * Find which components bind a given token id, and on which roles. Walks every
 * component's whole artifact tree. Empty array when nothing binds it.
 * @param {string} dir Project root.
 * @param {string} id Token id.
 * @returns {Array<{ componentId: string, keys: string[] }>}
 */
export const findTokenUsages = (dir, id) => {
  const out = []
  for (const { id: componentId } of listComponents(dir)) {
    /** @type {string[]} */
    const keys = []
    walkArtifact(dir, componentId, (n) => {
      const tokens = n.sorb && n.sorb.tokens
      if (!tokens) return
      for (const key of Object.keys(tokens)) {
        if (tokens[key] === id) keys.push(key)
      }
    })
    if (keys.length) out.push({ componentId, keys })
  }
  return out
}

/**
 * Find which components render a given CSS var: maps `cssVar` → token id via the
 * resolved map, then reverse-looks-up usages of that id. Empty array when the
 * cssVar is unknown or unused.
 * @param {string} dir Project root.
 * @param {string} cssVar e.g. `--color-action-primary`.
 * @returns {Array<{ componentId: string, tokenId: string, keys: string[] }>}
 */
export const findComponentsByToken = (dir, cssVar) => {
  const all = loadResolved(dir)
  const match = all && all.find((t) => t && t.cssVar === cssVar)
  if (!match) return []
  return findTokenUsages(dir, match.id).map((u) => ({
    componentId: u.componentId,
    tokenId: match.id,
    keys: u.keys,
  }))
}

/**
 * Build both reverse indexes in one pass over all components, for callers that
 * want to answer many lookups cheaply:
 *   - `byTokenId`: token id → [{ componentId, key }] (one entry per role binding).
 *   - `byCssVar` : cssVar → token id (from the resolved map).
 * @param {string} dir Project root.
 * @returns {{ byTokenId: Map<string, Array<{componentId:string,key:string}>>, byCssVar: Map<string,string> }}
 */
export const buildReverseIndex = (dir) => {
  /** @type {Map<string, Array<{componentId:string,key:string}>>} */
  const byTokenId = new Map()
  /** @type {Map<string,string>} */
  const byCssVar = new Map()

  // cssVar → token id from the resolved map.
  const all = loadResolved(dir)
  if (all) {
    for (const t of all) {
      if (t && t.cssVar) byCssVar.set(t.cssVar, t.id)
    }
  }

  // token id → component/role bindings, across every component tree.
  for (const { id: componentId } of listComponents(dir)) {
    walkArtifact(dir, componentId, (n) => {
      const tokens = n.sorb && n.sorb.tokens
      if (!tokens) return
      for (const key of Object.keys(tokens)) {
        const tokenId = tokens[key]
        const list = byTokenId.get(tokenId) || []
        list.push({ componentId, key })
        byTokenId.set(tokenId, list)
      }
    })
  }

  return { byTokenId, byCssVar }
}
