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
