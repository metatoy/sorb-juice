import { build, context } from 'esbuild'
import { chmodSync } from 'fs'

// @metatoy/sorb-juice is a Node CLI. Deps stay external (installed from the
// package's own node_modules), so we only bundle our own source.
const base = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  packages: 'external',
}

const builds = [
  // The `sorb` binary — gets a shebang so it runs directly.
  {
    ...base,
    entryPoints: ['src/cli.js'],
    outfile: 'dist/cli.js',
    banner: { js: '#!/usr/bin/env node' },
  },
  // The library entry (createServer, watchTokenFile, ...).
  { ...base, entryPoints: ['src/index.js'], outfile: 'dist/index.js' },
]

if (process.argv.includes('--watch')) {
  const ctxs = await Promise.all(builds.map((b) => context(b)))
  await Promise.all(ctxs.map((c) => c.watch()))
  console.log('@metatoy/sorb-juice — watching for changes...')
} else {
  await Promise.all(builds.map((b) => build(b)))
  chmodSync('dist/cli.js', 0o755)
  console.log('@metatoy/sorb-juice — built dist/cli.js + dist/index.js')
}
