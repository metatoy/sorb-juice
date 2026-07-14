// ─── handshake token codec ──────────────────────────────────────────────────
// The Sorb "handshake" is a self-contained invite a developer generates and a
// designer pastes into the Figma plugin. It carries everything the plugin needs
// to auto-configure — no cloud round-trip, no account. See the canonical format
// in spec/sorb/gfp/part8-p0-design.md §1.
//
// Payload shape (compact JSON, then base64url):
//   { v:1, origin, appUrl, gh, pk, projectId?, namespace?, exp? }
//
// This module is intentionally tiny + dependency-free so the same logic can be
// inlined UI-side in sorb-canopy (which has no bundler). Uses only Node globals
// (`Buffer`) — `base64url` support requires Node 16+ (we target Node 20).

/** The `sorb://handshake/` deep-link prefix wrapping a raw base64url blob. */
export const HANDSHAKE_PREFIX = 'sorb://handshake/'

/**
 * Encode a handshake payload object to a URL-safe base64url blob (no prefix).
 * @param {object} obj The payload ({ v, origin, appUrl, gh, pk, ... }).
 * @returns {string} base64url of the compact JSON (RFC 4648 §5, no padding).
 */
export const encodeHandshake = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString('base64url')

/**
 * Decode a handshake — accepts either a raw base64url blob OR a full
 * `sorb://handshake/<blob>` deep link (the prefix is stripped before decoding).
 * @param {string} str The blob or `sorb://handshake/<blob>` link.
 * @returns {object} The parsed payload object.
 * @throws {Error} If the input is not a string, or not valid base64url JSON.
 */
export const decodeHandshake = (str) => {
  if (typeof str !== 'string') {
    throw new Error('handshake must be a string')
  }
  let blob = str.trim()
  if (blob.startsWith(HANDSHAKE_PREFIX)) {
    blob = blob.slice(HANDSHAKE_PREFIX.length)
  }
  // Buffer.from(..., 'base64url') tolerates missing padding and the URL-safe
  // alphabet, so decode is the exact inverse of encodeHandshake.
  const json = Buffer.from(blob, 'base64url').toString('utf-8')
  return JSON.parse(json)
}

/**
 * Wrap a raw base64url blob in the `sorb://handshake/` deep link form.
 * @param {string} blob base64url blob (as returned by encodeHandshake).
 * @returns {string} `sorb://handshake/<blob>`.
 */
export const toHandshakeLink = (blob) => HANDSHAKE_PREFIX + blob
