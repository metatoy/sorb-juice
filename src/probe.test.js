import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { probeUrl } from './probe.js'

// probeUrl backs the `sorb handshake` reachability warnings — it must report
// listening/not-listening truthfully and NEVER throw (a probe failure may not
// fail the invite).

describe('probeUrl', () => {
  it('is true for a listening server (even on a non-200)', async () => {
    const srv = createServer((req, res) => { res.statusCode = 404; res.end('nope') })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const { port } = srv.address()
    try {
      assert.equal(await probeUrl(`http://127.0.0.1:${port}/anything`), true)
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })

  it('is false (not a throw) for a closed port', async () => {
    const srv = createServer(() => {})
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const { port } = srv.address()
    await new Promise((r) => srv.close(r))   // port now known-closed
    assert.equal(await probeUrl(`http://127.0.0.1:${port}/`), false)
  })

  it('is false on timeout instead of hanging', async () => {
    // A server that accepts but never responds — the abort timer must fire.
    const srv = createServer(() => { /* hold the request open */ })
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const { port } = srv.address()
    try {
      const t0 = Date.now()
      assert.equal(await probeUrl(`http://127.0.0.1:${port}/`, 300), false)
      assert.ok(Date.now() - t0 < 2000, 'aborted promptly')
    } finally {
      srv.closeAllConnections()
      await new Promise((r) => srv.close(r))
    }
  })
})
