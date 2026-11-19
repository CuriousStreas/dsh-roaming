import assert from 'node:assert/strict'
import test from 'node:test'
import { digest, compareThreeWay, compareOptional } from '../lib/revisions.js'

const a = digest('A'), b = digest('B'), c = digest('C')
test('full-content digest detects equal-length changes', () => {
  assert.notEqual(digest('a1b'), digest('a2b'))
})
test('three-way comparison separates single-sided edits and conflicts', () => {
  assert.equal(compareThreeWay({ base: a, local: a, remote: b }), 'adopt-remote')
  assert.equal(compareThreeWay({ base: a, local: b, remote: a }), 'publish-local')
  assert.equal(compareThreeWay({ base: a, local: b, remote: b }), 'equal')
  assert.equal(compareThreeWay({ base: a, local: b, remote: c }), 'conflict')
  assert.equal(compareThreeWay({ base: a, local: a, remote: a }), 'equal')
})
test('missing baseline refuses to guess ancestry', () => {
  assert.equal(compareOptional({ local: a, remote: b }), 'unbound-conflict')
  assert.equal(compareOptional({ local: a, remote: a }), 'unbound-equal')
  assert.throws(() => compareThreeWay({ base: '1', local: a, remote: b }))
})
