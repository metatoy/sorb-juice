/**
 * probe.js — tiny reachability probe used by `sorb handshake` to warn the
 * developer (never to substitute values) when the invite points at something
 * that isn't actually running.
 */

/**
 * True when `url` answers an HTTP GET within `timeoutMs`. Any response counts
 * (including 4xx/5xx — something is listening); never throws.
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function probeUrl(url, timeoutMs = 2500) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    await fetch(url, { signal: ctrl.signal, redirect: 'manual' })
    return true
  } catch (e) {
    return false
  } finally {
    clearTimeout(t)
  }
}
