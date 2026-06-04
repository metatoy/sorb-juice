// Store factory.
//
// Picks the backend from `config`:
//   - config.redisUrl set  → DYNAMICALLY `await import('./redis.js')` and return
//     createRedisStore(config). The dynamic import is what keeps ioredis out of
//     the dependency graph for free local users.
//   - config.redisUrl absent → return createMemoryStore(config), the
//     statically-imported zero-dependency default (today's behavior).
//
// NEVER static-import './redis.js' here — that would pull ioredis into every
// build reachable from src/index.js / src/cli.js and break the free local mode.
import { createMemoryStore } from './memory.js'

/**
 * Create the appropriate Store for the given config.
 *
 * @param {import('../types').Config} config
 * @returns {Promise<import('../types').Store>}
 */
export const createStore = async (config) => {
  if (config.redisUrl) {
    const { createRedisStore } = await import('./redis.js')
    return createRedisStore(config)
  }
  return createMemoryStore(config)
}
