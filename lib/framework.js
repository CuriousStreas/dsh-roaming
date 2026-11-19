import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMemorySync } from './memory-sync.js'
import { dshHome } from './state.js'
import { createDshBridge } from './dsh-bridge.js'

const DEFAULT_SOURCE = 'https://github.com/CuriousStreas/Mem_DSH.git'

// Data/UI controller. Its bridge is injected separately, not part of the
// independent data format or Git layer. Nothing syncs on plugin startup.
export function applyFramework(ctx, config = {}) {
  const root = path.join(dshHome(config), 'roaming', 'framework')
  const settingsFile = path.join(root, 'settings.json')
  const defaults = { repoUrl: config.repoUrl || DEFAULT_SOURCE,
    repoDir: config.repoDir || path.join(root, 'repository'),
    mappingDir: config.mappingDir || path.join(root, 'mapping'),
    machineId: crypto.randomUUID(), machineName: os.hostname() }
  let settingsPromise = fs.readFile(settingsFile, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return defaults
    throw error
  })
  const bridgeFor = settings => config.bridge || (config.sessionBridge ? createDshBridge({
    persistence: ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence,
    query: ctx.get?.('sessionQuery') ?? ctx.sessionQuery,
    workspaceRegistry: ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry,
    sessions: ctx.get?.('sessions') ?? ctx.sessions, machineId: settings.machineId,
  }) : undefined)
  const service = settings => createMemorySync({ ...settings, bridge: bridgeFor(settings) })
  let busy = false
  async function operate(action, body) {
    const settings = await settingsPromise
    if (action === 'status') {
      const sync = service(settings)
      return { ok: true, mode: 'portable-memory', version: '0.4.0-framework', ...settings,
        configured: settings !== defaults, repoExists: await fs.stat(path.join(settings.repoDir, '.git')).then(() => true, () => false),
        groups: await sync.workspace.list(await sync.workspace.load()), bridgeEnabled: Boolean(config.bridge || config.sessionBridge),
        settings: { autoSync: false, syncMemory: false } }
    }
    if (action === 'configure') {
      const next = { ...settings }
      for (const field of ['repoUrl', 'repoDir', 'mappingDir', 'machineName']) {
        if (typeof body[field] === 'string' && body[field].trim()) next[field] = body[field].trim()
      }
      next.repoDir = path.resolve(next.repoDir)
      next.mappingDir = path.resolve(next.mappingDir)
      service(next) // require separate paths, but configuration itself does not clone
      await fs.mkdir(root, { recursive: true })
      await fs.writeFile(settingsFile, JSON.stringify(next, null, 2) + '\n')
      settingsPromise = Promise.resolve(next)
      return { ok: true, configured: true }
    }
    if (action === 'listLocal') {
      const bridge = bridgeFor(settings)
      const local = bridge?.listLocal ? await bridge.listLocal() : []
      const bindings = await service(settings).workspace.bindings()
      return { ok: true, sessions: local, synced: Object.values(bindings).filter(b => b.owner === 'native').map(b => b.localId) }
    }
    if (action === 'enroll') {
      const bridge = bridgeFor(settings)
      if (!bridge?.enroll) throw new Error('会话桥接尚未启用；当前可同步独立数据区')
      await bridge.enroll(body.sessionId, service(settings).workspace, settings)
      return { ok: true }
    }
    if (action === 'settings') return { ok: true, settings: { autoSync: false, syncMemory: false } }
    if (action === 'openLogs') return { ok: true, dir: root, file: path.join(root, 'debug.log') }
    if (action === 'push' || action === 'syncAll' || action === 'pull') {
      const sync = service(settings)
      return action === 'pull' ? sync.download() : sync.upload()
    }
    throw new Error('未知操作，记忆文件和配置的自动采集暂未启用')
  }
  async function handler(req, res) {
    const respond = (status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
    if (req.method !== 'POST' || new URL(req.url || '/', 'http://localhost').pathname !== '/roaming/api') return respond(404, { ok: false })
    try {
      const connection = ctx.get?.('connection') ?? ctx.connection
      if (typeof connection?.requestRejection !== 'function' || connection.requestRejection(req) !== undefined) return respond(403, { ok: false, error: { message: '无法验证请求身份' } })
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const writes = !['status', 'listLocal', 'openLogs'].includes(body.action)
      if (writes && busy) throw new Error('已有操作进行中')
      if (writes) busy = true
      try { respond(200, await operate(body.action, body)) } finally { if (writes) busy = false }
    } catch (error) {
      // Avoid passing unsanitized child-process arguments or URLs to the UI.
      respond(400, { ok: false, error: { message: error.message } })
    }
  }
  const register = () => ctx.webServer.register({ kind: 'prefix', path: '/roaming', handler: (req, res) => { void handler(req, res) } })
  if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-roaming memory framework')
  else register()
  return { operate }
}
