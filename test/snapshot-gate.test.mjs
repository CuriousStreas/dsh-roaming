import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectSnapshotCandidate } from '../lib/snapshot-gate.js'

const header = { id: 'source-1', version: 4, createdAt: 1, isSeeded: false, cwd: 'C:/isolated' }
const enrollment = { localId: 'source-1', owner: 'native-readonly' }
const events = [{ seq: 0, time: 1, type: 'user/message', data: { content: 'hello' } }, { seq: 1, time: 2, type: 'assistant/message', data: { message: { content: 'world' } } }]
const candidate = (overrides = {}) => ({ header, enrollment, events, inheritedEventCount: 0, ...overrides })

test('only an explicitly enrolled native read-only source passes offline admission', () => {
  const result = inspectSnapshotCandidate(candidate())
  assert.match(result.revision, /^[a-f0-9]{64}$/)
  assert.equal(result.eventCount, 2)
  assert.equal(inspectSnapshotCandidate(candidate()).revision, result.revision)
  assert.notEqual(inspectSnapshotCandidate(candidate({ events: [{ ...events[0], data: { role: 'user', content: 'HELLO' } }, events[1]] })).revision, result.revision)
  assert.throws(() => inspectSnapshotCandidate(candidate({ enrollment: null })), /enrollment/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ enrollment: { localId: 'other', owner: 'native-readonly' } })), /enrollment/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ enrollment: { localId: 'source-1', owner: 'roaming-owned' } })), /enrollment/)
})

test('rejects forked ZIP without exact inherited cut, changed event seq, and media guesses', () => {
  const fork = { ...header, isSeeded: true }
  assert.throws(() => inspectSnapshotCandidate(candidate({ header: fork })), /inherited-event count/)
  assert.equal(inspectSnapshotCandidate(candidate({ header: fork, inheritedEventCount: 1 })).inheritedEventCount, 1)
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [{ ...events[0], seq: 4 }] })), /contiguous original seq/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ attachments: [{ id: 'unknown', sha256: 'a'.repeat(64), size: 12 }] })), /independent byte/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ header: { ...header, version: undefined } })), /header\/version/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ shadow: 'ignored' })), /unsupported snapshot candidate fields/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ attachments: undefined })), /attachments must be explicit/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ header: { ...header, seedLength: 1 } })), /invalid native header fields/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ header: { ...header, parentSession: 3 } })), /invalid native header fields/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [{ ...events[0], extra: 'ignored' }] })), /seq and envelope/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [{ ...events[0], data: { extra: undefined } }] })), /lossless JSON/)
  const sparse = []
  sparse.length = 2
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [{ ...events[0], data: { sparse } }] })), /lossless JSON/)
  const extra = [1]
  extra.unserialized = true
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [{ ...events[0], data: { extra } }] })), /lossless JSON/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [{ ...events[0], data: { numeric: NaN } }] })), /lossless JSON/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [{ ...events[0], data: { content: [{ type: 'image', attachment: { attachmentId: 'missing' } }] } }] })), /embedded media/)
  for (const block of [{ type: 'image', attachmentId: 'missing' }, { type: 'file' }, { attachmentId: 'detached' }]) {
    assert.throws(() => inspectSnapshotCandidate(candidate({ events: [{ ...events[0], data: { content: [block] } }] })), /embedded media/)
  }
  assert.throws(() => inspectSnapshotCandidate(candidate({ header: { ...header, version: 2 } })), /header\/version/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ header: { ...header, createdAt: undefined } })), /header\/version/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [{ ...events[0], time: undefined }] })), /seq and envelope/)
  assert.throws(() => inspectSnapshotCandidate(candidate({ header: { ...header, isSeeded: undefined } })), /fork lineage/)
  const cyc = { ...events[0] }
  cyc.data = cyc
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [cyc] })), /lossless JSON/)
})
