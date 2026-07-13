import pc from 'picocolors'

/**
 * @typedef {Object} TokenFile
 * @property {string} path  Repo-relative path to commit the file at.
 * @property {string} content  UTF-8 file contents.
 */

/**
 * @typedef {Object} CommitOptions
 * @property {string} owner
 * @property {string} repo
 * @property {TokenFile[]} [files]
 *   One or more token files to commit. Preferred (matches the `tokenSources`
 *   config shape). Falls back to the legacy single `tokenPath`+`content` pair.
 * @property {string} [tokenPath]  Legacy: single-file repo path.
 * @property {string} [content]  Legacy: single-file contents.
 * @property {string} message
 * @property {string} pat
 * @property {string} [apiBase]
 *   GitHub API base URL. Defaults to `GITHUB_API_BASE` env or the public API.
 *   Overridable so the commit round-trip can be smoke-tested against a stub.
 */

/**
 * Creates a branch with the updated token file(s) and opens a PR.
 * Called by the CLI when the designer hits "commit" in the Figma plugin.
 *
 * @param {CommitOptions} opts
 * @returns {Promise<string>}
 */
export const openTokenPR = async (opts) => {
  const apiBase =
    opts.apiBase || process.env.GITHUB_API_BASE || 'https://api.github.com'
  const base = `${apiBase}/repos/${opts.owner}/${opts.repo}`
  const headers = {
    Authorization: `Bearer ${opts.pat}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
  }

  // Normalise to the multi-file shape; keep back-compat with tokenPath+content.
  const files =
    opts.files && opts.files.length
      ? opts.files
      : opts.tokenPath
        ? [{ path: opts.tokenPath, content: opts.content }]
        : []
  if (files.length === 0) {
    throw new Error('No token files to commit.')
  }

  // 1. Resolve HEAD SHA of main
  const mainRef = await fetch(`${base}/git/ref/heads/main`, { headers })
    .then((r) => r.json())
  if (!mainRef || !mainRef.object || !mainRef.object.sha) {
    // Bad credentials / missing repo / no `main` all land here — surface the
    // GitHub message instead of an opaque "reading 'sha' of undefined" crash.
    throw new Error(
      `GitHub API error resolving main branch: ${mainRef && mainRef.message ? mainRef.message : 'could not read HEAD of main'}`,
    )
  }
  const sha = mainRef.object.sha

  // 2. Create a branch named tokens/<timestamp>
  const branchName = `tokens/update-${Date.now()}`
  await fetch(`${base}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha,
    }),
  })

  // 3+4. Commit each token file onto the branch (get its current SHA first so
  // we update rather than create when the file already exists).
  for (const file of files) {
    const fileRes = await fetch(`${base}/contents/${file.path}`, { headers })
    const fileData = fileRes.ok ? await fileRes.json() : null

    await fetch(`${base}/contents/${file.path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: opts.message,
        content: Buffer.from(file.content).toString('base64'),
        branch: branchName,
        ...(fileData?.sha ? { sha: fileData.sha } : {}),
      }),
    })
  }

  // 5. Open PR
  const pr = await fetch(`${base}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: opts.message,
      head: branchName,
      base: 'main',
      body: [
        '> 🎨 Created by **Sorb**',
        '',
        'This PR was generated from the Sorb Figma plugin.',
        'Review the token diff and merge to apply changes to the app.',
      ].join('\n'),
    }),
  }).then((r) => r.json())

  return pr.html_url
}
