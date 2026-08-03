// remoteAuth.js — pure tenant-scoping logic for the HOSTED MCP path.
//
// Phase 3.1 of the remote MCP endpoint (spec/day/mcp-p3-remote-auth.md §5/§6/§7).
// `auth.js` already turns an `Authorization: Bearer <key>` into a validated
// {@link AuthContext}; this module turns THAT context into the per-session MCP
// handler ctx, bound to exactly one tenant.
//
// THE ISOLATION BOUNDARY: the session's `projectId` (and therefore its `.sorb/`
// snapshot dir) is taken ONLY from the validated key's AuthContext — NEVER from
// tool arguments. A key for org A can never be steered to read/write org B's
// data by passing some other projectId in a tool call. The spec calls this the
// "hard line" (§7): the source resolver takes `projectId` from the session
// AuthContext, never from tool input.
//
// Everything here is defensive: bad / hostile input yields `null` (or `false`),
// never a throw. Pure + unit-testable — no SDK, no network, no db.
//
// JS-only per the hard rules: JSDoc typedefs, no `.ts`.

import { resolve, sep } from 'path'

/** @typedef {import('../auth.js').AuthContext} AuthContext */

/**
 * The per-session MCP handler ctx, scoped to a single tenant. Shares the shape
 * the local stdio server passes its tool handlers (`{ dir, bridge, github }`),
 * extended with the tenant identity so write-safety / entitlement gates can read
 * `orgId`/`scope` without re-auth. `github` is null in the hosted path (the
 * Open-PR creds are wired separately, not from the key).
 *
 * @typedef {Object} SessionCtx
 * @property {string} dir The INTERIM per-project `.sorb/` snapshot root (§7):
 *   `<baseDir>/<projectId>`. sorbData then reads `<dir>/.sorb/`.
 * @property {string} orgId The owning organization (from the key).
 * @property {string} projectId The tenant project (from the key) — the boundary.
 * @property {string} namespace The project namespace (from the key).
 * @property {'read' | 'write'} scope Derived key scope (from the key).
 * @property {string | undefined} bridge Optional live-bridge base URL for previews.
 * @property {null} github Always null in the hosted path.
 */

// A projects.id is a canonical lowercase v-agnostic UUID: 8-4-4-4-12 hex.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Is `id` a path-safe `projects.id` UUID?
 *
 * Accepts only the canonical 8-4-4-4-12 hex UUID shape. Rejects anything that is
 * not a string, or that contains a path separator (`/`), a parent ref (`..`), a
 * NUL byte (`\0`), or any whitespace — the path-safety screen that guards
 * {@link resolveProjectDir}. Never throws.
 *
 * @param {unknown} id The candidate project id.
 * @returns {boolean} True iff `id` is a canonical, path-safe UUID.
 */
export function isValidProjectId(id) {
  if (typeof id !== 'string') return false
  // Belt-and-braces explicit screens (the UUID regex already excludes these,
  // but spell them out so the path-safety intent is unmistakable).
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false
  if (id.includes('\0')) return false
  if (/\s/.test(id)) return false
  return UUID_RE.test(id)
}

/**
 * Resolve the INTERIM per-project `.sorb/` snapshot root for a tenant (§7):
 * `path.resolve(baseDir, projectId)`. sorbData then reads `<dir>/.sorb/`.
 *
 * Returns null when `projectId` is not a valid UUID, when `baseDir` is not a
 * usable string, or when the resolved path would escape `baseDir` — the
 * containment check mirrors `cli.js` / `sorbData.js` (`!== root && !startsWith(
 * root + sep)`). Never throws.
 *
 * @param {string} baseDir The snapshot root that holds one dir per project.
 * @param {unknown} projectId The tenant project id (validated here).
 * @returns {string | null} The project dir, or null on bad/escaping input.
 */
export function resolveProjectDir(baseDir, projectId) {
  if (typeof baseDir !== 'string' || baseDir === '') return null
  if (!isValidProjectId(projectId)) return null
  let root
  let dir
  try {
    root = resolve(baseDir)
    dir = resolve(root, /** @type {string} */ (projectId))
  } catch (e) {
    return null
  }
  // Containment: dir must be the root itself or sit strictly beneath it.
  if (dir !== root && !dir.startsWith(root + sep)) return null
  return dir
}

/**
 * Build the per-session MCP handler ctx, bound to the tenant in `authContext`.
 *
 * CRITICAL ISOLATION: `dir` and `projectId` come ONLY from `authContext` — never
 * from tool input. The resolved `dir` is the snapshot for the key's own project;
 * a tool call can pass whatever `projectId` it likes and it is ignored, because
 * this ctx (and the `dir` the tool handlers read) is fixed at session bind time
 * from the validated key.
 *
 * Returns null when `authContext` is null/falsy or when its `projectId` does not
 * resolve to a contained project dir. Never throws.
 *
 * @param {AuthContext | null | undefined} authContext The validated tenant context.
 * @param {{ baseDir: string, bridge?: string }} opts Snapshot root + optional bridge.
 * @returns {SessionCtx | null} The tenant-scoped ctx, or null.
 */
export function buildSessionCtx(authContext, opts) {
  if (!authContext) return null
  if (!opts || typeof opts !== 'object') return null
  const dir = resolveProjectDir(opts.baseDir, authContext.projectId)
  if (dir === null) return null
  return {
    dir,
    orgId: authContext.orgId,
    projectId: authContext.projectId,
    namespace: authContext.namespace,
    scope: authContext.scope,
    bridge: opts.bridge,
    github: null
  }
}
