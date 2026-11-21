// One minimal functional smoke: portable data -> Git -> mapping -> DSH bridge.
// All data/handles are synthetic and all directories/remote are disposable.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMemorySync } from '../lib/memory-sync.js'
import { createDshBridge } from '../lib/dsh-bridge.js'
import { applyFramework } from '../lib/framework.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-framework-'))
const fibers = []
try {
  const remoteUrl = path.join(root, 'cloud.git')
  execFileSync('git', ['init', '--bare', remoteUrl], { stdio: 'ignore' })
  const options = id => ({ remoteUrl, repoDir: path.join(root, id, 'repo'), mappingDir: path.join(root, id, 'mapping'), machineId: id, machineName: `Machine ${id}` })
  await fs.mkdir(path.join(root, 'A'), { recursive: true })
  await fs.mkdir(path.join(root, 'B'), { recursive: true })
  let A = createMemorySync(options('A'))
  let B = createMemorySync(options('B'))
  const memory = await A.workspace.load()
  memory.memories.preferences = { language: 'zh', note: 'synthetic preference' }
  await A.workspace.save(memory)
  await A.upload()
  await B.download()
  assert.deepEqual((await B.workspace.load()).memories.preferences, memory.memories.preferences)
  // Same existing API surface can configure paths and read grouped data.
  let apiRoute
  const controller = applyFramework({ webServer: { register(route) { apiRoute = route } }, connection: { requestRejection() {} }, effect: factory => factory() }, { home: path.join(root, 'ui-home') })
  await controller.operate('configure', { ...options('A'), repoUrl: remoteUrl })
  assert.equal((await controller.operate('status')).mappingDir, options('A').mappingDir)
  const response = await new Promise(resolve => {
    let httpStatus
    apiRoute.handler({ method: 'POST', url: '/roaming/api', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ action: 'sync' })) } },
      { writeHead(code) { httpStatus = code }, end(body) { resolve({ status: httpStatus, body: JSON.parse(body) }) } })
  })
  assert.equal(response.status, 202)
  assert.equal(response.body.accepted, true)
  assert.equal(response.body.syncState.state, 'running')
  const duplicate = await controller.operate('sync')
  assert.equal(duplicate.accepted, false)
  assert.equal(duplicate.syncState.runId, response.body.syncState.runId)
  await controller.runHourly() // Same queue, not another concurrent writer.
  const completed = await controller.whenIdle()
  assert.equal(completed.state, 'succeeded')
  assert.equal(completed.result.uploaded, true)
  assert.equal(completed.result.partial, false)
  const status = await controller.operate('status')
  assert.equal(status.lastSync.message, '同步完成')
  assert.equal(status.autoSync.intervalMs, 3600000)
  const log = await fs.readFile(status.logPath, 'utf8')
  assert.ok(log.includes('"stage":"fetch"') && log.includes('"stage":"complete"'))
  assert.equal((log.match(/"stage":"start"/g) || []).length, 1)
  controller.dispose()

  // The same button handles old repositories honestly, without migrating them.
  const legacy = path.join(root, 'legacy-source')
  execFileSync('git', ['init', '-b', 'main', legacy], { stdio: 'ignore' })
  await fs.mkdir(path.join(legacy, 'hosts', 'old-pc'), { recursive: true })
  await fs.writeFile(path.join(legacy, 'hosts', 'old-pc', 'machine.json'), JSON.stringify({ name: 'old-pc' }))
  execFileSync('git', ['-C', legacy, 'add', '.'], { stdio: 'ignore' })
  execFileSync('git', ['-C', legacy, '-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit', '-m', 'legacy fixture'], { stdio: 'ignore' })
  const legacyRemote = path.join(root, 'legacy.git')
  execFileSync('git', ['clone', '--bare', legacy, legacyRemote], { stdio: 'ignore' })
  const old = createMemorySync({ ...options('legacy'), remoteUrl: legacyRemote })
  const oldSync = await old.sync()
  assert.ok(!oldSync.readOnly && !oldSync.partial && oldSync.uploaded)
  await fs.access(path.join(options('legacy').repoDir, '.roaming-index.json'))
  await assert.rejects(fs.access(path.join(options('legacy').repoDir, 'memory-repository.json')))
  console.log('PASS one-button sync + stage logs + existing-format write-back')

  if (process.env.DSH_INSTALL_ROOT) {
    const install = process.env.DSH_INSTALL_ROOT
    const url = name => pathToFileURL(path.join(install, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href
    const [{ Context }, Jsonl, { Session, SessionId }, { createUserMessage }] = await Promise.all([
      import(url('cordis')), import(url('dsh-session-persistence-jsonl')), import(url('dsh-session')), import(url('dsh-llm')),
    ])
    const mount = async name => {
      const ctx = new Context()
      const fiber = ctx.plugin(Jsonl, { root: path.join(root, name), compression: 'none' })
      fibers.push(fiber)
      await fiber.await()
      return ctx.sessionPersistence
    }
    const nativeA = await mount('native-A')
    const nativeB = await mount('native-B')
    const source = Session.create(SessionId('synthetic-source'))
    const events = [
      source.append('turn/start', { turn: 1 }),
      source.append('step/start', { turn: 1, step: 1 }),
      source.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'synthetic user' }], source: { kind: 'user' } }), { surfaceOp: 'append' }),
      source.append('step/end', { turn: 1, step: 1 }),
      source.append('turn/end', { turn: 1, reason: { kind: 'completed' } }),
      source.append('session-log-deepseek/delivery-accepted', { sessionId: source.header.id, sessionFormatVersion: 4, throughSeq: 2 }),
      source.append('session/end-seed', {}),
    ]
    const write = await nativeA.create(source.header)
    try { await write.append(events); await write.flush() } finally { await write.close() }
    const original = (await nativeA.stat(source.header.id)).revision
    const bridgeA = createDshBridge({ persistence: nativeA, machineId: 'A' })
    const bridgeB = createDshBridge({ persistence: nativeB, machineId: 'B' })
    const nativeOptions = id => ({ ...options(`native-${id}`), machineId: id, machineName: `Machine ${id}`, remoteUrl: legacyRemote })
    A = createMemorySync({ ...nativeOptions('A'), bridge: bridgeA })
    B = createMemorySync({ ...nativeOptions('B'), bridge: bridgeB })
    await A.workspace.save(memory)
    await bridgeA.enroll(source.header.id, A.workspace, nativeOptions('A'))
    assert.ok((await A.workspace.list(await A.workspace.load()))[0].hidden)
    await A.upload()
    const downloaded = await B.download()
    assert.equal(downloaded.materialized.created.length, 1)
    const again = await B.download()
    assert.equal(again.materialized.created.length, 0)
    const mappedId = downloaded.materialized.created[0]
    const mapped = await nativeB.open(mappedId, 'read')
    try {
      const { events: restoredEvents, eventState } = await mapped.read()
      assert.equal(restoredEvents.find(event => event.type === 'session-log-deepseek/delivery-accepted').data.sessionId, mappedId)
      const restored = Session.fromRestore(mappedId, restoredEvents, mapped.header, mapped.inheritedEventCount, eventState)
      assert.deepEqual(restored.deriveMessages(), source.deriveMessages())
    } finally { await mapped.close() }
    // A and B independently edit the same opaque memory; preserve both values.
    const localA = await A.workspace.load()
    localA.memories.preferences.note = 'A edit'
    await A.workspace.save(localA)
    const localB = await B.workspace.load()
    localB.memories.preferences.note = 'B edit'
    await B.workspace.save(localB)
    await B.upload()
    const split = await A.upload()
    assert.ok(split.conflicts.some(row => row.kind === 'memories'))
    const merged = await A.workspace.load()
    assert.ok(Object.values(merged.memories).some(value => value.note === 'A edit'))
    assert.ok(Object.values(merged.memories).some(value => value.note === 'B edit'))
    assert.equal((await nativeA.stat(source.header.id)).revision, original)
    const addTurn = async (backend, id, text) => {
      const handle = await backend.open(id, 'write')
      try {
        const { events: prior, eventState } = await handle.read()
        const resumed = Session.fromRestore(id, prior, handle.header, handle.inheritedEventCount, eventState)
        const turn = prior.filter(event => event.type === 'turn/start').length + 1
        const additions = [
          resumed.append('turn/start', { turn }),
          resumed.append('step/start', { turn, step: 1 }),
          resumed.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' }),
          resumed.append('step/end', { turn, step: 1 }),
          resumed.append('turn/end', { turn, reason: { kind: 'completed' } }),
          resumed.append('session/end-seed', {}),
        ]
        await handle.append(additions); await handle.flush()
      } finally { await handle.close() }
    }
    await addTurn(nativeA, source.header.id, 'A offline turn')
    const editedOriginal = (await nativeA.stat(source.header.id)).revision
    await addTurn(nativeB, mappedId, 'B offline turn')
    await B.upload()
    const splitConversations = await A.upload()
    assert.ok(splitConversations.conflicts.some(row => row.kind === 'conversations'))
    await B.download()
    assert.equal(Object.keys((await B.workspace.load()).conversations).length, 2)
    await B.download()
    assert.equal((await nativeB.list()).length, 2)
    assert.equal((await nativeA.stat(source.header.id)).revision, editedOriginal)
    // One-sided remote continuation for A's original stays pending: never
    // overwrite it on a later upload before native writeback is implemented.
    const activeKey = Object.keys((await B.workspace.load()).conversations).find(key => !(key.includes('~remote-')))
    const rebound = (await B.workspace.bindings())[activeKey].localId
    await addTurn(nativeB, rebound, 'remote continuation for A')
    await B.upload()
    const pending = await A.download()
    assert.equal(pending.materialized.pendingNative.length, 1)
    const retained = await A.upload()
    assert.ok(retained.partial && retained.failed.some(item => /尚未写回/.test(item.message)))
    assert.equal((await nativeA.stat(source.header.id)).revision, editedOriginal)
    console.log('PASS native hidden binding + foreign import + repeat download + conversation split/rebinding + pending writeback retained')
  } else console.log('SKIP native bridge (set DSH_INSTALL_ROOT to opt in)')
} finally {
  try { for (const fiber of fibers.reverse()) await fiber.dispose() }
  finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('memory-framework-')) throw new Error('unexpected cleanup path')
    await fs.rm(root, { recursive: true, force: true })
  }
}
