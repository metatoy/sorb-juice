// bindingLoss.js — deterministic binding-loss detector for the Sorb Verify suite.
//
// Compares two resolved token snapshots (before/after) against a binding index
// to identify which bound cssVars have been lost (renamed, deleted, or broken)
// and which new cssVars have appeared.
//
// ZERO LLM calls — pure synchronous diff. No filesystem access.
//
// Shapes:
//   resolvedMap    : Record<cssVar, value>            e.g. { '--color-action-primary': '#0f65ef' }
//   bindingIndex   : Record<cssVar, string[]>         e.g. { '--color-action-primary': ['Button'] }
//   LostBinding    : { cssVar: string, components: string[], was: * }
//   GainedBinding  : { cssVar: string, value: * }

/**
 * Build a simple binding index from a resolved.json array.
 *
 * The resolved.json produced by sorb-seed is an array of ResolvedToken objects
 * ({ id, cssVar, value, tier, type }). This helper produces a flat
 * { [cssVar]: [tokenId] } map so callers can pass it to detectLost without
 * needing the full .sorb/ tree.
 *
 * For richer component-level indexes (Button → fill, etc.) use
 * sorbData.findTokenUsages or buildReverseIndex from the MCP module instead.
 *
 * @param {Array<{id:string, cssVar:string, value:*, tier?:string, type?:string}>} resolvedJson
 * @returns {Record<string, string[]>}
 */
export function buildBindingIndex(resolvedJson) {
  if (!Array.isArray(resolvedJson)) return {}
  /** @type {Record<string, string[]>} */
  const index = {}
  for (const token of resolvedJson) {
    if (!token || typeof token.cssVar !== 'string') continue
    const label = typeof token.id === 'string' ? token.id : token.cssVar
    index[token.cssVar] = [label]
  }
  return index
}

/**
 * Detect lost and gained token bindings between two resolved maps.
 *
 * A binding is considered **lost** when:
 *   - The cssVar existed in `before` and is absent from `after`, AND
 *   - The cssVar appears in `bindingIndex` (i.e. it was actually used).
 *
 * A cssVar is considered **gained** when it is present in `after` but not in `before`.
 * Gained entries are reported regardless of whether they appear in the binding index
 * (a new token may not yet have recorded bindings).
 *
 * @param {Record<string, *>} before  Resolved token map from the previous snapshot.
 * @param {Record<string, *>} after   Resolved token map from the current snapshot.
 * @param {Record<string, string[]>} bindingIndex  cssVar → [componentName, ...].
 * @returns {{ lost: Array<{cssVar:string, components:string[], was:*}>, gained: Array<{cssVar:string, value:*}> }}
 */
export function detectLost(before, after, bindingIndex) {
  const beforeMap = before && typeof before === 'object' ? before : {}
  const afterMap = after && typeof after === 'object' ? after : {}
  const index = bindingIndex && typeof bindingIndex === 'object' ? bindingIndex : {}

  /** @type {Array<{cssVar:string, components:string[], was:*}>} */
  const lost = []
  /** @type {Array<{cssVar:string, value:*}>} */
  const gained = []

  // Detect lost: in before, absent in after, AND present in binding index.
  for (const cssVar of Object.keys(beforeMap)) {
    if (Object.prototype.hasOwnProperty.call(afterMap, cssVar)) continue
    // Only report as lost if it was actually bound somewhere.
    const components = index[cssVar]
    if (!Array.isArray(components) || components.length === 0) continue
    lost.push({ cssVar, components: [...components], was: beforeMap[cssVar] })
  }

  // Detect gained: in after, absent in before.
  for (const cssVar of Object.keys(afterMap)) {
    if (Object.prototype.hasOwnProperty.call(beforeMap, cssVar)) continue
    gained.push({ cssVar, value: afterMap[cssVar] })
  }

  return { lost, gained }
}
