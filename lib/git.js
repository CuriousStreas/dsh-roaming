/**
 * Minimal git transport for the sync plugin.
 *
 * Wraps the `git` CLI (zero npm deps) with just the operations the plugin needs:
 * clone/init, pull, commit, push. All commands run with `stdio: 'ignore'` and are
 * judged by exit code only — capturing stdout/stderr through a pipe fails with
 * EPERM in confined environments, and none of our commands need their output.
 * (To debug a failing command, temporarily switch a call back to `stdio: 'pipe'`.)
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export class GitRepo {
  constructor({ dir, remoteUrl, log }) {
    this.dir = dir
    this.remoteUrl = remoteUrl ?? ''
    this.log = log ?? (() => {})
  }

  /** Run git with `stdio: 'ignore'`; reject unless the process exits 0. */
  run(args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.dir, stdio: 'ignore', ...opts }, (error) => {
        if (error) {
          reject(new Error(`git ${args[0]} 失败 (exit ${error?.code ?? '?'})`))
          return
        }
        resolve()
      })
    })
  }

  isRepo() {
    try {
      return fs.existsSync(path.join(this.dir, '.git'))
    } catch {
      return false
    }
  }

  /**
   * Make sure the local dir holds a clone of `remoteUrl`.
   * - dir exists with `.git`: leave it alone
   * - otherwise clone; an *empty* remote makes `git clone` fail, so fall back to
   *   `init` + `remote add` (the first push then creates the remote content).
   */
  async ensureRepo() {
    if (this.isRepo()) return 'ok'
    if (!this.remoteUrl) throw new Error('未配置远程仓库地址（请先 configure）')
    fs.mkdirSync(this.dir, { recursive: true })
    try {
      await this.run(['clone', this.remoteUrl, this.dir])
      return 'cloned'
    } catch {
      fs.mkdirSync(this.dir, { recursive: true })
      await this.run(['init'])
      await this.run(['remote', 'add', 'origin', this.remoteUrl])
      return 'initialized'
    }
  }

  /**
   * 清掉上次失败留下的 rebase/merge 中间态。`git pull --rebase` 一旦遇到
   * 冲突就会把仓库留在 detached HEAD + .git/rebase-merge 里，之后所有 git
   * 命令都失败，同步永久卡死。这里在每次拉取前先自救。
   */
  async _abortIfStuck() {
    const gitDir = path.join(this.dir, '.git')
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      if (fs.existsSync(path.join(gitDir, dir))) {
        await this.run(['rebase', '--abort']).catch(() => {})
      }
    }
    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
      await this.run(['merge', '--abort']).catch(() => {})
    }
  }

  /**
   * 拉取远端。刻意不用 `--rebase`（它会在冲突时把仓库卡死），改用普通合并。
   * 本地仓库只是同步缓存：冲突时回滚到拉取前状态，绝不把 conflict marker 写进
   * 数据文件；内容由下一次 commitAll/push 重新生成。
   */
  async pull() {
    await this.ensureRepo()
    await this._abortIfStuck()
    try {
      await this.run(['pull', '--no-rebase', '--no-edit'])
    } catch (error) {
      await this._abortIfStuck()
      this.log(`pull 冲突已回滚（本地仓库只是缓存，稍后重新导出即可）: ${error?.message ?? error}`)
    }
  }

  /** True when `git add` staged something: `git diff --cached --quiet` exits 1. */
  hasStagedChanges() {
    return new Promise((resolve, reject) => {
      execFile('git', ['diff', '--cached', '--quiet'], { cwd: this.dir, stdio: 'ignore' }, (error) => {
        if (error) {
          if (error?.code === 1) { resolve(true); return } // exit 1 = 有变更
          reject(new Error(`git diff --cached 失败: ${error?.message ?? error}`))
          return
        }
        resolve(false) // exit 0 = 无变更
      })
    })
  }

  /** Stage everything and commit only when there is something to commit. */
  async commitAll(message) {
    await this.ensureRepo()
    await this.run(['add', '-A'])
    if (!(await this.hasStagedChanges())) return 'no-changes'
    // A machine may have no global git identity, which makes `git commit` fail
    // with exit 128. Pin a stable per-command identity so sync never depends on
    // the host's git config.
    await this.run(['-c', 'user.name=dsh-roaming', '-c', 'user.email=dsh-roaming@localhost', 'commit', '-m', message])
    return 'committed'
  }

  async push() {
    await this.run(['push', '-u', 'origin', 'HEAD'])
  }

  /**
   * pull → commit → push. `pull` failure is not fatal (empty remote / no
   * upstream yet); `push` failure is logged so a local commit survives offline.
   */
  async sync(message) {
    await this.ensureRepo()
    try {
      await this.pull()
    } catch (error) {
      this.log(`pull 跳过: ${error?.message ?? error}`)
    }
    const outcome = await this.commitAll(message)
    if (outcome === 'committed') {
      try {
        await this.push()
      } catch (error) {
        this.log(`push 失败: ${error?.message ?? error}`)
      }
    }
    return outcome
  }
}
