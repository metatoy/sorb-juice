// tools.js — the 7 read-only MCP tool definitions (day-spec §5, "Read (Phase 1)").
//
// Plain data only: each tool is `{ name, description, inputSchema, handler }`,
// where `inputSchema` is a vanilla JSON Schema object and `handler` is an async
// fn `(args, { dir }) => result` that forwards to the matching `sorbData`
// accessor. NO MCP SDK import here — server.js (Worker B) wraps these into the
// SDK's registration calls. Keeping the SDK out means these definitions stay
// trivially unit-testable and transport-agnostic.

import {
  listTokens,
  getToken,
  resolveValue,
  listComponents,
  getComponentBindings,
  findTokenUsages,
  findComponentsByToken,
} from './sorbData.js'
import {
  buildTokenChangeset,
  buildRebindProposal,
} from './writeOps.js'
import { openTokenPR } from '../github.js'

/**
 * @typedef {Object} McpCtx
 * @property {string} dir  Project dir whose `.sorb/` is read.
 * @property {string} [bridge]  Optional live bridge base URL for previews.
 * @property {{owner:string,repo:string,pat:string,tokenPath:string}} [github]  Optional Open-PR creds.
 */

/**
 * @typedef {Object} McpTool
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema  JSON Schema for the tool's args.
 * @property {(args: object, ctx: McpCtx) => Promise<any>} handler
 */

/** @type {McpTool[]} */
export const tools = [
  {
    name: 'list_tokens',
    description:
      'List the running app\'s resolved design tokens, optionally filtered by tier (component/semantic/primitive), DTCG type, and a substring query over id/cssVar/value.',
    inputSchema: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: ['component', 'semantic', 'primitive'],
          description: 'Only tokens in this taxonomy tier.',
        },
        type: {
          type: 'string',
          description: 'Only tokens of this DTCG $type (e.g. color, dimension).',
        },
        q: {
          type: 'string',
          description: 'Case-insensitive substring match against id, cssVar, or value.',
        },
      },
    },
    handler: async (args, { dir }) =>
      listTokens(dir, { tier: args.tier, type: args.type, q: args.q }),
  },

  {
    name: 'get_token',
    description:
      'Get a single resolved token by its dotted id, together with the component/story ids that bind it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Dotted token id, e.g. button.primary.bg.default.' },
      },
      required: ['id'],
    },
    handler: async (args, { dir }) => getToken(dir, args.id),
  },

  {
    name: 'resolve_value',
    description:
      'Resolve the value a token renders as in the running app, looked up by token id or by CSS custom property (cssVar).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Dotted token id to resolve.' },
        cssVar: { type: 'string', description: 'CSS custom property to resolve, e.g. --color-action-primary.' },
      },
    },
    handler: async (args, { dir }) => resolveValue(dir, { id: args.id, cssVar: args.cssVar }),
  },

  {
    name: 'list_components',
    description:
      'List the captured components/stories in the project, each with the relative path to its captured artifact.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args, { dir }) => listComponents(dir),
  },

  {
    name: 'get_component_bindings',
    description:
      'Get a component\'s role→token bindings (and candidate alternatives) merged across every node in its captured artifact tree.',
    inputSchema: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: 'Story/component id from list_components.' },
      },
      required: ['componentId'],
    },
    handler: async (args, { dir }) => getComponentBindings(dir, args.componentId),
  },

  {
    name: 'find_token_usages',
    description:
      'Find which components bind a given token id, and on which roles (fill/stroke/cornerRadius/effectN).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Token id to search bindings for.' },
      },
      required: ['id'],
    },
    handler: async (args, { dir }) => findTokenUsages(dir, args.id),
  },

  {
    name: 'find_components_by_token',
    description:
      'Find which components render a given CSS custom property (cssVar), resolving the cssVar to its token id first.',
    inputSchema: {
      type: 'object',
      properties: {
        cssVar: { type: 'string', description: 'CSS custom property, e.g. --color-action-primary.' },
      },
      required: ['cssVar'],
    },
    handler: async (args, { dir }) => findComponentsByToken(dir, args.cssVar),
  },

  // ─── Write — GATED (day-spec §5 "Write — gated", §6 Phase 2) ──────────────
  // Every write tool returns a PROPOSAL / preview ref / PR url. Applying is a
  // separate human action (accept the preview, MERGE the PR). NEVER auto-apply.
  // Handlers degrade gracefully (return `{ error }`) when bridge/github absent.

  {
    name: 'propose_token_change',
    description:
      'GATED, proposal-only: compute the changeset + blast-radius for setting a token to a new value, and (with --bridge) open a live preview session. Does NOT apply — accept the preview or open a PR to apply.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Dotted token id to change, e.g. button.primary.bg.default.' },
        newValue: { type: 'string', description: 'Proposed new value for the token.' },
      },
      required: ['id', 'newValue'],
    },
    handler: async (args, ctx) => {
      const cs = buildTokenChangeset(ctx.dir, { id: args.id, newValue: args.newValue })
      const change = {
        id: cs.id,
        cssVar: cs.cssVar,
        oldValue: cs.oldValue,
        newValue: cs.newValue,
        type: cs.type,
        tier: cs.tier,
      }

      if (!ctx.bridge) {
        return {
          change,
          blastRadius: cs.blastRadius,
          preview: null,
          note: 'Proposal only — not applied. Pass --bridge <url> to sorb mcp for a live preview, or open a PR to apply.',
        }
      }

      try {
        const res = await fetch(`${ctx.bridge}/preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cs.tokenSet),
        })
        const preview = await res.json()
        return {
          change,
          blastRadius: cs.blastRadius,
          preview: { id: preview.id, url: preview.url },
          note: 'Proposal only — not applied. Accept the preview or open a PR to apply.',
        }
      } catch (e) {
        return {
          change,
          blastRadius: cs.blastRadius,
          preview: null,
          error: `Failed to open preview on bridge ${ctx.bridge}: ${e && e.message}`,
          note: 'Proposal only — not applied. Accept the preview or open a PR to apply.',
        }
      }
    },
  },

  {
    name: 'rebind_component',
    description:
      'GATED, proposal-only: propose rebinding a component role to a different token id. Returns a binding-change proposal; does NOT apply (no network).',
    inputSchema: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: 'Story/component id from list_components.' },
        role: { type: 'string', description: 'Bound role to rebind, e.g. fill/stroke/cornerRadius.' },
        tokenId: { type: 'string', description: 'Token id to bind the role to.' },
      },
      required: ['componentId', 'role', 'tokenId'],
    },
    handler: async (args, ctx) => ({
      ...buildRebindProposal(ctx.dir, {
        componentId: args.componentId,
        role: args.role,
        tokenId: args.tokenId,
      }),
      note: 'Proposal only — not applied.',
    }),
  },

  {
    name: 'open_pr',
    description:
      'GATED: open a GitHub PR with a proposed token change (reuses Sorb Open-PR flow). Requires GitHub creds passed to `sorb mcp`. Returns the PR url; review + MERGE is the human step — nothing auto-applies.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Dotted token id to change.' },
        newValue: { type: 'string', description: 'Proposed new value for the token.' },
        title: { type: 'string', description: 'PR / commit title.' },
      },
      required: ['id', 'newValue'],
    },
    handler: async (args, ctx) => {
      if (!ctx.github || !ctx.github.owner || !ctx.github.repo || !ctx.github.pat) {
        return {
          error:
            'open_pr needs GitHub creds: pass --gh-owner/--gh-repo/--gh-pat/--gh-token-path to `sorb mcp`.',
        }
      }
      try {
        const cs = buildTokenChangeset(ctx.dir, { id: args.id, newValue: args.newValue })
        const content = JSON.stringify(cs.tokenSet, null, 2)
        const prUrl = await openTokenPR({
          owner: ctx.github.owner,
          repo: ctx.github.repo,
          pat: ctx.github.pat,
          tokenPath: ctx.github.tokenPath,
          content,
          message: args.title || 'Sorb: propose token change',
        })
        return {
          prUrl,
          note: 'PR opened — review + MERGE is the human step; nothing auto-applied.',
        }
      } catch (e) {
        return { error: `Failed to open PR: ${e && e.message}` }
      }
    },
  },
]
