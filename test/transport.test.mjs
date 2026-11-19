import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { GitRepo } from '../lib/git.js'
import { newManifest } from '../lib/manifest.js'
import { digest } from '../lib/revisions.js'
import { MAX_ARTIFACT_BYTES, publishArtifact } from '../lib/transport.js'
import { manifestRevision } from '../lib/publisher.js'

const key = 'a'.repeat(64)
function git(cwd, ...args) {
  const output = path.join(cwd, `.git-output-${Math.random().toString(36).slice(2)}`)
  const fd = fs.openSync(output, 'w+')
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', fd, 'ignore'], timeout: 60_000 })
    return fs.readFileSync(output, 'utf8').trim()
  } finally { fs.closeSync(fd); fs.rmSync(output, { force: true }) }
}
function fixture(t, valid = true) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.dsh-roaming-transport-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  const local = path.join(root, 'local')
  git(root, 'init', '--bare', remote)
  git(root, 'clone', remote, seed)
  const manifest = valid ? `${JSON.stringify(newManifest())}\n` : '{"schema":2,"conversations":{}}\n'
  fs.writeFileSync(path.join(seed, 'manifest.json'), manifest)
  fs.writeFileSync(path.join(seed, 'SCHEMA_VERSION'), '3\n')
  git(seed, 'add', 'manifest.json', 'SCHEMA_VERSION')
  git(seed, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'seed')
  git(seed, 'push', '-u', 'origin', 'HEAD')
  git(root, 'clone', remote, local)
  return { root, remote, local, repo: new GitRepo({ dir: local, remoteUrl: remote }), manifestHead: manifestRevision(valid ? newManifest() : { schema: 3, conversations: {} }) }
}
function options(f, artifact = Buffer.from('immutable artifact'), expected = null, expectedManifestHead = f.manifestHead) {
  return { repo: f.repo, key, expected, expectedManifestHead, artifact }
}
test('publishes immutable artifact with independently verified remote manifest and revision', async (t) => {
  const f = fixture(t)
  const receipt = await publishArtifact(options(f))
  assert.deepEqual(receipt, { remoteAccepted: true, head: digest('immutable artifact'), manifestHead: manifestRevision(JSON.parse(fs.readFileSync(path.join(f.local, 'manifest.json'), 'utf8'))) })
  const verifier = path.join(f.root, 'verifier')
  git(f.root, 'clone', f.remote, verifier)
  assert.equal(git(verifier, 'rev-parse', 'HEAD'), git(f.local, 'rev-parse', 'HEAD'))
  assert.equal(manifestRevision(JSON.parse(fs.readFileSync(path.join(verifier, 'manifest.json'), 'utf8'))), receipt.manifestHead)
  assert.equal(fs.readFileSync(path.join(verifier, 'objects', `${receipt.head}.bin`), 'utf8'), 'immutable artifact')
  const manifest = JSON.parse(fs.readFileSync(path.join(verifier, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.conversations[key], { parent: null, head: receipt.head })
  await assert.rejects(publishArtifact(options(f, Buffer.from('next'), null, receipt.manifestHead)), /stale-head/)
  const second = await publishArtifact(options(f, Buffer.from('next'), receipt.head, receipt.manifestHead))
  assert.equal(second.head, digest('next'))
})
test('rejects legacy mirror and does not mutate remote', async (t) => {
  const f = fixture(t, false)
  const commit = git(f.remote, 'rev-parse', 'HEAD')
  await assert.rejects(publishArtifact(options(f)), /unsupported data protocol/)
  assert.equal(git(f.remote, 'rev-parse', 'HEAD'), commit)
})
test('rejects missing data protocol marker on otherwise valid mirror', async (t) => {
  const f = fixture(t)
  fs.rmSync(path.join(f.local, 'SCHEMA_VERSION'))
  git(f.local, 'add', '-u')
  git(f.local, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'remove marker')
  await assert.rejects(publishArtifact(options(f)), /schema-3 marker required/)
})

test('rejects stale entire manifest, even when the conversation head is unchanged', async (t) => {
  const f = fixture(t)
  const commit = git(f.remote, 'rev-parse', 'HEAD')
  await assert.rejects(publishArtifact(options(f, undefined, null, digest('another manifest'))), /stale complete manifest/)
  assert.equal(git(f.remote, 'rev-parse', 'HEAD'), commit)
})
test('rejects dirty or ahead mirror before staging', async (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.local, 'unrelated.txt'), 'private')
  await assert.rejects(publishArtifact(options(f)), /dirty/)
  fs.rmSync(path.join(f.local, 'unrelated.txt'))
  fs.writeFileSync(path.join(f.local, 'manifest.json'), `${JSON.stringify({ schema: 3, conversations: {} })}\n\n`)
  git(f.local, 'add', 'manifest.json')
  git(f.local, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'ahead')
  await assert.rejects(publishArtifact(options(f, undefined, null, manifestRevision(JSON.parse(fs.readFileSync(path.join(f.local, 'manifest.json'), 'utf8'))))), /diverged/)
})
test('refuses concurrent remote update even with unchanged local manifest', async (t) => {
  const f = fixture(t)
  const writer = path.join(f.root, 'writer')
  git(f.root, 'clone', f.remote, writer)
  fs.writeFileSync(path.join(writer, 'manifest.json'), `${JSON.stringify({ schema: 3, conversations: {} })}\n\n`)
  git(writer, 'add', 'manifest.json')
  git(writer, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'other writer')
  git(writer, 'push', 'origin', 'HEAD')
  await assert.rejects(publishArtifact(options(f)), /diverged/)
  assert.equal(git(f.remote, 'rev-parse', 'HEAD'), git(writer, 'rev-parse', 'HEAD'))
})
test('bounds artifact and rejects unexpected repository files', async (t) => {
  const f = fixture(t)
  await assert.rejects(publishArtifact(options(f, Buffer.alloc(MAX_ARTIFACT_BYTES + 1))), /bounded/)
  fs.writeFileSync(path.join(f.local, 'unexpected.txt'), 'oops')
  git(f.local, 'add', 'unexpected.txt')
  git(f.local, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'unexpected')
  await assert.rejects(publishArtifact(options(f)), /unexpected data-repository content/)
})
