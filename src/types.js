// Type definitions for @metatoy/sorb-juice, expressed as JSDoc typedefs.
// No runtime code — purely for editor tooling and docs.

/**
 * A flat map of token name → value.
 * @typedef {Object.<string, string | number>} TokenSet
 */

/**
 * @typedef {Object} PreviewEntry
 * @property {TokenSet} tokens
 * @property {number} createdAt
 */

/**
 * @typedef {Object} SorbCliConfig
 * @property {string} namespace
 *   Matches the namespace in your SorbProvider config.
 * @property {string[]} [tokenSources]
 *   DTCG token source files to watch (re-runs Style Dictionary on change).
 *   Preferred over `tokenPath` for the 3-tier taxonomy.
 * @property {string} [tokenPath]
 *   Legacy: path to a single flat tokens.json. If present, served at
 *   /tokens/latest; otherwise that endpoint derives a flat map from the
 *   SD-built .sorb/resolved.json. Also used as a fallback watch source.
 * @property {string} [styleDictionaryConfig]
 *   Optional path to style-dictionary config — runs build on startup + token change.
 * @property {number} [port] Port for the local server. Defaults to 7777.
 */

export {}
