import { build, context } from 'esbuild'
import { chmodSync, cpSync, mkdirSync } from 'fs'

// @sorb/juice is a Node CLI. Deps stay external (installed from the
// package's own node_modules), so we only bundle our own source.
const base = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  packages: 'external',
  // cjs has no `import.meta`. src/db/migrate.js uses `import.meta.url` to locate
  // its sibling `migrations/` dir; in a cjs bundle that token would be empty and
  // esbuild warns. Replace the token outright with a banner-provided
  // __dirname-derived file URL (`__sorbModuleUrl`) so the bundle carries no
  // `import.meta` reference (no warning) and the Postgres migration path
  // resolves dist/migrations correctly at runtime. No effect on free local
  // mode, which never loads the Postgres path.
  define: { 'import.meta.url': '__sorbModuleUrl' },
  banner: {
    js: "const __sorbModuleUrl = require('url').pathToFileURL(require('path').join(__dirname, 'migrate.js')).href;",
  },
}

const builds = [
  // The `sorb` binary — gets a shebang so it runs directly. Prepend the shebang
  // to the shared banner (which defines __sorbModuleUrl for migrate.js).
  {
    ...base,
    entryPoints: ['src/cli.js'],
    outfile: 'dist/cli.js',
    banner: { js: `#!/usr/bin/env node\n${base.banner.js}` },
  },
  // The library entry (createServer, watchTokenFile, ...).
  { ...base, entryPoints: ['src/index.js'], outfile: 'dist/index.js' },
]

if (process.argv.includes('--watch')) {
  const ctxs = await Promise.all(builds.map((b) => context(b)))
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('@sorb/juice — watching for changes...')
} else {
  await Promise.all(builds.map((b) => build(b)))
  chmodSync('dist/cli.js', 0o755)
  // Copy SQL migrations next to the bundle so the Postgres migration path
  // (DATABASE_URL set) can read dist/migrations/*.sql at runtime. No effect on
  // free local mode, which never touches Postgres.
  mkdirSync('dist/migrations', { recursive: true })
  cpSync('src/db/migrations', 'dist/migrations', { recursive: true })
  console.log('@sorb/juice — built dist/cli.js + dist/index.js (+ migrations)')
}
