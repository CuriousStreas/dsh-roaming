import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPublication, enrollPublication, preparePublication, commitPublication,
  acknowledgePublication, manifestRevision, putObject, readObject,
} from '../lib/publisher.js'
import { digest } from '../lib/revisions.js'

const key = 'a'.repeat(64)
const otherKey = 'b'.repeat(64)
const bytes = (value) => Buffer.from(value)
const enrollDevice = (deviceId, localId = 'local') => enrollPublication(createPublication({ deviceId }), { key, localId })
const prepare = (state, data, observedManifest = state.manifest) => preparePublication(state, { key, bytes: bytes(data), observedManifest })
const commit = (state, observedManifest = state.manifest) => commitPublication(state, { key, observedManifest })
const confirm = (state) => acknowledgePublication(state, {
  key, receipt: { remoteAccepted: true, head: state.manifest.conversations[key]?.head, manifestHead: manifestRevision(state.manifest) }, remoteManifest: state.manifest,
})

test('explicit enrollment only; no duplicate logical key or local session id', () => {
  const blank = createPublication({ deviceId: 'device-A' })
  assert.throws(() => prepare(blank, 'snapshot'), /enrollment required/)
  const enrolled = enrollPublication(blank, { key, localId: 'native-session' })
  assert.equal(enrolled.ledger.bindings[key].owner, 'native-readonly')
  assert.equal(blank.ledger.bindings[key], undefined)
  assert.throws(() => enrollPublication(enrolled, { key, localId: 'another-session' }), /already exists/)
  assert.throws(() => enrollPublication(enrolled, { key: otherKey, localId: 'native-session' }), /already exists/)
})

test('objects are immutable byte snapshots and digest validated', () => {
  const original = bytes('content')
  const { store, revision } = putObject(createPublication({ deviceId: 'A' }).objects, original)
  original[0] = 0
  const read = readObject(store, revision)
  assert.equal(read.toString(), 'content')
  read[0] = 0
  assert.equal(readObject(store, revision).toString(), 'content')
  assert.equal(putObject(store, bytes('content')).store, store)
  assert.equal(readObject(store, digest('absent')), null)
  assert.throws(() => putObject({ [revision]: 'bm90LWNvbnRlbnQ=' }, bytes('content')), /corrupt immutable object/)
})

test('local commit remains pending until exact verified remote manifest acknowledgement', () => {
  const device = enrollDevice('A')
  const staged = prepare(device, 'first')
  const committed = commit(staged)
  assert.equal(committed.status, 'local-committed')
  assert.equal(committed.state.manifest.conversations[key].parent, null)
  assert.equal(committed.state.manifest.conversations[key].head, digest('first'))
  assert.equal(committed.state.ledger.bindings[key].base, null)
  assert.equal(device.manifest.conversations[key], undefined)
  assert.throws(() => confirm(staged), /no locally committed/)
  assert.throws(() => acknowledgePublication(committed.state, { key, receipt: { remoteAccepted: false, head: digest('first'), manifestHead: manifestRevision(committed.state.manifest) }, remoteManifest: committed.state.manifest }), /acknowledgement/)
  assert.throws(() => acknowledgePublication(committed.state, { key, receipt: { remoteAccepted: true, head: digest('forged'), manifestHead: manifestRevision(committed.state.manifest) }, remoteManifest: committed.state.manifest }), /does not match/)
  assert.throws(() => acknowledgePublication(committed.state, { key, receipt: { remoteAccepted: true, head: digest('first'), manifestHead: manifestRevision(committed.state.manifest) }, remoteManifest: device.manifest }), /does not match/)
  const done = confirm(committed.state)
  assert.equal(done.ledger.bindings[key].base, digest('first'))
  assert.equal(done.pending, null)
  assert.throws(() => confirm(done), /no locally committed/)
})

test('two devices with checked ancestry: continuation, stale manifest and conflict are idempotent', () => {
  let a = enrollDevice('A', 'native-A')
  let b = enrollDevice('B', 'native-B')
  const initial = commit(prepare(a, 'common'))
  a = confirm(initial.state)
  // B explicitly enrolled its own native read-only source under the same logical key.
  // Remote object bytes must be present to establish known parent data.
  b = { ...b, manifest: a.manifest, objects: putObject(b.objects, bytes('common')).store }
  const same = commit(prepare(b, 'common'))
  assert.equal(same.status, 'unchanged')
  assert.equal(same.state.ledger.bindings[key].base, null)
  // A's next publication must be checked against the actual old head and manifest.
  const a2 = commit(prepare(a, 'from-A'))
  assert.equal(a2.status, 'local-committed')
  assert.equal(a2.state.manifest.conversations[key].parent, digest('common'))
  assert.equal(a2.state.ledger.bindings[key].base, digest('common'))
  assert.equal(commit(prepare(a, 'from-A'), a2.state.manifest).status, 'conflict')
  // B cannot guess common ancestry without its own acknowledged baseline.
  b = { ...b, objects: putObject(b.objects, bytes('from-A')).store }
  const divergent = prepare(b, 'from-B')
  const firstConflict = commit(divergent, a2.state.manifest)
  const retryConflict = commit(divergent, a2.state.manifest)
  assert.equal(firstConflict.status, 'conflict')
  assert.equal(firstConflict.reason, 'stale-manifest')
  assert.deepEqual(retryConflict, firstConflict)
  assert.equal(divergent.ledger.bindings[key].base, null)
  assert.equal(divergent.manifest.conversations[key].head, digest('common'))
})

test('published baseline never authorizes overwriting a changed remote', () => {
  let a = enrollDevice('A')
  a = confirm(commit(prepare(a, 'base')).state)
  const other = putObject(a.objects, bytes('remote-change'))
  const remote = { schema: 3, conversations: { [key]: { parent: digest('base'), head: other.revision } } }
  const state = { ...a, objects: other.store, manifest: remote }
  const result = commit(prepare(state, 'local-change'))
  assert.equal(result.status, 'conflict')
  assert.equal(result.reason, 'conflict')
  assert.equal(result.state.manifest.conversations[key].head, other.revision)
  assert.equal(a.ledger.bindings[key].base, digest('base'))
})

test('full-manifest CAS rejects independent key change, not only parent change', () => {
  const state = enrollDevice('A')
  const pending = prepare(state, 'first')
  const changed = { schema: 3, conversations: { [otherKey]: { parent: null, head: digest('other') } } }
  assert.equal(commit(pending, changed).reason, 'stale-manifest')
  assert.equal(pending.manifest.conversations[key], undefined)
})
