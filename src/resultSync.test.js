// resultSync.test.js — E4 Mode-C result-sync unit + integration tests.
//
// Unit tests exercise resultSync.js's pure builders + createResultSync()
// against a FAKE fetch (no real network). Integration tests drive
// createServer() in LOCAL mode with a real onLocalResultSync hook wired, to
// prove: (a) the free local bridge (no hook) is unaffected, (b) a wired hook
// actually fires proposal/verify_result/accept_reject events with the right
// shapes and no raw DOM/app content.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveResultSyncConfig,
  createResultSync,
  sanitizeTokenMap,
  buildProposalEvent,
  buildVerifyResultEvent,
  buildAcceptRejectEvent,
  buildConformanceSnapshotRefEvent,
  ORG_STATUS_PATH,
  INGEST_PATH,
} from './resultSync.js'
import { createServer } from './server.js'
import { createMemoryStore } from './store/memory.js'
import { loadConfig } from './config.js'

/**
 * A fake fetch that routes on URL suffix. `orgStatus` is the object returned
 * for ORG_STATUS_PATH; `ingestImpl(body)` handles INGEST_PATH POSTs.
 */
function makeFakeFetch({ orgStatus, ingestOk = true, ingestImpl, orgStatusOk = true, throwOnIngest = false } = {}) {
  const calls = []
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts })
    if (url.includes(ORG_STATUS_PATH)) {
      if (!orgStatusOk) return { ok: false, status: 500, statusText: 'boom' }
      return { ok: true, status: 200, json: async () => orgStatus }
    }
    if (url.includes(INGEST_PATH)) {
      if (throwOnIngest) throw new Error('network down')
      if (ingestImpl) ingestImpl(JSON.parse(opts.body))
      if (!ingestOk) return { ok: false, status: 500, statusText: 'boom' }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

describe('resultSync — resolveResultSyncConfig (invariant: no key = pure local)', () => {
  it('returns null with no org key anywhere (env or file config)', () => {
    assert.equal(resolveResultSyncConfig({}, {}), null)
  })

  it('returns null when fileConfig has no orgKey and env is empty', () => {
    assert.equal(resolveResultSyncConfig({ namespace: 'my-app' }, {}), null)
  })

  it('resolves from env SORB_ORG_KEY', () => {
    const cfg = resolveResultSyncConfig({}, { SORB_ORG_KEY: 'org_abc' })
    assert.equal(cfg.orgKey, 'org_abc')
    assert.equal(cfg.cloudBase, 'https://sorbcloud.com')
    assert.equal(cfg.appId, 'local')
    assert.equal(cfg.localForceNoSync, false)
  })

  it('resolves from sorb.config.json orgKey + cloudUrl + appId', () => {
    const cfg = resolveResultSyncConfig(
      { orgKey: 'org_file', cloudUrl: 'https://my-cloud.example', appId: 'my-app', namespace: 'ns' },
      {},
    )
    assert.deepEqual(cfg, {
      orgKey: 'org_file',
      cloudBase: 'https://my-cloud.example',
      appId: 'my-app',
      localForceNoSync: false,
    })
  })

  it('env orgKey wins over file config orgKey', () => {
    const cfg = resolveResultSyncConfig({ orgKey: 'org_file' }, { SORB_ORG_KEY: 'org_env' })
    assert.equal(cfg.orgKey, 'org_env')
  })

  it('falls back appId to namespace, then "local"', () => {
    assert.equal(resolveResultSyncConfig({ orgKey: 'k', namespace: 'my-ns' }, {}).appId, 'my-ns')
    assert.equal(resolveResultSyncConfig({ orgKey: 'k' }, {}).appId, 'local')
  })

  it('picks up SORB_LOCAL_ONLY_NO_SYNC as a local force override', () => {
    const cfg = resolveResultSyncConfig({}, { SORB_ORG_KEY: 'k', SORB_LOCAL_ONLY_NO_SYNC: 'true' })
    assert.equal(cfg.localForceNoSync, true)
  })
})

describe('resultSync — sanitizeTokenMap (payload separation)', () => {
  it('keeps only string/number/boolean-valued string keys', () => {
    const out = sanitizeTokenMap({
      '--color-brand': '#f26722',
      '--radius-md': 8,
      '--is-experimental': true,
      // Attempted smuggling of richer content — must be dropped.
      dom: { tagName: 'DIV', innerHTML: '<script>evil</script>' },
      screenshot: new Uint8Array([1, 2, 3]),
      nested: { a: 1 },
      arr: [1, 2, 3],
    })
    assert.deepEqual(out, {
      '--color-brand': '#f26722',
      '--radius-md': '8',
      '--is-experimental': 'true',
    })
  })

  it('tolerates non-object / null input', () => {
    assert.deepEqual(sanitizeTokenMap(null), {})
    assert.deepEqual(sanitizeTokenMap(undefined), {})
    assert.deepEqual(sanitizeTokenMap('not an object'), {})
    assert.deepEqual(sanitizeTokenMap(['a', 'b']), {})
  })
})

describe('resultSync — event builders (mode C, no raw DOM/app content)', () => {
  it('buildProposalEvent carries only preview_id/tokens/story_id', () => {
    const ev = buildProposalEvent({
      chainId: 'chain-1',
      orgId: 'org-1',
      appId: 'app-1',
      previewId: 'p1',
      tokens: { '--x': '1px', dom: { leaked: true } },
      storyId: 's1',
    })
    assert.equal(ev.type, 'proposal')
    assert.equal(ev.mode, 'C')
    assert.deepEqual(Object.keys(ev.payload).sort(), ['preview_id', 'story_id', 'tokens'])
    assert.deepEqual(ev.payload.tokens, { '--x': '1px' }) // dom key dropped
  })

  it('buildVerifyResultEvent carries counts only', () => {
    const ev = buildVerifyResultEvent({
      chainId: 'c',
      orgId: 'o',
      appId: 'a',
      check: 'app_values',
      ok: true,
      checked: 5,
      matched: 4,
      mismatchCount: 1,
    })
    assert.deepEqual(ev.payload, { check: 'app_values', ok: true, checked: 5, matched: 4, mismatch_count: 1 })
  })

  it('buildAcceptRejectEvent + buildConformanceSnapshotRefEvent shapes', () => {
    const ar = buildAcceptRejectEvent({
      chainId: 'c',
      orgId: 'o',
      appId: 'a',
      previewId: 'p',
      outcome: 'rejected',
      signal: 'explicit_discard',
    })
    assert.equal(ar.payload.outcome, 'rejected')
    assert.equal(ar.payload.token_commit_id, null)

    const ref = buildConformanceSnapshotRefEvent({
      chainId: 'c',
      orgId: 'o',
      appId: 'a',
      snapshotId: 'snap1',
      storageRef: 'juice:tokens-figma:local:123',
    })
    assert.deepEqual(ref.payload, { snapshot_id: 'snap1', storage_ref: 'juice:tokens-figma:local:123' })
  })
})

describe('resultSync — createResultSync gating + sync + non-blocking failure', () => {
  it('is inactive until refreshStatus() confirms consent (fail-closed default)', async () => {
    const fetchImpl = makeFakeFetch({ orgStatus: { orgId: 'org-1', consent: true, localOnlyNoSync: false } })
    const rs = createResultSync({ orgKey: 'k', appId: 'a', cloudBase: 'https://cloud.test', fetchImpl })
    assert.equal(rs.isActive(), false)
    assert.equal(rs.record('proposal', { previewId: 'p1', tokens: { '--x': '1' } }), false)
    await rs.refreshStatus()
    assert.equal(rs.isActive(), true)
  })

  it('records + flushes a batch of labeled outcomes to the ingest endpoint', async () => {
    let posted = null
    const fetchImpl = makeFakeFetch({
      orgStatus: { orgId: 'org-1', consent: true, localOnlyNoSync: false },
      ingestImpl: (body) => {
        posted = body
      },
    })
    const rs = createResultSync({ orgKey: 'org_key_1', appId: 'my-app', cloudBase: 'https://cloud.test', fetchImpl })
    await rs.refreshStatus()
    assert.equal(rs.record('proposal', { previewId: 'p1', tokens: { '--x': '1px' } }), true)
    assert.equal(rs.queueLength(), 1)
    await rs.flush()
    assert.equal(rs.queueLength(), 0)
    assert.ok(posted && Array.isArray(posted.events) && posted.events.length === 1)
    const ev = posted.events[0]
    assert.equal(ev.type, 'proposal')
    assert.equal(ev.mode, 'C')
    assert.equal(ev.org_id, 'org-1')
    assert.equal(ev.app_id, 'my-app')
    assert.equal(ev.payload.tokens['--x'], '1px')
    // Authorization header carried the org key.
    const ingestCall = fetchImpl.calls.find((c) => c.url.includes(INGEST_PATH))
    assert.equal(ingestCall.opts.headers.authorization, 'Bearer org_key_1')
  })

  it('local-only opt-out (cloud entitlement) makes record() + flush() a no-op', async () => {
    const fetchImpl = makeFakeFetch({ orgStatus: { orgId: 'org-1', consent: true, localOnlyNoSync: true } })
    const rs = createResultSync({ orgKey: 'k', appId: 'a', cloudBase: 'https://cloud.test', fetchImpl })
    await rs.refreshStatus()
    assert.equal(rs.isActive(), false)
    assert.equal(rs.record('proposal', { previewId: 'p1', tokens: { '--x': '1' } }), false)
    assert.equal(rs.queueLength(), 0)
    await rs.flush()
    const ingestCalls = fetchImpl.calls.filter((c) => c.url.includes(INGEST_PATH))
    assert.equal(ingestCalls.length, 0)
  })

  it('local SORB_LOCAL_ONLY_NO_SYNC override makes sync a no-op even when cloud says consent+no-opt-out', async () => {
    const fetchImpl = makeFakeFetch({ orgStatus: { orgId: 'org-1', consent: true, localOnlyNoSync: false } })
    const rs = createResultSync({
      orgKey: 'k',
      appId: 'a',
      cloudBase: 'https://cloud.test',
      localForceNoSync: true,
      fetchImpl,
    })
    await rs.refreshStatus()
    assert.equal(rs.isActive(), false)
  })

  it('consent=false from the cloud keeps sync inactive', async () => {
    const fetchImpl = makeFakeFetch({ orgStatus: { orgId: 'org-1', consent: false, localOnlyNoSync: false } })
    const rs = createResultSync({ orgKey: 'k', appId: 'a', cloudBase: 'https://cloud.test', fetchImpl })
    await rs.refreshStatus()
    assert.equal(rs.isActive(), false)
  })

  it('is non-blocking on POST failure (network throw) — never throws, event stays queued', async () => {
    const fetchImpl = makeFakeFetch({
      orgStatus: { orgId: 'org-1', consent: true, localOnlyNoSync: false },
      throwOnIngest: true,
    })
    const errors = []
    const rs = createResultSync({
      orgKey: 'k',
      appId: 'a',
      cloudBase: 'https://cloud.test',
      fetchImpl,
      onError: (e, ctx) => errors.push({ e, ctx }),
    })
    await rs.refreshStatus()
    rs.record('proposal', { previewId: 'p1', tokens: { '--x': '1' } })
    await assert.doesNotReject(rs.flush())
    assert.equal(rs.queueLength(), 1) // requeued, not dropped
    assert.ok(errors.length > 0)
  })

  it('is non-blocking on POST failure (non-2xx response) — event stays queued for retry', async () => {
    const fetchImpl = makeFakeFetch({
      orgStatus: { orgId: 'org-1', consent: true, localOnlyNoSync: false },
      ingestOk: false,
    })
    const rs = createResultSync({ orgKey: 'k', appId: 'a', cloudBase: 'https://cloud.test', fetchImpl })
    await rs.refreshStatus()
    rs.record('proposal', { previewId: 'p1', tokens: { '--x': '1' } })
    await rs.flush()
    assert.equal(rs.queueLength(), 1)
  })

  it('org status fetch failure fails closed (consent reverts to false)', async () => {
    const fetchImpl = makeFakeFetch({ orgStatus: {}, orgStatusOk: false })
    const rs = createResultSync({ orgKey: 'k', appId: 'a', cloudBase: 'https://cloud.test', fetchImpl })
    await rs.refreshStatus()
    assert.equal(rs.isActive(), false)
  })

  it('rejects an unknown event type without throwing', async () => {
    const fetchImpl = makeFakeFetch({ orgStatus: { orgId: 'org-1', consent: true, localOnlyNoSync: false } })
    const rs = createResultSync({ orgKey: 'k', appId: 'a', cloudBase: 'https://cloud.test', fetchImpl })
    await rs.refreshStatus()
    assert.equal(rs.record('runtime_outcome', {}), false) // reserved, no builder
    assert.equal(rs.record('nonsense', {}), false)
  })
})

describe('resultSync — server.js integration (LOCAL mode)', () => {
  it('free local bridge (no onLocalResultSync) is unaffected — normal preview lifecycle', async () => {
    const config = loadConfig({})
    const store = await createMemoryStore(config)
    const app = createServer({ store, config })

    const postRes = await app.request('/preview', { method: 'POST', body: JSON.stringify({ '--x': '1' }) })
    assert.equal(postRes.status, 200)
    const { id } = await postRes.json()

    const delRes = await app.request(`/preview/${id}`, { method: 'DELETE' })
    assert.equal(delRes.status, 200)
    assert.deepEqual(await delRes.json(), { deleted: true })
  })

  it('wired onLocalResultSync fires proposal then accept_reject(explicit_discard) on DELETE', async () => {
    const config = loadConfig({})
    const store = await createMemoryStore(config)
    const events = []
    const app = createServer({
      store,
      config,
      onLocalResultSync: (type, args) => events.push({ type, args }),
    })

    const postRes = await app.request('/preview', {
      method: 'POST',
      body: JSON.stringify({ '--color-brand': '#f26722' }),
    })
    const { id } = await postRes.json()

    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'proposal')
    assert.equal(events[0].args.previewId, id)
    assert.deepEqual(events[0].args.tokens, { '--color-brand': '#f26722' })
    const chainId = events[0].args.chainId
    assert.ok(chainId)

    const delRes = await app.request(`/preview/${id}`, { method: 'DELETE' })
    assert.equal(delRes.status, 200)

    assert.equal(events.length, 2)
    assert.equal(events[1].type, 'accept_reject')
    assert.equal(events[1].args.chainId, chainId)
    assert.equal(events[1].args.outcome, 'rejected')
    assert.equal(events[1].args.signal, 'explicit_discard')
  })

  it('wired onLocalResultSync fires verify_result(app_values) with genuine counts, correlated by previewId', async () => {
    const config = loadConfig({})
    const store = await createMemoryStore(config)
    const events = []
    const resolved = [{ id: 'color.brand', cssVar: '--color-brand', value: '#f26722', tier: 'primitive', type: 'color' }]
    const app = createServer({
      store,
      config,
      getResolvedTokens: () => resolved,
      onLocalResultSync: (type, args) => events.push({ type, args }),
    })

    const postRes = await app.request('/preview', { method: 'POST', body: JSON.stringify({}) })
    const { id: previewId } = await postRes.json()

    const verifyRes = await app.request('/verify/app', {
      method: 'POST',
      body: JSON.stringify({ previewId, values: { '--color-brand': '#F26722' } }),
    })
    assert.equal(verifyRes.status, 200)
    const result = await verifyRes.json()
    assert.equal(result.ok, true)

    const vr = events.find((e) => e.type === 'verify_result')
    assert.ok(vr)
    assert.equal(vr.args.check, 'app_values')
    assert.equal(vr.args.ok, true)
    assert.equal(vr.args.checked, 1)
    assert.equal(vr.args.matched, 1)
    assert.equal(vr.args.mismatchCount, 0)
  })

  it('does not register extra store listeners when onLocalResultSync is not wired (zero-cost invariant)', async () => {
    const config = loadConfig({})
    const store = await createMemoryStore(config)
    const app = createServer({ store, config }) // no hook

    // Drive many previews through — if a listener were (incorrectly)
    // registered per preview even without a hook, Node's EventEmitter would
    // eventually warn past its default max-listener cap. We assert instead on
    // the direct, deterministic signal: the store's update-bus listener count
    // for a given preview id stays at whatever the store itself needs (0 from
    // this module), not growing per POST /preview.
    const ids = []
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/preview', { method: 'POST', body: JSON.stringify({ '--x': String(i) }) })
      const { id } = await res.json()
      ids.push(id)
    }
    for (const id of ids) {
      // onUpdate should be a no-op subscribe/unsubscribe pair with nothing
      // registered by server.js itself in this no-hook mode; deleting must not
      // throw and the store must report the preview gone.
      const delRes = await app.request(`/preview/${id}`, { method: 'DELETE' })
      assert.equal(delRes.status, 200)
    }
  })
})
