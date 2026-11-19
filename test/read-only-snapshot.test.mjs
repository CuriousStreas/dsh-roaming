import assert from 'node:assert/strict'
import test from 'node:test'
import { createLedger, enroll } from '../lib/ledger.js'
import { readEnrolledSnapshot } from '../lib/read-only-snapshot.js'

const key = 'a'.repeat(64)
const header = { id: 'local-one', version: 4, createdAt: 1, isSeeded: false }
const events = Array.from({ length: 300 }, (_, seq) => ({ seq, type: 'fixture/event', time: seq + 1, data: { seq }, ignorable: true }))
function harness(options = {}) {
  const calls = []
  const ledger = enroll(createLedger('A'), { key, localId: 'local-one' })
  let stat = 0
  const persistence = {
    async stat(id) { calls.push(['stat', id]); return { revision: ((options.changed || options.changedAfterSerialization) && ++stat === (options.changed ? 2 : 3)) ? 'changed' : 'stable' } },
    async open(id, access) {
      calls.push(['open', id, access])
      if (options.openError) throw Error('open failed')
      return {
        id, access: options.writable ? 'write' : 'read', header, inheritedEventCount: 0,
        async read(offset, length) { calls.push(['read', offset, length]); if (options.readError) throw Error('read failed'); return { events: events.slice(offset, offset + length) } },
        async close() { calls.push(['close']); if (options.closeError) throw Error('close failed') },
      }
    },
    flush() { throw Error('forbidden flush') }, create() { throw Error('forbidden create') },
  }
  return { calls, ledger, persistence }
}

test('reads only explicitly enrolled session in bounded pages and closes read handle', async () => {
  const h = harness()
  const result = await readEnrolledSnapshot({ persistence: h.persistence, ledger: h.ledger, key })
  assert.equal(result.eventCount, events.length)
  assert.equal(result.snapshot.events[299].seq, 299)
  assert.deepEqual(h.calls.filter(([op]) => op === 'open'), [['open', 'local-one', 'read']])
  assert.deepEqual(h.calls.filter(([op]) => op === 'read'), [['read', 0, 256], ['read', 256, 256], ['read', 300, 256]])
  assert.deepEqual(h.calls.filter(([op]) => op === 'stat').length, 3)
  assert.deepEqual(h.calls.at(-1), ['close'])
  assert.notEqual(result.snapshot.events[0], events[0])
})

test('missing enrollment cannot open any source; changed source never produces a snapshot', async () => {
  const h = harness()
  await assert.rejects(readEnrolledSnapshot({ persistence: h.persistence, ledger: createLedger('A'), key }), /enrollment/)
  assert.deepEqual(h.calls, [])
  const changed = harness({ changed: true })
  await assert.rejects(readEnrolledSnapshot({ persistence: changed.persistence, ledger: changed.ledger, key }), /source changed/)
  assert.deepEqual(changed.calls.at(-1), ['close'])
  const changedLater = harness({ changedAfterSerialization: true })
  await assert.rejects(readEnrolledSnapshot({ persistence: changedLater.persistence, ledger: changedLater.ledger, key }), /source changed/)
  assert.deepEqual(changedLater.calls.at(-1), ['close'])
})

test('read failure or wrong access closes without mutation', async () => {
  for (const options of [{ readError: true }, { writable: true }, { closeError: true }]) {
    const h = harness(options)
    await assert.rejects(readEnrolledSnapshot({ persistence: h.persistence, ledger: h.ledger, key }))
    assert.deepEqual(h.calls.filter(([op]) => op === 'open'), [['open', 'local-one', 'read']])
    assert.deepEqual(h.calls.at(-1), ['close'])
  }
})
