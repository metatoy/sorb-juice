import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeHandshake,
  decodeHandshake,
  toHandshakeLink,
  HANDSHAKE_PREFIX,
} from './handshake.js'

// Unit tests for the handshake token codec. The plugin (sorb-canopy) inlines the
// same logic UI-side, so this format is a shared contract — round-trip fidelity
// and accepting BOTH surface forms (raw blob / sorb:// link) are load-bearing.

describe('handshake codec', () => {
  it('round-trips a keyless-local payload', () => {
    const payload = {
      v: 1,
      origin: 'http://127.0.0.1:7777',
      appUrl: 'http://localhost:5173',
      gh: 'https://github.com/metatoy/sorb-demo/edit/main/tokens/semantic.json',
      pk: '',
      namespace: 'sorb-demo',
    }
    const blob = encodeHandshake(payload)
    // base64url alphabet only — no +, /, or = padding.
    assert.match(blob, /^[A-Za-z0-9_-]+$/)
    assert.deepEqual(decodeHandshake(blob), payload)
  })

  it('round-trips a hosted payload with pk + projectId + exp', () => {
    const payload = {
      v: 1,
      origin: 'https://bridge.sorbcloud.com',
      appUrl: 'https://demo.sorbcloud.com',
      gh: 'https://github.com/metatoy/sorb-demo/edit/main/tokens/semantic.json',
      pk: 'sorb_pk_live_9f3a7c21b8e04d56',
      projectId: 'proj_8kQ2',
      namespace: 'acme-web',
      exp: 1791590400,
    }
    assert.deepEqual(decodeHandshake(encodeHandshake(payload)), payload)
  })

  it('decodes the sorb://handshake/<blob> deep-link form too', () => {
    const payload = { v: 1, origin: 'http://127.0.0.1:7777', appUrl: 'x', gh: '', pk: '' }
    const blob = encodeHandshake(payload)
    const link = toHandshakeLink(blob)
    assert.equal(link, HANDSHAKE_PREFIX + blob)
    assert.deepEqual(decodeHandshake(link), payload)
  })

  it('tolerates surrounding whitespace (copy/paste artifacts)', () => {
    const blob = encodeHandshake({ v: 1, x: 'y' })
    assert.deepEqual(decodeHandshake(`  ${blob}\n`), { v: 1, x: 'y' })
  })

  it('throws on non-string input', () => {
    assert.throws(() => decodeHandshake(42))
    assert.throws(() => decodeHandshake(null))
  })

  it('throws on a garbage blob that is not JSON', () => {
    // base64url of "not json at all" decodes to bytes that JSON.parse rejects.
    const bad = Buffer.from('not json at all').toString('base64url')
    assert.throws(() => decodeHandshake(bad))
  })
})
