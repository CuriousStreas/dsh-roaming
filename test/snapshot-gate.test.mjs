import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectSnapshotCandidate } from '../lib/snapshot-gate.js'

const header = { id: 'source-1', version: 4, isSeeded: false, cwd: 'C:/isolated' }
const enrollment = { localId: 'source-1', owner: 'native-readonly' }
const events = [{ seq: 0, type: 'message', data: { role: 'user', content: 'hello' } }, { seq: 1, type: 'message', data: { role: 'assistant', content: 'world' } }]
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
  assert.throws(() => inspectSnapshotCandidate(candidate({ header: { ...header, isSeeded: undefined } })), /fork lineage/)
  const cyc = { ...events[0] }
  cyc.data = cyc
  assert.throws(() => inspectSnapshotCandidate(candidate({ events: [cyc] })), /cannot be encoded/)
})
