// The `github` CODE-SOURCE connector — Option B ("point at an existing
// deployment") from spec/sorb/github-code-source-connector.md. Sorb does NOT
// clone/build/host the user's app (that's the parked Option A); it links a
// GitHub repo to the deployment URL the user ALREADY runs (Vercel/Netlify/
// their own host), so the repo-linkage that already exists for the PR target
// (`openTokenPR` in ./github.js) also names the running app.
//
// See spec/sorb/github-code-source-connector.md §1 Option B, §2 (auth reuse),
// §3 (config shape), §V (verification). Mirrors ./local.js structurally.

import * as core from '@sorb/core'

/**
 * GitHub API base, overridable for stub-testing — the same convention used by
 * `../github.js` (`openTokenPR`) so both the source-linkage and PR-target
 * calls hit the same (possibly stubbed) API host.
 * @returns {string}
 */
const apiBase = () =>
  process.env.GITHUB_API_BASE || 'https://api.github.com'

/**
 * Resolve the PAT used to authenticate GitHub API calls. Reuses the EXACT
 * credential path `openTokenPR`/`deriveGhUrl` rely on for the PR-target side
 * — one token serves both directions, never a second credential. The commit
 * flow takes this as a required CLI flag (`sorb commit --pat`); the code-
 * source side additionally accepts it from config or the environment so
 * `provision()` can run without a flag (e.g. from `sorb dev`/handshake).
 * @param {{ github?: { pat?: string } }} [config]
 * @returns {string|undefined}
 */
const resolvePat = (config = {}) =>
  (config && config.github && config.github.pat) ||
  process.env.GITHUB_PAT ||
  process.env.GITHUB_TOKEN ||
  undefined

/**
 * @param {{ github?: { repo?: string, branch?: string, deploymentUrl?: string, pat?: string, provisionMode?: string } }} [config]
 * @returns {{ repo?: string, branch?: string, deploymentUrl?: string, pat?: string, provisionMode: string }}
 */
const githubConfig = (config = {}) => (config && config.github) || {}

/** @type {import('@sorb/core').CodeSourceConnector} */
const githubCodeSource = {
  id: 'github',

  /**
   * Resolve the running app's URL. Option B: the user's EXISTING deployment
   * — Sorb never builds/hosts one. Config carries it at `github.deploymentUrl`
   * (spec §3). No fallback to a Sorb-managed URL exists (that's Option A/C,
   * out of scope here).
   * @param {{ github?: { deploymentUrl?: string } }} [config]
   * @returns {Promise<string|null>}
   */
  async resolveAppUrl(config = {}) {
    return githubConfig(config).deploymentUrl || null
  },

  /**
   * Resolve the project root dir. Option B rarely needs a local checkout —
   * most token writes go through the GitHub Contents API (`openTokenPR`), so
   * this stays lazy/minimal: an explicit `github.projectRoot` override, else
   * `process.cwd()` (same default as `local`). No cloning here — that's the
   * parked Option A's job.
   * @param {{ github?: { projectRoot?: string } }} [config]
   * @returns {string}
   */
  resolveProjectRoot(config = {}) {
    return githubConfig(config).projectRoot || process.cwd()
  },

  /**
   * Validate + LINK: confirm the repo is reachable with the configured
   * credential, confirm the deployment URL responds, and return the
   * resolved linkage. Does NOT stand up any build (Option B only — no
   * clone/build/host; that's the parked Option A/C `provisionMode`s).
   * @param {{ github?: { repo?: string, branch?: string, deploymentUrl?: string, provisionMode?: string } }} [config]
   * @returns {Promise<{ appUrl: string|null, projectRoot: string, meta: object }>}
   */
  async provision(config = {}) {
    const gh = githubConfig(config)
    const mode = gh.provisionMode || 'link'
    if (mode !== 'link') {
      // pr-preview (C) and hosted (A) are parked — see spec §1. Fail loud
      // rather than silently no-op a mode this connector doesn't implement.
      throw new Error(
        `Unsupported github provisionMode ${JSON.stringify(mode)} — only 'link' (Option B) is implemented.`,
      )
    }
    if (!gh.repo) {
      throw new Error('github.repo is required (owner/repo) to provision the github code source.')
    }
    if (!gh.deploymentUrl) {
      throw new Error('github.deploymentUrl is required (Option B: point at your existing deployment).')
    }

    const pat = resolvePat(config)
    const headers = { Accept: 'application/vnd.github+json' }
    if (pat) headers.Authorization = `Bearer ${pat}`

    let repoReachable = false
    let defaultBranch = gh.branch
    try {
      const res = await fetch(`${apiBase()}/repos/${gh.repo}`, { headers })
      if (res.ok) {
        repoReachable = true
        const data = await res.json()
        if (!defaultBranch && data && data.default_branch) {
          defaultBranch = data.default_branch
        }
      }
    } catch (e) {
      // Network error reaching the GitHub API — leave repoReachable false;
      // surfaced in meta rather than thrown, so a flaky check doesn't hard-fail.
      void e
    }

    let deploymentReachable = false
    try {
      const res = await fetch(gh.deploymentUrl, { method: 'HEAD' })
      deploymentReachable = res.ok || (res.status >= 200 && res.status < 400)
    } catch (e) {
      void e
    }

    return {
      appUrl: gh.deploymentUrl,
      projectRoot: this.resolveProjectRoot(config),
      meta: {
        repo: gh.repo,
        branch: defaultBranch || 'main',
        provisionMode: mode,
        repoReachable,
        deploymentReachable,
      },
    }
  },
}

// Register into the @sorb/core connector registry WHEN this build's core
// supports it — same older-published-core guard as local.js, kept for safety
// even though @sorb/core@0.2.0 (which has the registry) is now published.
if (typeof core.registerCodeSource === 'function') {
  core.registerCodeSource(githubCodeSource)
}

export default githubCodeSource
