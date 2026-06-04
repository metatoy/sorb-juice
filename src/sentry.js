/**
 * Sentry wrapper for the hosted bridge — ENV-GATED on SENTRY_DSN.
 *
 * NO-OP CONTRACT: with `SENTRY_DSN` unset, every export here is a no-op and the
 * SDK is never initialized (no network, no client). The free local bridge
 * (`sorb dev`) never imports this module's init path — `initSentry()` is only
 * called from the hosted `serve` command in cli.js. Importing this module is
 * itself side-effect-free; `@sentry/node` is only activated by `Sentry.init()`,
 * which we gate behind the DSN check.
 *
 * JS-ONLY repo rule applies: JSDoc typedefs, and `catch (e)` everywhere — never
 * `catch {}`.
 */

import * as Sentry from '@sentry/node'

/**
 * Module-level flag: true only after a successful gated `Sentry.init()`. Drives
 * the no-op behavior of captureError/flushSentry.
 * @type {boolean}
 */
let enabled = false

/**
 * Initialize Sentry IFF `process.env.SENTRY_DSN` is set. Idempotent: a second
 * call is a no-op once enabled. Returns whether Sentry is now active.
 *
 * @returns {boolean} true if Sentry was initialized (DSN present), else false.
 */
export const initSentry = () => {
  if (enabled) return true
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return false
  try {
    Sentry.init({
      dsn,
      environment:
        process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
      tracesSampleRate: 0,
    })
    enabled = true
  } catch (e) {
    // Never let an observability failure take down the bridge.
    enabled = false
  }
  return enabled
}

/**
 * Report an exception. NO-OP when Sentry is not enabled (DSN unset).
 *
 * @param {unknown} err the error/exception to report.
 * @param {Record<string, unknown>} [context] extra structured context (e.g.
 *   `{ at: 'auth' }`) attached as Sentry `extra`.
 * @returns {void}
 */
export const captureError = (err, context) => {
  if (!enabled) return
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined)
  } catch (e) {
    // Best-effort: a capture failure must not propagate into request handling.
  }
}

/**
 * Flush buffered events for a graceful shutdown. NO-OP when not enabled.
 *
 * @param {number} [ms] max time to wait for the flush, in milliseconds.
 * @returns {Promise<void>}
 */
export const flushSentry = async (ms) => {
  if (!enabled) return
  try {
    await Sentry.close(ms)
  } catch (e) {
    // Best-effort shutdown flush.
  }
}
