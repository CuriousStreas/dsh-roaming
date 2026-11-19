// Opt-in synthetic vertical slice. No daily DSH home, plugin API, or network remote.
// Run with absolute DSH_INSTALL_ROOT pointing at the installed DSH package.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLedger, enroll } from '../lib/ledger.js'
import { newManifest } from '../lib/manifest.js'
import { manifestRevision } from '../lib/publisher.js'
import { readEnrolledSnapshot } from '../lib/read-only-snapshot.js'
import { GitRepo } from '../lib/git.js'
import { observeRemoteArtifact, publishArtifact } from '../lib/transport.js'
import { digest } from '../lib/revisions.js'

const install = process.env.DSH_INSTALL_ROOT
if (!install || !path.isAbsolute(install)) throw new Error('absolute DSH_INSTALL_ROOT required')
const moduleUrl = (name) => pathToFileURL(path.join(install, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href
const [{ Context }, Jsonl, { Session, SessionId }, { createUserMessage }] = await Promise.all([
  import(pathToFileURL(path.join(install, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href),
  import(moduleUrl('dsh-session-persistence-jsonl')),
  import(moduleUrl('dsh-session')),
  import(moduleUrl('dsh-llm')),
])
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-roaming-vertical-'))
const fibers = []
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 60_000 })
const mount = async (name) => {
  const ctx = new Context()
  const fiber = ctx.plugin(Jsonl, { root: path.join(root, name), compression: 'none' })
  fibers.push(fiber)
  await fiber.await()
  return ctx.sessionPersistence
}
try {
  const A = await mount('A-native')
  const B = await mount('B-native')
  const remote = path.join(root, 'data.git')
  const seed = path.join(root, 'seed')
  const aMirror = path.join(root, 'A-mirror')
  const bMirror = path.join(root, 'B-mirror')
  git(root, 'init', '--bare', remote)
  git(root, 'clone', remote, seed)
  await fs.writeFile(path.join(seed, 'SCHEMA_VERSION'), '3\n')
  await fs.writeFile(path.join(seed, 'manifest.json'), `${JSON.stringify(newManifest())}\n`)
  git(seed, 'add', 'SCHEMA_VERSION', 'manifest.json')
  git(seed, '-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'v3 seed')
  git(seed, 'push', 'origin', 'HEAD')
  git(root, 'clone', remote, aMirror)
  git(root, 'clone', remote, bMirror)
  const repoA = new GitRepo({ dir: aMirror, remoteUrl: remote })
  const repoB = new GitRepo({ dir: bMirror, remoteUrl: remote })
  const key = crypto.randomBytes(32).toString('hex')
  const id = SessionId(`synthetic-${crypto.randomUUID()}`)
  const session = Session.create(id)
  const events = [
    session.append('turn/start', { turn: 1 }),
    session.append('step/start', { turn: 1, step: 1 }),
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'A synthetic text' }], source: { kind: 'user' } }), { surfaceOp: 'append' }),
    session.append('step/end', { turn: 1, step: 1 }),
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    session.append('session/end-seed', {}),
  ]
  const sourceWrite = await A.create(session.header)
  try { await sourceWrite.append(events); await sourceWrite.flush() } finally { await sourceWrite.close() }
  const sourceRevision = (await A.stat(id)).revision
  const ledger = enroll(createLedger('fixture-A'), { key, localId: id })
  const snapshot = await readEnrolledSnapshot({ persistence: A, ledger, key })
  const payload = Buffer.from(JSON.stringify(snapshot.snapshot))
  assert.equal(digest(payload), snapshot.revision)
  const first = await publishArtifact({ repo: repoA, key, expected: null, expectedManifestHead: manifestRevision(newManifest()), artifact: payload })
  const observed = await observeRemoteArtifact({ repo: repoB, key })
  assert.equal(observed.head, first.head)
  assert.deepEqual(observed.object, payload)
  // Import only into the second disposable backend. No plugin API enables this path.
  const received = JSON.parse(observed.object.toString('utf8'))
  const receivedSession = Session.fromRestore(id, received.events, received.header, received.inheritedEventCount, 'detached')
  assert.deepEqual(receivedSession.deriveMessages(), session.deriveMessages())
  const targetWrite = await B.create(received.header)
  try { await targetWrite.append(received.events); await targetWrite.flush() } finally { await targetWrite.close() }
  await assert.rejects(B.create(received.header))
  // B continues the same logical conversation with a second synthetic user turn.
  const continued = [
    receivedSession.append('turn/start', { turn: 2 }),
    receivedSession.append('step/start', { turn: 2, step: 1 }),
    receivedSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'B continuation' }], source: { kind: 'user' } }), { surfaceOp: 'append' }),
    receivedSession.append('step/end', { turn: 2, step: 1 }),
    receivedSession.append('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
  const resume = await B.open(id, 'write')
  try { await resume.append(continued); await resume.flush() } finally { await resume.close() }
  const Bledger = enroll(createLedger('fixture-B'), { key, localId: id })
  const secondSnapshot = await readEnrolledSnapshot({ persistence: B, ledger: Bledger, key })
  await repoB.pull() // the ordinary mirror is stale after A's publication
  const second = await publishArtifact({ repo: repoB, key, expected: first.head, expectedManifestHead: first.manifestHead, artifact: Buffer.from(JSON.stringify(secondSnapshot.snapshot)) })
  const seenByA = await observeRemoteArtifact({ repo: repoA, key })
  assert.equal(seenByA.head, second.head)
  assert.equal(JSON.parse(seenByA.object.toString('utf8')).events.length, events.length + continued.length)
  assert.equal((await A.stat(id)).revision, sourceRevision)
  // A proposes a different revision from its unchanged baseline. Even after
  // refreshing its mirror, the full-manifest/parent CAS must reject it.
  await repoA.pull()
  await assert.rejects(publishArtifact({ repo: repoA, key, expected: first.head, expectedManifestHead: first.manifestHead, artifact: Buffer.from('synthetic divergent A revision') }), /stale complete manifest/)
  assert.equal((await A.stat(id)).revision, sourceRevision)
  const conflictObservation = await observeRemoteArtifact({ repo: repoA, key })
  assert.equal(conflictObservation.head, second.head)
  console.log(JSON.stringify({ syntheticOnly: true, Aevents: events.length, Bevents: secondSnapshot.eventCount, sameKey: true, duplicateRejected: true, staleRejected: true }))
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  await fs.rm(root, { recursive: true, force: true })
}
