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
```

`dev` is the default command, so bare `sorb` == `sorb dev`. `commit` requires
`--owner`, `--repo`, and `--pat`; `--message` defaults to "Update design
tokens". It reads the `tokenSources` (or legacy `tokenPath`) from your
`sorb.config.json` — the same shape `sorb init` writes.

## What `sorb dev` does

- Serves the preview API the Figma plugin and your React app talk to:
  `POST/GET/PUT/DELETE /preview`, `GET /tokens/latest`, `GET /health`.
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
  "seed": { "storybookUrl": "http://localhost:6006" }
}
```

> `tokenSources` (a DTCG set list) is the current shape; a single legacy
> `tokenPath` string is still accepted as a fallback. `-p/--port` on the CLI
> overrides `port` here. `seed.storybookUrl` is read by `sorb-seed capture`.

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

See the [main README](https://github.com/nhunsaker/sorb#readme) for the
full workflow.

---

**Sorb™** is a trademark of Metatoy LLC.
