# @sorb/juice

Sorb bridge server + CLI (`sorb`) — carries proposed tokens from Figma into
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
sorb init      # create a sorb.config.json
sorb dev       # start the local token bridge server (default command)
sorb commit \  # open a GitHub PR with the current token file
  --owner my-org --repo my-repo --pat ghp_xxx \
  --message "Update primary color to indigo"
```

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
