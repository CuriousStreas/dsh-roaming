import assert from 'node:assert/strict'
import test from 'node:test'
import { newManifest, proposal } from '../lib/manifest.js'
import { digest } from '../lib/revisions.js'
const key = 'a'.repeat(64), a = digest('a'), b = digest('b'), c = digest('c')
test('inherited manifest entries are never accepted as remote heads', () => {
  const inherited = { schema: 3, conversations: Object.create({ [key]: { head: a, parent: null } }) }
  assert.throws(() => proposal(inherited, key, { expected: null, next: b }), /unsupported data protocol/)
  const own = { schema: 3, conversations: { [key]: Object.create({ head: a, parent: null }) } }
  assert.throws(() => proposal(own, key, { expected: a, next: b }), /invalid conversation head/)
})

test('immutable revisions require the actual parent and stable key', () => {
  const first = proposal(newManifest(), key, { expected: null, next: a })
  assert.equal(first.accepted, true)
  assert.equal(first.manifest.conversations[key].parent, null)
  const second = proposal(first.manifest, key, { expected: a, next: b })
  assert.equal(second.manifest.conversations[key].parent, a)
  assert.equal(proposal(second.manifest, key, { expected: a, next: c }).reason, 'stale-head')
  assert.equal(second.manifest.conversations[key].head, b)
})
