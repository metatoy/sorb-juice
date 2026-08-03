// Sorb MCP — P3.2 entitlement gate (pure; no SDK, no db, no network).
//
// Maps a hosted session's key SCOPE + the org's EFFECTIVE entitlements to the
// allowed tool set, and produces the structured error for a blocked write call.
// The 7 read tools are always free; the 3 write tools require a write-scoped
// (secret) key on a Team/Enterprise org with an active/trialing subscription.
//
// Defense in depth (spec/day/mcp-p3-remote-auth.md §6):
//   - allowedTools()  filters ListTools so a Free/read-only session never SEES
//     the write tools.
//   - writeGateError() re-checks on every CallTool (the real gate); read_only
//     (publishable key) is checked BEFORE the entitlement lookup.
//
// Consumes entitlements.js shapes (`{plan,status}`); the caller passes the
// result of effectiveEntitlements(getEntitlements(...)). Only the hosted path
// builds a `gate`; stdio passes none → ungated (back-compat).

/** The 3 gated write tools (mcp-smart-connect.md §5 "Write — gated"). */
export const WRITE_TOOLS = Object.freeze([
  'propose_token_change',
  'rebind_component',
  'open_pr',
])

/** @param {string} name @returns {boolean} */
export const isWriteTool = (name) => WRITE_TOOLS.includes(name)

/**
 * Does the org's effective entitlement permit writes? Team/Enterprise on an
 * active/trialing subscription. (effectiveEntitlements already degrades
 * past_due/canceled gate fields but KEEPS plan, so we also gate on status here.)
 * @param {{plan?: string, status?: string} | null | undefined} ent
 * @returns {boolean}
 */
export const writeEntitled = (ent) =>
  !!ent &&
  (ent.plan === 'team' || ent.plan === 'enterprise') &&
  (ent.status === 'active' || ent.status === 'trialing')

/**
 * Filter the advertised tool list for a session: write tools appear only for a
 * write-scoped key on a write-entitled org; otherwise read tools only.
 * @param {Array<{name:string}>} toolList
 * @param {{scope?: string, ent?: object} | null | undefined} gate
 * @returns {Array<{name:string}>}
 */
export const allowedTools = (toolList, gate) => {
  const canWrite = !!gate && gate.scope === 'write' && writeEntitled(gate.ent)
  return canWrite ? toolList : toolList.filter((t) => !isWriteTool(t.name))
}

/**
 * The structured MCP error for a blocked write CallTool, or null if allowed.
 * Mirrors the bridge's `code:'...'` shapes: `read_only` (403 analog, publishable
 * key) is checked BEFORE the entitlement lookup; otherwise `entitlement_required`
 * (402 analog) with an upgrade URL. Read tools are never blocked.
 * @param {string} toolName
 * @param {{scope?: string, ent?: object, upgradeUrl?: string} | null | undefined} gate
 * @returns {{error:string, code:string, upgradeUrl?:string} | null}
 */
export const writeGateError = (toolName, gate) => {
  if (!isWriteTool(toolName)) return null
  if (!gate || gate.scope !== 'write') {
    return { error: 'Publishable keys are read-only', code: 'read_only' }
  }
  if (!writeEntitled(gate.ent)) {
    return {
      error: 'Write tools require the Team plan',
      code: 'entitlement_required',
      upgradeUrl: gate.upgradeUrl || '/billing',
    }
  }
  return null
}
