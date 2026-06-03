# CLAUDE.md — sorb-juice

Part of the **Sorb** polyrepo under the **Metatoy** org (local base
`workspace/metatoy/`). Siblings: `sorb-core`, `sorb-seed`, `sorb-leaf`,
`sorb-canopy`, `sorb-demo`, `sorb-cloud`.

## What this is

`@metatoy/sorb-juice` — the local token **bridge** server and dev CLI (Hono). The
live conduit carrying tokens across. The package/repo is `sorb-juice`; the command
users type is the clean top-level **`sorb`** (`sorb dev` / `sorb init` /
`sorb commit`). Serves `/tokens/*`, `/preview`, `/verify`, `/health` on port 7777.

## Hard rules

- **JavaScript only — never TypeScript.** JSDoc typedefs in `src/types.js`; shared
  contract shapes come from `@metatoy/sorb-core`.
- **Build = esbuild** (`build.mjs`, run from this dir) → `dist/cli.js` (gitignored).
  `sorb dev` runs `dist/cli.js`, so **rebuild before smoke-testing** server changes
  or you test stale code.
- Reads config from **`sorb.config.json`**; serves the SD-built **`.sorb/`** map.
- **Per-repo lockfile is correct** (polyrepo).
- **Commit/push only when asked.** If on the default branch, branch first.
