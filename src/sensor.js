// sensor.js — E2 sensor-spine event emission for @sorb/juice.
//
// Spike for spec/sorb/hosted-bridge-modes-exploration-plan.md §E2 (=
// data-moat-strategy-brief.md W1, "the one pre-publish piece"). Contract:
// experiments/sorb-bridge-modes/contracts/{sensor-spine.md,sensor-events.schema.json}.
//
// HARD INVARIANT: this module is only ever reached from the `hosted` branch of
// server.js routes (config.databaseUrl set). LOCAL mode never calls anything
// here, so no telemetry is ever retained for the free local bridge — see
// server.js's single `hosted` switch. Every exported recordX() function is
// ALSO internally try/catch'd (never throws) so a telemetry failure can never
// break a preview/verify/commit response — mirrors the verify_events /
// evidence_events best-effort pattern already in server.js.
//
// JS only (JSDoc typedefs, mirroring sensor-events.schema.json's Envelope +
// per-type shapes). `catch (e)` everywhere, never `catch {}`.

import { randomUUID } from 'node:crypto'

/**
 * @typedef {Object} SensorEnvelope
 * @property {number} schema_version
 * @property {string} event_id
 * @property {string} chain_id
 * @property {string} org_id
 * @property {string} app_id
 * @property {'A' | 'B' | 'C'} mode
 * @property {boolean} consent
 * @property {string} ts
 * @property {'owner' | 'admin' | 'editor' | 'viewer' | 'system'} actor_role
 */

/**
 * @typedef {SensorEnvelope & { type: 'proposal', preview_id: string, tokens: Object<string,string>, story_id: string|null }} ProposalEvent
 * @typedef {SensorEnvelope & { type: 'verify_result', check: 'figma_geometry'|'app_values', ok: boolean, checked: number, matched: number, mismatch_count: number }} VerifyResultEvent
 * @typedef {SensorEnvelope & { type: 'accept_reject', outcome: 'accepted'|'rejected', signal: 'explicit_commit'|'explicit_discard'|'ttl_expiry', token_commit_id: string|null }} AcceptRejectEvent
 * @typedef {SensorEnvelope & { type: 'conformance_snapshot_ref', snapshot_id: string, storage_ref: string }} ConformanceSnapshotRefEvent
 */

/** Envelope schema_version this module emits. @type {number} */
export const SCHEMA_VERSION = 1

/**
 * The 5 sensor-spine event type discriminants. `RUNTIME_OUTCOME` is RESERVED
 * (sensor-spine.md "runtime_outcome — genuinely undesigned") — this module
 * never composes or records one; it's exported only so callers/tests can name
 * the reserved value without a magic string.
 * @type {Readonly<{PROPOSAL:'proposal', VERIFY_RESULT:'verify_result', ACCEPT_REJECT:'accept_reject', RUNTIME_OUTCOME:'runtime_outcome', CONFORMANCE_SNAPSHOT_REF:'conformance_snapshot_ref'}>}
 */
export const EVENT_TYPE = Object.freeze({
  PROPOSAL: 'proposal',
  VERIFY_RESULT: 'verify_result',
  ACCEPT_REJECT: 'accept_reject',
  RUNTIME_OUTCOME: 'runtime_outcome',
  CONFORMANCE_SNAPSHOT_REF: 'conformance_snapshot_ref',
})

/**
 * Mint a new chain_id. Called ONCE per proposal (POST /preview) and threaded
 * through every downstream verify_result / accept_reject event for that
 * preview's cycle. Exported so server.js can mint it before the first INSERT.
 * @returns {string} a fresh uuid.
 */
export function mintChainId() {
  return randomUUID()
}

/**
 * Is this org consented to sensor-spine retention? MUST be checked before
 * every record*() call below — see sensor-events.schema.json Envelope.consent
 * ("MUST be true for the event to be retained past the hot path").
 *
 * TODO(E2 cloud contract — blocking dependency, not a detail): `organizations`
 * has NO consent/ToS-acceptance column today (sensor-spine.md "Consent / ToS
 * gate"; open-questions.md #8). This queries a `data_consent` column that does
 * not exist yet as a documented placeholder for the real column/accessor the
 * cloud agent lands. Until then this FAILS CLOSED: a missing column (query
 * error), a missing org, or any other DB error all resolve to `false` — so
 * nothing is ever retained past the hot path by default. Swap the SELECT below
 * for the cloud agent's real consent accessor once it exists; do not relax the
 * fail-closed default.
 *
 * @param {import('./types.js').DbHandle} db
 * @param {string} orgId
 * @returns {Promise<boolean>}
 */
export async function isConsented(db, orgId) {
  if (!db || !orgId) return false
  try {
    const res = await db.query(
      'SELECT data_consent FROM organizations WHERE id = $1 LIMIT 1',
      [orgId],
    )
    const row = res && res.rows && res.rows[0]
    return Boolean(row && row.data_consent === true)
  } catch (e) {
    // Expected today (the column doesn't exist yet) as well as any other DB
    // error — fail closed. Callers do not need to catch this; it never throws.
    return false
  }
}

/**
 * Look up the chain_id minted for a preview (from `previews.chain_id`,
 * 005_sensor_events.sql), tenant-scoped. Returns null when the preview is
 * unknown, belongs to a different project, or carries no chain_id (e.g. a
 * preview created before this migration, or in local mode where this is never
 * called).
 *
 * @param {import('./types.js').DbHandle} db
 * @param {string} previewId
 * @param {string} projectId
 * @returns {Promise<string | null>}
 */
export async function lookupChainId(db, previewId, projectId) {
  if (!db || !previewId || !projectId) return null
  try {
    const res = await db.query(
      'SELECT chain_id FROM previews WHERE id = $1 AND project_id = $2 LIMIT 1',
      [previewId, projectId],
    )
    const row = res && res.rows && res.rows[0]
    return (row && row.chain_id) || null
  } catch (e) {
    return null
  }
}

/**
 * Build the common envelope fields. Pure — no I/O.
 * @param {Object} args
 * @param {string} args.chainId
 * @param {string} args.orgId
 * @param {string} args.appId
 * @param {'A'|'B'|'C'} [args.mode]
 * @param {'owner'|'admin'|'editor'|'viewer'|'system'} [args.actorRole]
 * @returns {SensorEnvelope}
 */
function envelope({ chainId, orgId, appId, mode, actorRole }) {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: randomUUID(),
    chain_id: chainId,
    org_id: orgId,
    app_id: appId,
    // TODO(org-model): org_settings.bridge_mode (contracts/org-model.md) isn't
    // wired into juice's AuthContext yet — this E2 slice always emits 'A'
    // (the account-managed default mode E1 built) until that lands.
    mode: mode || 'A',
    consent: true, // record*() below only ever inserts after isConsented() passed
    ts: new Date().toISOString(),
    actor_role: actorRole || 'system',
  }
}

/**
 * Best-effort INSERT into sensor_events. Never throws — callers get a boolean.
 * @param {import('./types.js').DbHandle} db
 * @param {SensorEnvelope & { type: string, [key: string]: unknown }} event
 * @param {(err: unknown, context?: Record<string, unknown>) => void} onError
 * @param {Record<string, unknown>} payload
 * @returns {Promise<boolean>}
 */
async function insertEvent(db, event, payload, onError) {
  try {
    await db.query(
      `INSERT INTO sensor_events
         (id, schema_version, chain_id, org_id, app_id, type, mode, consent, actor_role, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        event.event_id,
        event.schema_version,
        event.chain_id,
        event.org_id,
        event.app_id,
        event.type,
        event.mode,
        event.consent,
        event.actor_role,
        JSON.stringify(payload || {}),
        event.ts,
      ],
    )
    return true
  } catch (e) {
    onError(e, { at: 'sensor.record', type: event.type })
    return false
  }
}

/**
 * Record a `proposal` event — POST /preview. Carries the proposed
 * cssVar->value pairs (the product, not excluded — see sensor-spine.md
 * Exclusions). Gated on isConsented(); returns false (no-op) when not
 * consented or on any error. Never throws.
 *
 * @param {import('./types.js').DbHandle} db
 * @param {Object} args
 * @param {string} args.chainId
 * @param {string} args.orgId
 * @param {string} args.appId project id (= AppRegistration.id).
 * @param {string} args.previewId the id returned by POST /preview.
 * @param {import('./types.js').TokenSet} args.tokens
 * @param {string|null} [args.storyId]
 * @param {(err: unknown, context?: Record<string, unknown>) => void} [onError]
 * @returns {Promise<boolean>}
 */
export async function recordProposal(db, { chainId, orgId, appId, previewId, tokens, storyId }, onError = () => {}) {
  try {
    if (!(await isConsented(db, orgId))) return false
    const env = envelope({ chainId, orgId, appId })
    return await insertEvent(
      db,
      { ...env, type: EVENT_TYPE.PROPOSAL },
      { preview_id: previewId, tokens: tokens || {}, story_id: storyId ?? null },
      onError,
    )
  } catch (e) {
    onError(e, { at: 'sensor.proposal', previewId })
    return false
  }
}

/**
 * Record a `verify_result` event — POST /verify (check: 'figma_geometry') or
 * POST /verify/app (check: 'app_values'). Carries COUNTS only, never
 * cssVar-level expected/got detail (sensor-spine.md Exclusions). Correlated to
 * the originating proposal via `chainId` (caller resolves it, typically via
 * {@link lookupChainId}). Gated on isConsented(); never throws.
 *
 * @param {import('./types.js').DbHandle} db
 * @param {Object} args
 * @param {string} args.chainId
 * @param {string} args.orgId
 * @param {string} args.appId
 * @param {'figma_geometry'|'app_values'} args.check
 * @param {boolean} args.ok
 * @param {number} args.checked
 * @param {number} args.matched
 * @param {number} args.mismatchCount
 * @param {(err: unknown, context?: Record<string, unknown>) => void} [onError]
 * @returns {Promise<boolean>}
 */
export async function recordVerifyResult(
  db,
  { chainId, orgId, appId, check, ok, checked, matched, mismatchCount },
  onError = () => {},
) {
  try {
    if (!(await isConsented(db, orgId))) return false
    const env = envelope({ chainId, orgId, appId })
    return await insertEvent(
      db,
      { ...env, type: EVENT_TYPE.VERIFY_RESULT },
      {
        check,
        ok: Boolean(ok),
        checked: Number.isFinite(checked) ? checked : 0,
        matched: Number.isFinite(matched) ? matched : 0,
        mismatch_count: Number.isFinite(mismatchCount) ? mismatchCount : 0,
      },
      onError,
    )
  } catch (e) {
    onError(e, { at: 'sensor.verifyResult', check })
    return false
  }
}

/**
 * Record an `accept_reject` event. `outcome`/`signal` map:
 *   - accepted / explicit_commit  — a token_commits row was written (NOT YET
 *     WIRED to any route in this repo — `sorb commit` opens a GitHub PR, it
 *     does not INSERT token_commits. This function is ready for whichever
 *     route eventually does that write; see server.js E2 comment).
 *   - rejected / explicit_discard — DELETE /preview/:id.
 *   - rejected / ttl_expiry       — inferred from a preview's terminal
 *     store.onUpdate('delete') that was NOT preceded by an explicit DELETE.
 * Gated on isConsented(); never throws.
 *
 * @param {import('./types.js').DbHandle} db
 * @param {Object} args
 * @param {string} args.chainId
 * @param {string} args.orgId
 * @param {string} args.appId
 * @param {string} args.previewId
 * @param {'accepted'|'rejected'} args.outcome
 * @param {'explicit_commit'|'explicit_discard'|'ttl_expiry'} args.signal
 * @param {string|null} [args.tokenCommitId]
 * @param {(err: unknown, context?: Record<string, unknown>) => void} [onError]
 * @returns {Promise<boolean>}
 */
export async function recordAcceptReject(
  db,
  { chainId, orgId, appId, previewId, outcome, signal, tokenCommitId },
  onError = () => {},
) {
  try {
    if (!(await isConsented(db, orgId))) return false
    // 'system' actor for inference-driven signals (no human action); explicit
    // discard/commit is also recorded as 'system' here since juice's
    // AuthContext carries no per-user role today (see envelope() TODO).
    const env = envelope({ chainId, orgId, appId, actorRole: 'system' })
    return await insertEvent(
      db,
      { ...env, type: EVENT_TYPE.ACCEPT_REJECT },
      { preview_id: previewId, outcome, signal, token_commit_id: tokenCommitId ?? null },
      onError,
    )
  } catch (e) {
    onError(e, { at: 'sensor.acceptReject', previewId })
    return false
  }
}

/**
 * Record a `conformance_snapshot_ref` event — POST /tokens/figma. A POINTER
 * only (storage_ref); never the snapshot payload itself (sensor-spine.md
 * Exclusions). Gated on isConsented(); never throws.
 *
 * @param {import('./types.js').DbHandle} db
 * @param {Object} args
 * @param {string} args.chainId
 * @param {string} args.orgId
 * @param {string} args.appId
 * @param {string} args.snapshotId
 * @param {string} args.storageRef
 * @param {(err: unknown, context?: Record<string, unknown>) => void} [onError]
 * @returns {Promise<boolean>}
 */
export async function recordConformanceSnapshotRef(
  db,
  { chainId, orgId, appId, snapshotId, storageRef },
  onError = () => {},
) {
  try {
    if (!(await isConsented(db, orgId))) return false
    const env = envelope({ chainId, orgId, appId })
    return await insertEvent(
      db,
      { ...env, type: EVENT_TYPE.CONFORMANCE_SNAPSHOT_REF },
      { snapshot_id: snapshotId, storage_ref: storageRef },
      onError,
    )
  } catch (e) {
    onError(e, { at: 'sensor.conformanceSnapshotRef', snapshotId })
    return false
  }
}
