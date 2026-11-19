// Manual experiment: synthetic data in a newly created OS temporary directory.
// Run only with DSH_INSTALL_ROOT pointing at the installed DSH package root.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const install = process.env.DSH_INSTALL_ROOT
if (!install || !path.isAbsolute(install)) throw new Error('DSH_INSTALL_ROOT must be an absolute DSH package directory')
const moduleUrl = (name) => pathToFileURL(path.join(install, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href
const [{ Context }, Jsonl, { Session, SessionId }, { createUserMessage }] = await Promise.all([
  import(pathToFileURL(path.join(install, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href),
  import(moduleUrl('dsh-session-persistence-jsonl')),
  import(moduleUrl('dsh-session')),
  import(moduleUrl('dsh-llm')),
])
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-roaming-native-fixture-'))
let fiber
let targetFiber
try {
  const ctx = new Context()
  fiber = ctx.plugin(Jsonl, { root: path.join(home, 'session-logs'), compression: 'none' })
  await fiber.await()
  const db = ctx.sessionPersistence
  assert.ok(db)
  const id = SessionId(`synthetic-${crypto.randomUUID()}`)
  const session = Session.create(id)
  const events = [
    session.append('turn/start', { turn: 1 }),
    session.append('step/start', { turn: 1, step: 1 }),
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'synthetic test only' }], source: { kind: 'user' } }), { surfaceOp: 'append' }),
    session.append('step/end', { turn: 1, step: 1 }),
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
    session.append('session/end-seed', {}),
  ]
  const write = await db.create(session.header)
  try {
    await write.append(events)
    await write.flush()
  } finally { await write.close() }
  // This uses the plugin's read-only prototype against a synthetic enrolled
  // source; no import, fork resumption, or remote publication occurs.
  const [{ createLedger, enroll }, { readEnrolledSnapshot }] = await Promise.all([
    import('../lib/ledger.js'), import('../lib/read-only-snapshot.js'),
  ])
  const key = crypto.randomBytes(32).toString('hex')
  const ledger = enroll(createLedger('synthetic-device'), { key, localId: id })
  const before = await db.stat(id)
  const extracted = await readEnrolledSnapshot({ persistence: db, ledger, key })
  assert.equal(extracted.snapshot.events.length, events.length)
  assert.equal(extracted.snapshot.header.id, id)
  const fromSnapshot = Session.fromRestore(id, extracted.snapshot.events, extracted.snapshot.header, extracted.snapshot.inheritedEventCount, 'detached')
  assert.equal(fromSnapshot.seq, events.length)
  const expectedSurface = session.deriveMessages()
  assert.equal(expectedSurface.length, 1)
  assert.deepEqual(fromSnapshot.deriveMessages(), expectedSurface)
  // An unbound key must not even call the backend. This also demonstrates
  // that validation is not a permission to discover other native sessions.
  await assert.rejects(readEnrolledSnapshot({ persistence: {
    stat() { throw new Error('forbidden stat') }, open() { throw new Error('forbidden open') },
  }, ledger, key: crypto.randomBytes(32).toString('hex') }), /enrollment/)
  const after = await db.stat(id)
  assert.equal(after.revision, before.revision)
  const read = await db.open(id, 'read')
  try {
    const result = await read.read()
    const replay = Session.fromRestore(id, result.events, read.header, read.inheritedEventCount, result.eventState)
    assert.equal(replay.seq, result.events.length)
    assert.deepEqual(replay.deriveMessages(), expectedSurface)
    assert.deepEqual(result.events.map((event) => event.seq), [0, 1, 2, 3, 4, 5])
    assert.equal(read.header.id, id)
  } finally { await read.close() }
  // Explicitly restricted fixture only: use the same synthetic ID in a second,
  // independently rooted backend. This is not plugin import or agent resume.
  const targetCtx = new Context()
  targetFiber = targetCtx.plugin(Jsonl, { root: path.join(home, 'target-session-logs'), compression: 'none' })
  await targetFiber.await()
  const target = targetCtx.sessionPersistence
  assert.equal(await target.stat(id), undefined)
  const targetWrite = await target.create(extracted.snapshot.header)
  try {
    await targetWrite.append(extracted.snapshot.events)
    await targetWrite.flush()
  } finally { await targetWrite.close() }
  await assert.rejects(target.create(extracted.snapshot.header))
  const targetRead = await target.open(id, 'read')
  try {
    const { events: targetEvents, eventState } = await targetRead.read()
    assert.deepEqual(targetEvents, extracted.snapshot.events)
    const imported = Session.fromRestore(id, targetEvents, targetRead.header, targetRead.inheritedEventCount, eventState)
    assert.deepEqual(imported.deriveMessages(), expectedSurface)
  } finally { await targetRead.close() }
  // A partial native write is *not* transactional. Verify its observable
  // failure mode under an isolated ID: never assume close rolls back append.
  const incompleteId = SessionId(`partial-${crypto.randomUUID()}`)
  const partialHeader = { ...extracted.snapshot.header, id: incompleteId }
  const partial = await target.create(partialHeader)
  try {
    await partial.append(extracted.snapshot.events.slice(0, 2))
    await partial.flush()
  } finally { await partial.close() }
  const incomplete = await target.stat(incompleteId)
  assert.ok(incomplete, 'partial flush materializes a native session')
  assert.equal((await db.stat(id)).revision, before.revision)
  console.log(JSON.stringify({ isolated: true, syntheticEvents: events.length, restoredEvents: fromSnapshot.seq, targetImported: true, partialWriteVisible: true }))
} finally {
  try { await targetFiber?.dispose() } finally {
    try { await fiber?.dispose() } finally { await fs.rm(home, { recursive: true, force: true }) }
  }
}
