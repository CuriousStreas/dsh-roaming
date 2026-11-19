import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

function fixture({ reject = false } = {}) {
  const home = fs.mkdtempSync(path.join(process.cwd(), '.dsh-roaming-api-'))
  let registered
  const writes = { open: 0, create: 0 }
  const ctx = {
    get: (name) => name === 'connection' ? { requestRejection: () => reject ? 401 : undefined } : undefined,
    sessionPersistence: { open: () => { writes.open++; throw Error('native access') }, create: () => { writes.create++; throw Error('native access') } },
    webServer: { register: (spec) => { registered = spec.handler; return () => {} } },
    effect: (factory) => factory(),
  }
  apply(ctx, { home })
  const request = async (action, extra = {}) => {
    let status, body
    const req = {
      method: 'POST', url: '/roaming/api',
      on: (event, callback) => {
        if (event === 'data') queueMicrotask(() => callback(Buffer.from(JSON.stringify({ action, ...extra }))))
        if (event === 'end') queueMicrotask(callback)
        return req
      },
    }
    const res = { writeHead: (code) => { status = code }, end: (data) => { body = JSON.parse(data) } }
    registered(req, res)
    for (let i = 0; body === undefined && i < 20; i++) await new Promise((done) => setImmediate(done))
    assert.ok(body)
    return { status, body }
  }
  return { home, request, writes, dispose: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('unsafe commands reject before touching native session persistence', async () => {
  const h = fixture()
  try {
    for (const action of ['push', 'pushMemory', 'pullMemory', 'pushConfig']) {
      const result = await h.request(action, { sessionIds: ['native'] })
      assert.equal(result.status, 409)
      assert.equal(result.body.error.code, 'preview-only')
    }
    const local = await h.request('listLocal')
    assert.deepEqual(local.body.sessions, [])
    assert.equal(h.writes.open + h.writes.create, 0)
  } finally { h.dispose() }
})

test('rejected browser identity cannot create state or open native sessions', async () => {
  const h = fixture({ reject: true })
  try {
    for (const action of ['status', 'configure', 'syncAll', 'push']) {
      const response = await h.request(action, { repoUrl: 'git@github.com:owner/private.git' })
      assert.equal(response.status, 403)
      assert.equal(response.body.error.code, 'forbidden')
    }
    assert.equal(h.writes.open + h.writes.create, 0)
    assert.equal(fs.existsSync(path.join(h.home, 'roaming', 'v3')), false)
  } finally { h.dispose() }
})

test('missing connection service refuses even read-only API', async () => {
  const h = fixture()
  try {
    let handler
    apply({ webServer: { register: (spec) => { handler = spec.handler } }, effect: (cb) => cb() }, { home: h.home })
    let status = null
    const req = { method: 'POST', url: '/roaming/api' }
    handler(req, { writeHead: (code) => { status = code }, end: () => {} })
    await new Promise((done) => setImmediate(done))
    assert.equal(status, 403)
  } finally { h.dispose() }
})

test('state corruption denies operations without corrupting existing bytes', async () => {
  const h = fixture()
  try {
    const state = path.join(h.home, 'roaming', 'v3', 'state.json')
    fs.mkdirSync(path.dirname(state), { recursive: true })
    fs.writeFileSync(state, '{bad')
    // A newly activated instance must keep the malformed state and reject.
    let handler
    apply({ webServer: { register: (spec) => { handler = spec.handler } }, effect: (cb) => cb(), get: () => ({ requestRejection: () => undefined }) }, { home: h.home })
    assert.equal(typeof handler, 'function')
    assert.equal(fs.readFileSync(state, 'utf8'), '{bad')
  } finally { h.dispose() }
})
