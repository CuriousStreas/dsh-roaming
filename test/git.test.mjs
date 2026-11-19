import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GitRepo } from '../lib/git.js'

function git(cwd, ...args) {
  // Child-process pipes are unavailable in the confined test environment.
  const output = path.join(cwd, '.git-test-output-' + Math.random().toString(36).slice(2))
  const fd = fs.openSync(output, 'w+')
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', fd, 'ignore'] })
    return fs.readFileSync(output, 'utf8').trim()
  } finally {
    fs.closeSync(fd)
    fs.rmSync(output, { force: true })
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.dsh-roaming-git-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const remote = path.join(root, 'remote.git')
  const local = path.join(root, 'local')
  git(root, 'init', '--bare', remote)
  return { root, remote, local, repo: new GitRepo({ dir: local, remoteUrl: remote }) }
}

function seed(root, remote, name = 'seed') {
  const writer = path.join(root, name)
  git(root, 'clone', remote, writer)
  fs.writeFileSync(path.join(writer, 'remote.txt'), 'remote content\n')
  git(writer, 'add', '-A')
  git(writer, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'seed')
  git(writer, 'push', '-u', 'origin', 'HEAD')
  return writer
}

test('preview clone stays shallow and only fast-forwards, never merges local divergence', async (t) => {
  const { root, remote, local } = fixture(t)
  const writer = seed(root, remote)
  for (let n = 0; n < 3; n++) {
    fs.writeFileSync(path.join(writer, 'remote.txt'), `revision ${n}\n`)
    git(writer, 'add', '-A')
    git(writer, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', `update ${n}`)
    git(writer, 'push')
  }
  const repo = new GitRepo({ dir: local, remoteUrl: remote })
  assert.equal(await repo.ensurePreviewRepo(), 'cloned')
  assert.equal(git(local, 'rev-parse', '--is-shallow-repository'), 'true')
  assert.equal(git(local, 'rev-list', '--count', 'HEAD'), '1')
  fs.writeFileSync(path.join(writer, 'remote.txt'), 'new revision\n')
  git(writer, 'add', '-A')
  git(writer, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'latest')
  git(writer, 'push')
  assert.equal(await repo.previewPull(), 'pulled')
  assert.equal(git(local, 'rev-parse', 'HEAD'), git(writer, 'rev-parse', 'HEAD'))
  fs.writeFileSync(path.join(local, 'local.txt'), 'unpublished')
  await repo.commitAll('local divergence')
  await assert.rejects(repo.previewPull(), /preview HEAD differs from remote/)
  fs.writeFileSync(path.join(writer, 'remote.txt'), 'different revision\n')
  git(writer, 'add', '-A')
  git(writer, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'conflicting')
  git(writer, 'push')
  await assert.rejects(repo.previewPull(), /preview pull failed/)
  assert.equal(fs.existsSync(path.join(local, 'local.txt')), true)
})

test('preview does not accept a removed remote branch using stale tracking HEAD', async (t) => {
  const { root, remote, local } = fixture(t)
  const writer = seed(root, remote)
  const repo = new GitRepo({ dir: local, remoteUrl: remote })
  await repo.ensurePreviewRepo()
  const branch = git(writer, 'branch', '--show-current')
  git(root, '--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/placeholder')
  git(writer, 'push', 'origin', '--delete', branch)
  await assert.rejects(repo.previewPull(), /preview remote branch unavailable/)
})

test('preview refuses modified, untracked and ignored worktree content', async (t) => {
  const { root, remote, local } = fixture(t)
  seed(root, remote)
  const repo = new GitRepo({ dir: local, remoteUrl: remote })
  await repo.ensurePreviewRepo()
  const tracked = path.join(local, 'remote.txt')
  fs.writeFileSync(tracked, 'locally changed')
  await assert.rejects(repo.previewPull(), /preview mirror is dirty/)
  git(local, 'checkout', '--', 'remote.txt')
  fs.writeFileSync(path.join(local, 'untracked.txt'), 'local only')
  await assert.rejects(repo.previewPull(), /preview mirror is dirty/)
  fs.rmSync(path.join(local, 'untracked.txt'))
  fs.writeFileSync(path.join(local, '.gitignore'), 'ignored.txt\n')
  fs.writeFileSync(path.join(local, 'ignored.txt'), 'local only')
  await assert.rejects(repo.previewPull(), /preview mirror is dirty/)
})

test('post-transfer quota rejects oversized mirror without representing remote as fresh', async (t) => {
  const { root, remote, local } = fixture(t)
  const writer = seed(root, remote)
  const bounded = new GitRepo({ dir: local, remoteUrl: remote, maxMirrorBytes: 512 })
  await assert.rejects(bounded.ensureRepo(), /disk quota/)
  assert.equal(fs.existsSync(path.join(local, '.git')), true)
  assert.equal(fs.readFileSync(path.join(writer, 'remote.txt'), 'utf8'), 'remote content\n')
  await assert.rejects(bounded.pull(), /disk quota/)
})

test('empty remote clones and first sync creates content', async (t) => {
  const { remote, local, repo } = fixture(t)
  assert.equal(await repo.ensureRepo(), 'cloned')
  assert.equal(await repo.pull(), 'empty-remote')
  fs.writeFileSync(path.join(local, 'data.txt'), 'hello')
  assert.equal(await repo.sync('first'), 'committed')
  assert.equal(git(remote, 'rev-parse', '--verify', 'HEAD'), git(local, 'rev-parse', 'HEAD'))
})

test('existing repository must match configured origin; never modifies wrong remote', async (t) => {
  const { root, local, remote } = fixture(t)
  const wrong = path.join(root, 'wrong.git')
  git(root, 'init', '--bare', wrong)
  git(root, 'clone', wrong, local)
  const repo = new GitRepo({ dir: local, remoteUrl: remote })
  await assert.rejects(repo.ensureRepo(), /origin does not match/)
  await assert.rejects(repo.push(), /origin does not match/)
  assert.equal(git(local, 'remote', 'get-url', 'origin'), wrong)
})

test('clone failure stays fatal, without initializing a false local repo or leaking URL', async (t) => {
  const { root, local } = fixture(t)
  const secret = 'user:password'
  const missing = path.join(root, secret, 'missing.git')
  const repo = new GitRepo({ dir: local, remoteUrl: missing })
  await assert.rejects(repo.ensureRepo(), (error) => {
    assert.doesNotMatch(error.message, /password|missing\.git/)
    assert.match(error.message, /clone failed/)
    return true
  })
  assert.equal(fs.existsSync(path.join(local, '.git')), false)
})

test('pull failure is fatal and never logs credential-bearing Git diagnostics', async (t) => {
  const { root, remote, local } = fixture(t)
  seed(root, remote)
  const logs = []
  const repo = new GitRepo({ dir: local, remoteUrl: remote, log: (line) => logs.push(line) })
  await repo.ensureRepo()
  const branch = git(local, 'branch', '--show-current')
  git(local, 'branch', '--unset-upstream')
  git(local, 'config', `branch.${branch}.remote`, 'origin')
  git(local, 'config', `branch.${branch}.merge`, 'refs/heads/absent')
  await assert.rejects(repo.sync('sync'), /pull failed/)
  assert.deepEqual(logs, [])
})

test('empty unborn branch with no content does not report a pushed commit', async (t) => {
  const { remote, repo } = fixture(t)
  assert.equal(await repo.sync('empty'), 'no-changes')
  assert.throws(() => git(remote, 'rev-parse', '--verify', 'HEAD'))
})

test('unavailable remote fails closed even with a pending local commit', async (t) => {
  const { remote, local, repo } = fixture(t)
  await repo.ensureRepo()
  fs.writeFileSync(path.join(local, 'pending.txt'), 'pending')
  assert.equal(await repo.commitAll('pending'), 'committed')
  const unavailable = path.join(path.dirname(remote), 'unavailable.git')
  fs.renameSync(remote, unavailable)
  await assert.rejects(repo.sync('retry'), /inspect remote heads failed/)
  fs.renameSync(unavailable, remote)
  assert.throws(() => git(remote, 'rev-parse', '--verify', 'HEAD'))
})

test('retry pushes prior local commits despite no newly staged changes', async (t) => {
  const { remote, local, repo } = fixture(t)
  await repo.ensureRepo()
  fs.writeFileSync(path.join(local, 'retry.txt'), 'pending')
  assert.equal(await repo.commitAll('pending'), 'committed')
  assert.equal(await repo.sync('retry'), 'no-changes')
  assert.equal(git(remote, 'rev-parse', '--verify', 'HEAD'), git(local, 'rev-parse', 'HEAD'))
})

test('failed push leaves local commit for a later no-change retry', async (t) => {
  const { remote, local, repo } = fixture(t)
  await repo.ensureRepo()
  fs.writeFileSync(path.join(local, 'new.txt'), 'local')
  await repo.commitAll('pending')
  // Temporarily remove the disposable remote, then restore it.
  const unavailable = path.join(path.dirname(remote), 'unavailable.git')
  fs.renameSync(remote, unavailable)
  await assert.rejects(repo.push(), /push failed/)
  fs.renameSync(unavailable, remote)
  assert.equal(await repo.sync('again'), 'no-changes')
  assert.equal(git(remote, 'rev-parse', 'HEAD'), git(local, 'rev-parse', 'HEAD'))
})
