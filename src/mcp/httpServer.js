// Sorb MCP — P3.0 (transport) + P3.1 (auth + tenant scoping) hosted endpoint.
//
// A hosted HTTP/SSE MCP endpoint that reuses the SAME low-level `Server` + tool
// registration as the stdio path (`buildMcpServer` from `./server.js`) — no new
// tools, no change to write-safety. Each connection is authed with a cloud API
// key (`resolveApiKey` from `../auth.js`) and bound to that key's tenant
// (org/project) via `buildSessionCtx` (from `./remoteAuth.js`), so every tool
// call inherits the tenant scope with no per-call re-auth of the request body.
//
// SCOPE: P3.0 (transport) + P3.1 (auth/tenant scoping) + P3.2 (entitlement gate).
// The session's effective entitlement + key scope are resolved per connection and
// attached as `ctx.gate`: Free / read-only (publishable) keys see only the 7 read
// tools; the 3 write tools require a write-scoped key on a Team/Enterprise org
// (else read_only / entitlement_required). Write tools still return a preview/PR
// reference and never auto-apply (write-safety unchanged). P3.3 (cloud
// productization: dashboard connect URL/docs, snapshot→cloud-token-store) is held.
//
// HOSTED-ONLY (mirrors the bridge's hosted-iff-DATABASE_URL rule, INFRA.md §8):
// the remote transport refuses to start without a `db` handle (no DATABASE_URL).
// The local stdio path (`sorb mcp`) is entirely unaffected.
//
// REQUIRES `@modelcontextprotocol/sdk` to be installed. Agents do not install
// deps — adding the dependency and a live boot is a human/CI step. `node --check`
// on this file passes without the SDK present (the import is unresolved at
// syntax-check time, which is expected/fine).

import { createServer as createHttpServer } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { resolveApiKey } from '../auth.js'
import { getEntitlements, effectiveEntitlements } from '../entitlements.js'
import { buildSessionCtx } from './remoteAuth.js'
import { buildMcpServer } from './server.js'

/** The streamable-HTTP MCP path (primary). */
const MCP_PATH = '/mcp'
/** The SSE compatibility path for older clients (best-effort fallback). */
const SSE_PATH = '/mcp/sse'

/**
 * Write a JSON error response with the bridge's `{ error, code }` shape.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status HTTP status code.
 * @param {string} error Human-readable message.
 * @param {string} code Machine code (mirrors the bridge's `code:'...'` shapes).
 */
const sendError = (res, status, error, code) => {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify({ error, code })
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

/**
 * Start the hosted Sorb MCP HTTP/SSE server.
 *
 * Each request to `/mcp` (streamable-HTTP, primary) or `/mcp/sse` (SSE
 * fallback) is authed via `resolveApiKey(db, Authorization)`:
 *   - db throws → 503 `{error:'Service unavailable',code:'db_unavailable'}`
 *     (the error is NOT swallowed; fail-closed).
 *   - null (missing/malformed/invalid/revoked key) → 401
 *     `{error:'Unauthorized',code:'unauthorized'}`.
 *   - success → `buildSessionCtx(authContext,{baseDir,bridge})` resolves the
 *     tenant-scoped ctx; null ctx → 401. The ctx is then bound to a fresh
 *     `buildMcpServer(ctx)` and a transport, so the tenant scope (`dir`/
 *     `projectId`/`namespace`/`scope`) comes ONLY from the session — never from
 *     tool input (the isolation boundary).
 *
 * @param {{ db: import('../types.js').DbHandle | null, config?: { bridgeUrl?: string } | null, baseDir: string, port: number }} opts
 *   `db` is the Postgres handle (null in local mode — refuses to start);
 *   `config.bridgeUrl` is the optional live-bridge base URL passed to ctx;
 *   `baseDir` is the per-project snapshot root (one `.sorb/` dir per projectId);
 *   `port` is the listen port.
 * @returns {Promise<import('node:http').Server>} The listening HTTP server.
 */
export const startMcpHttpServer = async ({ db, config, baseDir, port }) => {
  // HOSTED-ONLY: the remote transport is the hosted path. Without a db handle
  // (no DATABASE_URL) there is no tenant store to scope against, so refuse to
  // start — the local stdio path (`sorb mcp`) is the supported db-less mode.
  if (!db) {
    throw new Error(
      'Refusing to start hosted MCP transport: no DATABASE_URL (db handle is null). ' +
        'The remote MCP endpoint is hosted-only; use `sorb mcp` (stdio) for local mode.',
    )
  }

  const bridge = config && config.bridgeUrl

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = req.url || ''
      const path = url.split('?')[0]
      const isSse = path === SSE_PATH
      const isMcp = path === MCP_PATH

      if (!isSse && !isMcp) {
        sendError(res, 404, 'Not found', 'not_found')
        return
      }

      // ── P3.1 auth ──────────────────────────────────────────────────────────
      // Resolve the cloud API key. db errors propagate (caught below → 503);
      // a null result means missing/malformed/invalid/revoked → 401.
      let authContext
      try {
        authContext = await resolveApiKey(db, req.headers && req.headers.authorization)
      } catch (e) {
        // db unreachable / query failed — fail closed (don't swallow).
        sendError(res, 503, 'Service unavailable', 'db_unavailable')
        return
      }
      if (!authContext) {
        sendError(res, 401, 'Unauthorized', 'unauthorized')
        return
      }

      // ── P3.1 tenant scoping ─────────────────────────────────────────────────
      // ctx (dir/projectId/namespace/scope/...) is derived ONLY from the authed
      // session — never from tool input. Sibling-owned `buildSessionCtx`.
      const ctx = buildSessionCtx(authContext, { baseDir, bridge })
      if (!ctx) {
        sendError(res, 401, 'Unauthorized', 'unauthorized')
        return
      }

      // ── P3.2 entitlement gate ────────────────────────────────────────────────
      // Resolve the org's effective entitlement (degrades past_due/canceled) and
      // attach a `gate` to the session ctx: Free/read-only keys see only the 7
      // read tools; write tools require a write-scoped key on a Team/Enterprise
      // org. db errors fail closed → 503 (never silently unlock paid gates).
      let ent
      try {
        ent = effectiveEntitlements(await getEntitlements(db, ctx.orgId))
      } catch (e) {
        sendError(res, 503, 'Service unavailable', 'db_unavailable')
        return
      }
      const upgradeUrl =
        (config && config.upgradeUrl) || process.env.SORB_UPGRADE_URL || '/billing'
      const gatedCtx = { ...ctx, gate: { scope: ctx.scope, ent, upgradeUrl } }

      // ── P3.0 transport ──────────────────────────────────────────────────────
      // One MCP session per authed connection: a fresh server bound to this
      // tenant's gated ctx, so every tool call inherits the scope + entitlement.
      const server = buildMcpServer(gatedCtx)

      if (isSse) {
        // SSE fallback for older clients (best-effort). The transport manages
        // the SSE stream + the companion POST channel itself.
        const transport = new SSEServerTransport(SSE_PATH, res)
        await server.connect(transport)
        return
      }

      // Primary: streamable-HTTP. Stateless per-connection session (ctx is bound
      // at connect), so no server-side session id store is needed here.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (e) {
      // Last-resort guard so a transport/handler throw never leaks an open
      // socket without a response.
      sendError(res, 500, 'Internal error', 'internal_error')
    }
  })

  await new Promise((resolveListen) => {
    httpServer.listen(port, '0.0.0.0', () => resolveListen(undefined))
  })

  return httpServer
}
