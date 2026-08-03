import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import net from 'node:net'

// CLI smoke tests for the `sorb` binary. These run the BUILT dist/cli.js (the
// same artifact users invoke), not src — a stale dist would be a false green.
// node:test + zero new deps; every test is hermetic (temp cwd, ephemeral port,
// servers/children killed in cleanup).

const CLI = resolve(import.meta.dirname, '..', 'dist', 'cli.js')
const PKG = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf-8'),
)

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Run the CLI to completion; resolve { code, stdout, stderr }. */
const runCli = (args, opts = {}) =>
  new Promise((res) => {
    const child = spawn('node', [CLI, ...args], {
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...(opts.env || {}) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => res({ code, stdout, stderr }))
  })

/** Grab a currently-free TCP port. */
const freePort = () =>
  new Promise((res, rej) => {
    const srv = net.createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })

/** Poll http://127.0.0.1:<port><path> until it returns, or time out. */
const waitFor = async (port, path = '/health', timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`)
      return r
    } catch (e) {
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  throw new Error(`server on :${port} never came up`)
}

/** Spawn a long-lived server command; return the child (caller kills it). */
const spawnServer = (args, opts = {}) =>
  spawn('node', [CLI, ...args], {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}) },
  })

const kill = (child) =>
  new Promise((res) => {
    if (!child || child.exitCode !== null) return res()
    child.on('close', () => res())
    child.kill('SIGINT')
    // Hard-stop backstop if SIGINT is ignored.
    setTimeout(() => { try { child.kill('SIGKILL') } catch (e) { /* gone */ } }, 2000)
  })

// ─── temp cwd per suite ─────────────────────────────────────────────────────

let tmp
before(() => { tmp = mkdtempSync(join(tmpdir(), 'sorb-cli-')) })
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

const freshDir = () => mkdtempSync(join(tmp, 'case-'))

// ─── --help / --version ─────────────────────────────────────────────────────

describe('sorb --help', () => {
  it('exits 0 and lists the core commands', async () => {
    const { code, stdout } = await runCli(['--help'])
    assert.equal(code, 0)
    for (const cmd of ['dev', 'serve', 'init', 'commit', 'check']) {
      assert.ok(stdout.includes(cmd), `--help should mention '${cmd}'`)
    }
  })
})

describe('sorb --version', () => {
  it('prints the version from package.json (not a hardcoded value)', async () => {
    const { code, stdout } = await runCli(['--version'])
    assert.equal(code, 0)
    assert.equal(stdout.trim(), PKG.version)
  })
})

// ─── init ──────────────────────────────────────────────────────────────────

describe('sorb init', () => {
  it('writes a valid, parseable sorb.config.json', async () => {
    const cwd = freshDir()
    const { code } = await runCli(['init'], { cwd })
    assert.equal(code, 0)
    const cfgPath = join(cwd, 'sorb.config.json')
    assert.ok(existsSync(cfgPath), 'sorb.config.json written')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    assert.equal(typeof cfg.namespace, 'string')
    assert.ok(Array.isArray(cfg.tokenSources), 'writes a tokenSources array')
    assert.ok(cfg.tokenSources.length > 0)
  })

  it('is idempotent — a second run does not overwrite', async () => {
    const cwd = freshDir()
    await runCli(['init'], { cwd })
    const cfgPath = join(cwd, 'sorb.config.json')
    writeFileSync(cfgPath, JSON.stringify({ namespace: 'kept' }) + '\n')
    const { code } = await runCli(['init'], { cwd })
    assert.equal(code, 0)
    assert.equal(JSON.parse(readFileSync(cfgPath, 'utf-8')).namespace, 'kept')
  })
})

// ─── dev (bridge) ────────────────────────────────────────────────────────────

describe('sorb dev', () => {
  it('serves /health and /tokens/latest, then shuts down cleanly', async () => {
    const cwd = freshDir()
    const port = await freePort()
    writeFileSync(
      join(cwd, 'sorb.config.json'),
      JSON.stringify({ namespace: 'test-dev', port }) + '\n',
    )
    const child = spawnServer(['dev'], { cwd })
    try {
      const health = await waitFor(port, '/health')
      assert.equal(health.status, 200)
      const tokens = await fetch(`http://127.0.0.1:${port}/tokens/latest`)
      assert.equal(tokens.status, 200)
    } finally {
      await kill(child)
    }
  })

  it('--port OVERRIDES the config port (D5)', async () => {
    const cwd = freshDir()
    const configPort = await freePort()
    const flagPort = await freePort()
    writeFileSync(
      join(cwd, 'sorb.config.json'),
      JSON.stringify({ namespace: 'test-override', port: configPort }) + '\n',
    )
    const child = spawnServer(['dev', '--port', String(flagPort)], { cwd })
    try {
      const health = await waitFor(flagPort, '/health')
      assert.equal(health.status, 200, 'flag port should be the one serving')
      // The config port must NOT be listening.
      await assert.rejects(fetch(`http://127.0.0.1:${configPort}/health`))
    } finally {
      await kill(child)
    }
  })

  it('prints an actionable message (not a raw stack) on a port clash (D5)', async () => {
    const cwd = freshDir()
    const port = await freePort()
    writeFileSync(
      join(cwd, 'sorb.config.json'),
      JSON.stringify({ namespace: 'test-clash', port }) + '\n',
    )
    // Occupy the port first.
    const blocker = net.createServer()
    await new Promise((r) => blocker.listen(port, '127.0.0.1', r))
    try {
      const { code, stderr } = await runCli(['dev'], { cwd })
      assert.equal(code, 1, 'should exit non-zero on clash')
      assert.ok(/in use/i.test(stderr), `friendly message, got: ${stderr}`)
      assert.ok(!/EADDRINUSE\n\s+at /.test(stderr), 'no raw stack trace')
    } finally {
      await new Promise((r) => blocker.close(r))
    }
  })
})

// ─── serve (hosted) ──────────────────────────────────────────────────────────

describe('sorb serve', () => {
  it('serves /health (200) and /ready, then shuts down cleanly', async () => {
    const port = await freePort()
    const child = spawnServer(['serve'], { env: { PORT: String(port) } })
    try {
      const health = await waitFor(port, '/health')
      assert.equal(health.status, 200)
      const ready = await fetch(`http://127.0.0.1:${port}/ready`)
      assert.equal(ready.status, 200)
    } finally {
      await kill(child)
    }
  })
})

// ─── check (E4 CI subcommand) ─────────────────────────────────────────────────

describe('sorb check', () => {
  const RESOLVED = [
    { id: 'color.action.primary', cssVar: '--color-action-primary', value: '#0f65ef', tier: 'semantic', type: 'color' },
    { id: 'radius.control', cssVar: '--radius-control', value: '4px', tier: 'semantic', type: 'dimension' },
  ]

  const setup = (cwd, { resolved = RESOLVED, baseline = RESOLVED } = {}) => {
    writeFileSync(join(cwd, 'sorb.config.json'), JSON.stringify({ namespace: 'chk' }) + '\n')
    mkdirSync(join(cwd, '.sorb'), { recursive: true })
    if (resolved) writeFileSync(join(cwd, '.sorb', 'resolved.json'), JSON.stringify(resolved))
    if (baseline) writeFileSync(join(cwd, '.sorb', 'baseline.json'), JSON.stringify(baseline))
  }

  it('exits 0 when the snapshot matches the baseline (--no-build)', async () => {
    const cwd = freshDir()
    setup(cwd)
    const { code, stdout } = await runCli(['check', '--no-build'], { cwd })
    assert.equal(code, 0, stdout)
    assert.ok(/exit 0/.test(stdout), stdout)
  })

  it('exits 1 on drift and names the drifted token', async () => {
    const cwd = freshDir()
    const drifted = RESOLVED.map((t) =>
      t.cssVar === '--color-action-primary' ? { ...t, value: '#0a5be0' } : t,
    )
    setup(cwd, { resolved: drifted })
    const { code, stdout } = await runCli(['check', '--no-build'], { cwd })
    assert.equal(code, 1, stdout)
    assert.ok(/--color-action-primary/.test(stdout), stdout)
    // Codex discipline: no outcome/enforcement wording in the CLI output.
    assert.ok(!/complian|enforc|guarantee|warrant/i.test(stdout), stdout)
  })

  it('exits 2 when no resolved snapshot exists', async () => {
    const cwd = freshDir()
    setup(cwd, { resolved: null, baseline: null })
    const { code, stderr } = await runCli(['check', '--no-build'], { cwd })
    assert.equal(code, 2, stderr)
    assert.ok(/No resolved token snapshot/i.test(stderr), stderr)
  })

  it('emits machine-readable JSON with --format json', async () => {
    const cwd = freshDir()
    setup(cwd)
    const { code, stdout } = await runCli(['check', '--no-build', '--format', 'json'], { cwd })
    assert.equal(code, 0, stdout)
    const parsed = JSON.parse(stdout)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.exitCode, 0)
    assert.ok(parsed.counts && typeof parsed.counts.drift === 'number')
  })
})

// ─── commit (D1 init→commit round-trip) ──────────────────────────────────────

describe('sorb commit', () => {
  it('gives a friendly error (no crash) when no token files exist', async () => {
    const cwd = freshDir()
    await runCli(['init'], { cwd }) // writes tokenSources, but no token files on disk
    const { code, stderr } = await runCli(
      ['commit', '--owner', 'o', '--repo', 'r', '--pat', 'x'],
      { cwd },
    )
    assert.equal(code, 1)
    assert.ok(/No token files found/i.test(stderr), stderr)
    // The old bug was a raw ERR_INVALID_ARG_TYPE from readFileSync(undefined).
    assert.ok(!/ERR_INVALID_ARG_TYPE/.test(stderr), 'no raw arg-type crash')
  })

  it('init → commit round-trip succeeds against a stub GitHub API (D1)', async () => {
    const cwd = freshDir()
    // init writes tokenSources: tokens/{primitive,semantic,component}.json
    await runCli(['init'], { cwd })
    const cfg = JSON.parse(readFileSync(join(cwd, 'sorb.config.json'), 'utf-8'))
    mkdirSync(join(cwd, 'tokens'), { recursive: true })
    for (const rel of cfg.tokenSources) {
      writeFileSync(join(cwd, rel), JSON.stringify({ color: { brand: { value: '#f26722' } } }))
    }

    // Minimal GitHub API stub covering the openTokenPR call sequence.
    const puts = []
    const stub = createHttpServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        if (req.url.endsWith('/git/ref/heads/main')) {
          res.end(JSON.stringify({ object: { sha: 'deadbeef' } }))
        } else if (req.url.endsWith('/git/refs') && req.method === 'POST') {
          res.end(JSON.stringify({ ref: 'ok' }))
        } else if (req.url.includes('/contents/') && req.method === 'GET') {
          res.statusCode = 404 // new file
          res.end(JSON.stringify({ message: 'Not Found' }))
        } else if (req.url.includes('/contents/') && req.method === 'PUT') {
          puts.push(req.url)
          res.end(JSON.stringify({ content: { path: req.url } }))
        } else if (req.url.endsWith('/pulls') && req.method === 'POST') {
          res.end(JSON.stringify({ html_url: 'https://example.test/pr/1' }))
        } else {
          res.statusCode = 500
          res.end(JSON.stringify({ message: `unexpected ${req.method} ${req.url}` }))
        }
      })
    })
    const stubPort = await freePort()
    await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r))
    try {
      const { code, stdout, stderr } = await runCli(
        ['commit', '--owner', 'o', '--repo', 'r', '--pat', 'x', '--message', 'tokens'],
        { cwd, env: { GITHUB_API_BASE: `http://127.0.0.1:${stubPort}` } },
      )
      assert.equal(code, 0, `commit should exit 0. stderr: ${stderr}`)
      assert.ok(/PR opened/i.test(stdout), stdout)
      assert.ok(/example\.test\/pr\/1/.test(stdout), stdout)
      // Every configured+present token source got committed.
      assert.equal(puts.length, cfg.tokenSources.length)
    } finally {
      await new Promise((r) => stub.close(r))
    }
  })
})
