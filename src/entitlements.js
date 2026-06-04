// Entitlements lookup + normalization for @sorb/juice (hosted mode).
//
// Pure JS (JSDoc types). The db handle is INJECTED as the first arg so tests
// can pass a fake db = { async query(text, params) { return { rows: [...] } } }
// — no real Postgres required. This module imports nothing (no pg, no crypto):
// it only reads sorb-cloud's `entitlements` table via the injected handle.
//
// BACK-COMPAT: never reached in local mode (DATABASE_URL unset). The server
// registers entitlement checks only inside the hosted branch.
//
// Spec: payment-subscription-spec.md §4 (entitlements object, Free defaults,
// degrade rule). See src/types.js for the Entitlements typedef.

/**
 * @typedef {object} DbHandle
 * @property {(text: string, params?: any[]) => Promise<{ rows: any[] }>} query
 */

/**
 * The frozen entitlements object, EXACT shape from payment-spec §4.
 * @typedef {object} Entitlements
 * @property {'free'|'team'|'enterprise'} plan
 * @property {'active'|'trialing'|'past_due'|'canceled'} status
 * @property {number} seats
 * @property {boolean} previewPersistence
 * @property {boolean} previewSharing
 * @property {number} maxProjects        -1 = unlimited
 * @property {number} maxActivePreviews  -1 = unlimited
 * @property {boolean} captureEnabled
 */

/**
 * The FREE baseline (payment-spec §4 Free row). Hosted Free = 1 project,
 * 1 seat, previews expire at 24h (no persistence), no sharing, no capture.
 * maxActivePreviews is -1 (unlimited COUNT on Free — the Free gate is the 24h
 * TTL + no sharing, not a count cap). Workers MUST treat -1 as unlimited.
 * @type {Readonly<Entitlements>}
 */
export const FREE = Object.freeze({
  plan: 'free',
  status: 'active',
  seats: 1,
  previewPersistence: false,
  previewSharing: false,
  maxProjects: 1,
  maxActivePreviews: -1,
  captureEnabled: false,
})

/**
 * Coerce a value to a finite Number, falling back to `fallback` on NaN/invalid.
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
const numOr = (v, fallback) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Normalize a raw `entitlements` row into a frozen {@link Entitlements} object.
 *
 * Merge order (later wins):
 *   1. FREE baseline.
 *   2. row.data jsonb — field-by-field, only KNOWN keys; each value coerced
 *      (booleans → Boolean, numeric caps → Number with NaN → FREE value).
 *   3. row.plan / row.status from the columns (columns win for plan + status).
 *
 * Unknown / missing fields fall back to the FREE value. Pure; no db.
 *
 * @param {{ plan?: unknown, status?: unknown, data?: unknown } | null | undefined} row
 * @returns {Readonly<Entitlements>}
 */
export function normalizeEntitlements(row) {
  const r = row || {}
  // row.data may arrive as parsed jsonb (object) or as a JSON string.
  let data = r.data
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (e) {
      data = null
    }
  }
  if (data === null || data === undefined || typeof data !== 'object') data = {}

  /** @type {Entitlements} */
  const out = {
    plan: FREE.plan,
    status: FREE.status,
    seats: 'seats' in data ? Math.max(1, numOr(data.seats, FREE.seats)) : FREE.seats,
    previewPersistence:
      'previewPersistence' in data ? Boolean(data.previewPersistence) : FREE.previewPersistence,
    previewSharing: 'previewSharing' in data ? Boolean(data.previewSharing) : FREE.previewSharing,
    maxProjects: 'maxProjects' in data ? numOr(data.maxProjects, FREE.maxProjects) : FREE.maxProjects,
    maxActivePreviews:
      'maxActivePreviews' in data
        ? numOr(data.maxActivePreviews, FREE.maxActivePreviews)
        : FREE.maxActivePreviews,
    captureEnabled: 'captureEnabled' in data ? Boolean(data.captureEnabled) : FREE.captureEnabled,
  }

  // Columns win for plan + status.
  if (r.plan !== undefined && r.plan !== null && String(r.plan).trim() !== '') {
    out.plan = /** @type {Entitlements['plan']} */ (String(r.plan))
  }
  if (r.status !== undefined && r.status !== null && String(r.status).trim() !== '') {
    out.status = /** @type {Entitlements['status']} */ (String(r.status))
  }

  return Object.freeze(out)
}

/**
 * Resolve the entitlements object for an org from sorb-cloud's `entitlements`
 * table. Returns {@link FREE} when no row exists; otherwise the normalized row.
 *
 * On a db.query throw this RETHROWS — the server maps it to 503. We never fall
 * back to FREE on a DB error, so a Postgres outage can't silently unlock paid
 * gates (fail closed).
 *
 * @param {DbHandle} db Injected db handle (fake in tests).
 * @param {string} orgId uuid string.
 * @returns {Promise<Readonly<Entitlements>>}
 */
export async function getEntitlements(db, orgId) {
  const { rows } = await db.query(
    'SELECT plan, status, data FROM entitlements WHERE org_id = $1 LIMIT 1',
    [orgId],
  )
  if (!rows || rows.length === 0) return FREE
  return normalizeEntitlements(rows[0])
}

/**
 * Apply the payment-spec §4 degrade rule. If status is 'past_due' or
 * 'canceled', collapse the paid GATE fields back to Free values (24h TTL, no
 * sharing/persistence, Free caps + seats) while KEEPING plan + status from the
 * original so the upgrade CTA can explain why access lapsed. 'active' and
 * 'trialing' pass through unchanged.
 *
 * Pure. The server calls this on the result of {@link getEntitlements} before
 * enforcing any gate.
 *
 * @param {Readonly<Entitlements>} ent
 * @returns {Readonly<Entitlements>}
 */
export function effectiveEntitlements(ent) {
  if (ent && (ent.status === 'past_due' || ent.status === 'canceled')) {
    return Object.freeze({
      ...ent,
      // Overlay FREE's gate fields; keep plan + status from ent.
      seats: FREE.seats,
      previewPersistence: FREE.previewPersistence,
      previewSharing: FREE.previewSharing,
      maxProjects: FREE.maxProjects,
      maxActivePreviews: FREE.maxActivePreviews,
      captureEnabled: FREE.captureEnabled,
      plan: ent.plan,
      status: ent.status,
    })
  }
  return ent
}

export default getEntitlements
