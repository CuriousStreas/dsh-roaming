import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedger, enroll, decide, acknowledge } from '../lib/ledger.js'
import { digest } from '../lib/revisions.js'

const a = digest('a'), b = digest('b'), c = digest('c')
const key = 'f'.repeat(64)
test('enrollment creates one stable conversation identity and read-only ownership', () => {
  let ledger = enroll(createLedger('device-A'), { key, localId: 'session-a' })
  assert.equal(ledger.bindings[key].owner, 'native-readonly')
  assert.equal(ledger.bindings[key].base, null)
  assert.equal(decide(ledger, key, { local: a, remote: b }), 'unbound-conflict')
  assert.throws(() => enroll(ledger, { key: 'a'.repeat(64), localId: 'session-a' }), /already exists/)
  assert.throws(() => enroll(ledger, { key: 'a'.repeat(64), localId: 'session-b', owner: 'roaming-owned' }), /may not claim/)
  assert.throws(() => acknowledge(ledger, key, a, { remoteAccepted: false, head: a }), /acknowledgement/)
  assert.throws(() => acknowledge(ledger, key, a, { remoteAccepted: true, head: b }), /acknowledgement/)
  assert.equal(ledger.bindings[key].base, null)
  ledger = acknowledge(ledger, key, a, { remoteAccepted: true, head: a })
  assert.equal(decide(ledger, key, { local: b, remote: a }), 'publish-local')
  assert.equal(decide(ledger, key, { local: a, remote: b }), 'adopt-remote')
  assert.equal(decide(ledger, key, { local: b, remote: c }), 'conflict')
})
