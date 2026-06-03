import { program } from 'commander'
import { serve } from '@hono/node-server'
import { readFileSync, existsSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import pc from 'picocolors'
import { createServer } from './server'
import { watchTokenFile, watchSources } from './watch'
import { runStyleDictionary } from './transform'
import { openTokenPR } from './github'

// ─── config loader ────────────────────────────────────────────────────────────

/** @returns {import('./types').SorbCliConfig} */
const loadConfig = () => {
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

// ─── program ──────────────────────────────────────────────────────────────────

program
  .name('sorb')
  .description('Sorb design token bridge')
  .version('1.2.0')

// ─── dev (default) ────────────────────────────────────────────────────────────

program
  .command('dev', { isDefault: true })
  .description('Start the local token bridge server')
  .option('-p, --port <port>', 'port to listen on', '7777')
  .action(async (opts) => {
    const config = loadConfig()
    const port = config.port ?? parseInt(opts.port)

    // Token sources to watch (DTCG sets). Falls back to the legacy single
    // tokenPath for pre-taxonomy apps.
    const sources = config.tokenSources || (config.tokenPath ? [config.tokenPath] : [])

    console.log(pc.bold('\nSorb'))
    console.log(pc.dim('  Namespace :') + ` ${config.namespace}`)
    console.log(pc.dim('  Sources   :') + ` ${sources.join(', ') || '(none)'}`)
    console.log(pc.dim('  Port      :') + ` ${port}`)

    const sorbDir = resolve(process.cwd(), '.sorb')
    const resolvedPath = resolve(sorbDir, 'resolved.json')
    const indexPath = resolve(sorbDir, 'index.json')

    const readJson = (p) => {
      if (!existsSync(p)) return null
      try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
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
      if (config.styleDictionaryConfig) runStyleDictionary(config.styleDictionaryConfig)
    }
    buildTokens()
    const { stop } = watchSources(sources, buildTokens)

    // GET /tokens/latest — the committed token values the plugin prefills its
    // editor with. Prefer a legacy flat token file if present; otherwise derive
    // a flat { cssVarName: value } map from the SD-built resolved map, so the
    // DTCG taxonomy works without a hand-maintained flat file.
    const legacyTokenAbs = config.tokenPath ? resolve(process.cwd(), config.tokenPath) : null
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

    const app = createServer(config.namespace, read, readResolved, readIndex, readArtifact)

    serve({ fetch: app.fetch, port }, () => {
      console.log(
        pc.dim('\n  Preview URL :') +
          pc.cyan(` http://localhost:${port}/preview`),
      )
      console.log(
        pc.dim('  Latest      :') +
          pc.cyan(` http://localhost:${port}/tokens/latest`),
      )
      console.log(
        pc.dim('  Health      :') +
          pc.cyan(` http://localhost:${port}/health`),
      )
      console.log(pc.dim('\n  Watching for token file changes...\n'))
    })

    process.on('SIGINT', () => {
      stop()
      console.log(pc.dim('\n  Stopped.\n'))
      process.exit(0)
    })
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
    const config = loadConfig()
    const content = readFileSync(
      resolve(process.cwd(), config.tokenPath),
      'utf-8',
    )

    console.log(pc.dim('\n  Opening PR...'))

    try {
      const url = await openTokenPR({
        owner: opts.owner,
        repo: opts.repo,
        tokenPath: config.tokenPath,
        content,
        message: opts.message,
        pat: opts.pat,
      })
      console.log(pc.green(`  ✓ PR opened: `) + pc.cyan(url) + '\n')
    } catch (err) {
      console.error(pc.red('  ✗ Failed to open PR:'), err)
      process.exit(1)
    }
  })

program.parse()
