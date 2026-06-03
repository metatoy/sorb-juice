import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'
import pc from 'picocolors'

/**
 * Runs a Style Dictionary build after tokens change.
 * Only runs if a config file exists — non-fatal if it doesn't.
 *
 * @param {string} configPath
 * @returns {boolean}
 */
export const runStyleDictionary = (configPath) => {
  const abs = resolve(process.cwd(), configPath)

  if (!existsSync(abs)) {
    console.warn(
      pc.yellow(`  ⚠ style-dictionary config not found at ${configPath}, skipping`),
    )
    return false
  }

  try {
    console.log(pc.dim('  → Running Style Dictionary...'))
    execSync(`npx style-dictionary build --config ${abs}`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    })
    console.log(pc.green('  ✓ Style Dictionary build complete'))
    return true
  } catch {
    console.error(pc.red('  ✗ Style Dictionary build failed'))
    return false
  }
}
