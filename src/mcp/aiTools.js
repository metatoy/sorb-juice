// @ts-check
/**
 * Portable MCP AI-tools module for sorb-juice (`@sorb/juice`).
 *
 * This module is SELF-CONTAINED. It defines a set of MCP tools that proxy the
 * hosted Sorb cloud's AI endpoints (the Wave-1/2/3 features built in
 * `sorb-cloud`). It imports nothing repo-specific — only global `fetch` — so it
 * can be dropped onto whichever branch carries the MCP server core and wired in
 * without edits.
 *
 * ## How to register (when the MCP core lands on main)
 *
 * The MCP server builds an array of `McpTool`s and an entitlement gate that
 * gates write tools to Team/Enterprise plans. To enable these AI tools:
 *
 * ```js
 * import { aiTools, AI_WRITE_TOOLS } from './aiTools.js'
 *
 * // 1. Register the tool definitions:
 * tools.push(...aiTools)
 *
 * // 2. Merge the write-tool names into the entitlement gate's WRITE_TOOLS so
 * //    the apply_* tools are gated to Team/Enterprise:
 * const WRITE_TOOLS = Object.freeze([...EXISTING_WRITE_TOOLS, ...AI_WRITE_TOOLS])
 * ```
 *
 * The MCP passes each handler `(args, ctx)`. The existing `ctx` is
 * `{ dir, bridge, github }`; this module reads one ADDITIVE field:
 * `ctx.cloud = { baseUrl, key }` — the hosted Sorb cloud base URL plus the
 * caller's API key. When `ctx.cloud` is absent, every tool returns a clear
 * "cloud not configured" message instead of throwing (mirroring how the
 * existing `open_pr` tool returns a creds-needed message rather than failing).
 *
 * ## DEPLOY-GATED caveat
 *
 * These tools are inert until the Sorb cloud is deployed and reachable at
 * `ctx.cloud.baseUrl`. With no cloud configured they return a structured
 * `cloud_not_configured` result; with a cloud configured but unreachable they
 * return `cloud_unreachable`. They never fabricate AI output — the cloud does
 * all of the AI work; this module only forwards args + auth and returns the
 * cloud's JSON verbatim (or an honest error).
 *
 * @typedef {Object} CloudConfig
 * @property {string} baseUrl  Base URL of the hosted Sorb cloud (no trailing slash needed).
 * @property {string} key      The caller's API key, forwarded as `Authorization: Bearer <key>`.
 *
 * @typedef {Object} McpCtx
 * @property {string} [dir]
 * @property {Object} [bridge]
 * @property {Object} [github]
 * @property {CloudConfig} [cloud]
 *
 * @typedef {Object} McpTool
 * @property {string} name
 * @property {string} description
 * @property {Object} inputSchema  JSON Schema for the tool args.
 * @property {(args: Object, ctx: McpCtx) => Promise<any>} handler
 */

/**
 * POST a JSON body to the hosted Sorb cloud and return the parsed result.
 *
 * Honest by construction:
 *  - No `ctx.cloud` → returns `cloud_not_configured` WITHOUT calling fetch.
 *  - Non-2xx → surfaces the cloud's `{ error, code }` (e.g. a 402
 *    `ai-cap-exceeded` / `plan_upgrade_required`) plus the HTTP `status`.
 *    Never fabricates success.
 *  - Network failure → `cloud_unreachable`.
 *
 * Never throws. Never logs or returns the API key.
 *
 * @param {McpCtx} ctx
 * @param {string} path  Endpoint path beginning with `/` (e.g. `/api/ai/a11y/scan`).
 * @param {Object} body  JSON-serializable request body.
 * @returns {Promise<any>} The cloud's JSON response, or a structured error object.
 */
async function callCloud(ctx, path, body) {
  if (!ctx || !ctx.cloud) {
    return {
      error: 'cloud not configured',
      code: 'cloud_not_configured',
      hint: 'pass --cloud-url/--cloud-key (or set the hosted session) to use AI tools',
    }
  }

  const url = `${ctx.cloud.baseUrl}${path}`
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.cloud.key}`,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    return {
      error: `cloud unreachable: ${e && e.message ? e.message : 'network error'}`,
      code: 'cloud_unreachable',
    }
  }

  // Parse the body once; tolerate non-JSON error pages.
  let data
  try {
    data = await res.json()
  } catch (e) {
    data = null
  }

  if (!res.ok) {
    return {
      error: (data && data.error) || `cloud request failed (HTTP ${res.status})`,
      code: (data && data.code) || 'cloud_error',
      status: res.status,
    }
  }

  return data
}

/**
 * Returns a structured invalid-args error (never thrown), listing what's missing.
 * @param {string} message
 * @returns {{ error: string, code: 'invalid_args' }}
 */
const invalidArgs = (message) => ({ error: message, code: 'invalid_args' })

/**
 * Validates that `accept` is a non-empty array. The apply tools NEVER invent
 * an accept[] — the caller must pass the explicitly-reviewed changes.
 * @param {unknown} accept
 * @returns {boolean}
 */
const hasAccept = (accept) => Array.isArray(accept) && accept.length > 0

// ---------------------------------------------------------------------------
// READ-ish tools — propose / analyze. They return PROPOSALS only; nothing is
// applied. Each runs against the user's OWN running-app token + binding data
// via the hosted Sorb cloud.
// ---------------------------------------------------------------------------

/** @type {McpTool} */
const explainBlastRadius = {
  name: 'explain_blast_radius',
  description:
    "Explain the blast radius of a single token in YOUR project: which token sets, " +
    "components, and running-app bindings depend on it, with a plain-language narrative. " +
    "Runs against your own data via the hosted Sorb cloud. READ-ONLY — returns an analysis, " +
    "applies no change.",
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'The Sorb cloud project id.' },
      tokenId: { type: 'string', description: 'The token whose blast radius to explain.' },
    },
    required: ['projectId', 'tokenId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args || !args.projectId || !args.tokenId) {
      return invalidArgs('explain_blast_radius requires `projectId` and `tokenId`')
    }
    return callCloud(ctx, '/api/ai/explainers/blast', {
      projectId: args.projectId,
      tokenId: args.tokenId,
    })
  },
}

/** @type {McpTool} */
const explainDrift = {
  name: 'explain_drift',
  description:
    "Explain the drift between two versions of one of YOUR token sets: a structured changeset " +
    "plus a plain-language narrative of what changed and why it matters. Runs against your own " +
    "data via the hosted Sorb cloud. READ-ONLY — returns an analysis, applies no change.",
  inputSchema: {
    type: 'object',
    properties: {
      setId: { type: 'string', description: 'The token-set id to diff.' },
      fromVersion: { type: 'string', description: 'Baseline version.' },
      toVersion: { type: 'string', description: 'Target version.' },
    },
    required: ['setId', 'fromVersion', 'toVersion'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args || !args.setId || !args.fromVersion || !args.toVersion) {
      return invalidArgs('explain_drift requires `setId`, `fromVersion`, and `toVersion`')
    }
    return callCloud(ctx, '/api/ai/explainers/drift', {
      setId: args.setId,
      fromVersion: args.fromVersion,
      toVersion: args.toVersion,
    })
  },
}

/** @type {McpTool} */
const scanA11y = {
  name: 'scan_a11y',
  description:
    "Scan YOUR project's tokens for accessibility issues (e.g. WCAG contrast failures) and return " +
    "a report plus a narrative of suggested fixes. Runs against your own running-app token data via " +
    "the hosted Sorb cloud. READ-ONLY — returns a proposal; use apply_a11y_fix to write reviewed fixes.",
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'The Sorb cloud project id.' },
      setId: { type: 'string', description: 'Optional: scope the scan to one token set.' },
      targetLevel: {
        type: 'string',
        description: "Optional WCAG target level, e.g. 'AA' or 'AAA'.",
      },
    },
    required: ['projectId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args || !args.projectId) {
      return invalidArgs('scan_a11y requires `projectId`')
    }
    /** @type {Record<string, unknown>} */
    const body = { projectId: args.projectId }
    if (args.setId !== undefined) body.setId = args.setId
    if (args.targetLevel !== undefined) body.targetLevel = args.targetLevel
    return callCloud(ctx, '/api/ai/a11y/scan', body)
  },
}

/** @type {McpTool} */
const generateReskin = {
  name: 'generate_reskin',
  description:
    "Generate a reskin PROPOSAL for YOUR token set (e.g. a dark-mode variant or a new direction). " +
    "Runs against your own data via the hosted Sorb cloud. READ-ONLY — returns a proposal of token " +
    "values; nothing is applied. Use apply_reskin_variant to write a reviewed variant.",
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'The Sorb cloud project id.' },
      setId: { type: 'string', description: 'Optional: the token set to reskin.' },
      direction: {
        type: 'string',
        description: "Optional creative direction, e.g. 'dark', 'high-contrast', 'warmer'.",
      },
    },
    required: ['projectId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args || !args.projectId) {
      return invalidArgs('generate_reskin requires `projectId`')
    }
    /** @type {Record<string, unknown>} */
    const body = { projectId: args.projectId }
    if (args.setId !== undefined) body.setId = args.setId
    if (args.direction !== undefined) body.direction = args.direction
    return callCloud(ctx, '/api/ai/reskin/generate', body)
  },
}

/** @type {McpTool} */
const suggestNames = {
  name: 'suggest_names',
  description:
    "Suggest improved, consistent token names for YOUR token set, returned as a rename PROPOSAL " +
    "(currentId -> newId). Runs against your own data via the hosted Sorb cloud. READ-ONLY — nothing " +
    "is renamed. Use apply_rename to write reviewed renames.",
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'The Sorb cloud project id.' },
      setId: { type: 'string', description: 'Optional: the token set to analyze.' },
    },
    required: ['projectId'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args || !args.projectId) {
      return invalidArgs('suggest_names requires `projectId`')
    }
    /** @type {Record<string, unknown>} */
    const body = { projectId: args.projectId }
    if (args.setId !== undefined) body.setId = args.setId
    return callCloud(ctx, '/api/ai/naming/suggest', body)
  },
}

// ---------------------------------------------------------------------------
// WRITE tools — gated to Team/Enterprise via AI_WRITE_TOOLS. Each writes via
// the REVIEW path: the caller MUST pass an explicitly-reviewed `accept[]`. The
// tool never invents accept[] and never auto-applies a proposal. Empty/absent
// accept[] is rejected with invalid_args.
// ---------------------------------------------------------------------------

/** @type {McpTool} */
const applyA11yFix = {
  name: 'apply_a11y_fix',
  description:
    "WRITE (Team-gated): apply reviewed accessibility fixes to a token set, creating a NEW version. " +
    "This is the review path — you must pass the explicitly-reviewed `accept` array of " +
    "{tokenId, value} changes (typically a subset of scan_a11y's report). The tool never invents " +
    "changes and never auto-applies a scan result.",
  inputSchema: {
    type: 'object',
    properties: {
      setId: { type: 'string', description: 'The token-set id to write to.' },
      accept: {
        type: 'array',
        description: 'Explicitly-reviewed fixes to apply.',
        items: {
          type: 'object',
          properties: {
            tokenId: { type: 'string' },
            value: {},
          },
          required: ['tokenId', 'value'],
        },
        minItems: 1,
      },
    },
    required: ['setId', 'accept'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args || !args.setId) {
      return invalidArgs('apply_a11y_fix requires `setId`')
    }
    if (!hasAccept(args.accept)) {
      return invalidArgs(
        'apply_a11y_fix requires a non-empty `accept` array of reviewed {tokenId, value} changes',
      )
    }
    return callCloud(ctx, `/api/token-sets/${encodeURIComponent(args.setId)}/apply-proposal`, {
      accept: args.accept,
    })
  },
}

/** @type {McpTool} */
const applyReskinVariant = {
  name: 'apply_reskin_variant',
  description:
    "WRITE (Team-gated): apply a reviewed reskin as a new variant (e.g. a dark mode) on a token set. " +
    "This is the review path — you must pass the explicitly-reviewed `accept` array of {tokenId, value} " +
    "values plus a `variantMode`. The tool never invents changes and never auto-applies a generate_reskin proposal.",
  inputSchema: {
    type: 'object',
    properties: {
      setId: { type: 'string', description: 'The token-set id to write to.' },
      accept: {
        type: 'array',
        description: 'Explicitly-reviewed variant values to apply.',
        items: {
          type: 'object',
          properties: {
            tokenId: { type: 'string' },
            value: {},
          },
          required: ['tokenId', 'value'],
        },
        minItems: 1,
      },
      variantMode: {
        type: 'string',
        description: "The variant mode to create, e.g. 'dark'.",
      },
    },
    required: ['setId', 'accept', 'variantMode'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args || !args.setId) {
      return invalidArgs('apply_reskin_variant requires `setId`')
    }
    if (!hasAccept(args.accept)) {
      return invalidArgs(
        'apply_reskin_variant requires a non-empty `accept` array of reviewed {tokenId, value} values',
      )
    }
    if (!args.variantMode) {
      return invalidArgs('apply_reskin_variant requires `variantMode`')
    }
    return callCloud(ctx, `/api/token-sets/${encodeURIComponent(args.setId)}/apply-variant`, {
      accept: args.accept,
      variantMode: args.variantMode,
    })
  },
}

/** @type {McpTool} */
const applyRename = {
  name: 'apply_rename',
  description:
    "WRITE (Team-gated): apply reviewed token renames, creating deprecated-alias renames (old id kept " +
    "as a deprecated alias pointing at the new id). This is the review path — you must pass the " +
    "explicitly-reviewed `accept` array of {currentId, newId}. The tool never invents renames and never " +
    "auto-applies a suggest_names proposal.",
  inputSchema: {
    type: 'object',
    properties: {
      setId: { type: 'string', description: 'The token-set id to write to.' },
      accept: {
        type: 'array',
        description: 'Explicitly-reviewed renames to apply.',
        items: {
          type: 'object',
          properties: {
            currentId: { type: 'string' },
            newId: { type: 'string' },
          },
          required: ['currentId', 'newId'],
        },
        minItems: 1,
      },
    },
    required: ['setId', 'accept'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    if (!args || !args.setId) {
      return invalidArgs('apply_rename requires `setId`')
    }
    if (!hasAccept(args.accept)) {
      return invalidArgs(
        'apply_rename requires a non-empty `accept` array of reviewed {currentId, newId} renames',
      )
    }
    return callCloud(ctx, `/api/token-sets/${encodeURIComponent(args.setId)}/apply-rename`, {
      accept: args.accept,
    })
  },
}

/**
 * All 8 AI tools, ready to `tools.push(...aiTools)` once the MCP core lands.
 * @type {McpTool[]}
 */
export const aiTools = [
  explainBlastRadius,
  explainDrift,
  scanA11y,
  generateReskin,
  suggestNames,
  applyA11yFix,
  applyReskinVariant,
  applyRename,
]

/**
 * Names of this module's WRITE tools. Merge into the entitlement gate's
 * frozen WRITE_TOOLS so these are gated to Team/Enterprise.
 * @type {readonly string[]}
 */
export const AI_WRITE_TOOLS = Object.freeze([
  'apply_a11y_fix',
  'apply_reskin_variant',
  'apply_rename',
])

// Exported for unit tests that exercise the cloud transport directly.
export { callCloud }
