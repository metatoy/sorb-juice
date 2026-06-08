// sorbData.js — read-only .sorb/ data access layer for the MCP module.
//
// All functions are synchronous, defensive (null / [] on missing/malformed
// data), and never mutate the filesystem.
//
// .sorb/ layout:
//   resolved.json       — array of ResolvedToken {id,cssVar,value,tier,type}
//   index.json          — { version, stories: { <storyId>: { component, name, artifact } } }
//   <name>.sorb.json    — root node tree, OR { stories:[{id,root}] } (capture format)
//
// Node trees: each node may carry `sorb: { tokens:{role→tokenId}, candidates:{role→[tokenId]} }`.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** @typedef {import('@sorb/core').ResolvedToken} ResolvedToken */

// ─── Internal helpers ──────────────────────────────────────────────────────────

const readJson = (p) => {
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null }
}

/**
 * Walk a node tree depth-first, calling fn on each node.
 * @param {object} node
 * @param {(node: object) => void} fn
 */
const walkTree = (node, fn) => {
  if (!node || typeof node !== 'object') return
  fn(node)
  const ch = node.children
  if (Array.isArray(ch)) for (const c of ch) walkTree(c, fn)
}

/**
 * Load the artifact root node from an index entry.
 * Handles both the bare-root format (tests) and the capture { stories:[{root}] } format.
 * @param {string} dir
 * @param {{ artifact?: string }} entry
 * @returns {object | null}
 */
const loadArtifactRoot = (dir, entry) => {
  if (!entry || !entry.artifact) return null
  const data = readJson(resolve(dir, entry.artifact))
  if (!data) return null
  // Capture format: { stories: [{ id, root }] }
  if (Array.isArray(data.stories) && data.stories[0] && data.stories[0].root) {
    return data.stories[0].root
  }
  // Bare-root format (test fixtures and older captures): the file IS the root node.
  if (data.type) return data
  return null
}

/**
 * Collect merged { role→tokenId } bindings and candidates across a node tree.
 * @param {object} root
 * @returns {{ bindings: Record<string,string>, candidates: Record<string,string[]> }}
 */
const collectBindings = (root) => {
  const bindings = {}
  const candidates = {}
  walkTree(root, (node) => {
    const s = node.sorb
    if (!s) return
    if (s.tokens && typeof s.tokens === 'object') {
      for (const [role, id] of Object.entries(s.tokens)) {
        if (typeof id === 'string') bindings[role] = id
      }
    }
    if (s.candidates && typeof s.candidates === 'object') {
      for (const [role, ids] of Object.entries(s.candidates)) {
        if (Array.isArray(ids)) candidates[role] = ids
      }
    }
  })
  return { bindings, candidates }
}

// ─── .sorb/ readers ───────────────────────────────────────────────────────────

/**
 * Load the resolved token array from `.sorb/resolved.json`. Returns null when
 * absent or malformed.
 * @param {string} dir Project root.
 * @returns {ResolvedToken[] | null}
 */
export const loadResolved = (dir) => {
  const data = readJson(join(dir, '.sorb', 'resolved.json'))
  if (!data) return null
  const arr = Array.isArray(data) ? data : data.tokens
  return Array.isArray(arr) ? arr : null
}

/**
 * Load the stories map from `.sorb/index.json`. Returns null when absent.
 * @param {string} dir
 * @returns {Record<string,{component?:string,name?:string,artifact?:string}> | null}
 */
const loadIndex = (dir) => {
  const data = readJson(join(dir, '.sorb', 'index.json'))
  if (!data || typeof data.stories !== 'object') return null
  return data.stories
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List resolved tokens, optionally filtered by tier, type, or substring query.
 * @param {string} dir
 * @param {{ tier?: string, type?: string, q?: string }} [opts]
 * @returns {ResolvedToken[]}
 */
export const listTokens = (dir, opts = {}) => {
  let all = loadResolved(dir) || []
  if (opts.tier) all = all.filter((t) => t && t.tier === opts.tier)
  if (opts.type) all = all.filter((t) => t && t.type === opts.type)
  if (opts.q) {
    const q = opts.q.toLowerCase()
    all = all.filter(
      (t) =>
        t &&
        ((t.id && t.id.toLowerCase().includes(q)) ||
          (t.cssVar && t.cssVar.toLowerCase().includes(q)) ||
          (t.value != null && String(t.value).toLowerCase().includes(q))),
    )
  }
  return all
}

/**
 * Get a single resolved token by id, with the component usages that bind it.
 * Returns null when the token is not found.
 * @param {string} dir
 * @param {string} id Dotted token id.
 * @returns {(ResolvedToken & { usages: Array<{componentId:string,keys:string[]}> }) | null}
 */
export const getToken = (dir, id) => {
  const all = loadResolved(dir)
  if (!all) return null
  const token = all.find((t) => t && t.id === id) || null
  if (!token) return null
  return { ...token, usages: findTokenUsages(dir, id) }
}

/**
 * Resolve the current rendered value for a token by id or cssVar.
 * Returns null when neither matches.
 * @param {string} dir
 * @param {{ id?: string, cssVar?: string }} lookup
 * @returns {{ id: string, cssVar: string, value: any } | null}
 */
export const resolveValue = (dir, { id, cssVar } = {}) => {
  const all = loadResolved(dir)
  if (!all) return null
  const t =
    all.find(
      (tok) =>
        tok &&
        ((id != null && tok.id === id) ||
          (cssVar != null && tok.cssVar === cssVar)),
    ) || null
  if (!t) return null
  return { id: t.id, cssVar: t.cssVar, value: t.value }
}

/**
 * List all captured components/stories.
 * @param {string} dir
 * @returns {Array<{ id: string, component: string, name: string, artifact: string }>}
 */
export const listComponents = (dir) => {
  const stories = loadIndex(dir)
  if (!stories) return []
  return Object.entries(stories).map(([id, entry]) => ({
    id,
    component: entry.component || '',
    name: entry.name || '',
    artifact: entry.artifact || '',
  }))
}

/**
 * Get merged role→token bindings (and candidate alternatives) for a component,
 * collected across every node in its artifact tree.
 * @param {string} dir
 * @param {string} componentId Story id from listComponents.
 * @returns {{ componentId: string, bindings: Record<string,string>, candidates: Record<string,string[]> }}
 */
export const getComponentBindings = (dir, componentId) => {
  const stories = loadIndex(dir)
  const entry = stories && stories[componentId]
  if (!entry) return { componentId, bindings: {}, candidates: {} }
  const root = loadArtifactRoot(dir, entry)
  if (!root) return { componentId, bindings: {}, candidates: {} }
  return { componentId, ...collectBindings(root) }
}

/**
 * Find which components directly bind a given token id, and on which roles.
 * @param {string} dir
 * @param {string} tokenId Dotted token id.
 * @returns {Array<{ componentId: string, keys: string[] }>}
 */
export const findTokenUsages = (dir, tokenId) => {
  const stories = loadIndex(dir)
  if (!stories) return []
  const result = []
  for (const [id, entry] of Object.entries(stories)) {
    const root = loadArtifactRoot(dir, entry)
    if (!root) continue
    const keys = []
    walkTree(root, (node) => {
      const s = node.sorb
      if (!s || !s.tokens) return
      for (const [role, tId] of Object.entries(s.tokens)) {
        if (tId === tokenId) keys.push(role)
      }
    })
    if (keys.length > 0) result.push({ componentId: id, keys })
  }
  return result
}

/**
 * Find which components render a given CSS custom property, resolving the cssVar
 * to its token id first.
 * @param {string} dir
 * @param {string} cssVar CSS custom property, e.g. --color-action-primary.
 * @returns {Array<{ componentId: string, keys: string[] }>}
 */
export const findComponentsByToken = (dir, cssVar) => {
  const all = loadResolved(dir)
  if (!all) return []
  const token = all.find((t) => t && t.cssVar === cssVar)
  if (!token) return []
  return findTokenUsages(dir, token.id)
}
