# @sorb/juice

Local token bridge server and dev tooling for
[Sorb](https://github.com/nhunsaker/sorb). A dev dependency only —
it never touches production.

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
sorb init      # create a sorb.config.json
sorb dev       # start the local token bridge server (default command)
sorb commit \  # open a GitHub PR with the current token file
  --owner my-org --repo my-repo --pat ghp_xxx \
  --message "Update primary color to indigo"
sorb mcp       # run the Sorb MCP server (stdio) for AI agents
```

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
- Watches your source `tokens.json` and, if configured, re-runs Style
  Dictionary on every change.

Configure it with `sorb.config.json`:

```json
{
  "namespace": "my-app",
  "tokenPath": "tokens/tokens.json",
  "styleDictionaryConfig": "sd.config.js",
  "port": 7777
}
```

See the [main README](https://github.com/nhunsaker/sorb#readme) for the
full workflow.
