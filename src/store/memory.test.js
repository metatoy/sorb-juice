// E1 (hosted-relay hardening) — onUpdate push-bus unit tests for the
// in-memory store. Server-level SSE end-to-end coverage lives in
// src/sse.test.js; this file isolates the store contract itself.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from './memory.js'
import { loadConfig } from '../config.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('memory store — onUpdate', () => {
  it('emits a put event on putPreview', async () => {
    const store = createMemoryStore(loadConfig())
    const events = []
    const unsubscribe = store.onUpdate('id-1', (evt) => events.push(evt))
    await store.putPreview('id-1', { a: 1 })
    assert.deepEqual(events, [{ type: 'put', tokens: { a: 1 } }])
    unsubscribe()
    await store.close()
  })

  it('emits an update event on updatePreview, not on a failed update', async () => {
    const store = createMemoryStore(loadConfig())
    const events = []
    await store.putPreview('id-2', { a: 1 })
    const unsubscribe = store.onUpdate('id-2', (evt) => events.push(evt))
    const updated = await store.updatePreview('id-2', { a: 2 })
    assert.equal(updated, true)
    const missed = await store.updatePreview('does-not-exist', { a: 3 })
    assert.equal(missed, false)
    assert.deepEqual(events, [{ type: 'update', tokens: { a: 2 } }])
    unsubscribe()
    await store.close()
  })

  it('emits a delete event on deletePreview, only when an entry existed', async () => {
    const store = createMemoryStore(loadConfig())
    const events = []
    await store.putPreview('id-3', { a: 1 })
    const unsubscribe = store.onUpdate('id-3', (evt) => events.push(evt))
    await store.deletePreview('id-3')
    await store.deletePreview('id-3') // second delete: no-op, no duplicate event
    assert.deepEqual(events, [{ type: 'delete', tokens: null }])
    unsubscribe()
    await store.close()
  })

  it('a subscriber on one id never sees events for a different id', async () => {
    const store = createMemoryStore(loadConfig())
    const events = []
    const unsubscribe = store.onUpdate('id-a', (evt) => events.push(evt))
    await store.putPreview('id-b', { x: 1 })
    await store.updatePreview('id-b', { x: 2 })
    assert.deepEqual(events, [])
    unsubscribe()
    await store.close()
  })

  it('unsubscribe stops delivery', async () => {
    const store = createMemoryStore(loadConfig())
    const events = []
    const unsubscribe = store.onUpdate('id-4', (evt) => events.push(evt))
    await store.putPreview('id-4', { a: 1 })
    unsubscribe()
    await store.updatePreview('id-4', { a: 2 })
    assert.deepEqual(events, [{ type: 'put', tokens: { a: 1 } }])
    await store.close()
  })

  it('emits a delete event when TTL expiry fires via the lazy getPreview() check', async () => {
    const store = createMemoryStore(loadConfig({ PREVIEW_TTL_MS: '20' }))
    const events = []
    await store.putPreview('id-5', { a: 1 })
    const unsubscribe = store.onUpdate('id-5', (evt) => events.push(evt))
    await sleep(40)
    const entry = await store.getPreview('id-5')
    assert.equal(entry, null)
    assert.deepEqual(events, [{ type: 'delete', tokens: null }])
    unsubscribe()
    await store.close()
  })

  it('supports many concurrent listeners on the same id without a max-listeners warning', async () => {
    const store = createMemoryStore(loadConfig())
    const counts = []
    const unsubscribes = []
    for (let i = 0; i < 30; i++) {
      let count = 0
      unsubscribes.push(store.onUpdate('id-6', () => { count += 1 }))
      counts.push(() => count)
    }
    await store.putPreview('id-6', { a: 1 })
    for (const getCount of counts) assert.equal(getCount(), 1)
    for (const u of unsubscribes) u()
    await store.close()
  })
})

describe('memory store — getLatestPreview (#4b)', () => {
  it('null on a fresh store', async () => {
    const store = createMemoryStore(loadConfig())
    assert.equal(await store.getLatestPreview(), null)
    await store.close()
  })

  it('returns { id, tokens, createdAt } for the most recently put preview', async () => {
    const store = createMemoryStore(loadConfig())
    await store.putPreview('id-7', { a: 1 })
    const latest = await store.getLatestPreview()
    assert.equal(latest.id, 'id-7')
    assert.deepEqual(latest.tokens, { a: 1 })
    assert.equal(typeof latest.createdAt, 'number')
    await store.close()
  })

  it('newer put wins', async () => {
    const store = createMemoryStore(loadConfig())
    await store.putPreview('id-8', { a: 1 })
    await store.putPreview('id-9', { a: 2 })
    const latest = await store.getLatestPreview()
    assert.equal(latest.id, 'id-9')
    await store.close()
  })

  it('updatePreview advances the latest pointer too', async () => {
    const store = createMemoryStore(loadConfig())
    await store.putPreview('id-10', { a: 1 })
    await store.putPreview('id-11', { a: 2 })
    await store.updatePreview('id-10', { a: 3 })
    const latest = await store.getLatestPreview()
    assert.equal(latest.id, 'id-10')
    assert.deepEqual(latest.tokens, { a: 3 })
    await store.close()
  })

  it('null after the latest preview is explicitly deleted', async () => {
    const store = createMemoryStore(loadConfig())
    await store.putPreview('id-12', { a: 1 })
    await store.deletePreview('id-12')
    assert.equal(await store.getLatestPreview(), null)
    await store.close()
  })

  it('null after the latest preview TTL-expires', async () => {
    const store = createMemoryStore(loadConfig({ PREVIEW_TTL_MS: '20' }))
    await store.putPreview('id-13', { a: 1 })
    await sleep(40)
    assert.equal(await store.getLatestPreview(), null)
    await store.close()
  })
})
