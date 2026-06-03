import { describe, it, expect } from 'vitest'
import { createServer } from './server.js'

const makeApp = () =>
  createServer('demo', () => ({}), () => null, () => null, () => null)

const jsonInit = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const TIGHT_BUTTON = { storyId: 'kit-button--primary', bbox: { width: 82, height: 38, x: 0, y: 0 } }

describe('bridge /verify', () => {
  it('POST /verify stores a tight-button geometry and returns a string id', async () => {
    const app = makeApp()
    const res = await app.request('/verify', jsonInit(TIGHT_BUTTON))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.id).toBe('string')
    expect(body.id.length).toBeGreaterThan(0)
  })
  it('GET /verify/latest reflects the most recent POST', async () => {
    const app = makeApp()
    await app.request('/verify', jsonInit(TIGHT_BUTTON))
    const res = await app.request('/verify/latest')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.storyId).toBe('kit-button--primary')
    expect(body.bbox.width).toBe(82)
    expect(body.bbox.height).toBe(38)
  })
  it('GET /verify/:id returns the same entry that was POSTed', async () => {
    const app = makeApp()
    const postRes = await app.request('/verify', jsonInit(TIGHT_BUTTON))
    const { id } = await postRes.json()
    const res = await app.request(`/verify/${id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.storyId).toBe('kit-button--primary')
    expect(body.bbox.width).toBe(82)
    expect(body.bbox.height).toBe(38)
  })
  it('GET /verify/:id returns 404 for an unknown id', async () => {
    const app = makeApp()
    const res = await app.request('/verify/does-not-exist')
    expect(res.status).toBe(404)
  })
  it('tracks "latest" across multiple POSTs (newer wins)', async () => {
    const app = makeApp()
    await app.request('/verify', jsonInit(TIGHT_BUTTON))
    await app.request('/verify', jsonInit({ storyId: 'kit-card--wide', bbox: { width: 1248, height: 320, x: 0, y: 0 } }))
    const res = await app.request('/verify/latest')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bbox.width).toBe(1248)
    expect(body.storyId).toBe('kit-card--wide')
  })
  it('GET /health includes a numeric verifications count', async () => {
    const app = makeApp()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.verifications).toBe('number')
  })
  it('does not regress POST /preview — still returns { id, url }', async () => {
    const app = makeApp()
    const res = await app.request('/preview', jsonInit({ '--btn-bg': '#abc' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.id).toBe('string')
    expect(typeof body.url).toBe('string')
    expect(body.url).toContain(body.id)
  })
})

describe('verify 404 before any report', () => {
  it('GET /verify/latest returns 404 on a fresh server with no verifications', async () => {
    const app = makeApp()
    const res = await app.request('/verify/latest')
    expect(res.status).toBe(404)
  })
})
