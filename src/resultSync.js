// resultSync.js — E4 Mode-C result-sync for @sorb/juice.
//
// Spike for spec/sorb/hosted-bridge-modes-exploration-plan.md §E4 ("mostly
// repackaging"). Principle (plan §1): "Even Mode C's local bridge can POST
// conformance/handoff RESULTS up to the account (preview traffic stays local;
// labeled outcomes still feed the corpus). Keep-everything-local is an
// explicit enterprise opt-out you charge for."
//
// This module is the local-bridge (`sorb dev`) half of that: it batches the
// SAME labeled-outcome event shapes E2's sensor.js defines (proposal /
// verify_result / accept_reject / conformance_snapshot_ref) and POSTs them to
// a cloud ingest endpoint instead of INSERTing them into a co-located
// Postgres. "The same events, emitted from a local bridge, POSTed to the
// cloud" — not a new telemetry design.
//
// HARD INVARIANT: nothing in this module is ever reached unless the caller
// (cli.js `dev`) resolved an org key — see resolveResultSyncConfig() below,
// which returns `null` (pure local, unaffected) whenever no key is present.
// Every public method here is best-effort and NEVER throws — a sync failure
// must never break the local preview loop.
//
// CLOUD CONTRACT ASSUMED (flagged for reconciliation with the cloud agent —
// no such route exists in sorb-cloud yet as of this spike):
//   GET  <cloudBase>/api/orgs/resolve      Bearer <orgKey>
//     -> { orgId: string, consent: boolean, localOnlyNoSync: boolean }
//   POST <cloudBase>/api/sensor/ingest     Bearer <orgKey>
//     body: { events: SyncableEvent[] }    (same shape as sensor-events.schema.json)
//
// JavaScript only (JSDoc typedefs). `catch (e)` everywhere, never `catch {}`.

import { EVENT_TYPE, mintChainId, buildEnvelope } from './sensor.js'

/** Assumed cloud contract paths — see module header. @type {string} */
export const ORG_STATUS_PATH = '/api/orgs/resolve'
/** @type {string} */
export const INGEST_PATH = '/api/sensor/ingest'

/**
 * @typedef {Object} SyncableEvent
 * @property {number} schema_version
 * @property {string} event_id
 * @property {string} chain_id
 * @property {string} org_id
 * @property {string} app_id
 * @property {'C'} mode
 * @property {boolean} consent
 * @property {string} ts
 * @property {'owner'|'admin'|'editor'|'viewer'|'system'} actor_role
 * @property {string} type
 * @property {Record<string, unknown>} [payload]
 */

/**
 * @typedef {Object} OrgStatus
 * @property {string|null} orgId
 * @property {boolean} consent
 * @property {boolean} localOnlyNoSync
 */

const strOrUndef = (raw) => {
  if (raw === undefined || raw === null) return undefined
  const s = String(raw).trim()
  return s === '' ? undefined : s
}

const truthyFlag = (raw) =>
  ['1', 'true', 'on', 'yes'].includes(String(raw ?? '').trim().toLowerCase())

/**
 * Resolve Mode-C result-sync settings from `sorb.config.json` + env, mirroring
 * `resolveCloudConfig` in src/cloud.js. Returns `null` when NO org key is
 * present — the invariant that keeps the free local bridge byte-for-byte
 * unchanged for anyone who hasn't opted into an account.
 *
 * @param {import('./types').SorbCliConfig & { orgKey?: string, cloudUrl?: string, appId?: string }} [fileConfig]
 *   The parsed sorb.config.json. Optional new fields: `orgKey`, `cloudUrl`,
 *   `appId` — additive, back-compatible (existing configs without them are
 *   unaffected, and still resolve to `null` here).
 * @param {NodeJS.ProcessEnv} [env] Defaults to process.env.
 * @returns {{ orgKey: string, cloudBase: string, appId: string, localForceNoSync: boolean } | null}
 */
export const resolveResultSyncConfig = (fileConfig = {}, env = process.env) => {
  const orgKey = strOrUndef(env.SORB_ORG_KEY) ?? strOrUndef(fileConfig.orgKey)
  if (!orgKey) return null // no account → pure local, this module is never touched

  const cloudBase =
    strOrUndef(env.SORB_CLOUD_URL) ??
    strOrUndef(env.CLOUD_API) ??
    strOrUndef(fileConfig.cloudUrl) ??
    'https://sorbcloud.com'

  const appId =
    strOrUndef(env.SORB_APP_ID) ??
    strOrUndef(fileConfig.appId) ??
    strOrUndef(fileConfig.namespace) ??
    'local'

  // Local escape hatch (e.g. an air-gapped CI runner under an account that
  // still must never phone home). The AUTHORITATIVE localOnlyNoSync signal is
  // the cloud entitlement fetched via ORG_STATUS_PATH at runtime — this just
  // ORs in an extra, purely-local override.
  const localForceNoSync = truthyFlag(env.SORB_LOCAL_ONLY_NO_SYNC)

  return { orgKey, cloudBase, appId, localForceNoSync }
}

/**
 * Keep only primitive (string/number/boolean) values under string keys.
 * Defense-in-depth payload separation: even if a caller accidentally passed
 * something richer than `{cssVar: value}` (e.g. a nested DOM/style object),
 * this strips it down to the labeled-outcome shape the corpus is allowed to
 * see. Never throws.
 * @param {unknown} tokens
 * @returns {Record<string, string>}
 */
export const sanitizeTokenMap = (tokens) => {
  const out = {}
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return out
  for (const [k, v] of Object.entries(tokens)) {
    if (typeof k !== 'string') continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v)
    }
    // Anything else (objects, arrays, functions) is silently dropped — it is
    // never DOM/screenshot content by contract (leaf/canopy only ever send
    // cssVar->value maps here), but a hostile/buggy caller must not be able
    // to smuggle richer content into the corpus via this path.
  }
  return out
}

/**
 * Build a `proposal` SyncableEvent (mode 'C'). Pure — no I/O.
 * @param {{ chainId: string, orgId: string, appId: string, previewId: string, tokens: Object, storyId?: string|null }} args
 * @returns {SyncableEvent}
 */
export const buildProposalEvent = ({ chainId, orgId, appId, previewId, tokens, storyId }) => ({
  ...buildEnvelope({ chainId, orgId, appId, mode: 'C' }),
  type: EVENT_TYPE.PROPOSAL,
  payload: { preview_id: previewId, tokens: sanitizeTokenMap(tokens), story_id: storyId ?? null },
})

/**
 * Build a `verify_result` SyncableEvent (mode 'C'). Carries COUNTS only, same
 * exclusion as sensor.js's recordVerifyResult.
 * @param {{ chainId: string, orgId: string, appId: string, check: 'figma_geometry'|'app_values', ok: boolean, checked: number, matched: number, mismatchCount: number }} args
 * @returns {SyncableEvent}
 */
export const buildVerifyResultEvent = ({ chainId, orgId, appId, check, ok, checked, matched, mismatchCount }) => ({
  ...buildEnvelope({ chainId, orgId, appId, mode: 'C' }),
  type: EVENT_TYPE.VERIFY_RESULT,
  payload: {
    check,
    ok: Boolean(ok),
    checked: Number.isFinite(checked) ? checked : 0,
    matched: Number.isFinite(matched) ? matched : 0,
    mismatch_count: Number.isFinite(mismatchCount) ? mismatchCount : 0,
  },
})

/**
 * Build an `accept_reject` SyncableEvent (mode 'C').
 * @param {{ chainId: string, orgId: string, appId: string, previewId: string, outcome: 'accepted'|'rejected', signal: 'explicit_commit'|'explicit_discard'|'ttl_expiry', tokenCommitId?: string|null }} args
 * @returns {SyncableEvent}
 */
export const buildAcceptRejectEvent = ({ chainId, orgId, appId, previewId, outcome, signal, tokenCommitId }) => ({
  ...buildEnvelope({ chainId, orgId, appId, mode: 'C', actorRole: 'system' }),
  type: EVENT_TYPE.ACCEPT_REJECT,
  payload: { preview_id: previewId, outcome, signal, token_commit_id: tokenCommitId ?? null },
})

/**
 * Build a `conformance_snapshot_ref` SyncableEvent (mode 'C'). POINTER only —
 * never the snapshot payload (Figma export / DOM capture) itself.
 * @param {{ chainId: string, orgId: string, appId: string, snapshotId: string, storageRef: string }} args
 * @returns {SyncableEvent}
 */
export const buildConformanceSnapshotRefEvent = ({ chainId, orgId, appId, snapshotId, storageRef }) => ({
  ...buildEnvelope({ chainId, orgId, appId, mode: 'C' }),
  type: EVENT_TYPE.CONFORMANCE_SNAPSHOT_REF,
  payload: { snapshot_id: snapshotId, storage_ref: storageRef },
})

const BUILDERS = Object.freeze({
  [EVENT_TYPE.PROPOSAL]: buildProposalEvent,
  [EVENT_TYPE.VERIFY_RESULT]: buildVerifyResultEvent,
  [EVENT_TYPE.ACCEPT_REJECT]: buildAcceptRejectEvent,
  [EVENT_TYPE.CONFORMANCE_SNAPSHOT_REF]: buildConformanceSnapshotRefEvent,
})

/**
 * @typedef {Object} ResultSync
 * @property {(type: string, args: Object) => boolean} record
 *   Build + enqueue a labeled-outcome event of `type` (one of EVENT_TYPE's 4
 *   non-reserved values). No-op (returns false) unless {@link isActive}.
 *   Never throws.
 * @property {() => boolean} isActive
 *   True iff an org key is configured AND the last-known cloud status says
 *   consent=true AND localOnlyNoSync is not set (locally or by the cloud).
 * @property {() => Promise<void>} refreshStatus
 *   Re-fetch org consent/opt-out status. Best-effort; failures fail CLOSED
 *   (consent reverts to false) so a transient outage can never silently start
 *   syncing an org that hasn't confirmed consent.
 * @property {() => Promise<void>} flush
 *   POST up to one batch of queued events. Best-effort; never throws. Failed
 *   sends are requeued (bounded).
 * @property {() => number} queueLength
 * @property {() => void} start
 * @property {() => void} stop
 */

/**
 * Create a Mode-C result-sync client. Pure factory — no network activity
 * until `start()` (or an explicit `refreshStatus()`/`flush()`) is called.
 *
 * @param {Object} options
 * @param {string} options.orgKey Bearer token identifying the org/publishable key.
 * @param {string} options.appId
 * @param {string} options.cloudBase e.g. `https://sorbcloud.com`.
 * @param {boolean} [options.localForceNoSync] Local override — see resolveResultSyncConfig.
 * @param {typeof fetch} [options.fetchImpl] Injectable fetch (tests).
 * @param {number} [options.batchIntervalMs] Default 5000.
 * @param {number} [options.maxBatchSize] Default 25.
 * @param {number} [options.maxQueueSize] Default 500 (oldest dropped beyond this).
 * @param {number} [options.statusRefreshMs] Default 60000.
 * @param {number} [options.timeoutMs] Per-request abort timeout. Default 10000.
 * @param {(err: unknown, context?: Record<string, unknown>) => void} [options.onError]
 * @returns {ResultSync}
 */
export const createResultSync = (options) => {
  const {
    orgKey,
    appId,
    cloudBase,
    localForceNoSync = false,
    fetchImpl = globalThis.fetch,
    batchIntervalMs = 5000,
    maxBatchSize = 25,
    maxQueueSize = 500,
    statusRefreshMs = 60_000,
    timeoutMs = 10_000,
    onError = () => {},
  } = options || {}

  if (!orgKey) throw new Error('createResultSync: orgKey is required')
  if (!cloudBase) throw new Error('createResultSync: cloudBase is required')
  if (typeof fetchImpl !== 'function') {
    throw new Error('createResultSync: global fetch is unavailable (need Node 20+) and no fetchImpl provided')
  }

  /** @type {OrgStatus} */
  // Fail CLOSED: nothing syncs until a real cloud response confirms consent —
  // mirrors sensor.js's isConsented() fail-closed default exactly.
  let status = { orgId: null, consent: false, localOnlyNoSync: false }

  /** @type {SyncableEvent[]} */
  let queue = []

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null

  const isActive = () =>
    Boolean(orgKey) && status.consent === true && status.localOnlyNoSync !== true && localForceNoSync !== true

  const withTimeout = async (fn) => {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    try {
      return await fn(ac.signal)
    } finally {
      clearTimeout(t)
    }
  }

  const refreshStatus = async () => {
    try {
      await withTimeout(async (signal) => {
        const res = await fetchImpl(`${cloudBase.replace(/\/+$/, '')}${ORG_STATUS_PATH}`, {
          headers: { accept: 'application/json', authorization: `Bearer ${orgKey}` },
          signal,
        })
        if (!res.ok) {
          onError(new Error(`org status ${res.status} ${res.statusText}`), { at: 'resultSync.refreshStatus' })
          // Fail closed — do not keep a stale `true` around on a bad response.
          status = { orgId: status.orgId, consent: false, localOnlyNoSync: status.localOnlyNoSync }
          return
        }
        const data = await res.json()
        status = {
          orgId: (data && typeof data.orgId === 'string' && data.orgId) || null,
          consent: Boolean(data && data.consent === true),
          localOnlyNoSync: Boolean(data && data.localOnlyNoSync === true),
        }
      })
    } catch (e) {
      onError(e, { at: 'resultSync.refreshStatus' })
      // Network error/timeout: fail closed on consent; keep the (safer, more
      // restrictive) localOnlyNoSync value already known.
      status = { orgId: status.orgId, consent: false, localOnlyNoSync: status.localOnlyNoSync }
    }
  }

  /**
   * @param {string} type
   * @param {Object} args
   * @returns {boolean}
   */
  const record = (type, args) => {
    try {
      if (!isActive()) return false
      const build = BUILDERS[type]
      if (!build) {
        onError(new Error(`resultSync.record: unknown event type "${type}"`), { at: 'resultSync.record', type })
        return false
      }
      const event = build({
        chainId: (args && args.chainId) || mintChainId(),
        orgId: status.orgId || '',
        appId,
        ...args,
      })
      queue.push(event)
      if (queue.length > maxQueueSize) queue = queue.slice(queue.length - maxQueueSize)
      return true
    } catch (e) {
      onError(e, { at: 'resultSync.record', type })
      return false
    }
  }

  const flush = async () => {
    if (queue.length === 0) return
    if (!isActive()) return // opted out (or consent revoked) since these were queued — drop silently, never send
    const batch = queue.slice(0, maxBatchSize)
    try {
      await withTimeout(async (signal) => {
        const res = await fetchImpl(`${cloudBase.replace(/\/+$/, '')}${INGEST_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${orgKey}`,
          },
          body: JSON.stringify({ events: batch }),
          signal,
        })
        if (!res.ok) {
          onError(new Error(`sensor ingest ${res.status} ${res.statusText}`), {
            at: 'resultSync.flush',
            count: batch.length,
          })
          return // keep batch queued for the next attempt (best-effort retry)
        }
        // Success: remove exactly the sent events (by event_id) from the head.
        const sentIds = new Set(batch.map((e) => e.event_id))
        queue = queue.filter((e) => !sentIds.has(e.event_id))
      })
    } catch (e) {
      onError(e, { at: 'resultSync.flush', count: batch.length })
      // Non-blocking: leave the batch queued, bounded by maxQueueSize on the
      // next record() call. Never throws to the caller.
    }
  }

  const start = () => {
    if (timer) return
    void refreshStatus()
    let sinceStatusRefresh = 0
    timer = setInterval(() => {
      sinceStatusRefresh += batchIntervalMs
      if (sinceStatusRefresh >= statusRefreshMs) {
        sinceStatusRefresh = 0
        void refreshStatus()
      }
      void flush()
    }, batchIntervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    record,
    isActive,
    refreshStatus,
    flush,
    queueLength: () => queue.length,
    start,
    stop,
  }
}

export default createResultSync
