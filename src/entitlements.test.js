// entitlements.test.js — unit tests for normalizeEntitlements + effectiveEntitlements
//
// Covers the maxCustomDomains field introduced in pricing-project-domain-caps P1.
// Uses injected fake-db for getEntitlements; normalizeEntitlements / effectiveEntitlements
// are pure and tested without any db. Run with: pnpm test

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FREE,
  normalizeEntitlements,
  effectiveEntitlements,
  getEntitlements,
} from './entitlements.js'

// ─── FREE constant ────────────────────────────────────────────────────────────

test('FREE (v2.1 Basic) has maxCustomDomains: 1', () => {
  assert.equal(FREE.maxCustomDomains, 1)
})

test('FREE has maxProjects: 1', () => {
  assert.equal(FREE.maxProjects, 1)
})

// ─── normalizeEntitlements ────────────────────────────────────────────────────

test('normalizeEntitlements — null row returns FREE values', () => {
  const ent = normalizeEntitlements(null)
  assert.equal(ent.maxCustomDomains, FREE.maxCustomDomains)
  assert.equal(ent.maxProjects, FREE.maxProjects)
})

test('normalizeEntitlements — data missing maxCustomDomains falls back to FREE.maxCustomDomains', () => {
  const ent = normalizeEntitlements({ plan: 'team', status: 'active', data: { seats: 3 } })
  assert.equal(ent.maxCustomDomains, FREE.maxCustomDomains) // 0
})

test('normalizeEntitlements — data.maxCustomDomains = 1 (Base tier)', () => {
  const ent = normalizeEntitlements({
    plan: 'team',
    status: 'active',
    data: { maxCustomDomains: 1, maxProjects: 1 },
  })
  assert.equal(ent.maxCustomDomains, 1)
  assert.equal(ent.maxProjects, 1)
})

test('normalizeEntitlements — data.maxCustomDomains = -1 (Pro/Enterprise, unlimited)', () => {
  const ent = normalizeEntitlements({
    plan: 'enterprise',
    status: 'active',
    data: { maxCustomDomains: -1, maxProjects: -1 },
  })
  assert.equal(ent.maxCustomDomains, -1)
  assert.equal(ent.maxProjects, -1)
})

test('normalizeEntitlements — NaN in maxCustomDomains coerces to FREE value', () => {
  const ent = normalizeEntitlements({
    plan: 'team',
    status: 'active',
    data: { maxCustomDomains: 'not-a-number' },
  })
  assert.equal(ent.maxCustomDomains, FREE.maxCustomDomains)
})

test('normalizeEntitlements — data as JSON string is parsed', () => {
  const ent = normalizeEntitlements({
    plan: 'team',
    status: 'active',
    data: JSON.stringify({ maxCustomDomains: 1 }),
  })
  assert.equal(ent.maxCustomDomains, 1)
})

// ─── effectiveEntitlements ────────────────────────────────────────────────────

test('effectiveEntitlements — active team plan passes through unchanged', () => {
  const team = normalizeEntitlements({
    plan: 'team',
    status: 'active',
    data: { maxCustomDomains: 1, maxProjects: 1, seats: 2, previewPersistence: true, previewSharing: true, captureEnabled: true, maxActivePreviews: 200 },
  })
  const eff = effectiveEntitlements(team)
  assert.equal(eff.maxCustomDomains, 1)
  assert.equal(eff.plan, 'team')
  assert.equal(eff.status, 'active')
})

test('effectiveEntitlements — past_due degrades maxCustomDomains to FREE.maxCustomDomains (0)', () => {
  const team = normalizeEntitlements({
    plan: 'team',
    status: 'past_due',
    data: { maxCustomDomains: 1, maxProjects: 1 },
  })
  const eff = effectiveEntitlements(team)
  assert.equal(eff.maxCustomDomains, FREE.maxCustomDomains) // 0
  assert.equal(eff.plan, 'team')   // plan preserved for CTA
  assert.equal(eff.status, 'past_due')
})

test('effectiveEntitlements — canceled degrades maxCustomDomains to FREE.maxCustomDomains (0)', () => {
  const ent = normalizeEntitlements({
    plan: 'enterprise',
    status: 'canceled',
    data: { maxCustomDomains: -1, maxProjects: -1 },
  })
  const eff = effectiveEntitlements(ent)
  assert.equal(eff.maxCustomDomains, FREE.maxCustomDomains)
  assert.equal(eff.maxProjects, FREE.maxProjects)
})

test('effectiveEntitlements — trialing passes through unchanged', () => {
  const ent = normalizeEntitlements({
    plan: 'team',
    status: 'trialing',
    data: { maxCustomDomains: 1 },
  })
  const eff = effectiveEntitlements(ent)
  assert.equal(eff.maxCustomDomains, 1)
})

// ─── getEntitlements (fake db injection) ────────────────────────────────────

test('getEntitlements — no row returns FREE', async () => {
  const fakeDb = { async query() { return { rows: [] } } }
  const ent = await getEntitlements(fakeDb, 'org-123')
  assert.equal(ent.maxCustomDomains, FREE.maxCustomDomains)
})

test('getEntitlements — row with maxCustomDomains = 1 normalizes correctly', async () => {
  const fakeDb = {
    async query() {
      return {
        rows: [{ plan: 'team', status: 'active', data: { maxCustomDomains: 1, maxProjects: 1 } }],
      }
    },
  }
  const ent = await getEntitlements(fakeDb, 'org-456')
  assert.equal(ent.maxCustomDomains, 1)
})
