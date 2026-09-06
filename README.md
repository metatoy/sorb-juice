# @sorb/juice

Sorb™ bridge server + CLI (`sorb`) — carries proposed tokens from Figma into
your running app. (Juice: the conduit.)

A dev dependency only — it never touches production.

```bash
npm install -D @sorb/juice
```

This installs the `sorb` binary into your project. To run it once
without installing first, use the full package name with npx:

```bash
npx @sorb/juice init
```

> `sorb` is the binary, not the package name. `npx sorb` only works
> after `@sorb/juice` is installed locally; otherwise npx fails
> with `could not determine executable to run`.

## Commands

Once installed, run via npx or an npm script:

```bash
sorb init          # create a sorb.config.json (idempotent — won't overwrite)
sorb dev           # start the local token bridge server (default command)
sorb dev -p 8000   # override the configured port (--port <port> also works)
sorb serve         # run the hosted bridge (config from env; no sorb.config.json) — advanced, see below
sorb commit \      # open a GitHub PR with the current token file(s)
  --owner my-org --repo my-repo --pat ghp_xxx \
  --message "Update primary color to indigo"
sorb handshake     # generate a shareable invite that auto-configures a designer's Figma plugin
sorb check         # re-run the token build and report drift/binding-mismatch/deprecation (exits non-zero — for CI)

sorb --help        # usage (works for any command)
sorb --version     # prints the installed @sorb/juice version
sorb mcp           # run the Sorb MCP server (stdio) for AI agents
```

`dev` is the default command, so bare `sorb` == `sorb dev`. `commit` requires
`--owner`, `--repo`, and `--pat`; `--message` defaults to "Update design
tokens". It reads the `tokenSources` (or legacy `tokenPath`) from your
`sorb.config.json` — the same shape `sorb init` writes.

`handshake` writes a `sorb://` link + paste code that configures a designer's
Figma plugin against your running bridge in one step — no manual origin/key
entry. It reads `appUrl` and `gh` from `sorb.config.json` (see below) so it
runs zero-flag on a configured repo, or accepts `--app <url>` / `--gh <url>`
directly; `--pk <key>` attaches a read-only key for a hosted bridge, `--exp
<days>` sets the invite's expiry (default 30, `0` = no expiry), and
`--copy`/`--link-only`/`--code-only` control what's printed vs. copied.

`check` rebuilds the tokens and reports evidence of drift/mismatch/deprecation
without starting a server — run it in CI. `--resolved`/`--baseline` point at
the snapshots to diff (defaults `.sorb/resolved.json` / `.sorb/baseline.json`),
`--format json` for machine-readable output, `--no-build` to check an existing
snapshot instead of rebuilding.

`serve` is the **advanced, self-hosted** path — it takes its config entirely
from environment variables (no `sorb.config.json`), the same server `sorb
dev` runs, meant for running the bridge as a standalone hosted service rather
than a project-local dev tool. Most consumers want `sorb dev`.

For the full CLI reference (every command's options) see
[the docs site](https://www.sorbcloud.com/docs/packages/juice).

## `sorb mcp` — Model Context Protocol server

Exposes your running app's **resolved tokens + bound React components** to any
MCP-capable agent (Claude Code, Cursor, Copilot). Phase 1 is **read-only** over the
project's local `.sorb/` map — no `sorb dev` needed. It speaks stdio; `stdout` is the
MCP channel.

**Read tools:** `list_tokens`, `get_token`, `resolve_value`, `list_components`,
`get_component_bindings`, `find_token_usages`, `find_components_by_token`.

**Gated write tools (proposal-only — never auto-apply):** `propose_token_change`
(returns a diff + blast-radius, and a live preview when `--bridge` is set),
`rebind_component` (proposes a binding change), `open_pr` (opens a token PR via the
existing Open-PR flow when GitHub creds are passed). Each returns a proposal / preview
ref / PR url — **accepting or merging is the human step.**

Register it with an MCP client, e.g. `.mcp.json` / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sorb": { "command": "sorb", "args": ["mcp", "--dir", "/path/to/your/app"] }
  }
}
```

Write tools take optional config: `--bridge <url>` (for live previews) and
`--gh-owner` / `--gh-repo` / `--gh-pat` / `--gh-token-path` (for `open_pr`). With none
set, the read tools work fully and write tools return a clear "config needed" message.

> Requires `@modelcontextprotocol/sdk` (a dependency) to be installed for the live boot.
> The read + write **logic** is unit-tested without it (`node --test src/mcp/`).

## What `sorb dev` does

- Serves the preview API the Figma plugin and your React app talk to:
  `POST/GET/PUT/DELETE /preview`, `GET /tokens/latest`, `GET /health`.
- Serves the resolved bindable token map at `GET /tokens/resolved` and accepts
  running-app self-reports at `POST /verify/app` for drift checking.
- Accepts a Figma Variables export from the plugin at `POST /tokens/figma`
  (read back via `GET /tokens/figma`) and diffs it against the resolved map at
  `GET /verify/figma` — a Figma-vs-DTCG drift check. This only **flags**
  drift; the DTCG token source is always truth, the Figma export is a mirror.
  Set `SORB_FIGMA_FILE_KEY` to have the bridge echo back a `configuredFileKey`
  in that response, useful for spotting an export taken from the wrong file.
- Watches your source `tokens.json` and, if configured, re-runs Style
  Dictionary on every change.

Configure it with `sorb.config.json` (this is exactly what `sorb init` writes):

```json
{
  "namespace": "my-app",
  "tokenSources": [
    "tokens/primitive.json",
    "tokens/semantic.json",
    "tokens/component.json"
  ],
  "styleDictionaryConfig": "sd.config.js",
  "port": 7777,
  "figmaFileKey": "abc123XYZ",
  "appUrl": "http://localhost:5173",
  "gh": "https://github.com/my-org/my-repo/edit/main/tokens/component.json",
  "seed": { "storybookUrl": "http://localhost:6006" }
}
```

> `tokenSources` (a DTCG set list) is the current shape; a single legacy
> `tokenPath` string is still accepted as a fallback. `-p/--port` on the CLI
> overrides `port` here. `seed.storybookUrl` is read by `sorb-seed capture`.
> `figmaFileKey` is optional and informational only — echoed back by
> `GET /verify/figma` as `configuredFileKey`; the `SORB_FIGMA_FILE_KEY` env var
> takes precedence over it when both are set. `appUrl` and `gh` are both
> optional and blank by default (`sorb init` writes them empty) — `sorb
> handshake` reads them so it can run zero-flag once you fill them in;
> `gh` falls back to your `git remote` when unset.

## HTTP routes

Everything the bridge serves except `/enterprise/*`. In **local mode**
(`sorb dev`, no `databaseUrl`) every route is open — no auth, no tenant
scope, byte-for-byte the free bridge's behavior. In **hosted mode** (a
self-host with `databaseUrl` set, or Sorb Cloud) every route except
`GET /health`/`GET /ready` requires a Bearer API key, and only `POST /verify`
and `POST /tokens/figma` require a **secret** key rather than a read-only
**publishable** one — every other route below, including the `PUT`/`DELETE`
preview writes, accepts either.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/orgs/:orgId/preview/:id/subscribe` | SSE push — the leaf SDK subscribes here instead of polling `GET /preview/:id`. |
| `POST` | `/preview` | Figma plugin posts a proposed token set; returns a short id for `?preview=<id>`. |
| `GET` | `/preview/latest` | The project's most-recently-pushed live preview. |
| `GET` | `/preview/:id` | React app polls this while a preview is active. |
| `PUT` | `/preview/:id` | Plugin updates an existing preview in place (live edit mode). |
| `DELETE` | `/preview/:id` | Plugin clears a preview when the designer exits without committing. |
| `POST` | `/verify` | Plugin posts post-layout geometry of an inserted component, for reconciliation against the captured artifact. |
| `GET` | `/verify/latest` | The most recently reported verification. |
| `GET` | `/verify/figma` | Figma-vs-DTCG drift check — diffs the latest Figma Variables export against the committed resolved map. |
| `GET` | `/verify/:id` | A specific verification by id. |
| `POST` | `/verify/activity` | Records that the current Figma user just ran a preview. |
| `GET` | `/verify/activity` | The most recent *other* user's activity entry. |
| `GET` | `/tokens/latest` | The latest committed tokens from disk. |
| `GET` | `/tokens/resolved` | The resolved bindable token map — `{ id, cssVar, value, tier, type }` per token. |
| `POST` | `/verify/app` | Running-app self-report: the app posts the values it actually resolved; the bridge diffs them against the committed map. |
| `POST` | `/tokens/figma` | Plugin posts its exported Figma Variables as a resolved-map artifact (single latest snapshot, no history). |
| `GET` | `/tokens/figma` | The latest Figma Variables export, as posted by the plugin. |
| `GET` | `/artifacts` | The captured-component index (from `sorb-seed capture`). |
| `GET` | `/artifact` | One captured artifact, looked up by id — never a raw filesystem path. |
| `GET` | `/usages` | Which captured components/roles render a given token. |
| `GET` | `/blast` | Like `/usages` but expands the alias chain — editing a primitive reports every token that aliases it, and their bound components. |
| `POST` | `/graft/plan` | Plans a theme graft from one component onto another, reconciled by role. Compute-only — never writes. |
| `GET` | `/health` | Infra probe. Open in all modes, no auth. |
| `GET` | `/ready` | Readiness probe — 200 only when every configured backend is reachable. |

Full per-route detail (request/response shapes, edge cases): the
[`@sorb/juice` reference](https://www.sorbcloud.com/docs/packages/juice).

## Capture → dev → preview (the free loop)

The token capture step lives in [`@sorb/seed`](https://www.npmjs.com/package/@sorb/seed)
(`sorb-seed capture`), which needs a Playwright **chromium browser**
(`npx playwright install chromium`, one-time — separate from the `playwright`
package). The end-to-end path a consumer runs:

```bash
sorb init                       # write sorb.config.json
sorb-seed capture               # walk the running Storybook → .sorb/ token map
sorb dev                        # bring the bridge up (/health, /tokens, /preview)
# → load your app with ?preview=<id> to see a POSTed token override live, then revert
```

See [Getting started](https://www.sorbcloud.com/docs/getting-started) for the
full workflow, or [the bridge](https://www.sorbcloud.com/docs/bridge) for what
`sorb dev` does and why.

---

## Related packages

- [`@sorb/core`](https://www.sorbcloud.com/docs/packages/core) — the shared contract
- [`@sorb/seed`](https://www.sorbcloud.com/docs/packages/seed) — capture + resolve tokens
- [`@sorb/leaf`](https://www.sorbcloud.com/docs/packages/leaf) — the React SDK this bridge serves

Full docs: [sorbcloud.com/docs/packages/juice](https://www.sorbcloud.com/docs/packages/juice).

**Sorb™** is a trademark of Metatoy LLC.
