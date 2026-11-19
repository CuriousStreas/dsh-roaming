import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Never include CLI arguments, remote URLs, or Git's stderr in errors/logs: all
// of them may contain embedded credentials. Exit codes are sufficient diagnostics.
function gitError(operation, error) {
  const code = typeof error?.code === 'number' ? error.code : 'unknown'
  return new Error(`git ${operation} failed (exit ${code})`)
}

const MAX_MIRROR_BYTES = 64 * 1024 * 1024

// A post-transfer disk guard, NOT a bound on network bytes or temporary Git
// allocations. Refuse links and unexpected non-file nodes before trusting a
// mirror; the caller must not treat a failed pull as a usable fresh checkout.
function checkMirrorSize(root, maxBytes) {
  let total = 0
  const dirs = [root]
  while (dirs.length) {
    const dir = dirs.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error('Git mirror contains an unsafe link')
      if (stat.isDirectory()) dirs.push(file)
      else if (stat.isFile()) {
        total += stat.size
        if (total > maxBytes) throw new Error('Git mirror exceeds disk quota')
      } else throw new Error('Git mirror contains an unsafe node')
    }
  }
}

export class GitRepo {
  constructor({ dir, remoteUrl, log, maxMirrorBytes = MAX_MIRROR_BYTES }) {
    if (!Number.isSafeInteger(maxMirrorBytes) || maxMirrorBytes < 1 || maxMirrorBytes > MAX_MIRROR_BYTES) throw new Error('invalid Git mirror quota')
    this.dir = path.resolve(dir)
    this.remoteUrl = remoteUrl ?? ''
    this.log = log ?? (() => {})
    this.maxMirrorBytes = maxMirrorBytes
  }

  run(args, { cwd = this.dir, operation = args[0] } = {}) {
    return new Promise((resolve, reject) => {
      // Ignore output rather than piping it: confined environments cannot
      // capture child stdio, and Git output can expose credential-bearing URLs.
      const env = { ...process.env }
      for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_')) delete env[key]
      }
      const child = spawn('git', args, { cwd, env, stdio: 'ignore', timeout: 60_000 })
      child.once('error', (error) => reject(gitError(operation, error)))
      child.once('close', (code) => {
        if (code !== 0) reject(gitError(operation, { code }))
        else resolve()
      })
    })
  }

  // Exit 1 is meaningful for these probes; all other failures are fatal.
  probe(args, operation, expectedFailure = 1) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env }
      for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_')) delete env[key]
      }
      const child = spawn('git', args, { cwd: this.dir, env, stdio: 'ignore', timeout: 60_000 })
      child.once('error', (error) => reject(gitError(operation, error)))
      child.once('close', (code) => {
        if (code === 0) resolve(true)
        else if (code === expectedFailure) resolve(false)
        else reject(gitError(operation, { code }))
      })
    })
  }

  isRepo() {
    try {
      return fs.lstatSync(path.join(this.dir, '.git')).isDirectory()
    } catch {
      return false
    }
  }

  async verifyRepo() {
    if (!this.isRepo()) throw new Error('Git repository missing or unsafe (.git must be a directory)')
    if (!this.remoteUrl) throw new Error('Remote repository URL is not configured')
    // Local config must contain the requested effective origin. Never silently
    // reuse a repo pointed at another remote, including one with no origin.
    if (!(await this.probe(['config', '--local', '--fixed-value', '--get', 'remote.origin.url', this.remoteUrl], 'verify origin'))) {
      throw new Error('Git origin does not match configured remote URL')
    }
    // Work only in an ordinary repository rooted here, not a linked worktree.
    const config = path.join(this.dir, '.git', 'config')
    if (!fs.existsSync(config) || !fs.statSync(config).isFile()) {
      throw new Error('Git repository config is unavailable')
    }
    await this.run(['rev-parse', '--is-inside-work-tree'], { operation: 'verify repository' })
  }

  async ensureRepo() {
    if (this.isRepo()) {
      await this.verifyRepo()
      checkMirrorSize(this.dir, this.maxMirrorBytes)
      return 'ok'
    }
    if (!this.remoteUrl) throw new Error('Remote repository URL is not configured')
    if (fs.existsSync(this.dir)) {
      const stat = fs.lstatSync(this.dir)
      if (!stat.isDirectory() || fs.readdirSync(this.dir).length) {
        throw new Error('Refusing to clone into a nonempty or unsafe directory')
      }
    } else {
      fs.mkdirSync(path.dirname(this.dir), { recursive: true })
    }
    // Git clone works with empty bare remotes (creating an unborn branch).
    // Clone failure is always fatal; never replace its partial output with init.
    await this.run(['clone', '--', this.remoteUrl, this.dir], { cwd: path.dirname(this.dir), operation: 'clone' })
    await this.verifyRepo()
    checkMirrorSize(this.dir, this.maxMirrorBytes)
    return 'cloned'
  }

  async _abortIfStuck() {
    const gitDir = path.join(this.dir, '.git')
    if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
      await this.run(['rebase', '--abort'], { operation: 'abort rebase' })
    }
    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
      await this.run(['merge', '--abort'], { operation: 'abort merge' })
    }
  }

  async pull() {
    await this.ensureRepo()
    await this._abortIfStuck()
    // An empty remote has nothing to integrate, including on a retry after
    // the first local commit (which has no upstream until its first push).
    // --exit-code reports 2 only for no matching heads; network/auth failures
    // remain fatal. A nonempty remote must still pass the ordinary pull.
    if (!(await this.probe(['ls-remote', '--exit-code', '--heads', 'origin'], 'inspect remote heads', 2))) {
      return 'empty-remote'
    }
    try {
      await this.run(['pull', '--no-rebase', '--no-edit'], { operation: 'pull' })
      checkMirrorSize(this.dir, this.maxMirrorBytes)
    } catch (error) {
      // A failed merge must not leave conflict markers for later export.
      await this._abortIfStuck()
      throw error
    }
    return 'pulled'
  }

  async hasStagedChanges() {
    return !(await this.probe(['diff', '--cached', '--quiet'], 'inspect staged changes'))
  }

  async commitAll(message) {
    await this.ensureRepo()
    await this.run(['add', '-A'], { operation: 'stage' })
    if (!(await this.hasStagedChanges())) return 'no-changes'
    await this.run(['-c', 'user.name=dsh-roaming', '-c', 'user.email=dsh-roaming@localhost', 'commit', '-m', message], { operation: 'commit' })
    return 'committed'
  }

  async push() {
    await this.ensureRepo()
    await this.run(['push', '-u', 'origin', 'HEAD'], { operation: 'push' })
  }

  async sync(message) {
    await this.pull()
    const outcome = await this.commitAll(message)
    // Even without new staged changes, an earlier failed push may have left
    // local commits pending. An empty unborn branch cannot be pushed yet.
    if (outcome === 'committed' || await this.probe(['rev-parse', '--verify', '--quiet', 'HEAD'], 'inspect HEAD')) {
      await this.push()
    }
    return outcome
  }
}
