import { program } from 'commander'
import { serve } from '@hono/node-server'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import pc from 'picocolors'
import { createServer } from './server'
import { loadConfig } from './config'
import { createStore } from './store/index'
import { createDb } from './db/index'
import { watchSources } from './watch'
import { runStyleDictionary } from './transform'
import { openTokenPR } from './github'
import { initSentry, captureError, flushSentry } from './sentry'

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
  .action(async (opts) => {
    const fileConfig = loadFileConfig()

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
    }
    const port = config.port

    // Token sources to watch (DTCG sets). Falls back to the legacy single
    // tokenPath for pre-taxonomy apps.
    const sources =
      fileConfig.tokenSources || (fileConfig.tokenPath ? [fileConfig.tokenPath] : [])

    console.log(pc.bold('\nSorb™'))
    console.log(pc.dim('  Namespace :') + ` ${config.namespace}`)
    console.log(pc.dim('  Sources   :') + ` ${sources.join(', ') || '(none)'}`)
    console.log(pc.dim('  Port      :') + ` ${port}`)

    const sorbDir = resolve(process.cwd(), '.sorb')
    const resolvedPath = resolve(sorbDir, 'resolved.json')
    const indexPath = resolve(sorbDir, 'index.json')

    const readJson = (p) => {
      if (!existsSync(p)) return null
      try { return JSON.parse(readFileSync(p, 'utf-8')) } catch (e) { return null }
    }
    const readResolvedArray = () => {
      const data = readJson(resolvedPath)
      return data && (Array.isArray(data) ? data : data.tokens)
    }
    const readResolved = () => readResolvedArray()
    const readIndex = () => readJson(indexPath)

    // Build tokens once up front, then on every source change, so the resolved
    // map the plugin/seed consume is always fresh.
    const buildTokens = () => {
      if (fileConfig.styleDictionaryConfig) runStyleDictionary(fileConfig.styleDictionaryConfig)
    }
    buildTokens()
    const { stop } = watchSources(sources, buildTokens)

    // GET /tokens/latest — the committed token values the plugin prefills its
    // editor with. Prefer a legacy flat token file if present; otherwise derive
    // a flat { cssVarName: value } map from the SD-built resolved map, so the
    // DTCG taxonomy works without a hand-maintained flat file.
    const legacyTokenAbs = fileConfig.tokenPath ? resolve(process.cwd(), fileConfig.tokenPath) : null
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
      const artPath = resolve(process.cwd(), entry.artifact)
      // Sanity: artifact path must be inside cwd.
      if (!artPath.startsWith(process.cwd() + '/')) return null
      return readJson(artPath)
    }

    // Backend wiring. createStore picks in-memory (zero-dep default) unless
    // config.redisUrl is set; createDb returns null unless config.databaseUrl
    // is set. Local mode = both fall through to today's single-process behavior.
    const store = await createStore(config)
    const db = await createDb(config)
    if (db && db.runMigrations) await db.runMigrations()

    const app = createServer({
      store,
      config,
      db,
      getLatestTokens: read,
      getResolvedTokens: readResolved,
      getArtifactIndex: readIndex,
      getArtifact: readArtifact,
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
        try { await store.close() } catch (e) { /* best-effort */ }
        process.exit(1)
      }
      throw err
    })

    process.on('SIGINT', async () => {
      stop()
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

    const files = []
    for (const rel of sources) {
      const abs = resolve(process.cwd(), rel)
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

program.parse()
