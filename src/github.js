import pc from 'picocolors'

/**
 * @typedef {Object} CommitOptions
 * @property {string} owner
 * @property {string} repo
 * @property {string} tokenPath
 * @property {string} content
 * @property {string} message
 * @property {string} pat
 */

/**
 * Creates a branch with the updated token file and opens a PR.
 * Called by the CLI when the designer hits "commit" in the Figma plugin.
 *
 * @param {CommitOptions} opts
 * @returns {Promise<string>}
 */
export const openTokenPR = async (opts) => {
  const base = `https://api.github.com/repos/${opts.owner}/${opts.repo}`
  const headers = {
    Authorization: `Bearer ${opts.pat}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
  }

  // 1. Resolve HEAD SHA of main
  const mainRef = await fetch(`${base}/git/ref/heads/main`, { headers })
    .then((r) => r.json())
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

  // 3. Get current file SHA so we can update rather than create
  const fileRes = await fetch(`${base}/contents/${opts.tokenPath}`, {
    headers,
  })
  const fileData = fileRes.ok ? await fileRes.json() : null

  // 4. Commit the updated token file
  await fetch(`${base}/contents/${opts.tokenPath}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: opts.message,
      content: Buffer.from(opts.content).toString('base64'),
      branch: branchName,
      ...(fileData?.sha ? { sha: fileData.sha } : {}),
    }),
  })

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
