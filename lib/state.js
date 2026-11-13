/**
 * dsh-roaming — shared helpers.
 *
 * Only `dshHome` is needed by the reused `sessions.js` bridge. This plugin keeps
 * its own tiny JSON state inline in `index.js` (the LAN plugin's peer/settings
 * schema does not apply to a git remote).
 */
import os from 'node:os'
import path from 'node:path'

/** Resolve the harness home directory (`$DSH_HOME` or `~/.dsh`). */
export function dshHome(config) {
  if (typeof config?.home === 'string' && config.home.length > 0) return config.home
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}
