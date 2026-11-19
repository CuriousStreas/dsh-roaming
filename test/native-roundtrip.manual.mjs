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
const [{ Context }, Jsonl, { Session, SessionId }] = await Promise.all([
  import(pathToFileURL(path.join(install, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href),
  import(moduleUrl('dsh-session-persistence-jsonl')),
  import(moduleUrl('dsh-session')),
])
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-roaming-native-fixture-'))
let fiber
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
    assert.deepEqual(result.events.map((event) => event.seq), [0, 1, 2])
    assert.equal(read.header.id, id)
    console.log(JSON.stringify({ isolated: true, syntheticEvents: result.events.length, restoredEvents: replay.seq }))
  } finally { await read.close() }
} finally {
  try { await fiber?.dispose() } finally { await fs.rm(home, { recursive: true, force: true }) }
}
