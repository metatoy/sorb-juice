import chokidar from 'chokidar'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import pc from 'picocolors'

/**
 * @typedef {Object} Watcher
 * @property {() => import('./types').TokenSet} read
 * @property {() => void} stop
 */

/**
 * @param {string} tokenPath
 * @param {(tokens: import('./types').TokenSet) => void} onChange
 * @returns {Watcher}
 */
export const watchTokenFile = (tokenPath, onChange) => {
  const abs = resolve(process.cwd(), tokenPath)

  if (!existsSync(abs)) {
    console.error(pc.red(`  ✗ Token file not found: ${abs}`))
    process.exit(1)
  }

  const read = () => {
    try {
      return JSON.parse(readFileSync(abs, 'utf-8'))
    } catch (err) {
      console.error(pc.red(`  ✗ Failed to parse token file: ${abs}`))
      return {}
    }
  }

  const watcher = chokidar.watch(abs, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100 },
  })

  watcher.on('change', () => {
    console.log(pc.cyan(`  → Token file changed`))
    onChange(read())
  })

  watcher.on('error', (err) => {
    console.error(pc.red(`  ✗ Watcher error:`), err)
  })

  return {
    read,
    stop: () => watcher.close(),
  }
}

/**
 * Watch multiple token *source* files (the DTCG sets) and fire `onChange` when
 * any changes — used to re-run Style Dictionary. Unlike watchTokenFile this
 * doesn't read/serve a file and doesn't hard-exit on a missing path (it watches
 * whichever paths exist).
 *
 * @param {string[]} paths
 * @param {(changedPath: string) => void} onChange
 * @returns {{ stop: () => void }}
 */
export const watchSources = (paths, onChange) => {
  const abs = (paths || [])
    .map((p) => resolve(process.cwd(), p))
    .filter((p) => existsSync(p))

  if (!abs.length) {
    console.warn(pc.yellow('  ⚠ No token sources found to watch.'))
    return { stop: () => {} }
  }

  const watcher = chokidar.watch(abs, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100 },
  })

  watcher.on('change', (p) => {
    console.log(pc.cyan('  → Token source changed') + pc.dim(` (${p})`))
    onChange(p)
  })
  watcher.on('error', (err) => console.error(pc.red('  ✗ Watcher error:'), err))

  return { stop: () => watcher.close() }
}
