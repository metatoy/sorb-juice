/**
 * Thin SQL migration runner — no external migration framework.
 *
 * Reads `src/db/migrations/*.sql` in lexical (NNNN_*) order, applies each
 * inside a single transaction, and records applied filenames in a
 * `schema_migrations` table so re-runs are idempotent. JS only; uses the pool
 * carried by the {@link DbHandle} passed in.
 *
 * @module db/migrate
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Module URL used to locate sibling files.
 *
 * In raw ESM source (dev / `node src/cli.js`) this is the real
 * `import.meta.url`. In the esbuild **cjs** bundle (`dist/`) `import.meta` would
 * be empty, so build.mjs `define`s `import.meta.url` to a `__dirname`-derived
 * file URL — replacing the token outright, so the bundle carries no
 * `import.meta` reference (no esbuild warning) and the path still resolves to
 * `dist/migrations` at runtime.
 *
 * @type {string}
 */
const SELF_URL = import.meta.url

/**
 * Absolute path to the directory holding the `.sql` migration files. Resolved
 * relative to this module so it works from both `src/` (dev) and `dist/`
 * (bundled) — the build copies the `.sql` files alongside the bundle.
 * @type {string}
 */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(SELF_URL)), 'migrations')

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
)
`

/**
 * Apply all pending migrations in lexical order.
 *
 * Each unapplied file is run in its own transaction together with the
 * bookkeeping INSERT, so a failed migration rolls back cleanly and leaves
 * `schema_migrations` consistent.
 *
 * @param {import('../types.js').DbHandle} db A DbHandle from {@link createDb}.
 * @param {object} [opts]
 * @param {string} [opts.dir] Override the migrations directory (testing).
 * @returns {Promise<string[]>} The filenames that were applied this run (in
 *   order). Empty array when the schema is already up to date.
 */
export async function runMigrations(db, opts) {
  if (!db) {
    throw new Error('runMigrations: no DbHandle (DATABASE_URL not configured?)')
  }
  const dir = (opts && opts.dir) || MIGRATIONS_DIR

  // Ensure the ledger table exists before we read it.
  await db.query(SCHEMA_MIGRATIONS_DDL)

  let entries
  try {
    entries = await readdir(dir)
  } catch (e) {
    if (e && e.code === 'ENOENT') return []
    throw e
  }

  const files = entries
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const appliedRes = await db.query('SELECT filename FROM schema_migrations')
  const already = new Set((appliedRes.rows || []).map((r) => r.filename))

  /** @type {string[]} */
  const applied = []

  for (const file of files) {
    if (already.has(file)) continue
    const sql = await readFile(join(dir, file), 'utf8')

    // Apply the migration body + its ledger row atomically.
    await db.tx(async (client) => {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
    })

    applied.push(file)
    // eslint-disable-next-line no-console
    console.log(`[db] applied migration ${file}`)
  }

  return applied
}

export default { runMigrations, MIGRATIONS_DIR }
