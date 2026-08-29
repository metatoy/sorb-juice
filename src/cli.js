import { program } from 'commander'
import { serve } from '@hono/node-server'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import pc from 'picocolors'
import * as core from '@sorb/core'
import localCodeSource from './codeSources/local'

/**
 * Resolve the active CODE-SOURCE connector. Prefers the @sorb/core registry
 * (id-selectable via config.codeSource), but falls back to the built-in `local`
 * connector when the installed @sorb/core predates the connector contract (the
 * published npm version can lag the workspace — see codeSources/local.js). Same
 * behavior either way: today's `local` default.
 * @param {object} [config]
 * @returns {import('@sorb/core').CodeSourceConnector}
 */
function resolveCodeSource(config) {
  try {
    if (
      typeof core.resolveConnectorIds === 'function' &&
      typeof core.getCodeSource === 'function'
    ) {
      return core.getCodeSource(core.resolveConnectorIds(config).codeSource)
    }
  } catch (e) {
    // Registry unavailable or id unregistered — fall through to the local default.
    void e
  }
  return localCodeSource
}
import { createServer } from './server'
import { loadConfig } from './config'
import { createStore } from './store/index'
import { createDb } from './db/index'
import { watchSources } from './watch'
import { runStyleDictionary } from './transform'
import { runCheck, formatCheckText, EXIT } from './check'
import { openTokenPR } from './github'
import { createCloudReader, resolveCloudConfig, headUrl } from './cloud'
import { createResultSync, resolveResultSyncConfig } from './resultSync'
import { initSentry, captureError, flushSentry } from './sentry'
import { execFileSync, spawnSync } from 'child_process'
import { encodeHandshake, toHandshakeLink } from './handshake'
import { probeUrl } from './probe'
// Side-effect import: registers the default `local` CODE-SOURCE connector.
// See spec/sorb/connectors-architecture.md §3.2 / §4 C2.
import './codeSources/local'
// Side-effect import: registers the `github` CODE-SOURCE connector (Option B
// — point-at-existing-deployment). See spec/sorb/github-code-source-connector.md.
import './codeSources/github'

// ─── sorb.config.json loader ────────────────────────────────────────────────
// The on-disk project config (namespace, token sources, port). Kept separate
// from loadConfig() (env / 12-factor) which the store + db factories read.

/** @returns {import('./types').SorbCliConfig} */
const loadFileConfig = () => {
  const configPath = resolve(process.cwd(), 'sorb.config.json')
  if (!existsSync(configPath)) {
    console.error(pc.red('\n✗ No sorb.config.json found.\n'))
    console.error(
      pc.dim('  Run ') +
        pc.cyan('sorb init') +
        pc.dim(' to create one, or see the docs.\n'),
    )
    process.exit(1)
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'))
}

// ─── version ────────────────────────────────────────────────────────────────
// Read the real version from package.json rather than hardcoding it (which
// drifts). dist/cli.js lives in dist/, so package.json is one level up — the
// same layout in-repo and in the published npm package (`files: ["dist"]`).

const readPkgVersion = () => {
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf-8')).version || '0.0.0'
  } catch (e) {
    return '0.0.0'
  }
}

// ─── program ──────────────────────────────────────────────────────────────────

program
  .name('sorb')
  .description('Sorb™ design token bridge')
  .version(readPkgVersion())

// ─── dev (default) ────────────────────────────────────────────────────────────

program
  .command('dev', { isDefault: true })
  .description('Start the local token bridge server')
  .option('-p, --port <port>', 'port to listen on (overrides config)')
  // ── cloud mode (north-star P3) — opt-in; local .sorb/ stays the free default ──
  .option('--cloud', 'serve the resolved token map from sorb-cloud HEAD instead of local .sorb/resolved.json')
  .option('--cloud-url <url>', 'sorb-cloud base URL (or env SORB_CLOUD_URL / CLOUD_API)')
  .option('--cloud-set <id>', 'cloud token-set id to serve (or env SORB_CLOUD_SET)')
  .option('--cloud-key <key>', 'API key for the cloud request (or env SORB_CLOUD_KEY)')
  .action(async (opts) => {
    const fileConfig = loadFileConfig()

    // Cloud reader (north-star "cloud replaces the CLI", P3). Additive + opt-in:
    // resolveCloudConfig returns null unless --cloud / SORB_CLOUD_URL is set, so
    // the local path below is byte-for-byte unchanged when cloud mode is off.
    let cloud = null
    let cloudCfg = null
    try {
      cloudCfg = resolveCloudConfig(opts)
      if (cloudCfg) {
        cloud = createCloudReader({
          ...cloudCfg,
          // Surface transient cloud blips without crashing the bridge; the last
          // good HEAD keeps serving.
          onError: (err) =>
            console.error(pc.yellow('  ⚠ cloud HEAD fetch failed: ') + (err && err.message ? err.message : String(err))),
        })
      }
    } catch (e) {
      console.error(pc.red('\n✗ ' + (e && e.message ? e.message : String(e)) + '\n'))
      process.exit(1)
    }

    // 12-factor env config, then merge the on-disk sorb.config.json on top so
    // local mode keeps reading namespace/port from the file. With no hosted env
    // vars set, redisUrl/databaseUrl stay undefined → in-memory store, no DB.
    //
    // Port precedence: explicit --port flag > sorb.config.json > env/default.
    // The flag has no default so an unpassed flag is `undefined` and yields to
    // the config; passing -p always wins.
    const cliPort =
      opts.port !== undefined ? Number.parseInt(opts.port, 10) : undefined
    const envConfig = loadConfig()
    const config = {
      ...envConfig,
      namespace: fileConfig.namespace ?? envConfig.namespace,
      port: cliPort ?? fileConfig.port ?? envConfig.port,
      // Optional Figma file key (informational — surfaced by GET /verify/figma
      // as `configuredFileKey`). SORB_FIGMA_FILE_KEY env wins if both are set.
      figmaFileKey: envConfig.figmaFileKey ?? fileConfig.figmaFileKey,
    }
    const port = config.port

    // Token sources to watch (DTCG sets). Falls back to the legacy single
    // tokenPath for pre-taxonomy apps.
    const sources =
      fileConfig.tokenSources || (fileConfig.tokenPath ? [fileConfig.tokenPath] : [])

    console.log(pc.bold('\nSorb™'))
    console.log(pc.dim('  Namespace :') + ` ${config.namespace}`)
    if (cloud) {
      console.log(pc.dim('  Tokens    :') + ' cloud HEAD ' + pc.cyan(headUrl(cloudCfg.baseUrl, cloudCfg.setId)))
    } else {
      console.log(pc.dim('  Sources   :') + ` ${sources.join(', ') || '(none)'}`)
    }
    console.log(pc.dim('  Port      :') + ` ${port}`)

    // CODE-SOURCE connector (default `local` = today's implicit cwd root; see
    // @sorb/core's connector contract). Pure indirection — no behavior change.
    const codeSource = resolveCodeSource(fileConfig)
    const projectRoot = codeSource.resolveProjectRoot(fileConfig)

    const sorbDir = resolve(projectRoot, '.sorb')
    const resolvedPath = resolve(sorbDir, 'resolved.json')
    const indexPath = resolve(sorbDir, 'index.json')

    const readJson = (p) => {
      if (!existsSync(p)) return null
      try { return JSON.parse(readFileSync(p, 'utf-8')) } catch (e) { return null }
    }
    const readResolvedArray = () => {
      // Cloud mode: the resolved map is the cloud HEAD snapshot, not local disk.
      if (cloud) return cloud.getResolvedTokens()
      const data = readJson(resolvedPath)
      return data && (Array.isArray(data) ? data : data.tokens)
    }
    const readResolved = () => readResolvedArray()
    const readIndex = () => readJson(indexPath)

    // Build tokens once up front, then on every source change, so the resolved
    // map the plugin/seed consume is always fresh. In cloud mode there are no
    // local sources to build or watch — the resolved map comes from cloud HEAD.
    const buildTokens = () => {
      if (fileConfig.styleDictionaryConfig) runStyleDictionary(fileConfig.styleDictionaryConfig)
    }
    let stop = () => {}
    if (cloud) {
      cloud.start()
    } else {
      buildTokens()
      ;({ stop } = watchSources(sources, buildTokens))
    }

    // GET /tokens/latest — the committed token values the plugin prefills its
    // editor with. Prefer a legacy flat token file if present; otherwise derive
    // a flat { cssVarName: value } map from the SD-built resolved map, so the
    // DTCG taxonomy works without a hand-maintained flat file.
    const legacyTokenAbs = fileConfig.tokenPath ? resolve(projectRoot, fileConfig.tokenPath) : null
    const read = () => {
      if (legacyTokenAbs && existsSync(legacyTokenAbs)) {
        try { return JSON.parse(readFileSync(legacyTokenAbs, 'utf-8')) } catch (e) { return {} }
      }
      const arr = readResolvedArray()
      if (!arr) return {}
      const flat = {}
      for (const t of arr) if (t.cssVar) flat[t.cssVar.replace(/^--/, '')] = t.value
      return flat
    }

    // Look up an artifact by story id via the index. NEVER trust a raw path
    // from the caller (path-traversal safe).
    const readArtifact = (storyId) => {
      const idx = readIndex()
      const entry = idx && idx.stories && idx.stories[storyId]
      if (!entry) return null
      const artPath = resolve(projectRoot, entry.artifact)
      // Sanity: artifact path must be inside the project root.
      if (!artPath.startsWith(projectRoot + '/')) return null
      return readJson(artPath)
    }

    // Backend wiring. createStore picks in-memory (zero-dep default) unless
    // config.redisUrl is set; createDb returns null unless config.databaseUrl
    // is set. Local mode = both fall through to today's single-process behavior.
    const store = await createStore(config)
    const db = await createDb(config)
    if (db && db.runMigrations) await db.runMigrations()

    // E4 (Mode C result-sync) — ADDITIVE + opt-in. resolveResultSyncConfig()
    // returns null unless an org key is present (SORB_ORG_KEY env or
    // sorb.config.json `orgKey`), so the local bridge for anyone who hasn't
    // created an account is untouched: no resultSync instance, no
    // onLocalResultSync hook passed to createServer (it keeps its own
    // zero-cost default), zero extra network activity.
    const resultSyncCfg = resolveResultSyncConfig(fileConfig)
    const resultSync = resultSyncCfg
      ? createResultSync({
          ...resultSyncCfg,
          onError: (err, ctx) =>
            console.error(
              pc.yellow('  ⚠ result-sync: ') + (err && err.message ? err.message : String(err)) +
                (ctx && ctx.at ? pc.dim(` (${ctx.at})`) : ''),
            ),
        })
      : null
    if (resultSync) {
      resultSync.start()
      console.log(
        pc.dim('  Account   :') +
          ` synced to ${resultSyncCfg.cloudBase} (labeled outcomes only — never raw app data; entitlement-gated opt-out honored)`,
      )
    }

    const app = createServer({
      store,
      config,
      db,
      getLatestTokens: read,
      getResolvedTokens: readResolved,
      getArtifactIndex: readIndex,
      getArtifact: readArtifact,
      onLocalResultSync: resultSync ? (type, args) => resultSync.record(type, args) : undefined,
    })

    // C2: bind the local bridge to 127.0.0.1 only (loopback), NOT 0.0.0.0
    // (all interfaces). @hono/node-server defaults to 0.0.0.0 when hostname is
    // omitted, which would expose the no-auth/open-CORS dev bridge to the LAN.
    const devServer = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
      console.log(
        pc.dim('\n  Preview URL :') +
          pc.cyan(` http://127.0.0.1:${port}/preview`),
      )
      console.log(
        pc.dim('  Latest      :') +
          pc.cyan(` http://127.0.0.1:${port}/tokens/latest`),
      )
      console.log(
        pc.dim('  Health      :') +
          pc.cyan(` http://127.0.0.1:${port}/health`),
      )
      console.log(pc.dim('\n  Watching for token file changes...\n'))
    })

    // A port clash otherwise surfaces as a raw unhandled EADDRINUSE stack
    // trace. Catch it and print something the dev can act on.
    devServer.on('error', async (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(
          pc.red(`\n✗ Port ${port} in use`) +
            pc.dim(' — pass ') +
            pc.cyan('--port <n>') +
            pc.dim(' or free it.\n'),
        )
        try { stop() } catch (e) { /* best-effort */ }
        if (resultSync) { try { resultSync.stop() } catch (e) { /* best-effort */ } }
        try { await store.close() } catch (e) { /* best-effort */ }
        process.exit(1)
      }
      throw err
    })

    process.on('SIGINT', async () => {
      stop()
      if (cloud) cloud.stop()
      if (resultSync) {
        // Best-effort final flush so a clean Ctrl-C doesn't strand the last
        // batch of labeled outcomes in memory. Bounded by timeoutMs inside
        // flush() — never hangs shutdown.
        try { await resultSync.flush() } catch (e) { /* best-effort */ }
        try { resultSync.stop() } catch (e) { /* best-effort */ }
      }
      try { await store.close() } catch (e) { /* best-effort shutdown */ }
      if (db) {
        try { await db.close() } catch (e) { /* best-effort shutdown */ }
      }
      console.log(pc.dim('\n  Stopped.\n'))
      process.exit(0)
    })
  })

// ─── serve (hosted bridge) ──────────────────────────────────────────────────
// Hosted mode: config comes entirely from env (loadConfig — 12-factor). No
// sorb.config.json, no token-file watching, no Style Dictionary build (those are
// local-dev concerns). Serves previews + verify (the hosted wedge). This is the
// container entry point (Dockerfile CMD).

program
  .command('serve')
  .description('Run the hosted bridge server (config from env; no sorb.config.json)')
  .action(async () => {
    // Hosted entry ONLY. Init Sentry FIRST (before any backend wiring) so a
    // startup error is captured. NO-OP when SENTRY_DSN is unset — the free
    // local `dev` command never calls this, so it stays zero-Sentry regardless.
    initSentry()
    process.on('unhandledRejection', (reason) => {
      captureError(reason, { at: 'unhandledRejection' })
    })
    process.on('uncaughtException', (err) => {
      captureError(err, { at: 'uncaughtException' })
    })

    const config = loadConfig()
    const port = config.port

    console.log(pc.bold('\nSorb™ (hosted bridge)'))
    console.log(pc.dim('  Namespace :') + ` ${config.namespace}`)
    console.log(pc.dim('  Port      :') + ` ${port}`)
    console.log(pc.dim('  Redis     :') + ` ${config.redisUrl ? 'on' : 'off (in-memory)'}`)
    console.log(pc.dim('  Postgres  :') + ` ${config.databaseUrl ? 'on' : 'off'}`)

    const store = await createStore(config)

    // DB init is best-effort: a Postgres hiccup must not crash-loop the bridge,
    // since previews/verify live in the store (Redis), not Postgres.
    let db = null
    try {
      db = await createDb(config)
      if (db && db.runMigrations) await db.runMigrations()
    } catch (e) {
      console.error(pc.yellow('  ⚠ Postgres init failed; continuing without DB: ') + e.message)
      db = null
    }

    // No local project files in hosted mode → token/artifact getters are empty
    // for now (hosted token serving is a later phase; previews are the wedge).
    const app = createServer({
      store,
      config,
      db,
      getLatestTokens: () => ({}),
      getResolvedTokens: () => null,
      getArtifactIndex: () => null,
      getArtifact: () => null,
      // Route server-side DB-error / bookkeeping catches to Sentry. NO-OP when
      // SENTRY_DSN is unset (captureError gates on the enabled flag).
      onError: captureError,
    })

    serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
      console.log(pc.dim(`\n  Listening on 0.0.0.0:${port}  ·  /health  /ready\n`))
    })

    const shutdown = async () => {
      try { await store.close() } catch (e) { /* best-effort shutdown */ }
      if (db) { try { await db.close() } catch (e) { /* best-effort shutdown */ } }
      // Flush buffered Sentry events (NO-OP when Sentry is disabled).
      try { await flushSentry(2000) } catch (e) { /* best-effort shutdown */ }
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })

// ─── init ─────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a sorb.config.json in the current directory')
  .action(() => {
    const configPath = resolve(process.cwd(), 'sorb.config.json')
    if (existsSync(configPath)) {
      console.log(pc.yellow('  sorb.config.json already exists'))
      return
    }
    /** @type {import('./types').SorbCliConfig} */
    const defaults = {
      namespace: 'my-app',
      tokenSources: [
        'tokens/primitive.json',
        'tokens/semantic.json',
        'tokens/component.json',
      ],
      styleDictionaryConfig: 'sd.config.js',
      port: 7777,
      // Optional handshake-invite fields (blank-ok). `sorb handshake` reads these
      // so it can run zero-flag on a configured repo; both are additive + back-
      // compatible (existing configs without them still work). appUrl = the app
      // page the preview opens; gh = the tokens-file GitHub edit URL (else derived
      // from `git remote`).
      appUrl: '',
      gh: '',
    }
    writeFileSync(configPath, JSON.stringify(defaults, null, 2) + '\n')
    console.log(pc.green('  ✓ Created sorb.config.json'))
  })

// ─── commit ───────────────────────────────────────────────────────────────────

program
  .command('commit')
  .description('Open a GitHub PR with the current token file')
  .requiredOption('--owner <owner>', 'GitHub org or user')
  .requiredOption('--repo <repo>', 'GitHub repo name')
  .requiredOption('--pat <pat>', 'GitHub personal access token')
  .option('--message <message>', 'PR / commit title', 'Update design tokens')
  .action(async (opts) => {
    const config = loadFileConfig()

    // Resolve token files from the SAME config shape the other commands use:
    // `tokenSources` (what `sorb init` writes) with a legacy `tokenPath`
    // fallback. Previously this only read `config.tokenPath`, so the config
    // `init` writes crashed commit with a raw ERR_INVALID_ARG_TYPE.
    const sources =
      config.tokenSources ||
      (config.tokenPath ? [config.tokenPath] : [])

    if (sources.length === 0) {
      console.error(
        pc.red('\n✗ No token sources configured in sorb.config.json.\n'),
      )
      console.error(
        pc.dim('  Add a ') +
          pc.cyan('tokenSources') +
          pc.dim(' array (or a legacy ') +
          pc.cyan('tokenPath') +
          pc.dim(') and try again.\n'),
      )
      process.exit(1)
    }

    // CODE-SOURCE connector (default `local` = today's implicit cwd root).
    const codeSource = resolveCodeSource(config)
    const projectRoot = codeSource.resolveProjectRoot(config)

    const files = []
    for (const rel of sources) {
      const abs = resolve(projectRoot, rel)
      if (existsSync(abs)) files.push({ path: rel, content: readFileSync(abs, 'utf-8') })
    }

    if (files.length === 0) {
      console.error(pc.red('\n✗ No token files found on disk.\n'))
      console.error(
        pc.dim('  Looked for: ') + sources.join(', ') + '\n',
      )
      console.error(
        pc.dim('  Build/create your token sources, then run ') +
          pc.cyan('sorb commit') +
          pc.dim(' again.\n'),
      )
      process.exit(1)
    }

    console.log(pc.dim('\n  Opening PR...'))

    try {
      const url = await openTokenPR({
        owner: opts.owner,
        repo: opts.repo,
        files,
        message: opts.message,
        pat: opts.pat,
      })
      console.log(pc.green(`  ✓ PR opened: `) + pc.cyan(url) + '\n')
    } catch (err) {
      console.error(pc.red('  ✗ Failed to open PR: ') + (err && err.message ? err.message : String(err)) + '\n')
      process.exit(1)
    }
  })

// ─── handshake ──────────────────────────────────────────────────────────────
// Generate a shareable, self-contained invite that auto-configures a designer's
// Figma plugin — no servers/URLs/keys for the designer to type. Assembles the
// bundle from sorb.config.json (+ git remote for `gh`), base64url-encodes it,
// and prints the sorb:// deep link + the raw paste code. See the canonical
// format + signature in spec/sorb/gfp/part8-p0-design.md §2. The plugin's redeem
// box accepts either the full link or the bare code.

/**
 * Derive a GitHub tokens-file edit URL from `git remote get-url origin`.
 * Parses both SSH (git@github.com:owner/repo.git) and HTTPS remotes, strips a
 * trailing .git, and points at the first token source on `main`. Returns '' when
 * there is no origin remote or it isn't a github.com URL — `gh` blank is valid
 * (the plugin treats it as "Open PR disabled").
 * @param {string | undefined} tokenFile First token source (e.g. tokens/semantic.json).
 * @returns {string}
 */
const deriveGhUrl = (tokenFile) => {
  let raw
  try {
    raw = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch (e) {
    return ''
  }
  if (!raw) return ''
  // Normalize SSH + HTTPS forms to `owner/repo`.
  let path = ''
  const sshMatch = raw.match(/^git@github\.com:(.+?)(?:\.git)?$/)
  const httpsMatch = raw.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/)
  if (sshMatch) path = sshMatch[1]
  else if (httpsMatch) path = httpsMatch[1]
  else return ''
  path = path.replace(/\/$/, '')
  const file = tokenFile || 'tokens/semantic.json'
  return `https://github.com/${path}/edit/main/${file}`
}

program
  .command('handshake')
  .description('Generate a shareable invite that auto-configures a designer\'s Figma plugin')
  .option('--app <url>', 'App URL the preview opens (default: config.appUrl or http://localhost:5173)')
  .option('--gh <url>', 'GitHub edit URL of the tokens file (default: config.gh or from git remote)')
  .option('--pk <key>', 'Read-only sorb_pk_ for a hosted bridge (default: blank = keyless-local)')
  .option('--origin <url>', 'Bridge origin override (default: http://127.0.0.1:<port from config>)')
  .option('--exp <days>', 'Days until the invite expires (default: 30; pass 0 for no expiry)')
  .option('--copy', 'Copy the paste code to the clipboard')
  .option('--link-only', 'Print only the sorb:// link')
  .option('--code-only', 'Print only the paste code')
  .action(async (opts) => {
    try {
      const config = loadFileConfig()

      // origin: --origin, else derived loopback from config.port (default 7777),
      // matching what `sorb dev` binds/prints.
      const port = config.port ?? 7777
      const origin = opts.origin || `http://127.0.0.1:${port}`

      // appUrl: --app > CODE-SOURCE connector (default `local` = config.appUrl
      // > default dev URL). Track the source so the invite output can say
      // where it came from.
      const codeSource = resolveCodeSource(config)
      const appUrl = opts.app || (await codeSource.resolveAppUrl(config)) || 'http://localhost:5173'
      const appUrlSource = opts.app ? '--app' : config.appUrl ? 'sorb.config.json' : 'default'

      // gh: --gh > config.gh > derived from `git remote` > blank.
      const tokenSources =
        config.tokenSources || (config.tokenPath ? [config.tokenPath] : [])
      const gh =
        opts.gh || config.gh || deriveGhUrl(tokenSources[0]) || ''

      // pk: --pk (from the cloud dashboard), else blank (keyless-local).
      const pk = opts.pk || ''

      // exp: now + --exp days (default 30). --exp 0 ⇒ omit (never expires).
      const expDays = opts.exp !== undefined ? Number.parseInt(opts.exp, 10) : 30
      const days = Number.isFinite(expDays) ? expDays : 30

      // Assemble the payload in the canonical field order. Only include optional
      // fields when meaningful so the blob stays minimal + matches the spec.
      const payload = { v: 1, origin, appUrl, gh, pk }
      if (config.namespace) payload.namespace = config.namespace
      if (days > 0) payload.exp = Math.floor(Date.now() / 1000) + days * 86400

      const code = encodeHandshake(payload)
      const link = toHandshakeLink(code)

      // --link-only / --code-only: raw single-string output for piping.
      if (opts.linkOnly) {
        console.log(link)
        return
      }
      if (opts.codeOnly) {
        console.log(code)
      } else {
        const kind = pk ? 'hosted' : 'keyless-local'
        const expLabel = days > 0 ? `expires in ${days} day${days === 1 ? '' : 's'}` : 'no expiry'
        console.log(pc.bold('\n  Sorb invite') + pc.dim(`  ·  ${kind}  ·  ${expLabel}\n`))
        console.log(pc.dim('  Link  ') + pc.cyan(link))
        console.log(pc.dim('  Code  ') + code)
        console.log(pc.dim('  App   ') + appUrl + pc.dim(`  (from ${appUrlSource})`))

        // Probe (inform, never substitute): a dead bridge or app is the #1 way
        // an invite silently fails for the designer — say so now.
        const [bridgeUp, appUp] = await Promise.all([
          probeUrl(`${origin}/health`),
          probeUrl(appUrl),
        ])
        if (!bridgeUp) {
          console.error(pc.yellow(`\n  ⚠ No bridge at ${origin} — run \`sorb dev\` and leave it running before the designer connects.`))
        }
        if (!appUp) {
          console.error(pc.yellow(`\n  ⚠ Your app at ${appUrl} isn't reachable — start it (e.g. \`npm run dev\`). Until it's up, the designer's preview falls back to the Sorb demo.`))
        }
        console.log(
          pc.dim('\n  → Send this to your designer. In the Sorb plugin they click') +
            pc.dim('\n    "Paste an invite" and drop it in — no servers, URLs, or keys to set up.\n'),
        )
      }

      // --copy: pipe the paste code to the macOS clipboard. Guarded — a missing
      // pbcopy (non-mac / headless) must not fail the command.
      if (opts.copy) {
        try {
          const r = spawnSync('pbcopy', { input: code })
          if (r.status === 0) {
            if (!opts.codeOnly) console.log(pc.green('  (copied to clipboard)\n'))
          } else {
            console.error(pc.yellow('  ⚠ Could not copy to clipboard (pbcopy unavailable).\n'))
          }
        } catch (e) {
          console.error(pc.yellow('  ⚠ Could not copy to clipboard: ') + (e && e.message ? e.message : String(e)) + '\n')
        }
      }
    } catch (e) {
      console.error(pc.red('\n✗ Failed to build handshake: ') + (e && e.message ? e.message : String(e)) + '\n')
      process.exit(1)
    }
  })

// ─── check ────────────────────────────────────────────────────────────────────
// Headless token-build check for CI. Re-runs the Style Dictionary build and diffs
// the freshly-built snapshot for EVIDENCE of drift / binding-mismatch / off-role
// bindings / deprecation, then exits non-zero so a CI check can fail the build.
// The diff logic is the Sorb verify suite (src/verify/*); this command wires the
// file I/O + SD rebuild around src/check.js's pure core. Reports what it measured
// — it makes no compliance/outcome claim and promises no merge outcome.

program
  .command('check')
  .description(
    'Re-run the token build and report evidence of drift, binding-mismatch, or deprecation; exits non-zero on findings (for CI)',
  )
  .option('--resolved <path>', 'resolved token snapshot to check', '.sorb/resolved.json')
  .option('--baseline <path>', 'previous resolved snapshot to diff against', '.sorb/baseline.json')
  .option('--live <path>', 'live-captured cssVar→value map to diff the build against')
  .option('--computed <path>', 'computed-styles map (property→value) for the hardcoded-value scan')
  .option('--format <fmt>', 'output format: text | json', 'text')
  .option('--no-build', 'skip the Style Dictionary rebuild; check the existing snapshot only')
  .action(async (opts) => {
    const fileConfig = loadFileConfig()

    // Read a JSON file, returning null (not throwing) on absence/parse error so
    // an optional input (baseline/live/computed) degrades to "skipped".
    const readJsonFile = (rel) => {
      const abs = resolve(process.cwd(), rel)
      if (!existsSync(abs)) return null
      try {
        return JSON.parse(readFileSync(abs, 'utf-8'))
      } catch (e) {
        return null
      }
    }
    // Coerce a parsed snapshot to the resolved-token array shape
    // ([{cssVar,...}] or { tokens: [...] }).
    const asArray = (data) =>
      Array.isArray(data) ? data : data && Array.isArray(data.tokens) ? data.tokens : null

    // 1) Re-run the Style Dictionary build (unless --no-build). A failed build is
    //    itself a finding → non-zero exit.
    // Diagnostics go to stderr so stdout carries only the report (clean JSON in
    // --format json; the text block otherwise).
    let buildOk = true
    if (opts.build === false) {
      console.error(pc.dim('  → Skipping Style Dictionary rebuild (--no-build)'))
    } else if (fileConfig.styleDictionaryConfig) {
      buildOk = runStyleDictionary(fileConfig.styleDictionaryConfig)
    } else {
      console.error(
        pc.dim('  → No styleDictionaryConfig in sorb.config.json; checking the existing snapshot'),
      )
    }

    // 2) Load the freshly-built resolved snapshot (required).
    const resolved = asArray(readJsonFile(opts.resolved))
    if (!resolved) {
      console.error(
        pc.red(`\n✗ No resolved token snapshot found at ${opts.resolved}.\n`),
      )
      console.error(
        pc.dim('  Build your tokens first (') +
          pc.cyan('sorb dev') +
          pc.dim(' or your Style Dictionary build), then run ') +
          pc.cyan('sorb check') +
          pc.dim(' again.\n'),
      )
      process.exit(EXIT.USAGE)
    }

    // 3) Optional inputs.
    const baseline = asArray(readJsonFile(opts.baseline))
    const liveData = opts.live ? readJsonFile(opts.live) : undefined
    const live =
      liveData && !Array.isArray(liveData) && typeof liveData === 'object' ? liveData : null
    const computedData = opts.computed ? readJsonFile(opts.computed) : null
    const computedStyles =
      computedData && typeof computedData === 'object' && !Array.isArray(computedData)
        ? new Map(Object.entries(computedData))
        : null

    // 4) Run the pure check core.
    const result = runCheck({
      resolved,
      baseline,
      live: opts.live ? live : undefined,
      computedStyles,
      buildOk,
    })

    // 5) Report + set the exit code.
    if (opts.format === 'json') {
      console.log(JSON.stringify(result, null, 2))
    } else {
      // Plain text keeps CI logs clean; only the final ✓/✗ summary line is colored.
      const lines = formatCheckText(result).split('\n')
      const last = lines.pop()
      console.log('\n' + lines.join('\n'))
      console.log((result.ok ? pc.green(last) : pc.red(last)) + '\n')
    }
    process.exit(result.exitCode)
  })

// ─── mcp ────────────────────────────────────────────────────────────────────
// Sorb MCP server (stdio): exposes the running app's resolved tokens + bound
// React components to any MCP-capable agent (Claude Code / Cursor / Copilot).
// Read-only (Phase 1) over the project's local `.sorb/` map — no `sorb dev`
// needed. The SDK is imported LAZILY here so `dev`/`serve`/`init`/`commit` keep
// working even when `@modelcontextprotocol/sdk` isn't installed. stdout is the
// MCP channel — this command must not print to stdout.

program
  .command('mcp')
  .description('Run the Sorb MCP server (stdio) — resolved tokens + component bindings for AI agents')
  .option('--dir <path>', 'project dir whose .sorb/ is served', process.cwd())
  .option('--bridge <url>', 'live bridge base URL for gated write previews (e.g. http://localhost:7777)')
  .option('--http', 'run the hosted HTTP/SSE MCP endpoint (auth + tenant scoping; requires DATABASE_URL)')
  .option('-p, --port <port>', 'port for the hosted --http endpoint', '7878')
  .option('--base-dir <path>', 'per-project snapshot root for hosted --http mode', process.env.SORB_MCP_BASE_DIR || './.sorb-projects')
  .option('--gh-owner <owner>', 'GitHub org or user for open_pr')
  .option('--gh-repo <repo>', 'GitHub repo name for open_pr')
  .option('--gh-pat <pat>', 'GitHub personal access token for open_pr')
  .option('--gh-token-path <path>', 'token file path open_pr writes to', 'tokens/component.json')
  .action(async (opts) => {
    // Hosted HTTP/SSE mode (P3.0 transport + P3.1 auth). DATABASE_URL-gated —
    // createDb returns null without it, and startMcpHttpServer refuses to boot.
    // Lazily import so `dev`/`serve`/stdio never load the hosted SDK transport.
    if (opts.http) {
      const { startMcpHttpServer } = await import('./mcp/httpServer')
      const config = loadConfig()
      const db = await createDb(config)
      if (db && db.runMigrations) await db.runMigrations()
      const port = parseInt(opts.port, 10)
      await startMcpHttpServer({
        db,
        config,
        baseDir: resolve(opts.baseDir),
        port,
      })
      console.log(pc.bold('\nSorb MCP (hosted HTTP/SSE)'))
      console.log(pc.dim('  Endpoint :') + pc.cyan(` http://0.0.0.0:${port}/mcp`))
      console.log(pc.dim('  SSE      :') + pc.cyan(` http://0.0.0.0:${port}/mcp/sse`))
      console.log(pc.dim('  Base dir :') + ` ${resolve(opts.baseDir)}\n`)
      return
    }

    const { startMcpServer } = await import('./mcp/server')
    // Build github creds only when owner+repo+pat are all present; otherwise the
    // gated open_pr tool degrades gracefully (returns { error }).
    const github =
      opts.ghOwner && opts.ghRepo && opts.ghPat
        ? {
            owner: opts.ghOwner,
            repo: opts.ghRepo,
            pat: opts.ghPat,
            tokenPath: opts.ghTokenPath,
          }
        : undefined
    await startMcpServer({ dir: resolve(opts.dir), bridge: opts.bridge, github })
  })

program.parse()
