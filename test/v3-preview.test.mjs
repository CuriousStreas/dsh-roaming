import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { digest } from '../lib/revisions.js'
import { previewV3Mirror } from '../lib/v3-preview.js'

const key = 'a'.repeat(64)
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.dsh-roaming-view-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'SCHEMA_VERSION'), '3\n')
  fs.mkdirSync(path.join(dir, 'objects'))
  return dir
}
test('v3 preview exposes verified immutable pointers, never native session content', (t) => {
  const dir = fixture(t)
  const content = Buffer.from('synthetic object only')
  const revision = digest(content)
  fs.writeFileSync(path.join(dir, 'objects', `${revision}.bin`), content)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 3, conversations: { [key]: { head: revision, parent: null } } }))
  const result = previewV3Mirror({ dir })
  assert.deepEqual(result.sessions, [{ key, revision, parent: null }])
  assert.match(result.manifestHead, /^[a-f0-9]{64}$/)
  assert.equal(result.objectCount, 1)
  assert.doesNotMatch(JSON.stringify(result), /synthetic object only/)
  fs.writeFileSync(path.join(dir, 'objects', `${revision}.bin`), 'changed')
  assert.throws(() => previewV3Mirror({ dir }), /invalid immutable artifact/)
})
test('v3 preview rejects partial objects and unexpected repository content', (t) => {
  const dir = fixture(t)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 3, conversations: { [key]: { head: digest('absent'), parent: null } } }))
  assert.throws(() => previewV3Mirror({ dir }), /missing artifact/)
  fs.writeFileSync(path.join(dir, 'unexpected.txt'), 'not a v3 artifact')
  assert.throws(() => previewV3Mirror({ dir }), /unexpected data-repository content/)
})
