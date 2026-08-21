// evidenceFeed.js — Sorb-for-Enterprise E5 Continuous Conformance-EVIDENCE Feed.
//
// ⚠️⚠️  HELD SURFACE — DARK BY DEFAULT. PLUMBING ONLY.  ⚠️⚠️
//
// This module composes the continuous conformance-EVIDENCE stream (the E5
// surface) from three substrates already present in the bridge:
//   1. POST /verify/app      — the running-app token check result (published),
//   2. verify_events         — per-/verify telemetry rows (feat/moat-proof-telemetry,
//                              002_verifications.sql),
//   3. captureError (Sentry) — operational signals captured on the hosted path.
//
// The customer-facing feed exposure is gated behind an OFF-by-default flag
// (`config.enterpriseFeedEnabled` ← env `SORB_ENTERPRISE_FEED`). With the flag
// unset (the default and the only supported state today):
//   • NOTHING is recorded to evidence_events,
//   • the GET feed endpoint answers 404 (dormant / indistinguishable from absent),
//   • NO event is delivered to any subscriber.
// The composition/record/query functions exist so the data path is complete and
// testable, but they only run when a caller opts in — which no deployed
// environment does.
//
// ── THREE HARD GATES — ALL must clear before this surface may be enabled ───────
//   [ ] Tech E&O + Cyber insurance BOUND ($1–2M limits)   — founder precondition
//   [ ] GA Terms of Service with a real contracts attorney (cap/indemnity/venue/DPA)
//   [ ] SOC 2 in-flight or complete (procurement scrutinizes this feed hardest)
// Do NOT set SORB_ENTERPRISE_FEED on any deployed environment until all three
// are recorded cleared (sorb-enterprise-program.md §4 → E5). This ships dormant.
//
// ── Claims discipline (E5 = the single highest FTC-exposure surface) ──────────
// Every user-visible string here is MEASUREMENT register (claims-codex.md, the
// gating artifact): it describes what was measured — a check we ran,
// declared-vs-resolved values, a captured signal — never an OUTCOME
// (compliance / accessibility / a guarantee / a warranty). The stream is
// descriptive conformance EVIDENCE: an input to the customer's OWN conformance
// program, not an arbiter of it.
//
// This module is intentionally NOT exported from the package entrypoint
// (src/index.js): enterprise-lane phrasing is firewall-restricted to gated
// surfaces and must not ride the published @sorb/juice npm package.
//
// JS only (JSDoc typedefs). `catch (e)` everywhere, never `catch {}`.

/**
 * Env var that (and only that) enables the E5 feed surface. Documented here so
 * the one true switch has a single named home. Default state: unset = DARK.
 * @type {string}
 */
export const FEED_ENV_FLAG = 'SORB_ENTERPRISE_FEED'

/**
 * Measurement-register event kinds carried on the stream. Each names WHAT was
 * checked/captured — never a verdict.
 * @type {Readonly<{ APP_CHECK: 'app-check', DECLARED_VS_RESOLVED: 'declared-vs-resolved', SIGNAL: 'signal' }>}
 */
export const EVIDENCE_KIND = Object.freeze({
  // A POST /verify/app result: the values the running app resolved, checked
  // against the committed resolved map.
  APP_CHECK: 'app-check',
  // A POST /verify telemetry row: a declared-vs-running verify was run.
  DECLARED_VS_RESOLVED: 'declared-vs-resolved',
  // A captured operational signal (the Sentry leg) — an 'at' tag, no payload PII.
  SIGNAL: 'signal',
})

/**
 * One-line framing shown on the feed envelope. Measurement register: reuses the
 * codex-approved negation pattern (warranty / compliance) and avoids any
 * outcome or ongoing-guarantee verb.
 * @type {string}
 */
export const FEED_FRAMING =
  'Descriptive conformance-evidence stream — the checks Sorb ran over the ' +
  'token-governed WCAG 1.4.3 / 1.4.6 contrast slice, across your environments. ' +
  'Measurement, not a warranty of compliance.'

/**
 * The fixed feed disclaimer, baked onto every feed envelope. Transcribed from
 * the E1 claims-codex §6 register; the banned nouns appear ONLY inside explicit
 * negations, which the codex permits.
 *
 * ⚠ HELD GATE: exact wording is finalized under counsel before any customer-
 * facing feed goes live (E5 gate 2 — the GA-ToS/contracts-attorney review).
 * @type {string}
 */
export const FEED_DISCLAIMER =
  'This feed is descriptive conformance evidence for the WCAG 1.4.3 / 1.4.6 ' +
  'contrast criteria over the token-governed slice of the named application. ' +
  'It is not a full accessibility audit and not a warranty or guarantee of ' +
  'WCAG compliance. Automated checks do not detect all accessibility issues.'

/**
 * The stable feed-envelope kind identifier (for consumers to key on).
 * @type {string}
 */
export const FEED_KIND = 'sorb-conformance-evidence-feed'

/**
 * Is the E5 feed surface enabled? Reads the resolved config flag ONLY — there is
 * no other way to turn it on, and it defaults false (dormant).
 *
 * @param {{ enterpriseFeedEnabled?: boolean } | null | undefined} config
 * @returns {boolean} true only when the config flag is explicitly enabled.
 */
export function isFeedEnabled(config) {
  return Boolean(config && config.enterpriseFeedEnabled)
}

/**
 * Coerce an environment tag to the allowed set, defaulting to 'prod'.
 * @param {unknown} env
 * @returns {'dev' | 'stage' | 'prod'}
 */
function normEnv(env) {
  return env === 'dev' || env === 'stage' || env === 'prod' ? env : 'prod'
}

/**
 * Compose an `app-check` evidence event from a POST /verify/app result. Pure:
 * builds the row shape, computes nothing beyond selecting measurement fields.
 * Records COUNTS only — no token names/values leak into the durable stream.
 *
 * @param {Object} args
 * @param {{ ok?: boolean, checked?: number, matched?: number, mismatches?: Array<*>, unknown?: Array<*> }} args.result
 *   The /verify/app response body.
 * @param {string} [args.environment] The tenant key's environment.
 * @param {string} [args.storyId] Optional story/component id, if the caller has one.
 * @returns {{ kind: string, environment: 'dev'|'stage'|'prod', storyId: string|null, payload: object }}
 */
export function composeAppCheckEvent({ result, environment, storyId } = {}) {
  const r = result && typeof result === 'object' ? result : {}
  return {
    kind: EVIDENCE_KIND.APP_CHECK,
    environment: normEnv(environment),
    storyId: storyId == null ? null : String(storyId),
    payload: {
      // Descriptive measurement: how many token bindings were checked and how
      // many matched what the design system declares. Not a pass/fail verdict.
      checked: Number.isFinite(r.checked) ? r.checked : 0,
      matched: Number.isFinite(r.matched) ? r.matched : 0,
      mismatched: Array.isArray(r.mismatches) ? r.mismatches.length : 0,
      unknown: Array.isArray(r.unknown) ? r.unknown.length : 0,
    },
  }
}

/**
 * Compose a `declared-vs-resolved` evidence event from a /verify telemetry row.
 * Composes the verify_events substrate into the stream.
 *
 * @param {Object} args
 * @param {string} [args.storyId]
 * @param {number} [args.boundFields]
 * @param {string} [args.environment]
 * @returns {{ kind: string, environment: 'dev'|'stage'|'prod', storyId: string|null, payload: object }}
 */
export function composeTelemetryEvent({ storyId, boundFields, environment } = {}) {
  return {
    kind: EVIDENCE_KIND.DECLARED_VS_RESOLVED,
    environment: normEnv(environment),
    storyId: storyId == null ? null : String(storyId),
    payload: {
      boundFields: Number.isFinite(boundFields) ? boundFields : null,
    },
  }
}

/**
 * Compose a `signal` evidence event — the Sentry leg. Carries only a coarse
 * `at` tag (e.g. 'verify.telemetry.insert'); NEVER the error message/stack, so
 * no PII or secret reaches the durable stream. The full error still goes to
 * Sentry via captureError; this event only records THAT a signal occurred.
 *
 * @param {Object} args
 * @param {string} [args.at] Coarse location tag for the captured signal.
 * @param {string} [args.environment]
 * @returns {{ kind: string, environment: 'dev'|'stage'|'prod', storyId: null, payload: object }}
 */
export function composeSignalEvent({ at, environment } = {}) {
  return {
    kind: EVIDENCE_KIND.SIGNAL,
    environment: normEnv(environment),
    storyId: null,
    payload: {
      at: typeof at === 'string' && at !== '' ? at : 'unknown',
    },
  }
}

/**
 * Best-effort record an evidence event to the durable stream (evidence_events).
 * Mirrors the verify_events telemetry pattern: a failed insert never fails the
 * caller's request. Returns whether the row was written.
 *
 * IMPORTANT: callers MUST gate this behind {@link isFeedEnabled}. This function
 * does not re-check the flag (so it stays unit-testable), but nothing in the
 * running server calls it while the feed is dark.
 *
 * @param {import('../types.js').DbHandle} db Hosted Postgres handle.
 * @param {string} projectId The tenant project id (uuid).
 * @param {{ kind: string, environment: string, storyId: string|null, payload: object }} event
 * @param {(err: unknown, context?: Record<string, unknown>) => void} [onError]
 *   Optional error sink (Sentry). Called on a failed insert.
 * @returns {Promise<boolean>} true if the row was inserted, false on any error.
 */
export async function recordEvidenceEvent(db, projectId, event, onError = () => {}) {
  if (!db || !projectId || !event) return false
  try {
    await db.query(
      'INSERT INTO evidence_events (project_id, environment, kind, story_id, payload) VALUES ($1, $2, $3, $4, $5)',
      [
        projectId,
        normEnv(event.environment),
        event.kind,
        event.storyId ?? null,
        JSON.stringify(event.payload || {}),
      ],
    )
    return true
  } catch (e) {
    onError(e, { at: 'evidence.record', kind: event && event.kind })
    return false
  }
}

/**
 * List recent evidence events for a tenant (the feed read path). Returns [] on
 * any error so the endpoint can degrade cleanly.
 *
 * @param {import('../types.js').DbHandle} db
 * @param {Object} args
 * @param {string} args.projectId Tenant project id.
 * @param {string} [args.environment] Optional env filter.
 * @param {number} [args.limit] Max rows (clamped 1..200, default 50).
 * @param {(err: unknown, context?: Record<string, unknown>) => void} [onError]
 * @returns {Promise<Array<object>>}
 */
export async function listEvidenceEvents(db, { projectId, environment, limit } = {}, onError = () => {}) {
  if (!db || !projectId) return []
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50
  try {
    if (environment) {
      const res = await db.query(
        'SELECT id, environment, kind, story_id, payload, recorded_at FROM evidence_events WHERE project_id = $1 AND environment = $2 ORDER BY recorded_at DESC LIMIT $3',
        [projectId, normEnv(environment), n],
      )
      return (res && res.rows) || []
    }
    const res = await db.query(
      'SELECT id, environment, kind, story_id, payload, recorded_at FROM evidence_events WHERE project_id = $1 ORDER BY recorded_at DESC LIMIT $2',
      [projectId, n],
    )
    return (res && res.rows) || []
  } catch (e) {
    onError(e, { at: 'evidence.list' })
    return []
  }
}

/**
 * The subscription/alerting substrate — INTENTIONALLY INERT.
 *
 * Even when the feed flag is on and a subscription row is active, this performs
 * NO external delivery: there is no transport wired to any destination. It only
 * resolves how many subscribers WOULD receive the event, and returns
 * `emitted: false` with a reason. This is a hard belt-and-suspenders guard on
 * top of the OFF-by-default flag — the customer-facing emission is dark two ways.
 *
 * Wiring a real transport is deferred until ALL THREE E5 hard gates clear.
 *
 * @param {import('../types.js').DbHandle} db
 * @param {{ kind: string, environment: string }} event
 * @param {Object} [opts]
 * @param {boolean} [opts.enabled] The resolved feed flag.
 * @param {string} [opts.projectId] Tenant project id, for the subscriber lookup.
 * @param {(err: unknown, context?: Record<string, unknown>) => void} [onError]
 * @returns {Promise<{ emitted: false, reason: string, recipients: number }>}
 *   `emitted` is ALWAYS false — no destination is ever contacted.
 */
export async function emitToSubscribers(db, event, { enabled = false, projectId, onError = () => {} } = {}) {
  // Gate 1: the feed is dark ⇒ do not even look at subscribers.
  if (!enabled) {
    return { emitted: false, reason: 'feed-dark', recipients: 0 }
  }
  // Gate 2 (belt-and-suspenders): even enabled, count would-be recipients but
  // deliver to NONE — no external transport is wired until the hard gates clear.
  let recipients = 0
  if (db && projectId) {
    try {
      const res = await db.query(
        'SELECT count(*)::int AS n FROM feed_subscriptions WHERE project_id = $1 AND active = true',
        [projectId],
      )
      recipients = (res && res.rows && res.rows[0] && res.rows[0].n) || 0
    } catch (e) {
      onError(e, { at: 'evidence.emit.count' })
      recipients = 0
    }
  }
  return { emitted: false, reason: 'no-destination-wired', recipients }
}
