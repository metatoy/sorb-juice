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
sorb serve         # run the hosted bridge (config from env; no sorb.config.json)
sorb commit \      # open a GitHub PR with the current token file(s)
  --owner my-org --repo my-repo --pat ghp_xxx \
  --message "Update primary color to indigo"

sorb --help        # usage (works for any command)
sorb --version     # prints the installed @sorb/juice version
sorb mcp           # run the Sorb MCP server (stdio) for AI agents
```

`dev` is the default command, so bare `sorb` == `sorb dev`. `commit` requires
`--owner`, `--repo`, and `--pat`; `--message` defaults to "Update design
tokens". It reads the `tokenSources` (or legacy `tokenPath`) from your
`sorb.config.json` — the same shape `sorb init` writes.

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
  "seed": { "storybookUrl": "http://localhost:6006" }
}
```

> `tokenSources` (a DTCG set list) is the current shape; a single legacy
> `tokenPath` string is still accepted as a fallback. `-p/--port` on the CLI
> overrides `port` here. `seed.storybookUrl` is read by `sorb-seed capture`.
> `figmaFileKey` is optional and informational only — echoed back by
> `GET /verify/figma` as `configuredFileKey`; the `SORB_FIGMA_FILE_KEY` env var
> takes precedence over it when both are set.

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

See the [main README](https://github.com/metatoy/sorb-juice#readme) for the
full workflow.

---

**Sorb™** is a trademark of Metatoy LLC.
