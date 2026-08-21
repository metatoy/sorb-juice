// conformanceReport.js — Sorb-for-Enterprise E2 Conformance-Evidence Artifact renderer.
//
// Renders the output of the verify suite's `diffConformance(declared, resolved)`
// (src/verify/conformance.js) into a filable **Conformance Evidence Report** in
// three formats: HTML, JSON, and Markdown.
//
// ── Claims discipline (the enterprise program's #1 risk) ─────────────────────
// Every user-visible string in this module is a MEASUREMENT-register string:
// it describes what was *measured* (declared value vs the value the running app
// resolves), never an OUTCOME (compliance / accessibility / a guarantee). This
// is mandated by `spec/sorb/enterprise/e1/claims-codex.md` — the gating artifact.
// The fixed disclaimer below is baked into EVERY render and cannot be omitted or
// overridden by the caller. See CONFORMANCE_DISCLAIMER.
//
// The renderer is pure and deterministic: same input → byte-identical output.
// No filesystem access, no clock (a timestamp only appears if the caller passes
// one), no LLM. Findings are sorted deterministically so output is stable
// regardless of the input map's key order.
//
// NOTE: this module is intentionally NOT exported from the package's public
// entrypoint (src/index.js). Enterprise-lane phrasing is firewall-restricted to
// gated surfaces and must not ride the published @sorb/juice npm package.

/**
 * The FIXED evidence-artifact disclaimer, baked verbatim into every render and
 * every format. Wording is transcribed from the E1 claims-codex §6 (the
 * measurement register). It is a module constant — there is no code path that
 * omits, shortens, or overrides it.
 *
 * The banned outcome words it contains ("accessibility audit", "warranty",
 * "guarantee", "compliance") appear ONLY inside explicit negations ("It is not
 * …"), which the codex permits — a negation disclaims the outcome, it does not
 * claim it.
 *
 * ⚠ HELD GATE: the EXACT wording is finalized under counsel in E2
 * (`sorb-enterprise-program.md` §4). This is the codex-mandated placeholder the
 * program requires be present + unmodifiable until counsel ratifies it.
 * @type {string}
 */
export const CONFORMANCE_DISCLAIMER =
  'This report is descriptive conformance evidence for the WCAG 1.4.3 / 1.4.6 ' +
  'contrast criteria over the token-governed slice of the named application. ' +
  'It is not a full accessibility audit and not a warranty or guarantee of ' +
  'WCAG compliance. Automated checks do not detect all accessibility issues.'

/**
 * The mandatory scope qualifier (claims-codex §5.1). Descriptive; a negation.
 * @type {string}
 */
export const CONFORMANCE_SCOPE =
  'WCAG 1.4.3 / 1.4.6 contrast only — not a full-site accessibility audit.'

/**
 * One-line description of what the artifact IS, in the measurement register
 * (claims-codex §3 green cells: "conformance evidence" / "the tokens that ship
 * are the tokens we checked").
 * @type {string}
 */
export const CONFORMANCE_SUMMARY_LINE =
  'Descriptive conformance evidence: the tokens the running app resolves, ' +
  'checked against the tokens the design system declares.'

export const REPORT_TITLE = 'Sorb Conformance Evidence Report'
export const REPORT_KIND = 'sorb-conformance-evidence'
export const REPORT_VERSION = 1

// Canonical tier ordering for grouping/sorting (base → semantic → component).
// Unknown/other tiers sort last, alphabetically.
const TIER_ORDER = ['primitive', 'semantic', 'component']

/**
 * @typedef {import('../verify/conformance.js')} _conformance
 * @typedef {{ drifted: Array<{cssVar:string,declared:string,resolved:string,tier:string,type:string}>,
 *             missing: Array<{cssVar:string,declared:string,tier:string}>,
 *             extra:   Array<{cssVar:string,resolved:string}> }} ConformanceResult
 * @typedef {{ app?: string, environment?: string, generatedAt?: string }} ReportMeta
 */

const tierRank = (tier) => {
  const i = TIER_ORDER.indexOf(tier)
  return i === -1 ? TIER_ORDER.length : i
}

// Deterministic comparators: (tier order, then cssVar) for tiered lists, cssVar
// alone for the untiered `extra` list.
const byTierThenVar = (a, b) => {
  const r = tierRank(a.tier) - tierRank(b.tier)
  if (r !== 0) return r
  if (a.tier !== b.tier) return a.tier < b.tier ? -1 : 1
  return a.cssVar < b.cssVar ? -1 : a.cssVar > b.cssVar ? 1 : 0
}
const byVar = (a, b) => (a.cssVar < b.cssVar ? -1 : a.cssVar > b.cssVar ? 1 : 0)

/**
 * Normalize + sort a raw diffConformance result into the stable shape the
 * renderers consume. Defensive: missing arrays become empty.
 * @param {ConformanceResult} result
 * @returns {{ drifted: any[], missing: any[], extra: any[],
 *             summary: { drifted:number, missing:number, extra:number, divergences:number,
 *                        byTier: Record<string,{drifted:number,missing:number}> } }}
 */
export function summarizeConformance(result) {
  const r = result && typeof result === 'object' ? result : {}
  const drifted = Array.isArray(r.drifted) ? [...r.drifted].sort(byTierThenVar) : []
  const missing = Array.isArray(r.missing) ? [...r.missing].sort(byTierThenVar) : []
  const extra = Array.isArray(r.extra) ? [...r.extra].sort(byVar) : []

  /** @type {Record<string,{drifted:number,missing:number}>} */
  const byTier = {}
  const bump = (tier, key) => {
    const t = tier || 'unknown'
    if (!byTier[t]) byTier[t] = { drifted: 0, missing: 0 }
    byTier[t][key] += 1
  }
  for (const d of drifted) bump(d.tier, 'drifted')
  for (const m of missing) bump(m.tier, 'missing')

  return {
    drifted,
    missing,
    extra,
    summary: {
      drifted: drifted.length,
      missing: missing.length,
      extra: extra.length,
      divergences: drifted.length + missing.length + extra.length,
      byTier,
    },
  }
}

// ─── JSON renderer ──────────────────────────────────────────────────────────

/**
 * Render the Conformance Evidence Report as a JSON string (2-space indented,
 * trailing newline). The disclaimer is a top-level field and is always the
 * baked constant — any `disclaimer` on `meta` is ignored.
 * @param {ConformanceResult} result
 * @param {ReportMeta} [meta]
 * @returns {string}
 */
export function renderConformanceReportJSON(result, meta = {}) {
  const { drifted, missing, extra, summary } = summarizeConformance(result)
  const m = meta && typeof meta === 'object' ? meta : {}

  const doc = {
    report: REPORT_KIND,
    version: REPORT_VERSION,
    title: REPORT_TITLE,
    // Baked measurement-register framing + disclaimer — never caller-supplied.
    description: CONFORMANCE_SUMMARY_LINE,
    scope: CONFORMANCE_SCOPE,
    disclaimer: CONFORMANCE_DISCLAIMER,
    app: typeof m.app === 'string' ? m.app : null,
    environment: typeof m.environment === 'string' ? m.environment : null,
    generatedAt: typeof m.generatedAt === 'string' ? m.generatedAt : null,
    summary,
    findings: { drifted, missing, extra },
  }
  return JSON.stringify(doc, null, 2) + '\n'
}

// ─── Markdown renderer ──────────────────────────────────────────────────────

const mdCell = (v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')

const mdTable = (headers, rows) => {
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((cells) => `| ${cells.map(mdCell).join(' | ')} |`).join('\n')
  return `${head}\n${sep}\n${body}`
}

/**
 * Render the Conformance Evidence Report as Markdown. The disclaimer is emitted
 * verbatim as a blockquote in every render.
 * @param {ConformanceResult} result
 * @param {ReportMeta} [meta]
 * @returns {string}
 */
export function renderConformanceReportMarkdown(result, meta = {}) {
  const { drifted, missing, extra, summary } = summarizeConformance(result)
  const m = meta && typeof meta === 'object' ? meta : {}
  const lines = []

  lines.push(`# ${REPORT_TITLE}`)
  lines.push('')
  lines.push(`_${CONFORMANCE_SUMMARY_LINE}_`)
  lines.push('')
  // Baked disclaimer — always present, always verbatim.
  lines.push(`> **Disclaimer.** ${CONFORMANCE_DISCLAIMER}`)
  lines.push('')
  lines.push(`**Scope:** ${CONFORMANCE_SCOPE}`)
  lines.push('')

  const facts = []
  if (typeof m.app === 'string') facts.push(['Application', m.app])
  if (typeof m.environment === 'string') facts.push(['Environment', m.environment])
  if (typeof m.generatedAt === 'string') facts.push(['Generated', m.generatedAt])
  if (facts.length) {
    for (const [k, v] of facts) lines.push(`- **${k}:** ${v}`)
    lines.push('')
  }

  lines.push('## Summary')
  lines.push('')
  lines.push(
    mdTable(
      ['Category', 'Count', 'Meaning (descriptive)'],
      [
        ['Drifted', summary.drifted, 'declared value ≠ value the running app resolves'],
        ['Missing', summary.missing, 'declared, but the running app resolves no value'],
        ['Extra', summary.extra, 'the running app resolves a value that is not declared'],
        ['Total divergences', summary.divergences, 'drifted + missing + extra'],
      ],
    ),
  )
  lines.push('')

  lines.push('## Drifted — declared value differs from resolved')
  lines.push('')
  if (drifted.length) {
    lines.push(
      mdTable(
        ['Token (CSS var)', 'Tier', 'Type', 'Declared', 'Resolved'],
        drifted.map((d) => [d.cssVar, d.tier, d.type, d.declared, d.resolved]),
      ),
    )
  } else {
    lines.push('_None — every declared token that the running app resolves matches its declared value._')
  }
  lines.push('')

  lines.push('## Missing — declared but not resolved in the running app')
  lines.push('')
  if (missing.length) {
    lines.push(
      mdTable(
        ['Token (CSS var)', 'Tier', 'Declared'],
        missing.map((mi) => [mi.cssVar, mi.tier, mi.declared]),
      ),
    )
  } else {
    lines.push('_None — every declared token resolves to a value in the running app._')
  }
  lines.push('')

  lines.push('## Extra — resolved in the running app but not declared')
  lines.push('')
  if (extra.length) {
    lines.push(
      mdTable(
        ['Token (CSS var)', 'Resolved'],
        extra.map((e) => [e.cssVar, e.resolved]),
      ),
    )
  } else {
    lines.push('_None — the running app resolves no value outside the declared set._')
  }
  lines.push('')

  return lines.join('\n')
}

// ─── HTML renderer ──────────────────────────────────────────────────────────

const esc = (v) =>
  String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const htmlRows = (rows) =>
  rows
    .map((cells) => `      <tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('\n')

const htmlTable = (headers, rows) =>
  [
    '    <table>',
    `      <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`,
    '      <tbody>',
    htmlRows(rows),
    '      </tbody>',
    '    </table>',
  ].join('\n')

/**
 * Render the Conformance Evidence Report as a self-contained HTML document. The
 * disclaimer is emitted verbatim in a prominent block in every render.
 * @param {ConformanceResult} result
 * @param {ReportMeta} [meta]
 * @returns {string}
 */
export function renderConformanceReportHTML(result, meta = {}) {
  const { drifted, missing, extra, summary } = summarizeConformance(result)
  const m = meta && typeof meta === 'object' ? meta : {}

  const facts = []
  if (typeof m.app === 'string') facts.push(['Application', m.app])
  if (typeof m.environment === 'string') facts.push(['Environment', m.environment])
  if (typeof m.generatedAt === 'string') facts.push(['Generated', m.generatedAt])
  const factsHtml = facts.length
    ? '    <dl class="facts">\n' +
      facts.map(([k, v]) => `      <dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('\n') +
      '\n    </dl>'
    : ''

  const driftedSection = drifted.length
    ? htmlTable(
        ['Token (CSS var)', 'Tier', 'Type', 'Declared', 'Resolved'],
        drifted.map((d) => [d.cssVar, d.tier, d.type, d.declared, d.resolved]),
      )
    : '    <p class="none">None — every declared token that the running app resolves matches its declared value.</p>'

  const missingSection = missing.length
    ? htmlTable(
        ['Token (CSS var)', 'Tier', 'Declared'],
        missing.map((mi) => [mi.cssVar, mi.tier, mi.declared]),
      )
    : '    <p class="none">None — every declared token resolves to a value in the running app.</p>'

  const extraSection = extra.length
    ? htmlTable(
        ['Token (CSS var)', 'Resolved'],
        extra.map((e) => [e.cssVar, e.resolved]),
      )
    : '    <p class="none">None — the running app resolves no value outside the declared set.</p>'

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(REPORT_TITLE)}</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
    h1 { margin-bottom: .25rem; }
    .lede { color: #555; margin-top: 0; }
    .disclaimer { border: 1px solid #d0872f; background: #fff8ee; color: #5a3d12;
      padding: .75rem 1rem; border-radius: 6px; margin: 1rem 0; }
    .scope { font-weight: 600; }
    dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: .1rem .75rem; margin: 1rem 0; }
    dl.facts dt { font-weight: 600; }
    dl.facts dd { margin: 0; }
    table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.5rem; }
    th, td { border: 1px solid #ccc; padding: .35rem .55rem; text-align: left; font-variant-numeric: tabular-nums; }
    th { background: #f2f2f2; }
    .none { color: #666; font-style: italic; }
    code, td { font-family: ui-monospace, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>${esc(REPORT_TITLE)}</h1>
    <p class="lede">${esc(CONFORMANCE_SUMMARY_LINE)}</p>
    <p class="disclaimer"><strong>Disclaimer.</strong> ${esc(CONFORMANCE_DISCLAIMER)}</p>
    <p class="scope"><strong>Scope:</strong> ${esc(CONFORMANCE_SCOPE)}</p>
${factsHtml}
    <h2>Summary</h2>
${htmlTable(
  ['Category', 'Count', 'Meaning (descriptive)'],
  [
    ['Drifted', summary.drifted, 'declared value ≠ value the running app resolves'],
    ['Missing', summary.missing, 'declared, but the running app resolves no value'],
    ['Extra', summary.extra, 'the running app resolves a value that is not declared'],
    ['Total divergences', summary.divergences, 'drifted + missing + extra'],
  ],
)}
    <h2>Drifted — declared value differs from resolved</h2>
${driftedSection}
    <h2>Missing — declared but not resolved in the running app</h2>
${missingSection}
    <h2>Extra — resolved in the running app but not declared</h2>
${extraSection}
  </main>
</body>
</html>
`
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

/**
 * Render in a named format. The baked disclaimer is present in every format.
 * @param {ConformanceResult} result
 * @param {'html'|'json'|'md'|'markdown'} format
 * @param {ReportMeta} [meta]
 * @returns {string}
 * @throws {Error} on an unknown format.
 */
export function renderConformanceReport(result, format, meta = {}) {
  switch (format) {
    case 'json':
      return renderConformanceReportJSON(result, meta)
    case 'md':
    case 'markdown':
      return renderConformanceReportMarkdown(result, meta)
    case 'html':
      return renderConformanceReportHTML(result, meta)
    default:
      throw new Error(`unknown conformance report format: ${format}`)
  }
}
