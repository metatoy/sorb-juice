// liveTools.js — LIVE-app MCP read tools (roadmap §3 "sees the running app").
//
// Companion to tools.js (the 7 static reads + 3 gated writes). These four READ
// tools differ in ONE way that is the whole point: they answer from the RUNNING
// bridge (ctx.bridge), not the on-disk `.sorb/` snapshot — so an agent can ask
// "what is the app rendering right now?" and get live ground truth, including
// active previews. They take no write scope (always available, both modes).
//
// Same plain-data contract as tools.js: `{ name, description, inputSchema,
// handler }`, handler `(args, ctx) => result`. NO MCP SDK import — server.js
// wraps these. Every handler requires `ctx.bridge`; without it the tool fails
// loudly with an actionable message instead of silently reading the stale file.

import {
  bridgeStatus,
  listTokensLive,
  resolveValueLive,
  getActivePreview,
} from './liveData.js'

/** Friendly guard: live tools are useless without a running bridge. */
const needBridge = (ctx) => {
  if (!ctx || !ctx.bridge) {
    throw new Error(
      'This is a LIVE-app tool — it needs a running bridge. Start `sorb dev` and launch the MCP ' +
        'server with --bridge <url> (e.g. `sorb mcp --bridge http://127.0.0.1:7777`).',
    )
  }
  return ctx.bridge
}

/** @type {import('./tools.js').McpTool[]} */
export const liveTools = [
  {
    name: 'bridge_status',
    description:
      'Check whether the running app is live: queries the bridge for health + readiness and reports namespace, the number of previews active right now, and total verifications. Use this first to confirm there is a running app to inspect.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => bridgeStatus(needBridge(ctx)),
  },

  {
    name: 'list_tokens_live',
    description:
      "List the resolved design tokens the running app is serving RIGHT NOW (from the live bridge, not the on-disk snapshot), optionally filtered by tier (component/semantic/primitive), DTCG type, and a substring query over id/cssVar/value. Differs from list_tokens: reflects the app's current build, not the last committed file.",
    inputSchema: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: ['component', 'semantic', 'primitive'],
          description: 'Only tokens in this taxonomy tier.',
        },
        type: { type: 'string', description: 'Only tokens of this DTCG $type (e.g. color, dimension).' },
        q: { type: 'string', description: 'Case-insensitive substring match against id, cssVar, or value.' },
      },
    },
    handler: async (args, ctx) =>
      listTokensLive(needBridge(ctx), { tier: args.tier, type: args.type, q: args.q }),
  },

  {
    name: 'resolve_value_live',
    description:
      "Get a single token's resolved value AS THE RUNNING APP RENDERS IT NOW, by dotted id (e.g. button.primary.bg.default). Returns { id, cssVar, value, tier, type } from the live bridge. Loud if the id is absent from the live map (uncommitted/renamed, or the app is on an older build).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Dotted token id, e.g. button.primary.bg.default.' },
      },
      required: ['id'],
    },
    handler: async (args, ctx) => resolveValueLive(needBridge(ctx), args.id),
  },

  {
    name: 'get_active_preview',
    description:
      "Inspect the live override currently applied for an active preview by id: returns the { cssVar: value } map the running app is rendering for it. This is the difference between what's committed and what a designer is previewing in the app right now. Loud (not found) if the preview has expired or was never active.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Active preview id (from the bridge / PreviewBanner).' },
      },
      required: ['id'],
    },
    handler: async (args, ctx) => getActivePreview(needBridge(ctx), args.id),
  },
]
