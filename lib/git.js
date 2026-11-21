import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const STDERR_TAIL_BYTES = 16 * 1024
const DIAGNOSTIC_CHARS = 800

// Redact before shortening: truncating first could cut a credential in half.
// Drop URLs entirely, retaining Git's surrounding DNS/SSL/auth explanation.
function sanitizeDiagnostic(text) {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']*/gi, '[redacted-url]')
    .replace(/\b[^\s<>"'@]+@[^\s<>"']+/g, '[redacted-userinfo]')
    .replace(/\b(?:github_pat_[a-z0-9_]+|gh[pousr]_[a-z0-9_]+)/gi, '[redacted-token]')
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(/\b(bearer|basic)\s+[^\s,"';]+/gi, '$1 [redacted]')
    .replace(/\b((?:access[_-]?|refresh[_-]?)?token|password|passwd|secret|credential|api[_-]?key)\b["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DIAGNOSTIC_CHARS)
}

function gitError(operation, error, stderr = '') {
  const code = typeof error?.code === 'number' ? error.code : 'unknown'
  // Spawn errors can contain argv; only their system code is safe to add.
  const detail = stderr || (typeof error?.code === 'string' ? `Git process error: ${error.code}` : '') ||
    (error?.signal ? `Git process terminated (${error.signal}; timeout possible)` : '')
  const diagnostic = sanitizeDiagnostic(detail)
  const failure = new Error(`git ${operation} failed (exit ${code})${diagnostic ? `: ${diagnostic}` : ''}`)
  failure.code = 'git-failed'
  if (diagnostic) failure.diagnostic = diagnostic
  return failure
}

// A regular, exclusively created file avoids named-pipe stdio on Windows.
// Only a bounded tail is read into memory; no argv or raw stderr is logged.
function executeGit(args, { cwd, operation, expectedFailure }) {
  return new Promise((resolve, reject) => {
    let report, fd, settled = false
    const finish = (error, code, signal) => {
      if (settled) return
      settled = true
      let stderr = ''
      try {
        if (fd !== undefined) { fs.closeSync(fd); fd = undefined }
        if (report) {
          const input = fs.openSync(report, 'r')
          try {
            const size = fs.fstatSync(input).size
            const length = Math.min(size, STDERR_TAIL_BYTES)
            const buffer = Buffer.alloc(length)
            const count = fs.readSync(input, buffer, 0, length, size - length)
            stderr = buffer.toString('utf8', 0, count)
            // If the tail starts mid-line, omit that fragment (possibly a secret).
            if (size > length) stderr = stderr.includes('\n') ? stderr.slice(stderr.indexOf('\n') + 1) : ''
          } finally { fs.closeSync(input) }
        }
      } catch { /* A diagnostic read failure must not replace the Git outcome. */ }
      finally {
        if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
        if (report) { try { fs.rmSync(report, { force: true }) } catch {} }
      }
      if (error || code !== 0 && code !== expectedFailure) reject(gitError(operation, error ?? { code, signal }, stderr))
      else resolve(code === 0)
    }
    try {
      const candidate = path.join(os.tmpdir(), `dsh-git-stderr-${process.pid}-${randomUUID()}`)
      fd = fs.openSync(candidate, 'wx', 0o600)
      report = candidate
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
      env.GIT_TERMINAL_PROMPT = '0'
      env.GCM_INTERACTIVE = 'never'
      const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'ignore', fd], timeout: 60_000 })
      child.once('error', (error) => finish(error))
      child.once('close', (code, signal) => finish(null, code, signal))
    } catch (error) { finish(error) }
  })
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

  async run(args, { cwd = this.dir, operation = args[0] } = {}) {
    await executeGit(args, { cwd, operation })
  }

  // Exit 1 (or explicitly 2 for ls-remote) is meaningful, not a fatal error.
  probe(args, operation, expectedFailure = 1) {
    return executeGit(args, { cwd: this.dir, operation, expectedFailure })
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

  // Preview never needs full history. Keep this separate from the legacy
  // mutable GitRepo sync helper, which remains unreachable from the API.
  async ensurePreviewRepo() {
    if (this.isRepo()) {
      await this.verifyRepo()
      checkMirrorSize(this.dir, this.maxMirrorBytes)
      if (await this.probe(['rev-parse', '--verify', '--quiet', 'HEAD'], 'inspect preview HEAD') &&
          !fs.existsSync(path.join(this.dir, '.git', 'shallow'))) throw new Error('preview requires a fresh shallow mirror')
      return 'ok'
    }
    if (!this.remoteUrl) throw new Error('Remote repository URL is not configured')
    if (fs.existsSync(this.dir)) {
      if (!fs.lstatSync(this.dir).isDirectory() || fs.readdirSync(this.dir).length) throw new Error('Refusing to clone into a nonempty or unsafe directory')
    } else fs.mkdirSync(path.dirname(this.dir), { recursive: true })
    await this.run(['clone', '--depth=1', '--single-branch', '--no-tags', '--no-local', '--', this.remoteUrl, this.dir], { cwd: path.dirname(this.dir), operation: 'preview clone' })
    await this.verifyRepo()
    checkMirrorSize(this.dir, this.maxMirrorBytes)
    return 'cloned'
  }

  async previewPull() {
    await this.ensurePreviewRepo()
    // A stale or locally edited checkout is not independently verified remote
    // data. Do not show its worktree after a failed or misleading pull.
    if (!(await this.probe(['diff', '--quiet'], 'inspect preview worktree')) ||
        !(await this.probe(['diff', '--cached', '--quiet'], 'inspect preview index'))) throw new Error('preview mirror is dirty')
    // Quiet status checks do not see untracked or ignored files. A temporary
    // output file avoids named pipes in confined Windows test environments.
    const report = path.join(path.dirname(this.dir), `.preview-status-${process.pid}-${Math.random().toString(36).slice(2)}`)
    const fd = fs.openSync(report, 'wx', 0o600)
    try {
      const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS') delete env[key]
      try { execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], { cwd: this.dir, env, stdio: ['ignore', fd, 'ignore'], timeout: 60_000 }) }
      catch { throw new Error('preview status unavailable') }
      if (fs.statSync(report).size > 0) throw new Error('preview mirror is dirty')
    } finally { fs.closeSync(fd); fs.rmSync(report, { force: true }) }
    if (!(await this.probe(['ls-remote', '--exit-code', '--heads', 'origin'], 'inspect remote heads', 2))) {
      // A previously materialized checkout cannot turn into an empty repository
      // without explicit migration: do not present its stale local worktree.
      if (await this.probe(['rev-parse', '--verify', '--quiet', 'HEAD'], 'inspect preview HEAD')) throw new Error('preview remote branch unavailable')
      return 'empty-remote'
    }
    await this.run(['pull', '--ff-only', '--depth=2', '--no-tags'], { operation: 'preview pull' })
    checkMirrorSize(this.dir, this.maxMirrorBytes)
    // A clean local commit ahead of origin survives ff-only pull. Compare the
    // commits, not merely the trees: the preview must represent fetched data.
    if (!(await this.probe(['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'], 'verify preview remote head')) ||
        !(await this.probe(['merge-base', '--is-ancestor', '@{upstream}', 'HEAD'], 'verify preview local head'))) {
      throw new Error('preview HEAD differs from remote')
    }
    return 'pulled'
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
