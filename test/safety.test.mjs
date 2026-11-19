import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

function harness() {
  const home = fs.mkdtempSync(path.join(process.cwd(), '.dsh-roaming-safe-'))
  const calls = { read: 0, write: 0, registered: 0 }
  const ctx = {
    sessionPersistence: {
      list: async () => [],
      open: async () => { calls.write++; throw Error('unexpected open') },
      create: async () => { calls.write++; throw Error('unexpected create') },
    },
    sessionQuery: {
      listSessions: async () => { calls.read++; return [] },
      readTitleSnapshots: async () => [],
    },
    webServer: { register: () => { calls.registered++; return () => {} } },
    effect: (factory) => factory(),
  }
  return { home, calls, ctx, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('initialization does not start a sync, create state, or mutate DSH', async () => {
  const h = harness()
  try {
    apply(h.ctx, { home: h.home })
    assert.equal(h.calls.registered, 1)
    assert.equal(h.calls.write, 0)
    assert.equal(h.calls.read, 0)
    assert.equal(fs.existsSync(path.join(h.home, 'roaming', 'v3')), false)
  } finally { h.cleanup() }
})

test('legacy mirror and state remain unread and unchanged', async () => {
  const h = harness()
  try {
    const old = path.join(h.home, 'roaming')
    fs.mkdirSync(old, { recursive: true })
    fs.writeFileSync(path.join(old, 'state.json'), '{ not a v3 state }')
    fs.mkdirSync(path.join(old, 'repo'), { recursive: true })
    const original = fs.readFileSync(path.join(old, 'state.json'))
    apply(h.ctx, { home: h.home })
    assert.deepEqual(fs.readFileSync(path.join(old, 'state.json')), original)
    assert.equal(h.calls.write, 0)
  } finally { h.cleanup() }
})

test('diagnostics never follow a plugin log symlink or unsafe root', async () => {
  const h = harness()
  try {
    const root = path.join(h.home, 'roaming', 'v3')
    fs.mkdirSync(root, { recursive: true })
    const victim = path.join(h.home, 'unrelated.txt')
    fs.writeFileSync(victim, 'unaltered')
    try { fs.symlinkSync(victim, path.join(root, 'debug.log'), 'file') }
    catch (error) { if (error.code === 'EPERM') return; throw error }
    fs.writeFileSync(path.join(root, 'state.json'), '{bad')
    apply(h.ctx, { home: h.home })
    assert.equal(fs.readFileSync(victim, 'utf8'), 'unaltered')
    assert.equal(h.calls.write, 0)
  } finally { h.cleanup() }
})

test('malformed v3 state fails closed instead of resetting bindings', async () => {
  const h = harness()
  try {
    const dir = path.join(h.home, 'roaming', 'v3')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'state.json'), '{bad')
    const plugin = apply(h.ctx, { home: h.home })
    assert.equal(plugin.state.repoUrl, '')
    assert.equal(h.calls.registered, 1)
    assert.equal(h.calls.write, 0)
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), '{bad')
  } finally { h.cleanup() }
})
