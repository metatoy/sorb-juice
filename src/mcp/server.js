// Sorb MCP — Phase 0 stdio server (roadmap §3, spec/day/mcp-smart-connect.md §6).
//
// A stdio Model Context Protocol server that exposes the running app's resolved
// tokens + component bindings (read-only in P0/P1) to any MCP-capable agent
// (Claude Code, Cursor, Copilot). It uses the LOW-LEVEL `@modelcontextprotocol/sdk`
// `Server` + `setRequestHandler` API (no zod, no `McpServer.tool()`); the tool
// surface is defined in the sibling `./tools` module.
//
// REQUIRES `@modelcontextprotocol/sdk` to be installed. Agents do not install
// deps — adding the dependency and booting (`sorb mcp`) is a human/CI step.
// `node --check` on this file passes without the SDK present (syntax-only).

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { tools } from './tools.js'
import { liveTools } from './liveTools.js'
import { allowedTools, writeGateError } from './entitlementGate.js'

// LIVE-app reads (liveTools.js, roadmap §3 "sees the running app") are offered
// ONLY in local/stdio mode. They query the bridge UNAUTHENTICATED, so in the
// hosted multi-tenant path (where a `gate` is present) they're withheld to avoid
// cross-tenant/401 ambiguity — hosted live-reads need a separate auth-forwarded
// design. Local stdio (no gate) = the dev's own running app, no auth: safe.

/**
 * Build a Sorb MCP low-level `Server` with the `ListTools` + `CallTool`
 * handlers registered over `tools`, and RETURN it (NOT connected to any
 * transport). This is the single registration site shared by the stdio path
 * ({@link startMcpServer}) and the hosted HTTP/SSE path
 * (`./httpServer.js`) — both bind a transport to the result, so the tool
 * surface + write-safety can't drift between modes.
 *
 * `ctx` is forwarded verbatim to each tool handler as its second arg (the same
 * shape stdio has always passed: `{ dir, bridge, github }`). In hosted mode the
 * ctx additionally carries the tenant scope (`{ orgId, projectId, namespace,
 * scope }`) resolved from the session's API key — but this layer is
 * plus a P3.2 `gate` ({scope, ent, upgradeUrl}). Read tools are always
 * available; the 3 write tools are filtered from `ListTools` + rejected at
 * `CallTool` unless `gate` permits. stdio passes no `gate` → all tools.
 *
 * @param {{ dir?: string, bridge?: string, github?: {owner:string,repo:string,pat:string,tokenPath:string}, [k:string]: any }} [ctx]
 *   The tool-handler context. `dir` is the project dir / snapshot root whose
 *   `.sorb/` the read tools consume (defaults to `process.cwd()`); `bridge` is
 *   an optional live-bridge base URL for gated write previews; `github` is
 *   optional Open-PR creds. Hosted ctx adds tenant fields (passed through).
 * @returns {import('@modelcontextprotocol/sdk/server/index.js').Server} The
 *   configured (but un-connected) low-level MCP server.
 */
export const buildMcpServer = (ctx = {}) => {
  const { dir = process.cwd(), bridge, github, gate } = ctx
  const server = new Server(
    { name: 'sorb-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  // P3.2 entitlement gate: in hosted mode `ctx.gate` ({scope, ent, upgradeUrl})
  // filters the advertised set so a Free/read-only session never SEES the write
  // tools. stdio (no gate) advertises all tools — back-compat.
  // Local stdio advertises static + live reads + writes; hosted advertises the
  // write-gated static set only (live tools withheld — see the import note).
  const advertised = gate ? allowedTools(tools, gate) : [...tools, ...liveTools]
  // CallTool looks up in the full *callable* set so a write tool a read-only
  // session can't see still resolves to the structured `read_only` error (not
  // "Unknown tool"); live tools are callable only when ungated (stdio).
  const callable = gate ? tools : [...tools, ...liveTools]

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: advertised.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = callable.find((t) => t.name === req.params.name)
    if (!tool) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `Unknown tool: ${req.params.name}` },
        ],
      }
    }
    // P3.2 re-check on every call (the real gate): a write tool without the
    // entitlement/scope returns a structured error and NEVER reaches the handler.
    if (gate) {
      const gErr = writeGateError(req.params.name, gate)
      if (gErr) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(gErr) }] }
      }
    }
    try {
      const result = await tool.handler(req.params.arguments || {}, { dir, bridge, github })
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (e) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${e && e.message}` }],
      }
    }
  })

  return server
}

/**
 * Start the Sorb MCP stdio server.
 *
 * Thin wrapper over {@link buildMcpServer}: builds the shared server, then
 * connects a `StdioServerTransport`. stdio behavior is byte-for-byte identical
 * to before the shared-registration refactor (back-compat is sacred).
 *
 * @param {{ dir?: string, bridge?: string, github?: {owner:string,repo:string,pat:string,tokenPath:string} }} [opts]
 *   `dir` is the project dir whose `.sorb/` is read by the tool handlers
 *   (defaults to `process.cwd()`); `bridge` is an optional live-bridge base URL
 *   for gated write previews; `github` is optional Open-PR creds. Read tools
 *   work with zero write-config.
 * @returns {Promise<import('@modelcontextprotocol/sdk/server/index.js').Server>}
 */
export const startMcpServer = async ({ dir = process.cwd(), bridge, github } = {}) => {
  const server = buildMcpServer({ dir, bridge, github })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return server
}
