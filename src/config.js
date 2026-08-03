// 12-factor environment config loader for @sorb/juice.
//
// Pure module: reads process.env and returns a frozen config object with safe
// local defaults so the FREE local bridge runs with ZERO new env and ZERO new
// deps. NO Redis/Postgres imports here — this module only decides *whether*
// hosted backends are configured (via redisUrl / databaseUrl presence) so the
// store factory and /ready can pick which checks to run.
//
// JavaScript only (JSDoc types). See src/types.js for the Config typedef.

/**
 * Canonical default values for every env var the bridge understands.
 * These reproduce today's single-process behavior exactly (port 7777,
 * in-memory store, 24h TTL, hourly prune, open CORS).
 * @type {{
 *   PORT: number,
 *   SORB_NAMESPACE: string,
 *   REDIS_URL: undefined,
 *   DATABASE_URL: undefined,
 *   CORS_ORIGINS: '*',
 *   PREVIEW_TTL_MS: number,
 *   PRUNE_INTERVAL_MS: number,
 *   NODE_ENV: string,
 *   SORB_ENTERPRISE_FEED: undefined,
 * }}
 */
export const DEFAULTS = Object.freeze({
  PORT: 7777,
  SORB_NAMESPACE: 'sorb-local',
  REDIS_URL: undefined,
  DATABASE_URL: undefined,
  CORS_ORIGINS: '*', // open by default = free local mode
  PREVIEW_TTL_MS: 86_400_000, // 24h — preserves today's preview/verify lifetime
  PRUNE_INTERVAL_MS: 3_600_000, // 1h — preserves today's in-memory prune cadence
  NODE_ENV: 'development',
  // E5 continuous conformance-EVIDENCE feed: DARK by default. Unset ⇒ the feed
  // surface is fully dormant (nothing recorded, no feed endpoint answers, no
  // delivery). See src/enterprise/evidenceFeed.js for the three hard gates that
  // must ALL clear before this is ever set on a deployed environment.
  SORB_ENTERPRISE_FEED: undefined,
})

/**
 * Parse a positive integer from an env string, falling back to `fallback`
 * when the value is missing, empty, or not a finite positive number.
 * @param {string | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
const intOr = (raw, fallback) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = Number.parseInt(String(raw), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Coerce an env value to a trimmed non-empty string, or `undefined`.
 * @param {string | undefined} raw
 * @returns {string | undefined}
 */
const strOrUndef = (raw) => {
  if (raw === undefined || raw === null) return undefined
  const s = String(raw).trim()
  return s === '' ? undefined : s
}

/**
 * Parse CORS_ORIGINS. Empty/unset → '*' (today's open default). Otherwise a
 * comma-separated list becomes a de-duped array of trimmed origins. A literal
 * '*' (alone or among entries) collapses back to '*'.
 * @param {string | undefined} raw
 * @returns {string[] | '*'}
 */
const parseCorsOrigins = (raw) => {
  const s = strOrUndef(raw)
  if (s === undefined) return '*'
  const parts = s
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')
  if (parts.length === 0 || parts.includes('*')) return '*'
  return Array.from(new Set(parts))
}

/**
 * Load the bridge configuration from `env` (defaults to process.env), applying
 * the safe local defaults from {@link DEFAULTS}. The result is deeply frozen so
 * downstream units (store, db, server) can treat it as immutable.
 *
 * Local mode (no REDIS_URL / DATABASE_URL) yields:
 *   { redisUrl: undefined, databaseUrl: undefined, hosted: false, ... }
 * which keeps the in-memory store + no-DB path active.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment source. Defaults to process.env.
 * @returns {import('./types').Config}
 */
export const loadConfig = (env = process.env) => {
  const redisUrl = strOrUndef(env.REDIS_URL)
  const databaseUrl = strOrUndef(env.DATABASE_URL)

  // E5 dark-feed switch. Only the exact opt-in tokens flip it on; anything else
  // (including unset) leaves the continuous conformance-EVIDENCE feed dormant.
  const enterpriseFeedEnabled = ((v) =>
    v === '1' || v === 'true' || v === 'on' || v === 'yes')(
    String(env.SORB_ENTERPRISE_FEED ?? '').trim().toLowerCase(),
  )

  /** @type {import('./types').Config} */
  const config = {
    port: intOr(env.PORT, DEFAULTS.PORT),
    namespace: strOrUndef(env.SORB_NAMESPACE) ?? DEFAULTS.SORB_NAMESPACE,

    // Presence of these URLs is the switch that activates each hosted backend.
    redisUrl,
    databaseUrl,

    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    previewTtlMs: intOr(env.PREVIEW_TTL_MS, DEFAULTS.PREVIEW_TTL_MS),
    pruneIntervalMs: intOr(env.PRUNE_INTERVAL_MS, DEFAULTS.PRUNE_INTERVAL_MS),
    nodeEnv: strOrUndef(env.NODE_ENV) ?? DEFAULTS.NODE_ENV,

    // Convenience flags so the store factory + /ready don't re-derive presence.
    redisEnabled: redisUrl !== undefined,
    databaseEnabled: databaseUrl !== undefined,
    hosted: redisUrl !== undefined || databaseUrl !== undefined,

    // E5 (HELD/DARK): continuous conformance-EVIDENCE feed exposure. Default
    // false ⇒ dormant. Gated by three hard human gates (E&O+Cyber · GA-ToS ·
    // SOC 2) — never flip on a deployed env until all clear.
    enterpriseFeedEnabled,
  }

  return Object.freeze(config)
}

export default loadConfig
