// check.js — headless token-build check for the `sorb check` CI subcommand (E4).
//
// Re-runs the Style-Dictionary build (the CLI wrapper owns that side effect) and
// diffs the freshly-built token snapshot for EVIDENCE of:
//   • drift            — a declared token value differs from the value the build/app resolves
//   • binding-mismatch — a previously-bound token is gone (removed / renamed)
//   • off-role binding — a token's type is inconsistent with the slot its name implies
//   • deprecation      — a token flagged deprecated is still present
//
// It wires directly to the Sorb verify-suite libs already on this branch
// (verify/conformance · verify/bindingLoss · verify/tierAffinity · verify/heatMap)
// — it does NOT reimplement any diff logic.
//
// ── Wording discipline ───────────────────────────────────────────────────────
// This is a build-diagnostic tool. Every user-visible string reports WHAT WAS
// MEASURED ("found N drifted tokens", "a previously-bound token is gone"). It
// makes no outcome claim (no compliance / accessibility / guarantee wording) and
// no merge-outcome promise — it reports evidence and sets an exit code; a CI
// check decides what to do with that exit code.
//
// Pure + deterministic: same inputs → same result. No filesystem access, no clock,
// no LLM. The CLI wrapper (src/cli.js) does the file I/O and the SD rebuild.
//
// @module check

import { diffConformance, toDeclaredMap } from './verify/conformance.js'
import { detectLost, buildBindingIndex } from './verify/bindingLoss.js'
import { detectOffRole } from './verify/tierAffinity.js'
import { matchHardcoded, scoreHeatMap } from './verify/heatMap.js'

/**
 * The fatal check categories, in report order. A non-empty count in ANY of
 * these drives a non-zero exit code.
 * @type {readonly string[]}
 */
export const CHECK_CATEGORIES = Object.freeze([
  'drift',
  'binding-mismatch',
  'off-role',
  'deprecation',
])

/**
 * Exit-code contract for `sorb check` (documented on the CLI subcommand too):
 *   0 — build completed and no fatal findings.
 *   1 — build did not complete, OR evidence of drift / binding-mismatch /
 *       off-role binding / deprecation was found.
 *   2 — usage / configuration error (no snapshot to check, unreadable input).
 * @type {Readonly<{ CLEAN: 0, FINDINGS: 1, USAGE: 2 }>}
 */
export const EXIT = Object.freeze({ CLEAN: 0, FINDINGS: 1, USAGE: 2 })

/**
 * Flatten a resolved.json array (`[{ cssVar, value, ... }]`) to a flat
 * `{ cssVar: value }` map for the diff libs.
 * @param {Array<{cssVar?: string, value?: *}>} arr
 * @returns {Record<string, *>}
 */
function toResolvedMap(arr) {
  /** @type {Record<string, *>} */
  const m = {}
  if (!Array.isArray(arr)) return m
  for (const t of arr) if (t && typeof t.cssVar === 'string') m[t.cssVar] = t.value
  return m
}

/**
 * Detect tokens flagged deprecated that are still present in the resolved set.
 *
 * A token is deprecated when it carries a truthy `deprecated` (or DTCG
 * `$deprecated`) field — either `true` or a non-empty string message (the DTCG
 * convention for "deprecated, use X instead").
 *
 * @param {Array<{cssVar?: string, tier?: string, deprecated?: *, ['$deprecated']?: *}>} resolved
 * @returns {Array<{cssVar: string, tier: string, note: string|null}>}
 */
export function detectDeprecated(resolved) {
  /** @type {Array<{cssVar: string, tier: string, note: string|null}>} */
  const out = []
  if (!Array.isArray(resolved)) return out
  for (const t of resolved) {
    if (!t || typeof t.cssVar !== 'string') continue
    const dep = t.deprecated !== undefined ? t.deprecated : t['$deprecated']
    const isDep = dep === true || (typeof dep === 'string' && dep.trim() !== '')
    if (!isDep) continue
    out.push({
      cssVar: t.cssVar,
      tier: typeof t.tier === 'string' ? t.tier : 'unknown',
      note: typeof dep === 'string' ? dep : null,
    })
  }
  return out
}

/**
 * @typedef {object} CheckInputs
 * @property {Array<{cssVar:string,value:*,tier?:string,type?:string,deprecated?:*}>} resolved
 *   The freshly-built resolved token snapshot to check (required).
 * @property {Array<{cssVar:string,value:*,tier?:string,type?:string}>|null} [baseline]
 *   The previous resolved snapshot to diff against for drift + binding-mismatch.
 *   When absent, those two checks are skipped (with a note).
 * @property {Record<string,*>|null} [live]
 *   A live-captured `cssVar → value` map from the running app. When present, the
 *   build is diffed against it (build-vs-running-app conformance).
 * @property {Map<string,string>|null} [computedStyles]
 *   Computed styles (`property → value`) for the informational hardcoded-value scan.
 * @property {boolean} [buildOk] Whether the Style-Dictionary rebuild completed.
 *   Defaults to true; pass false to record a build failure (→ exit 1).
 */

/**
 * Run the token-build check over the supplied snapshots.
 *
 * @param {CheckInputs} [inputs]
 * @returns {{
 *   ok: boolean,
 *   exitCode: 0|1|2,
 *   buildOk: boolean,
 *   findings: {
 *     drifted: Array<*>, lostBindings: Array<*>, offRole: Array<*>, deprecated: Array<*>,
 *     liveDrifted: Array<*>, liveMissing: Array<*>,
 *     gained: Array<*>, extra: Array<*>, hardcoded: Array<*>
 *   },
 *   counts: Record<string, number>,
 *   fatalTotal: number,
 *   notes: string[]
 * }}
 */
export function runCheck(inputs = {}) {
  const resolved = Array.isArray(inputs.resolved) ? inputs.resolved : []
  const baseline = Array.isArray(inputs.baseline) ? inputs.baseline : null
  const live = inputs.live && typeof inputs.live === 'object' ? inputs.live : null
  const computedStyles = inputs.computedStyles instanceof Map ? inputs.computedStyles : null
  const buildOk = inputs.buildOk !== false

  const findings = {
    drifted: /** @type {Array<*>} */ ([]),
    lostBindings: /** @type {Array<*>} */ ([]),
    offRole: /** @type {Array<*>} */ ([]),
    deprecated: /** @type {Array<*>} */ ([]),
    liveDrifted: /** @type {Array<*>} */ ([]),
    liveMissing: /** @type {Array<*>} */ ([]),
    // informational (never fatal):
    gained: /** @type {Array<*>} */ ([]),
    extra: /** @type {Array<*>} */ ([]),
    hardcoded: /** @type {Array<*>} */ ([]),
  }
  /** @type {string[]} */
  const notes = []

  const resolvedMap = toResolvedMap(resolved)

  // 1. Baseline diff — drift (value changed) + binding-mismatch (bound token gone).
  if (baseline) {
    const conf = diffConformance(toDeclaredMap(baseline), resolvedMap)
    findings.drifted = conf.drifted
    findings.extra = conf.extra // new tokens vs baseline — informational

    const bindingIndex = buildBindingIndex(baseline)
    const { lost, gained } = detectLost(toResolvedMap(baseline), resolvedMap, bindingIndex)
    findings.lostBindings = lost
    findings.gained = gained // informational
  } else {
    notes.push(
      'No baseline snapshot provided — drift and binding-mismatch checks were skipped.',
    )
  }

  // 2. Off-role bindings — token type inconsistent with the slot its name implies.
  findings.offRole = detectOffRole(resolved).offRole

  // 3. Deprecation — tokens flagged deprecated that are still present.
  findings.deprecated = detectDeprecated(resolved)

  // 4. Conformance vs a live capture (optional): the build declared it, does the
  //    running app resolve it, and to the same value?
  if (live) {
    const conf = diffConformance(toDeclaredMap(resolved), live)
    findings.liveDrifted = conf.drifted
    findings.liveMissing = conf.missing
  } else if (inputs.live !== undefined) {
    notes.push('A --live path was given but held no usable cssVar→value map; skipped.')
  }

  // 5. Hardcoded-value heat map (optional, informational only).
  if (computedStyles) {
    const tokenMap = new Map(
      resolved.filter((t) => t && typeof t.cssVar === 'string').map((t) => [t.cssVar, t.value]),
    )
    const { hardcoded } = matchHardcoded(computedStyles, tokenMap)
    findings.hardcoded = scoreHeatMap(hardcoded).highConfidence
  }

  const counts = {
    drift: findings.drifted.length + findings.liveDrifted.length,
    'binding-mismatch': findings.lostBindings.length + findings.liveMissing.length,
    'off-role': findings.offRole.length,
    deprecation: findings.deprecated.length,
  }
  const fatalTotal = CHECK_CATEGORIES.reduce((sum, c) => sum + counts[c], 0)

  let exitCode = EXIT.CLEAN
  if (!buildOk || fatalTotal > 0) exitCode = EXIT.FINDINGS

  return {
    ok: exitCode === EXIT.CLEAN,
    exitCode,
    buildOk,
    findings,
    counts,
    fatalTotal,
    notes,
  }
}

/**
 * Render a check result as a human-readable text block for terminal / CI logs.
 *
 * Pure string builder (no color, no clock) so it is stable in CI logs and unit
 * testable. The CLI wrapper adds color via picocolors around the summary line.
 *
 * @param {ReturnType<typeof runCheck>} result
 * @returns {string}
 */
export function formatCheckText(result) {
  const { findings, counts, buildOk, notes, ok } = result
  const lines = []
  lines.push('Sorb check — token build diagnostics')
  lines.push('')
  lines.push(`  Token build : ${buildOk ? 'completed' : 'DID NOT COMPLETE'}`)
  for (const note of notes) lines.push(`  Note        : ${note}`)
  lines.push('')

  lines.push(`  Drift (declared value differs from the resolved value) : ${counts.drift}`)
  for (const d of findings.drifted) {
    lines.push(`    ${d.cssVar}  ${d.declared} → ${d.resolved}  (${d.tier})`)
  }
  for (const d of findings.liveDrifted) {
    lines.push(`    ${d.cssVar}  build ${d.declared} → app ${d.resolved}  (${d.tier})`)
  }

  lines.push(`  Binding mismatch (a previously-bound token is gone) : ${counts['binding-mismatch']}`)
  for (const l of findings.lostBindings) {
    const used = Array.isArray(l.components) && l.components.length
      ? `  (used by: ${l.components.join(', ')})`
      : ''
    lines.push(`    ${l.cssVar}  was ${l.was}${used}`)
  }
  for (const m of findings.liveMissing) {
    lines.push(`    ${m.cssVar}  declared ${m.declared} but the running app resolves no value  (${m.tier})`)
  }

  lines.push(`  Off-role bindings (token type inconsistent with its slot) : ${counts['off-role']}`)
  for (const o of findings.offRole) {
    lines.push(`    ${o.cssVar}  (${o.type})  ${o.reason}`)
  }

  lines.push(`  Deprecated tokens still present : ${counts.deprecation}`)
  for (const dep of findings.deprecated) {
    lines.push(`    ${dep.cssVar}  (${dep.tier})${dep.note ? `  — ${dep.note}` : ''}`)
  }

  if (findings.hardcoded.length) {
    lines.push('')
    lines.push(`  Hardcoded values not matched to a token (informational) : ${findings.hardcoded.length}`)
    for (const h of findings.hardcoded) {
      lines.push(`    ${h.property}: ${h.value}  (confidence ${h.confidence})`)
    }
  }

  lines.push('')
  if (ok) {
    lines.push('✓ No drift, binding-mismatch, off-role bindings, or deprecated tokens found. (exit 0)')
  } else if (!buildOk) {
    lines.push('✗ The token build did not complete. (exit 1)')
  } else {
    lines.push('✗ Found evidence of drift / binding-mismatch / off-role bindings / deprecation. (exit 1)')
  }
  return lines.join('\n')
}
