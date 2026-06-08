/**
 * tierAffinity.js — Tier-affinity Anomaly Detector (Sorb Verify P2)
 *
 * Detects tokens used in the wrong role ("off-role bindings"):
 *   - a color token bound to a radius/dimension slot
 *   - a dimension token bound to a fill/color slot
 *
 * Deterministic, zero-LLM, zero-COGS. Composes with P0 bindingLoss and P1
 * conformance checks as the "Sorb Verify" suite.
 *
 * The role/affinity taxonomy mirrors annotateTokens.js from sorb-seed:
 *   fill  → `bg` or `text` (color)
 *   stroke → `border` (color)
 *   cornerRadius → `radius` (dimension)
 */

// CSS property families that are fill/color slots.
export const FILL_TYPES = new Set(['color', 'fill'])

// CSS property families that are border/stroke slots.
export const BORDER_TYPES = new Set(['color', 'border'])

// CSS property families that are radius/dimension slots.
export const RADIUS_TYPES = new Set(['dimension', 'border-radius', 'radius'])

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Infer the expected affinity ("color" or "dimension") from a token's cssVar
 * name using naming-convention heuristics, when no explicit role is available.
 *
 * @param {string} cssVar  e.g. "--button-radius", "--color-bg-surface"
 * @returns {'radius'|'color'|null}
 */
function inferAffinityFromName(cssVar) {
  const name = String(cssVar || '').toLowerCase()
  // radius-shaped names
  if (/radius|border-radius/.test(name)) return 'radius'
  // color-shaped names
  if (/color|fill|bg|text|border/.test(name)) return 'color'
  return null
}

/**
 * Determine the type category for a token ("color" or "dimension") from its
 * `type` field, falling back to value heuristics.
 *
 * @param {{ type?: string, value?: string }} token
 * @returns {'color'|'dimension'|null}
 */
function tokenTypeCategory(token) {
  const t = String(token.type || '').toLowerCase()
  if (t === 'color') return 'color'
  if (t === 'dimension') return 'dimension'
  // Heuristic fallback on the value itself.
  const v = String(token.value || '').trim()
  if (/^#|^rgb/i.test(v)) return 'color'
  if (/px$/.test(v)) return 'dimension'
  return null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect off-role bindings in an annotated token list.
 *
 * An "off-role binding" occurs when a token's type (color vs. dimension) is
 * inconsistent with the slot role implied by its cssVar name:
 *   - A token with type 'color' but a radius-like cssVar name is off-role.
 *   - A token with type 'dimension' but a color/fill-like cssVar name is off-role.
 *
 * @param {Array<{cssVar: string, value: string, type: string, role?: string}>} resolvedWithMeta
 * @returns {{ offRole: Array<{cssVar, value, type, role, reason}>, total: number, offRoleRate: number }}
 */
export function detectOffRole(resolvedWithMeta) {
  const offRole = []

  for (const token of resolvedWithMeta) {
    const typeCategory = tokenTypeCategory(token)
    const nameAffinity = inferAffinityFromName(token.cssVar)

    if (!typeCategory || !nameAffinity) continue

    // color token in a radius slot
    if (typeCategory === 'color' && nameAffinity === 'radius') {
      offRole.push({
        cssVar: token.cssVar,
        value: token.value,
        type: token.type,
        role: token.role ?? null,
        reason: 'color-token-in-radius-slot',
      })
      continue
    }

    // dimension token in a color/fill slot
    if (typeCategory === 'dimension' && nameAffinity === 'color') {
      offRole.push({
        cssVar: token.cssVar,
        value: token.value,
        type: token.type,
        role: token.role ?? null,
        reason: 'dimension-token-in-color-slot',
      })
    }
  }

  const total = resolvedWithMeta.length
  const offRoleRate = total > 0 ? offRole.length / total : 0

  return { offRole, total, offRoleRate }
}

/**
 * Study the off-role binding frequency in a raw resolved.json payload.
 *
 * Derives the annotated token list using naming-convention heuristics (no
 * explicit `role` field required). Returns the detectOffRole result plus a
 * GO/NO-GO verdict for the P2 spike gate.
 *
 * Verdict logic:
 *   - 'GO'    if offRoleRate < 0.05  (low enough noise to be useful)
 *             OR offRole.length > 0  (violations actually exist → worth surfacing)
 *   - 'NO-GO' if impossible to determine (empty/unrecognised input)
 *
 * @param {Array<{id: string, cssVar: string, value: string, tier: string, type: string}>} resolvedJson
 * @returns {{ offRole: Array, total: number, offRoleRate: number, verdict: 'GO'|'NO-GO' }}
 */
export function studyFrequency(resolvedJson) {
  if (!Array.isArray(resolvedJson) || resolvedJson.length === 0) {
    return { offRole: [], total: 0, offRoleRate: 0, verdict: 'NO-GO' }
  }

  // The resolved.json tokens already carry `type` and `cssVar` — pass through
  // as-is; detectOffRole applies name heuristics internally.
  const result = detectOffRole(resolvedJson)

  // Verdict: GO if the check is operational and violations are detectable or
  // the noise floor is acceptably low.
  const verdict =
    result.total === 0
      ? 'NO-GO'
      : result.offRoleRate < 0.05 || result.offRole.length > 0
        ? 'GO'
        : 'NO-GO'

  return { ...result, verdict }
}
