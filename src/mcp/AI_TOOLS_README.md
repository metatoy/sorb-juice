# MCP AI tools (`src/mcp/aiTools.js`)

A **portable, self-contained** module that adds AI-powered MCP tools to
sorb-juice. Each tool proxies a hosted **Sorb cloud** AI endpoint — the cloud
does all the AI work; this module only forwards args + auth and returns the
cloud's JSON (or an honest error). It imports nothing repo-specific (only global
`fetch`), so it can be wired in the moment the MCP server core lands on `main`.

## The 8 tools

### READ (propose / analyze — nothing is applied)

| Tool | Cloud endpoint | Returns |
| --- | --- | --- |
| `explain_blast_radius` | `POST /api/ai/explainers/blast` | `{topology, narrative, usage}` |
| `explain_drift` | `POST /api/ai/explainers/drift` | `{changeset, narrative, usage}` |
| `scan_a11y` | `POST /api/ai/a11y/scan` | `{report, narrative, usage}` |
| `generate_reskin` | `POST /api/ai/reskin/generate` | `{proposal, usage}` |
| `suggest_names` | `POST /api/ai/naming/suggest` | `{proposal, usage}` |

These run against the user's **own** running-app token + binding data via the
hosted cloud and return **proposals only**.

### WRITE (Team/Enterprise-gated — via the review path)

| Tool | Cloud endpoint | Body |
| --- | --- | --- |
| `apply_a11y_fix` | `POST /api/token-sets/{setId}/apply-proposal` | `{accept:[{tokenId,value}]}` |
| `apply_reskin_variant` | `POST /api/token-sets/{setId}/apply-variant` | `{accept:[{tokenId,value}], variantMode}` |
| `apply_rename` | `POST /api/token-sets/{setId}/apply-rename` | `{accept:[{currentId,newId}]}` |

Each write tool **requires an explicit, reviewed `accept[]`** that the caller
passes. The tool **never invents `accept[]`** and **never auto-applies** a
proposal — an absent/empty `accept[]` is rejected with `invalid_args`. The cloud
creates a new version / dark variant / deprecated-alias rename.

## `ctx.cloud` config

The MCP passes each handler `(args, ctx)`. This module reads one **additive**
field:

```js
ctx.cloud = {
  baseUrl: 'https://api.sorbcloud.com', // hosted Sorb cloud base URL
  key:     '...',                       // caller's API key (Bearer, never logged)
}
```

When `ctx.cloud` is **absent**, every tool returns (without calling `fetch`):

```json
{
  "error": "cloud not configured",
  "code": "cloud_not_configured",
  "hint": "pass --cloud-url/--cloud-key (or set the hosted session) to use AI tools"
}
```

The API key is forwarded only as the `Authorization: Bearer <key>` header — it is
never logged and never appears in any return value.

## Registration snippet

When the MCP server core lands on `main`:

```js
import { aiTools, AI_WRITE_TOOLS } from './mcp/aiTools.js'

// 1. Register the tool definitions:
tools.push(...aiTools)

// 2. Gate the write tools to Team/Enterprise by merging into the entitlement
//    gate's frozen WRITE_TOOLS:
const WRITE_TOOLS = Object.freeze([...EXISTING_WRITE_TOOLS, ...AI_WRITE_TOOLS])
```

## `callCloud` error contract (honest by construction)

`callCloud(ctx, path, body)` never throws and never leaks the key. It returns
either the cloud's JSON on success, or one of:

| Condition | Shape |
| --- | --- |
| No `ctx.cloud` | `{ error, code: 'cloud_not_configured', hint }` (no fetch made) |
| Non-2xx response | `{ error, code, status }` — surfaces the cloud's `{error, code}` (e.g. a 402 `ai-cap-exceeded` / `plan_upgrade_required`), with the HTTP `status` |
| Non-2xx, no parseable body | `{ error, code: 'cloud_error', status }` |
| Network failure | `{ error, code: 'cloud_unreachable' }` |
| Missing required args | `{ error, code: 'invalid_args' }` (from the handler, before `callCloud`) |

## DEPLOY-GATED note

These tools are **inert until the Sorb cloud is deployed** and reachable at
`ctx.cloud.baseUrl`. With no cloud configured they return `cloud_not_configured`;
with a cloud configured but unreachable they return `cloud_unreachable`. They
never fabricate AI output.
