// P3.2 entitlement-gate unit tests. Pure — no SDK, no db, no server import.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WRITE_TOOLS,
  isWriteTool,
  writeEntitled,
  allowedTools,
  writeGateError,
} from './entitlementGate.js'

const TOOLS = [
  { name: 'list_tokens' },
  { name: 'get_token' },
  { name: 'propose_token_change' },
  { name: 'rebind_component' },
  { name: 'open_pr' },
]

test('isWriteTool / WRITE_TOOLS', () => {
  assert.equal(WRITE_TOOLS.length, 3)
  assert.ok(isWriteTool('propose_token_change'))
  assert.ok(isWriteTool('open_pr'))
  assert.equal(isWriteTool('list_tokens'), false)
})

test('writeEntitled — plan + status gate', () => {
  assert.ok(writeEntitled({ plan: 'team', status: 'active' }))
  assert.ok(writeEntitled({ plan: 'enterprise', status: 'trialing' }))
  assert.equal(writeEntitled({ plan: 'team', status: 'past_due' }), false)
  assert.equal(writeEntitled({ plan: 'team', status: 'canceled' }), false)
  assert.equal(writeEntitled({ plan: 'free', status: 'active' }), false)
  assert.equal(writeEntitled(null), false)
  assert.equal(writeEntitled(undefined), false)
})

test('allowedTools — write tools only for write-scope + write-entitled', () => {
  const team = { scope: 'write', ent: { plan: 'team', status: 'active' } }
  assert.equal(allowedTools(TOOLS, team).length, 5) // all

  const readKey = { scope: 'read', ent: { plan: 'team', status: 'active' } }
  assert.deepEqual(
    allowedTools(TOOLS, readKey).map((t) => t.name),
    ['list_tokens', 'get_token'],
  ) // publishable key → read tools only despite Team

  const freeOrg = { scope: 'write', ent: { plan: 'free', status: 'active' } }
  assert.equal(allowedTools(TOOLS, freeOrg).length, 2) // free → read only

  // no gate (stdio path never calls this, but be safe) → read only
  assert.equal(allowedTools(TOOLS, undefined).length, 2)
})

test('writeGateError — read_only before entitlement; null when allowed', () => {
  // read tool is never gated
  assert.equal(writeGateError('list_tokens', { scope: 'read' }), null)

  // publishable (read) key on a write tool → read_only, BEFORE entitlement
  assert.deepEqual(
    writeGateError('propose_token_change', { scope: 'read', ent: { plan: 'free', status: 'active' } }),
    { error: 'Publishable keys are read-only', code: 'read_only' },
  )

  // write key, free org → entitlement_required + upgradeUrl
  const e = writeGateError('open_pr', {
    scope: 'write',
    ent: { plan: 'free', status: 'active' },
    upgradeUrl: '/billing',
  })
  assert.equal(e.code, 'entitlement_required')
  assert.equal(e.upgradeUrl, '/billing')

  // write key, Team active → allowed (null)
  assert.equal(
    writeGateError('rebind_component', { scope: 'write', ent: { plan: 'team', status: 'active' } }),
    null,
  )
})
