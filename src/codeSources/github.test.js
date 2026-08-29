import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import net from 'node:net'

import githubCodeSource from './github.js'

// Unit tests for the `github` CODE-SOURCE connector (Option B — point at an
// existing deployment). Mirrors the verification plan in
// spec/sorb/github-code-source-connector.md §V: resolveAppUrl returns the
// configured deploymentUrl, provision validates + links without cloning or
// building anything, back-compat with `local` is untouched by this file.

const freePort = () =>
  new Promise((res, rej) => {
    const srv = net.createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })

describe('github code-source connector', () => {
  it('has the expected registry id', () => {
    assert.equal(githubCodeSource.id, 'github')
  })

  it('resolveAppUrl returns github.deploymentUrl (Option B: point-at-existing)', async () => {
    const url = await githubCodeSource.resolveAppUrl({
      github: { repo: 'owner/repo', deploymentUrl: 'https://my-app.vercel.app' },
    })
    assert.equal(url, 'https://my-app.vercel.app')
  })

  it('resolveAppUrl returns null when no deploymentUrl is configured (never fabricates a hosted URL)', async () => {
    const url = await githubCodeSource.resolveAppUrl({ github: { repo: 'owner/repo' } })
    assert.equal(url, null)
  })

  it('resolveProjectRoot defaults to process.cwd(), like local (no clone)', () => {
    assert.equal(githubCodeSource.resolveProjectRoot({}), process.cwd())
  })

  it('resolveProjectRoot honors an explicit github.projectRoot override', () => {
    assert.equal(
      githubCodeSource.resolveProjectRoot({ github: { projectRoot: '/tmp/checkout' } }),
      '/tmp/checkout',
    )
  })

  it('provision throws when github.repo is missing', async () => {
    await assert.rejects(
      () => githubCodeSource.provision({ github: { deploymentUrl: 'https://x.test' } }),
      /github\.repo is required/,
    )
  })

  it('provision throws when github.deploymentUrl is missing', async () => {
    await assert.rejects(
      () => githubCodeSource.provision({ github: { repo: 'owner/repo' } }),
      /github\.deploymentUrl is required/,
    )
  })

  it('provision throws on an unimplemented provisionMode (pr-preview/hosted are parked)', async () => {
    await assert.rejects(
      () =>
        githubCodeSource.provision({
          github: { repo: 'owner/repo', deploymentUrl: 'https://x.test', provisionMode: 'hosted' },
        }),
      /Unsupported github provisionMode/,
    )
  })

  it('provision validates + links against a stubbed GitHub API + deployment URL', async () => {
    // Stub GitHub API: GET /repos/:owner/:repo -> reachable, default_branch.
    const ghStub = createHttpServer((req, res) => {
      if (req.url === '/repos/owner/repo') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ default_branch: 'main' }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    })
    // Stub deployment: any HEAD returns 200.
    const deployStub = createHttpServer((req, res) => {
      res.statusCode = 200
      res.end()
    })
    const ghPort = await freePort()
    const deployPort = await freePort()
    await new Promise((r) => ghStub.listen(ghPort, '127.0.0.1', r))
    await new Promise((r) => deployStub.listen(deployPort, '127.0.0.1', r))
    const prevApiBase = process.env.GITHUB_API_BASE
    process.env.GITHUB_API_BASE = `http://127.0.0.1:${ghPort}`
    try {
      const result = await githubCodeSource.provision({
        github: {
          repo: 'owner/repo',
          deploymentUrl: `http://127.0.0.1:${deployPort}`,
        },
      })
      assert.equal(result.appUrl, `http://127.0.0.1:${deployPort}`)
      assert.equal(result.meta.repo, 'owner/repo')
      assert.equal(result.meta.branch, 'main')
      assert.equal(result.meta.provisionMode, 'link')
      assert.equal(result.meta.repoReachable, true)
      assert.equal(result.meta.deploymentReachable, true)
    } finally {
      if (prevApiBase === undefined) delete process.env.GITHUB_API_BASE
      else process.env.GITHUB_API_BASE = prevApiBase
      await new Promise((r) => ghStub.close(r))
      await new Promise((r) => deployStub.close(r))
    }
  })

  it('provision surfaces unreachable repo/deployment via meta flags instead of throwing', async () => {
    const prevApiBase = process.env.GITHUB_API_BASE
    // Point at a local port nothing listens on, so the GitHub API call fails
    // like the deployment one does — no real network call in this test.
    process.env.GITHUB_API_BASE = 'http://127.0.0.1:1'
    try {
      const result = await githubCodeSource.provision({
        github: {
          repo: 'owner/does-not-exist',
          deploymentUrl: 'http://127.0.0.1:1', // port 1 — nothing listens, connection refused
        },
      })
      assert.equal(result.meta.repoReachable, false)
      assert.equal(result.meta.deploymentReachable, false)
      // still returns the configured URL — Sorb doesn't invent one (Option B).
      assert.equal(result.appUrl, 'http://127.0.0.1:1')
    } finally {
      if (prevApiBase === undefined) delete process.env.GITHUB_API_BASE
      else process.env.GITHUB_API_BASE = prevApiBase
    }
  })
})
