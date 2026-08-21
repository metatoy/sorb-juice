import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  headUrl,
  coerceResolvedArray,
  resolveCloudConfig,
  createCloudReader,
} from './cloud.js'

// ─── headUrl ────────────────────────────────────────────────────────────────

test('headUrl appends /api/token-sets/:id/head', () => {
  assert.equal(
    headUrl('https://sorbcloud.com', 'set_123'),
    'https://sorbcloud.com/api/token-sets/set_123/head',
  )
})

test('headUrl tolerates a trailing slash and an existing /api suffix', () => {
  assert.equal(
    headUrl('https://sorbcloud.com/', 'set_123'),
    'https://sorbcloud.com/api/token-sets/set_123/head',
  )
  assert.equal(
    headUrl('http://localhost:3000/api', 'abc'),
    'http://localhost:3000/api/token-sets/abc/head',
  )
})

test('headUrl url-encodes the set id', () => {
  assert.equal(
    headUrl('https://x.com', 'a/b c'),
    'https://x.com/api/token-sets/a%2Fb%20c/head',
  )
})

// ─── coerceResolvedArray ──────────────────────────────────────────────────────

test('coerceResolvedArray accepts a bare array', () => {
  const a = [{ id: 'color.x', cssVar: '--color-x', value: '#fff', tier: 'primitive', type: 'color' }]
  assert.deepEqual(coerceResolvedArray(a), a)
})

test('coerceResolvedArray unwraps a { tokens: [...] } envelope', () => {
  const a = [{ id: 'color.x', cssVar: '--color-x', value: '#fff', tier: 'primitive', type: 'color' }]
  assert.deepEqual(coerceResolvedArray({ tokens: a }), a)
})

test('coerceResolvedArray returns null for unusable shapes', () => {
  assert.equal(coerceResolvedArray(null), null)
  assert.equal(coerceResolvedArray({}), null)
  assert.equal(coerceResolvedArray({ error: 'nope' }), null)
  assert.equal(coerceResolvedArray('string'), null)
})

// ─── resolveCloudConfig ───────────────────────────────────────────────────────

test('resolveCloudConfig returns null when cloud mode is not requested', () => {
  assert.equal(resolveCloudConfig({}, {}), null)
})

test('resolveCloudConfig reads CLI flags (flags win)', () => {
  const cfg = resolveCloudConfig(
    { cloud: true, cloudUrl: 'https://flag.com', cloudSet: 'flagset', cloudKey: 'flagkey' },
    { SORB_CLOUD_URL: 'https://env.com', SORB_CLOUD_SET: 'envset' },
  )
  assert.deepEqual(cfg, { baseUrl: 'https://flag.com', setId: 'flagset', apiKey: 'flagkey' })
})

test('resolveCloudConfig reads env (SORB_CLOUD_URL implies cloud mode)', () => {
  const cfg = resolveCloudConfig(
    {},
    { SORB_CLOUD_URL: 'https://env.com', SORB_CLOUD_SET: 'envset', SORB_CLOUD_KEY: 'k' },
  )
  assert.deepEqual(cfg, { baseUrl: 'https://env.com', setId: 'envset', apiKey: 'k' })
})

test('resolveCloudConfig honors the CLOUD_API / CLOUD_SET aliases', () => {
  const cfg = resolveCloudConfig({}, { CLOUD_API: 'https://alias.com', CLOUD_SET: 's' })
  assert.equal(cfg.baseUrl, 'https://alias.com')
  assert.equal(cfg.setId, 's')
})

test('resolveCloudConfig throws when --cloud lacks a URL', () => {
  assert.throws(() => resolveCloudConfig({ cloud: true }, {}), /requires a cloud URL/)
})

test('resolveCloudConfig throws when a URL is given without a set id', () => {
  assert.throws(
    () => resolveCloudConfig({ cloud: true, cloudUrl: 'https://x.com' }, {}),
    /requires a token-set id/,
  )
})

// ─── createCloudReader ────────────────────────────────────────────────────────

const SAMPLE = [
  { id: 'color.action.primary', cssVar: '--color-action-primary', value: '#0f65ef', tier: 'semantic', type: 'color' },
  { id: 'space.sm', cssVar: '--space-sm', value: '8px', tier: 'primitive', type: 'dimension' },
]

/** Build a fake fetch that returns the given status/body and records calls. */
function fakeFetch(responses) {
  const calls = []
  let i = 0
  const fn = async (url, init) => {
    calls.push({ url, init })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      json: async () => r.body,
    }
  }
  fn.calls = calls
  return fn
}

test('createCloudReader requires baseUrl and setId', () => {
  assert.throws(() => createCloudReader({ setId: 'x', fetchImpl: async () => {} }), /baseUrl is required/)
  assert.throws(() => createCloudReader({ baseUrl: 'x', fetchImpl: async () => {} }), /setId is required/)
})

test('getResolvedTokens is null before the first fetch, then the HEAD array', async () => {
  const fetchImpl = fakeFetch([{ body: SAMPLE }])
  const reader = createCloudReader({ baseUrl: 'https://c.com', setId: 's1', fetchImpl })
  assert.equal(reader.getResolvedTokens(), null)
  const snap = await reader.refresh()
  assert.deepEqual(snap, SAMPLE)
  assert.deepEqual(reader.getResolvedTokens(), SAMPLE)
  // hit the right URL
  assert.equal(fetchImpl.calls[0].url, 'https://c.com/api/token-sets/s1/head')
})

test('refresh sends a Bearer header when an apiKey is set', async () => {
  const fetchImpl = fakeFetch([{ body: SAMPLE }])
  const reader = createCloudReader({ baseUrl: 'https://c.com', setId: 's1', apiKey: 'secret', fetchImpl })
  await reader.refresh()
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer secret')
})

test('refresh keeps the last good snapshot on a non-OK response', async () => {
  const fetchImpl = fakeFetch([{ body: SAMPLE }, { ok: false, status: 503, statusText: 'Unavailable' }])
  const errs = []
  const reader = createCloudReader({
    baseUrl: 'https://c.com', setId: 's1', fetchImpl, onError: (e) => errs.push(e),
  })
  await reader.refresh() // good
  const snap = await reader.refresh() // 503 → keep prior
  assert.deepEqual(snap, SAMPLE)
  assert.equal(errs.length, 1)
})

test('refresh keeps the last good snapshot when fetch throws', async () => {
  let n = 0
  const throwing = async () => {
    n++
    if (n === 1) return { ok: true, status: 200, statusText: 'OK', json: async () => SAMPLE }
    throw new Error('network down')
  }
  const errs = []
  const reader = createCloudReader({
    baseUrl: 'https://c.com', setId: 's1', fetchImpl: throwing, onError: (e) => errs.push(e),
  })
  await reader.refresh()
  const snap = await reader.refresh()
  assert.deepEqual(snap, SAMPLE)
  assert.equal(errs.length, 1)
  assert.match(errs[0].message, /network down/)
})

test('start/stop run and tear down the poll loop without leaking a timer', async () => {
  const fetchImpl = fakeFetch([{ body: SAMPLE }])
  const reader = createCloudReader({ baseUrl: 'https://c.com', setId: 's1', refreshMs: 5, fetchImpl })
  reader.start()
  // eager fetch is async — give it a microtask/timer tick
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(reader.getResolvedTokens(), SAMPLE)
  reader.stop()
  // calling stop twice is safe
  reader.stop()
})
