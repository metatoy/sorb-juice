/**
 * heatMap.js — P3 Hardcoded-value Heat Map
 *
 * Read-only diagnostic: walks computed style values and matches them against the
 * resolved token set. Flags raw values that should be tokens but aren't, with a
 * confidence score per value type.
 *
 * Read-only / diagnosis-only — no source rewrite, no auto-binding.
 *
 * @module heatMap
 */

'use strict';

/**
 * Normalise a CSS color value to a lowercase hex string for comparison,
 * handling common formats: #rrggbb, #rgb, rgb(), rgba() (opaque only).
 * Returns null if the value cannot be normalised to a comparable form.
 *
 * @param {string} v
 * @returns {string|null}
 */
function normaliseColor(v) {
  v = v.trim().toLowerCase();

  // Already hex
  const hex6 = /^#([0-9a-f]{6})$/.exec(v);
  if (hex6) return '#' + hex6[1];

  const hex3 = /^#([0-9a-f]{3})$/.exec(v);
  if (hex3) {
    const [r, g, b] = hex3[1].split('').map(c => c + c);
    return '#' + r + g + b;
  }

  // rgb(r, g, b) — opaque
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (rgb) {
    return '#' + [rgb[1], rgb[2], rgb[3]]
      .map(n => parseInt(n, 10).toString(16).padStart(2, '0'))
      .join('');
  }

  // rgba(r, g, b, a) — only normalise if fully opaque (a === 1)
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(v);
  if (rgba) {
    if (parseFloat(rgba[4]) === 1) {
      return '#' + [rgba[1], rgba[2], rgba[3]]
        .map(n => parseInt(n, 10).toString(16).padStart(2, '0'))
        .join('');
    }
    // transparent / partially transparent: return as-is for exact string match
    return v;
  }

  return null;
}

/**
 * Detect the CSS value type for confidence heuristics.
 *
 * @param {string} value
 * @returns {'hex'|'rgba'|'px'|'other'}
 */
function detectValueType(value) {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return 'hex';
  if (/^rgba?\(/.test(v)) return 'rgba';
  if (/^\d+(\.\d+)?px$/.test(v)) return 'px';
  return 'other';
}

/**
 * Confidence heuristic for a value that has no token match.
 *  - hex color → 0.9  (very likely hardcoded)
 *  - rgba       → 0.85
 *  - px         → 0.7  (border-radius / spacing / font-size shapes)
 *  - other      → 0.3
 *
 * @param {string} value
 * @returns {number}
 */
function confidenceFor(value) {
  switch (detectValueType(value)) {
    case 'hex':  return 0.9;
    case 'rgba': return 0.85;
    case 'px':   return 0.7;
    default:     return 0.3;
  }
}

/**
 * Build a normalised lookup map from resolvedTokens (cssVar → value).
 * Keys: normalised value string → cssVar (first match wins for duplicates).
 *
 * @param {Map<string, string>} resolvedTokens
 * @returns {Map<string, string>} normalisedValue → cssVar
 */
function buildTokenValueIndex(resolvedTokens) {
  /** @type {Map<string, string>} */
  const index = new Map();
  for (const [cssVar, rawValue] of resolvedTokens) {
    const norm = normaliseColor(rawValue);
    const key = norm !== null ? norm : rawValue.trim().toLowerCase();
    if (!index.has(key)) index.set(key, cssVar);
  }
  return index;
}

/**
 * Walk computed style values and match each against the resolved token set.
 *
 * @param {Map<string, string>} computedStyles  property → value (from getComputedStyle)
 * @param {Map<string, string>} resolvedTokens  cssVar → value (from resolved.json)
 * @returns {{
 *   hardcoded: Array<{property: string, value: string, confidence: number}>,
 *   tokenized: Array<{property: string, value: string, cssVar: string}>
 * }}
 */
export function matchHardcoded(computedStyles, resolvedTokens) {
  const index = buildTokenValueIndex(resolvedTokens);

  /** @type {Array<{property: string, value: string, confidence: number}>} */
  const hardcoded = [];
  /** @type {Array<{property: string, value: string, cssVar: string}>} */
  const tokenized = [];

  for (const [property, rawValue] of computedStyles) {
    const norm = normaliseColor(rawValue);
    const lookupKey = norm !== null ? norm : rawValue.trim().toLowerCase();

    if (index.has(lookupKey)) {
      tokenized.push({ property, value: rawValue, cssVar: index.get(lookupKey) });
    } else {
      hardcoded.push({ property, value: rawValue, confidence: confidenceFor(rawValue) });
    }
  }

  return { hardcoded, tokenized };
}

/**
 * Score a hardcoded array into a summary heat map object.
 *
 * @param {Array<{property: string, value: string, confidence: number}>} hardcoded
 * @returns {{
 *   heatScore: number,
 *   highConfidence: Array<{property: string, value: string, confidence: number}>,
 *   verdict: 'actionable'|'sparse'
 * }}
 */
export function scoreHeatMap(hardcoded) {
  if (hardcoded.length === 0) {
    return { heatScore: 0, highConfidence: [], verdict: 'sparse' };
  }

  const heatScore = hardcoded.reduce((sum, h) => sum + h.confidence, 0) / hardcoded.length;
  const highConfidence = hardcoded.filter(h => h.confidence > 0.7);
  const verdict = highConfidence.length > 0 ? 'actionable' : 'sparse';

  return { heatScore, highConfidence, verdict };
}
