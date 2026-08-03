// conformance.js — deterministic declared-vs-running conformance diff for the Sorb Verify suite.
//
// Compares what the design system **declares** (DTCG token set, flat cssVar→{value,tier,type} map)
// against what the **running app actually renders** (the resolved/bound truth from .sorb/resolved.json).
//
// Returns per-token drift, missing, and extra entries — no LLM in the core path.
// Descriptive only: the output describes what resolves as declared vs not, per tier.
// It does NOT certify compliance or make accuracy guarantees.
//
// ZERO LLM calls — pure synchronous diff. No filesystem access.
//
// Shapes:
//   DeclaredToken  : { value: string, tier: string, type: string }
//   DeclaredMap    : Record<cssVar, DeclaredToken>
//   ResolvedMap    : Record<cssVar, string>           e.g. { '--color-action-primary': '#0f65ef' }
//   DriftedEntry   : { cssVar: string, declared: string, resolved: string, tier: string, type: string }
//   MissingEntry   : { cssVar: string, declared: string, tier: string }
//   ExtraEntry     : { cssVar: string, resolved: string }
//   ConformanceResult : { drifted: DriftedEntry[], missing: MissingEntry[], extra: ExtraEntry[] }

/**
 * Diff declared token definitions against what the running app actually resolves.
 *
 * - **drifted**: cssVar present in both declared and resolved, but values differ.
 * - **missing**: cssVar in declared but absent from the running resolved map.
 * - **extra**:   cssVar in the running resolved map but not declared.
 *
 * The comparison is case-sensitive and value-exact (no normalisation of whitespace,
 * unit suffixes, or hex casing). Normalise inputs before calling if needed.
 *
 * @param {Record<string, {value:string, tier:string, type:string}>} declared
 *   Flat map of cssVar → declared token definition.
 * @param {Record<string, string>} resolved
 *   Flat map of cssVar → running resolved value.
 * @returns {{ drifted: Array<{cssVar:string, declared:string, resolved:string, tier:string, type:string}>,
 *             missing: Array<{cssVar:string, declared:string, tier:string}>,
 *             extra:   Array<{cssVar:string, resolved:string}> }}
 */
export function diffConformance(declared, resolved) {
  const dec = declared && typeof declared === 'object' ? declared : {}
  const res = resolved && typeof resolved === 'object' ? resolved : {}

  /** @type {Array<{cssVar:string, declared:string, resolved:string, tier:string, type:string}>} */
  const drifted = []
  /** @type {Array<{cssVar:string, declared:string, tier:string}>} */
  const missing = []
  /** @type {Array<{cssVar:string, resolved:string}>} */
  const extra = []

  // Walk declared tokens: determine drifted vs missing.
  for (const cssVar of Object.keys(dec)) {
    const decToken = dec[cssVar]
    if (!decToken || typeof decToken !== 'object') continue

    if (!Object.prototype.hasOwnProperty.call(res, cssVar)) {
      // Declared but not present in the running app.
      missing.push({
        cssVar,
        declared: decToken.value,
        tier: decToken.tier ?? 'unknown',
      })
    } else if (res[cssVar] !== decToken.value) {
      // Present in both but values differ — running app diverged from declared.
      drifted.push({
        cssVar,
        declared: decToken.value,
        resolved: res[cssVar],
        tier: decToken.tier ?? 'unknown',
        type: decToken.type ?? 'unknown',
      })
    }
    // else: exact match — healthy conformance; not reported.
  }

  // Walk resolved tokens: find extras not present in declared.
  for (const cssVar of Object.keys(res)) {
    if (!Object.prototype.hasOwnProperty.call(dec, cssVar)) {
      extra.push({ cssVar, resolved: res[cssVar] })
    }
  }

  return { drifted, missing, extra }
}

/**
 * Convert a resolved.json array (the .sorb/resolved.json format produced by sorb-seed)
 * to the flat declared map shape expected by diffConformance.
 *
 * Each entry in resolved.json carries the ground-truth declared value (the token
 * spec value as resolved by SD), so the same array functions both as the declared
 * source and as the running resolved truth when no drift has occurred.
 *
 * Typical usage: load resolved.json at design-time → pass as `declared`; then load
 * the live captured values as `resolved`. The diff reveals in-production divergence.
 *
 * @param {Array<{cssVar:string, value:string, tier?:string, type?:string}>} sorbIndex
 *   Array of resolved token objects from .sorb/resolved.json.
 * @returns {Record<string, {value:string, tier:string, type:string}>}
 */
export function toDeclaredMap(sorbIndex) {
  if (!Array.isArray(sorbIndex)) return {}

  /** @type {Record<string, {value:string, tier:string, type:string}>} */
  const map = {}
  for (const token of sorbIndex) {
    if (!token || typeof token.cssVar !== 'string') continue
    map[token.cssVar] = {
      value: token.value,
      tier: token.tier ?? 'unknown',
      type: token.type ?? 'unknown',
    }
  }
  return map
}
