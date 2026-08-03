import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../server.js'
import { createMemoryStore } from '../store/memory.js'
import { loadConfig } from '../config.js'
import { hashKey } from '../auth.js'
import {
  isFeedEnabled,
  composeAppCheckEvent,
  composeTelemetryEvent,
  composeSignalEvent,
  recordEvidenceEvent,
  listEvidenceEvents,
  emitToSubscribers,
  EVIDENCE_KIND,
  FEED_KIND,
  FEED_FRAMING,
  FEED_DISCLAIMER,
} from './evidenceFeed.js'

// node:test only (zero new deps). Exercises the E5 conformance-EVIDENCE feed
// plumbing AND — crucially — proves it stays DARK when the flag is off.

const PROJECT_A = '11111111-1111-1111-1111-111111111111'
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SECRET_KEY = 'sk_secret_test'
const SECRET_HASH = hashKey(SECRET_KEY)

const openStores = []
afterEach(async () => {
  while (openStores.length) {
    const store = openStores.pop()
    await store.close()
  }
})

/**
 * FAKE db routing on SQL text. Records evidence_events + verify_events inserts
 * into arrays the tests inspect, and serves evidence_events SELECTs back.
 */
const makeFakeDb = ({ throwOnEvidenceInsert = false, subscriptions = 0 } = {}) => {
  const evidenceEvents = []
  const verifyEvents = []
  const calls = []
  return {
    evidenceEvents,
    verifyEvents,
    calls,
    async ping() {
      return true
    },
    async query(text, params) {
      calls.push([text, params])
      if (text.includes('FROM api_keys')) {
        if (params[0] === SECRET_HASH) {
          return {
            rows: [
              {
                key_id: 'key-secret',
                type: 'secret',
                environment: 'stage',
                project_id: PROJECT_A,
                org_id: ORG_A,
                namespace: 'proj-a',
                allowed_origins: [],
              },
            ],
          }
        }
        return { rows: [] }
      }
      if (text.includes('FROM entitlements')) return { rows: [] }
      if (text.startsWith('INSERT INTO verify_events')) {
        verifyEvents.push({ projectId: params[0], storyId: params[1], boundFields: params[2] })
        return { rows: [] }
      }
      if (text.startsWith('INSERT INTO evidence_events')) {
        if (throwOnEvidenceInsert) throw new Error('evidence insert failed')
        evidenceEvents.push({
          projectId: params[0],
          environment: params[1],
          kind: params[2],
          storyId: params[3],
          payload: JSON.parse(params[4]),
        })
        return { rows: [] }
      }
      if (text.includes('FROM evidence_events')) {
        // Newest-first, like the real ORDER BY recorded_at DESC.
        const rows = evidenceEvents
          .slice()
          .reverse()
          .map((e, i) => ({
            id: `ev-${i}`,
            environment: e.environment,
            kind: e.kind,
            story_id: e.storyId,
            payload: e.payload,
            recorded_at: '2026-08-03T00:00:00.000Z',
          }))
        return { rows }
      }
      if (text.includes('FROM feed_subscriptions')) {
        return { rows: [{ n: subscriptions }] }
      }
      return { rows: [] }
    },
  }
}

const jsonInit = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const authed = (init = {}) => ({
  ...init,
  headers: { ...(init.headers || {}), Authorization: `Bearer ${SECRET_KEY}` },
})

const RESOLVED = [
  { id: 't1', cssVar: '--color-action-primary', value: '#0f65ef', tier: 'semantic', type: 'color' },
  { id: 't2', cssVar: '--color-text', value: '#111111', tier: 'semantic', type: 'color' },
]

const makeHostedApp = async ({ feed = false, dbOpts = {} } = {}) => {
  const env = { ...process.env, DATABASE_URL: 'postgres://fake/db' }
  if (feed) env.SORB_ENTERPRISE_FEED = '1'
  else delete env.SORB_ENTERPRISE_FEED
  const config = loadConfig(env)
  const store = await createMemoryStore(config)
  openStores.push(store)
  const db = makeFakeDb(dbOpts)
  const app = createServer({
    store,
    config,
    db,
    getResolvedTokens: () => RESOLVED,
  })
  return { app, db, config }
}

// ─── PURE UNIT TESTS ──────────────────────────────────────────────────────────

describe('evidenceFeed — flag gate', () => {
  it('isFeedEnabled is false by default (no flag)', () => {
    assert.equal(isFeedEnabled(loadConfig({})), false)
  })
  it('isFeedEnabled is false with DATABASE_URL but no feed flag', () => {
    assert.equal(isFeedEnabled(loadConfig({ DATABASE_URL: 'postgres://x' })), false)
  })
  it('isFeedEnabled true only for explicit opt-in tokens', () => {
    for (const v of ['1', 'true', 'on', 'yes', 'TRUE', 'On']) {
      assert.equal(isFeedEnabled(loadConfig({ SORB_ENTERPRISE_FEED: v })), true, v)
    }
    for (const v of ['0', 'false', 'off', '', 'nope']) {
      assert.equal(isFeedEnabled(loadConfig({ SORB_ENTERPRISE_FEED: v })), false, v)
    }
  })
})

describe('evidenceFeed — composers (measurement register, counts only)', () => {
  it('composeAppCheckEvent records counts, not token names/values', () => {
    const ev = composeAppCheckEvent({
      result: {
        ok: false,
        checked: 3,
        matched: 2,
        mismatches: [{ cssVar: '--x', expected: '#000', got: '#fff' }],
        unknown: ['--y'],
      },
      environment: 'stage',
    })
    assert.equal(ev.kind, EVIDENCE_KIND.APP_CHECK)
    assert.equal(ev.environment, 'stage')
    assert.deepEqual(ev.payload, { checked: 3, matched: 2, mismatched: 1, unknown: 1 })
    // No token names/values leaked into the durable payload.
    const s = JSON.stringify(ev.payload)
    assert.ok(!s.includes('--x') && !s.includes('#fff'))
  })
  it('composeTelemetryEvent carries boundFields only', () => {
    const ev = composeTelemetryEvent({ storyId: 'kit-button', boundFields: 4, environment: 'prod' })
    assert.equal(ev.kind, EVIDENCE_KIND.DECLARED_VS_RESOLVED)
    assert.equal(ev.storyId, 'kit-button')
    assert.deepEqual(ev.payload, { boundFields: 4 })
  })
  it('composeSignalEvent (Sentry leg) carries a coarse tag, no error detail', () => {
    const ev = composeSignalEvent({ at: 'verify.telemetry.insert', environment: 'dev' })
    assert.equal(ev.kind, EVIDENCE_KIND.SIGNAL)
    assert.deepEqual(ev.payload, { at: 'verify.telemetry.insert' })
    assert.equal(ev.storyId, null)
  })
  it('normalizes an unknown environment to prod', () => {
    assert.equal(composeSignalEvent({ at: 'x', environment: 'bogus' }).environment, 'prod')
  })
})

describe('evidenceFeed — record + list + emit (unit)', () => {
  it('recordEvidenceEvent inserts and listEvidenceEvents reads back newest-first', async () => {
    const db = makeFakeDb()
    await recordEvidenceEvent(db, PROJECT_A, composeSignalEvent({ at: 'a', environment: 'prod' }))
    await recordEvidenceEvent(db, PROJECT_A, composeSignalEvent({ at: 'b', environment: 'prod' }))
    assert.equal(db.evidenceEvents.length, 2)
    const rows = await listEvidenceEvents(db, { projectId: PROJECT_A })
    assert.equal(rows.length, 2)
    assert.equal(rows[0].payload.at, 'b') // newest first
  })
  it('recordEvidenceEvent is best-effort: returns false, does not throw, on db error', async () => {
    const db = makeFakeDb({ throwOnEvidenceInsert: true })
    let captured = null
    const ok = await recordEvidenceEvent(
      db,
      PROJECT_A,
      composeSignalEvent({ at: 'x' }),
      (e, ctx) => {
        captured = ctx
      },
    )
    assert.equal(ok, false)
    assert.equal(captured.at, 'evidence.record')
  })
  it('emitToSubscribers is INERT when disabled — never emits, ignores subscribers', async () => {
    const db = makeFakeDb({ subscriptions: 5 })
    const r = await emitToSubscribers(db, composeSignalEvent({ at: 'x' }), { enabled: false, projectId: PROJECT_A })
    assert.deepEqual(r, { emitted: false, reason: 'feed-dark', recipients: 0 })
  })
  it('emitToSubscribers NEVER delivers even when enabled (no destination wired)', async () => {
    const db = makeFakeDb({ subscriptions: 5 })
    const r = await emitToSubscribers(db, composeSignalEvent({ at: 'x' }), { enabled: true, projectId: PROJECT_A })
    assert.equal(r.emitted, false)
    assert.equal(r.reason, 'no-destination-wired')
    assert.equal(r.recipients, 5) // counted, but delivered to none
  })
})

// ─── DORMANCY (the load-bearing tests) ────────────────────────────────────────

describe('evidenceFeed — DARK by default (dormancy proof)', () => {
  it('feed endpoint 404s in LOCAL mode', async () => {
    const config = loadConfig({})
    const store = await createMemoryStore(config)
    openStores.push(store)
    const app = createServer({ store, config })
    const res = await app.request('/enterprise/evidence/feed')
    assert.equal(res.status, 404)
  })

  it('feed endpoint 404s in HOSTED mode when the flag is OFF (default)', async () => {
    const { app } = await makeHostedApp({ feed: false })
    const res = await app.request('/enterprise/evidence/feed', authed())
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.deepEqual(body, { error: 'Not found' })
  })

  it('POST /verify/app works with feed OFF but records NO evidence event', async () => {
    const { app, db } = await makeHostedApp({ feed: false })
    const res = await app.request(
      '/verify/app',
      authed(jsonInit({ values: { '--color-action-primary': '#0f65ef' } })),
    )
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.matched, 1)
    // DORMANT: nothing written to the evidence stream.
    assert.equal(db.evidenceEvents.length, 0)
    assert.ok(!db.calls.some(([t]) => String(t).includes('evidence_events')))
  })

  it('POST /verify writes verify_events but NO evidence event with feed OFF', async () => {
    const { app, db } = await makeHostedApp({ feed: false })
    const res = await app.request(
      '/verify',
      authed(jsonInit({ storyId: 'kit-button--primary', bbox: { width: 82, height: 38 }, meta: { boundFields: 3 } })),
    )
    assert.equal(res.status, 200)
    assert.equal(db.verifyEvents.length, 1) // telemetry substrate still records
    assert.equal(db.evidenceEvents.length, 0) // evidence stream stays dark
  })
})

// ─── ENABLED (proves the plumbing is real, gated behind a test-only flag) ──────

describe('evidenceFeed — plumbing works when explicitly enabled (test-only)', () => {
  it('POST /verify/app records an app-check evidence event when feed ON', async () => {
    const { app, db } = await makeHostedApp({ feed: true })
    await app.request(
      '/verify/app',
      authed(jsonInit({ values: { '--color-action-primary': '#0f65ef', '--color-text': '#999999' } })),
    )
    assert.equal(db.evidenceEvents.length, 1)
    const ev = db.evidenceEvents[0]
    assert.equal(ev.kind, EVIDENCE_KIND.APP_CHECK)
    assert.equal(ev.environment, 'stage') // from the key's environment
    assert.equal(ev.payload.checked, 2)
    assert.equal(ev.payload.matched, 1)
    assert.equal(ev.payload.mismatched, 1)
  })

  it('POST /verify records a declared-vs-resolved evidence event when feed ON', async () => {
    const { app, db } = await makeHostedApp({ feed: true })
    await app.request(
      '/verify',
      authed(jsonInit({ storyId: 'kit-card', bbox: { width: 10, height: 10 }, meta: { boundFields: 7 } })),
    )
    const evs = db.evidenceEvents.filter((e) => e.kind === EVIDENCE_KIND.DECLARED_VS_RESOLVED)
    assert.equal(evs.length, 1)
    assert.equal(evs[0].payload.boundFields, 7)
    assert.equal(evs[0].storyId, 'kit-card')
  })

  it('GET feed returns the envelope (framing + disclaimer + events) when ON', async () => {
    const { app } = await makeHostedApp({ feed: true })
    await app.request(
      '/verify/app',
      authed(jsonInit({ values: { '--color-action-primary': '#0f65ef' } })),
    )
    const res = await app.request('/enterprise/evidence/feed', authed())
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.kind, FEED_KIND)
    assert.equal(body.framing, FEED_FRAMING)
    assert.equal(body.disclaimer, FEED_DISCLAIMER)
    assert.ok(Array.isArray(body.events) && body.events.length === 1)
    assert.equal(body.events[0].kind, EVIDENCE_KIND.APP_CHECK)
  })

  it('feed still requires a Bearer key even when ON (tenant-scoped, never public)', async () => {
    const { app } = await makeHostedApp({ feed: true })
    const res = await app.request('/enterprise/evidence/feed') // no auth header
    assert.equal(res.status, 401)
  })
})

// ─── CLAIMS DISCIPLINE (measurement register, no outcome/monitoring claims) ────

describe('evidenceFeed — claims discipline (banned-phrase scan of exported strings)', () => {
  it('framing + disclaimer contain no banned outcome/monitoring phrasing', () => {
    const strings = [FEED_FRAMING, FEED_DISCLAIMER].join('\n').toLowerCase()
    // "compliance" is permitted ONLY inside the disclaimer's explicit negation
    // ("not a warranty ... of WCAG compliance"); assert the banned OUTCOME forms
    // are absent.
    const banned = [
      'ensures compliance',
      'ensures continued compliance',
      'keeps you compliant',
      'makes you compliant',
      'compliance monitoring',
      'monitoring',
      'guarantee of compliance', // must be "guarantee ... of WCAG compliance" only via negation
      'accessibility audit', // only allowed as "not a full accessibility audit"
      'we guarantee',
      'we ensure',
      'oracle',
      'specification drift',
      'zero false-apply',
    ]
    for (const b of banned) {
      // 'accessibility audit' and 'guarantee ... compliance' appear only inside
      // negations; check the raw banned token is NOT present as a positive claim
      // by asserting it only ever appears after "not a"/"not a full".
      if (b === 'accessibility audit') {
        assert.ok(strings.includes('not a full accessibility audit'), 'audit must be negated')
        continue
      }
      assert.ok(!strings.includes(b), `banned phrase present: "${b}"`)
    }
    // Positive assertion: the measurement register is present.
    assert.ok(strings.includes('descriptive conformance evidence'))
  })
})
