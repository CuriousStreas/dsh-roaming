import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { GitRepo } from '../lib/git.js'
import { newManifest } from '../lib/manifest.js'
import { digest } from '../lib/revisions.js'
import { createPublication, enrollPublication, preparePublication, commitPublication, acknowledgePublication, acknowledgeObservedEquality, manifestRevision, putObject } from '../lib/publisher.js'
import { publishArtifact, observeRemoteArtifact } from '../lib/transport.js'

const key = 'c'.repeat(64)
function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 60_000 }) }
function setup(t) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.dsh-roaming-e2e-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  git(root, 'init', '--bare', remote)
  git(root, 'clone', remote, seed)
  fs.writeFileSync(path.join(seed, 'SCHEMA_VERSION'), '3\n')
  fs.writeFileSync(path.join(seed, 'manifest.json'), `${JSON.stringify(newManifest())}\n`)
  git(seed, 'add', 'SCHEMA_VERSION', 'manifest.json')
  git(seed, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'v3-only seed')
  git(seed, 'push', 'origin', 'HEAD')
  const dir = (name) => path.join(root, name)
  git(root, 'clone', remote, dir('A'))
  git(root, 'clone', remote, dir('B'))
  return { root, remote, dir, repoA: new GitRepo({ dir: dir('A'), remoteUrl: remote }), repoB: new GitRepo({ dir: dir('B'), remoteUrl: remote }) }
}
function begin(state, bytes) {
  const prepared = preparePublication(state, { key, bytes, observedManifest: state.manifest })
  const committed = commitPublication(prepared, { key, observedManifest: state.manifest })
  assert.equal(committed.status, 'local-committed')
  return committed.state
}
function finish(state, receipt, mirror) {
  const verifiedManifest = JSON.parse(fs.readFileSync(path.join(mirror, 'manifest.json'), 'utf8'))
  return acknowledgePublication(state, { key, receipt, remoteManifest: verifiedManifest })
}

test('A publishes one explicitly enrolled artifact; B fetches same logical key and A rejects stale branch', async (t) => {
  const f = setup(t)
  const first = Buffer.from('same conversation rev 1')
  let A = enrollPublication(createPublication({ deviceId: 'A' }), { key, localId: 'native-A' })
  let staged = begin(A, first)
  assert.equal(staged.ledger.bindings[key].base, null)
  const receipt = await publishArtifact({ repo: f.repoA, key, expected: null, expectedManifestHead: manifestRevision(A.manifest), artifact: first })
  staged = finish(staged, receipt, f.dir('A'))
  assert.equal(staged.ledger.bindings[key].base, digest(first))
  A = staged

  await f.repoB.pull()
  const manifestB = JSON.parse(fs.readFileSync(path.join(f.dir('B'), 'manifest.json'), 'utf8'))
  assert.equal(manifestB.conversations[key].head, receipt.head)
  assert.equal(fs.readFileSync(path.join(f.dir('B'), 'objects', `${receipt.head}.bin`), 'utf8'), first.toString())
  // B has no enrollment: receiving an artifact alone must not authorize local session writes.
  let B = createPublication({ deviceId: 'B', manifest: manifestB, objects: putObject({}, first).store })
  assert.equal(Object.keys(B.ledger.bindings).length, 0)
  assert.throws(() => preparePublication(B, { key, bytes: first, observedManifest: manifestB }), /explicit enrollment required/)
  B = enrollPublication(B, { key, localId: 'roaming-B' })
  const observation = await observeRemoteArtifact({ repo: f.repoB, key })
  B = acknowledgeObservedEquality(B, { key, localBytes: first, observation })
  assert.equal(B.ledger.bindings[key].base, receipt.head)
  const divergent = Buffer.from('same conversation rev 2 from B')
  assert.equal(commitPublication(preparePublication(B, { key, bytes: divergent, observedManifest: manifestB }), { key, observedManifest: manifestB }).status, 'local-committed')
  const aSecond = Buffer.from('same conversation rev 2 from A')
  const commitA = begin(A, aSecond)
  const second = await publishArtifact({ repo: f.repoA, key, expected: receipt.head, expectedManifestHead: receipt.manifestHead, artifact: aSecond })
  const A2 = finish(commitA, second, f.dir('A'))
  assert.equal(A2.ledger.bindings[key].base, second.head)
  await assert.rejects(publishArtifact({ repo: f.repoB, key, expected: receipt.head, expectedManifestHead: receipt.manifestHead, artifact: divergent }), /diverged/)
})
