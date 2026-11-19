import assert from 'node:assert/strict'
import test from 'node:test'
import { newManifest, proposal } from '../lib/manifest.js'
import { digest } from '../lib/revisions.js'
const key = 'a'.repeat(64), a = digest('a'), b = digest('b'), c = digest('c')
test('immutable revisions require the actual parent and stable key', () => {
  const first = proposal(newManifest(), key, { expected: null, next: a })
  assert.equal(first.accepted, true)
  assert.equal(first.manifest.conversations[key].parent, null)
  const second = proposal(first.manifest, key, { expected: a, next: b })
  assert.equal(second.manifest.conversations[key].parent, a)
  assert.equal(proposal(second.manifest, key, { expected: a, next: c }).reason, 'stale-head')
  assert.equal(second.manifest.conversations[key].head, b)
})
