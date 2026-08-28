// E1 (hosted-relay hardening) — RedisStore onUpdate (pub/sub) unit tests
// against a FAKE ioredis-shaped client, never a live Redis. This repo has no
// local Redis in dev/CI (same constraint the relay-spike hit — see
// experiments/sorb-bridge-modes/relay-spike/NOTES.md), so createRedisStore
// takes an injected `client` (test-only DI) and this fake models the pub/sub
// semantics the store relies on:
//   - duplicate() returns a SEPARATE handle onto the SAME shared keyspace +
//     pub/sub bus (mirrors ioredis's duplicate()).
//   - publish() delivers to subscribed handles asynchronously (queueMicrotask),
//     matching real ioredis's async 'message' delivery.
//   - set(...,'PX',ms) / pttl / del / exists behave like Redis.
//
// This proves RedisStore's OWN wiring (channel naming, subscribe/unsubscribe
// lifecycle, TTL-preserving update publish, delete-only-when-present) is
// correct against a Redis-shaped API. It does NOT prove the live wire protocol
// — NOTES.md's standing caveat (verify against a real Redis before trusting in
// prod) still holds.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRedisStore } from './redis.js'
import { loadConfig } from '../config.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A fake Redis "server": a shared keyspace + a pub/sub bus. `makeClient()`
 * returns a handle; `duplicate()` returns another handle onto the same server.
 */
const makeFakeRedis = () => {
  /** @type {Map<string, {value: string, expiresAt: number|null}>} */
  const kv = new Map()
  const bus = new EventEmitter()
  bus.setMaxListeners(0)

  const live = (key) => {
    const e = kv.get(key)
    if (!e) return false
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      kv.delete(key)
      return false
    }
    return true
  }

  const makeClient = () => {
    const subscribed = new Set()
    let onMessage = null

    const client = {
      async get(key) {
        return live(key) ? kv.get(key).value : null
      },
      async set(key, value, ...rest) {
        let expiresAt = null
        const i = rest.indexOf('PX')
        if (i !== -1) expiresAt = Date.now() + Number(rest[i + 1])
        kv.set(key, { value, expiresAt })
        return 'OK'
      },
      async del(key) {
        const existed = live(key)
        kv.delete(key)
        return existed ? 1 : 0
      },
      async exists(key) {
        return live(key) ? 1 : 0
      },
      async pttl(key) {
        const e = kv.get(key)
        if (!e || e.expiresAt === null) return -1
        return Math.max(0, e.expiresAt - Date.now())
      },
      async ping() {
        return 'PONG'
      },
      async publish(channel, message) {
        queueMicrotask(() => bus.emit(channel, message))
        return 1
      },
      async subscribe(channel) {
        subscribed.add(channel)
        bus.on(channel, (message) => {
          if (subscribed.has(channel) && onMessage) onMessage(channel, message)
        })
      },
      async unsubscribe(channel) {
        subscribed.delete(channel)
        bus.removeAllListeners(channel)
      },
      duplicate() {
        return makeClient()
      },
      // Minimal ioredis-shaped multi()/exec() pipeline — putPreview/putVerification
      // queue a couple of `set`s and exec() them in order. Real ioredis batches
      // these over one round-trip; this fake just runs them sequentially against
      // the same shared keyspace, which is observationally identical for these
      // tests (no partial-failure semantics are exercised here).
      multi() {
        const ops = []
        const chain = {
          set(...args) {
            ops.push(args)
            return chain
          },
          async exec() {
            for (const args of ops) await client.set(...args)
            return ops.map(() => [null, 'OK'])
          },
        }
        return chain
      },
      on(event, handler) {
        if (event === 'message') onMessage = handler
        return client
      },
      async quit() {
        return 'OK'
      },
    }
    return client
  }

  return { makeClient }
}

const cfg = () => ({ ...loadConfig(), redisUrl: 'redis://fake', previewTtlMs: 60_000 })

describe('redis store — onUpdate (fake client)', () => {
  it('subscriber receives put / update / delete events published on the primary handle', async () => {
    const { makeClient } = makeFakeRedis()
    const store = await createRedisStore(cfg(), { client: makeClient() })
    const events = []
    const unsubscribe = store.onUpdate('r-1', (evt) => events.push(evt))

    await store.putPreview('r-1', { a: 1 })
    await store.updatePreview('r-1', { a: 2 })
    await store.deletePreview('r-1')
    await sleep(20) // let queued pub/sub microtasks drain

    assert.deepEqual(events, [
      { type: 'put', tokens: { a: 1 } },
      { type: 'update', tokens: { a: 2 } },
      { type: 'delete', tokens: null },
    ])
    unsubscribe()
    await store.close()
  })

  it('a subscriber on one id never sees another id\'s events (channel isolation)', async () => {
    const { makeClient } = makeFakeRedis()
    const store = await createRedisStore(cfg(), { client: makeClient() })
    const events = []
    const unsubscribe = store.onUpdate('r-a', (evt) => events.push(evt))

    await store.putPreview('r-b', { x: 1 })
    await store.updatePreview('r-b', { x: 2 })
    await sleep(20)

    assert.deepEqual(events, [])
    unsubscribe()
    await store.close()
  })

  it('unsubscribe stops delivery', async () => {
    const { makeClient } = makeFakeRedis()
    const store = await createRedisStore(cfg(), { client: makeClient() })
    const events = []
    const unsubscribe = store.onUpdate('r-2', (evt) => events.push(evt))
    await store.putPreview('r-2', { a: 1 })
    await sleep(20)
    unsubscribe()
    await store.updatePreview('r-2', { a: 2 })
    await sleep(20)
    assert.deepEqual(events, [{ type: 'put', tokens: { a: 1 } }])
    await store.close()
  })

  it('updatePreview on a missing id publishes nothing and returns false', async () => {
    const { makeClient } = makeFakeRedis()
    const store = await createRedisStore(cfg(), { client: makeClient() })
    const events = []
    const unsubscribe = store.onUpdate('r-3', (evt) => events.push(evt))
    const updated = await store.updatePreview('r-3', { a: 1 })
    await sleep(20)
    assert.equal(updated, false)
    assert.deepEqual(events, [])
    unsubscribe()
    await store.close()
  })

  it('update() re-applies the TTL as a real PX expiry (never persistent), matching juice\'s refresh-on-update contract', async () => {
    // NOTE: juice's redis store (like its memory store, which resets createdAt)
    // deliberately REFRESHES the TTL on updatePreview — it does NOT preserve
    // the remaining window (that differs from the relay-spike's RedisStore).
    // The bar that matters for the Free-tier TTL is that update keeps a REAL
    // expiry set (never strips it to persistent/-1).
    const { makeClient } = makeFakeRedis()
    const client = makeClient()
    const store = await createRedisStore({ ...cfg(), previewTtlMs: 500 }, { client })
    await store.putPreview('r-4', { a: 1 })
    await sleep(60)
    await store.updatePreview('r-4', { a: 2 })
    const after = await client.pttl('preview:r-4')
    assert.ok(after > 0, `expected a live TTL after update, got ${after}`)
    assert.ok(after <= 500, `TTL should not exceed the configured window, got ${after}`)
    await store.close()
  })

  it('delete only publishes when the key actually existed', async () => {
    const { makeClient } = makeFakeRedis()
    const store = await createRedisStore(cfg(), { client: makeClient() })
    const events = []
    const unsubscribe = store.onUpdate('r-5', (evt) => events.push(evt))
    await store.deletePreview('r-5') // nothing there
    await sleep(20)
    assert.deepEqual(events, [])
    unsubscribe()
    await store.close()
  })
})

describe('redis store — getLatestPreview (#4b)', () => {
  it('null on a fresh store', async () => {
    const { makeClient } = makeFakeRedis()
    const store = await createRedisStore(cfg(), { client: makeClient() })
    assert.equal(await store.getLatestPreview(), null)
    await store.close()
  })

  it('returns { id, tokens, createdAt } for the most recently put preview', async () => {
    const { makeClient } = makeFakeRedis()
    const store = await createRedisStore(cfg(), { client: makeClient() })
    await store.putPreview('r-6', { a: 1 })
    const latest = await store.getLatestPreview()
    assert.equal(latest.id, 'r-6')
    assert.deepEqual(latest.tokens, { a: 1 })
    assert.equal(typeof latest.createdAt, 'number')
    await store.close()
  })

  it('newer put wins', async () => {
    const { makeClient } = makeFakeRedis()
    const store = await createRedisStore(cfg(), { client: makeClient() })
    await store.putPreview('r-7', { a: 1 })
    await store.putPreview('r-8', { a: 2 })
    const latest = await store.getLatestPreview()
    assert.equal(latest.id, 'r-8')
    await store.close()
  })

  it('updatePreview advances the latest pointer too', async () => {
    const { makeClient } = makeFakeRedis()
    const store = await createRedisStore(cfg(), { client: makeClient() })
    await store.putPreview('r-9', { a: 1 })
    await store.putPreview('r-10', { a: 2 })
    await store.updatePreview('r-9', { a: 3 })
    const latest = await store.getLatestPreview()
    assert.equal(latest.id, 'r-9')
    assert.deepEqual(latest.tokens, { a: 3 })
    await store.close()
  })
})
