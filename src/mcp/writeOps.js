// P2 write-ops — pure changeset/blast-radius logic; the MCP write tools (tools.js)
// wrap these with the gated network/PR calls. Nothing here mutates source or opens
// a PR.
//
// This is the unit-testable core behind the Phase-2 gated write tools
// (spec/day/mcp-smart-connect.md §5 "Write — gated", §6 Phase 2): given a project's
// local `.sorb/`, compute what a proposed token-value change or a component rebind
// WOULD do — its blast radius, a derived token set, validity — without performing
// any side effect. NO network, NO MCP SDK, NO github import. All side effects
// (POST /preview, Open-PR) live in tools.js and call into here.
//
// Contract shapes come from `@sorb/core` as JSDoc typedefs only (JS-only per the
// hard rules): ResolvedToken {id,cssVar,value,tier,type}; an artifact node carries
// `node.sorb = { tokens: { role → tokenId }, candidates: { role → tokenId[] } }`.
//
// Defensive throughout: missing files / fields → ok:false / empty / null, never a
// throw. We sit on top of the existing P1 data layer (`./sorbData.js`).

import {
  loadResolved,
  findTokenUsages,
  getComponentBindings,
} from './sorbData.js'

/** @typedef {import('@sorb/core').ResolvedToken} ResolvedToken */

/**
 * Build a token id → ResolvedToken lookup from the resolved map. Empty Map when
 * the resolved map is absent/malformed.
 * @param {string} dir Project root.
 * @returns {Map<string, ResolvedToken>}
 */
const resolvedById = (dir) => {
  /** @type {Map<string, ResolvedToken>} */
  const map = new Map()
  const all = loadResolved(dir)
  if (!all) return map
  for (const t of all) if (t && t.id != null) map.set(t.id, t)
  return map
}

/**
 * Compute the blast radius of a token: the components that directly bind it and on
 * which roles. `cssVar` is pulled from the resolved map (null when the id is
 * unknown). `count` is the number of distinct components.
 * @param {string} dir Project root.
 * @param {string} tokenId Dotted token id.
 * @returns {{ tokenId: string, cssVar: string|null, directComponents: Array<{ componentId: string, keys: string[] }>, count: number }}
 */
export const computeBlastRadius = (dir, tokenId) => {
  const tok = resolvedById(dir).get(tokenId)
  const directComponents = findTokenUsages(dir, tokenId)
  return {
    tokenId,
    cssVar: tok ? tok.cssVar : null,
    directComponents,
    count: directComponents.length,
  }
}

/**
 * Validate a proposed token-value change before building a changeset. Fails when
 * the token id is unknown, with a light type sanity check (color tokens expect a
 * string value).
 * @param {string} dir Project root.
 * @param {{ id?: string, newValue?: any }} change
 * @returns {{ ok: boolean, token: ResolvedToken|null, error: string|null }}
 */
export const validateTokenChange = (dir, { id, newValue } = {}) => {
  if (id == null || id === '') {
    return { ok: false, token: null, error: 'missing token id' }
  }
  const token = resolvedById(dir).get(id) || null
  if (!token) {
    return { ok: false, token: null, error: `unknown token id: ${id}` }
  }
  // Light type sanity: a color must be a string (e.g. "#FF0000"), never a number/object.
  if (token.type === 'color' && typeof newValue !== 'string') {
    return {
      ok: false,
      token,
      error: `color token ${id} expects a string value`,
    }
  }
  return { ok: true, token, error: null }
}

/**
 * Build a non-mutating changeset for a proposed token-value change. `tokenSet` is
 * a flat `{ <cssVarNameNoLeadingDashes>: value }` map derived from the resolved map
 * (mirrors cli.js `read()`: `t.cssVar.replace(/^--/, '')` → value), WITH this id's
 * entry overridden to `newValue`. `blastRadius` is `computeBlastRadius(dir, id)`.
 *
 * When the id is unknown the value-bearing fields are null and `tokenSet` reflects
 * the unchanged map (no override applied) — callers should `validateTokenChange`
 * first; this never throws.
 * @param {string} dir Project root.
 * @param {{ id?: string, newValue?: any }} change
 * @returns {{ id: string, cssVar: string|null, oldValue: any, newValue: any, type: string|null, tier: string|null, tokenSet: Object.<string, any>, blastRadius: ReturnType<typeof computeBlastRadius> }}
 */
export const buildTokenChangeset = (dir, { id, newValue } = {}) => {
  const all = loadResolved(dir) || []
  /** @type {Object.<string, any>} */
  const tokenSet = {}
  for (const t of all) {
    if (t && t.cssVar) tokenSet[t.cssVar.replace(/^--/, '')] = t.value
  }
  const token = all.find((t) => t && t.id === id) || null
  // Apply the override for this id's cssVar (only when we know its cssVar).
  if (token && token.cssVar) {
    tokenSet[token.cssVar.replace(/^--/, '')] = newValue
  }
  return {
    id,
    cssVar: token ? token.cssVar : null,
    oldValue: token ? token.value : null,
    newValue,
    type: token ? token.type : null,
    tier: token ? token.tier : null,
    tokenSet,
    blastRadius: computeBlastRadius(dir, id),
  }
}

/**
 * Build a non-mutating rebind proposal: change `componentId`'s `role` binding to
 * `tokenId`. `from` is the current token id bound on that role (null when none).
 * `valid` is false (with `error`) when the target token id is unknown, or when the
 * component/role is unknown. `affected` is the blast radius of the TARGET token.
 * @param {string} dir Project root.
 * @param {{ componentId?: string, role?: string, tokenId?: string }} proposal
 * @returns {{ componentId: string, role: string, from: string|null, to: string, valid: boolean, error: string|null, affected: ReturnType<typeof computeBlastRadius> }}
 */
export const buildRebindProposal = (dir, { componentId, role, tokenId } = {}) => {
  const { bindings } = getComponentBindings(dir, componentId)
  const from = (bindings && Object.prototype.hasOwnProperty.call(bindings, role))
    ? bindings[role]
    : null
  const affected = computeBlastRadius(dir, tokenId)

  let valid = true
  let error = null
  if (tokenId == null || tokenId === '') {
    valid = false
    error = 'missing target token id'
  } else if (!resolvedById(dir).has(tokenId)) {
    valid = false
    error = `unknown token id: ${tokenId}`
  } else if (!bindings || Object.keys(bindings).length === 0) {
    valid = false
    error = `unknown component: ${componentId}`
  } else if (from === null) {
    valid = false
    error = `unknown role '${role}' on component ${componentId}`
  }

  return { componentId, role, from, to: tokenId, valid, error, affected }
}
