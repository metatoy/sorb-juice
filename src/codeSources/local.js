// The `local` CODE-SOURCE connector — captures today's implicit `sorb dev`
// behavior (app URL = config.appUrl or the localhost dev-server default;
// project root = process.cwd()) as the default, registered connector. Pure
// extraction behind the `@sorb/core` contract: no new behavior.
//
// See spec/sorb/connectors-architecture.md §3.2 (CodeSourceConnector) / §4 C2.
// `provision` is intentionally unimplemented — that's the future `github`
// connector's job (v1 scope cut).

import * as core from '@sorb/core'

/** @type {import('@sorb/core').CodeSourceConnector} */
const localCodeSource = {
  id: 'local',

  /**
   * Resolve the running app's URL. Mirrors today's default precedence below
   * the CLI flag: `config.appUrl` when set, else `http://localhost:5173`.
   * The `--app` CLI override is handled at the call site and takes
   * precedence over this — this only reproduces the config-and-below half.
   * @param {{ appUrl?: string }} [config]
   * @returns {Promise<string|null>}
   */
  async resolveAppUrl(config = {}) {
    return (config && config.appUrl) || 'http://localhost:5173'
  },

  /**
   * Resolve the project root dir. Today's implicit root is always
   * `process.cwd()`. Accepts an optional `projectRoot` override on config
   * for forward-compat with future connectors; absent that, falls back to
   * cwd — today's unchanged behavior.
   * @param {{ projectRoot?: string }} [config]
   * @returns {string}
   */
  resolveProjectRoot(config = {}) {
    return (config && config.projectRoot) || process.cwd()
  },
}

// Register into the @sorb/core connector registry WHEN this build's core
// supports it. The published @sorb/core on npm can lag the connector contract
// (polyrepo publish order) — in that case the registry fns are undefined, so we
// skip registration and cli.js falls back to this connector directly. Guarding
// here keeps the hosted bridge bootable against an older published core.
if (typeof core.registerCodeSource === 'function') {
  core.registerCodeSource(localCodeSource)
}

export default localCodeSource
