import fs from 'node:fs/promises'
import { readFileSync, constants } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMemorySync } from './memory-sync.js'
import { dshHome } from './state.js'
import { createDshBridge } from './dsh-bridge.js'

export const RUNTIME_VERSION = '0.4.1-framework.1'
const DEFAULT_SOURCE = 'https://github.com/CuriousStreas/Mem_DSH.git'
const apiError = (code, message, status) => Object.assign(new Error(message), { code, status })

function dataRoot(config) {
  if (typeof config.rootDir === 'string' && config.rootDir.trim()) return path.resolve(config.rootDir)
  // Local-only bootstrap: relocation does not require editing a profile or bundle.
  try {
    const location = JSON.parse(readFileSync(path.join(dshHome(config), 'roaming', 'location.json'), 'utf8'))
    if (typeof location.rootDir !== 'string' || !location.rootDir.trim()) throw new Error('Invalid roaming location.rootDir')
    return path.resolve(location.rootDir)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return path.join(dshHome(config), 'roaming', 'framework')
  }
}

// Data/UI controller. Its bridge is injected separately, not part of the
// independent data format or Git layer. Nothing syncs on plugin startup.
export function applyFramework(ctx, config = {}) {
  const root = dataRoot(config)
  const runtime = { version: RUNTIME_VERSION, pid: process.pid, startedAt: new Date().toISOString() }
  const settingsFile = path.join(root, 'settings.json')
  const logPath = path.join(root, 'debug.log')
  const defaults = { repoUrl: config.repoUrl || DEFAULT_SOURCE,
    repoDir: config.repoDir || path.join(root, 'repository'),
    mappingDir: config.mappingDir || path.join(root, 'mapping'),
    machineId: crypto.randomUUID(), machineName: os.hostname() }
  let configured = false
  let settingsPromise
  const getSettings = () => settingsPromise ??= fs.readFile(settingsFile, 'utf8').then(text => {
    const saved = JSON.parse(text)
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid roaming settings')
    configured = true
    return { ...defaults, ...saved }
  }).catch(error => {
    if (error.code === 'ENOENT') return defaults
    throw error
  })
  let lastSync = null
  const log = async (action, error, event) => {
    try {
      await fs.mkdir(root, { recursive: true })
      const file = await fs.open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        // Git already suppresses raw arguments/stderr; redact URLs from other errors too.
        const detail = (error ? String(error.stack || error) : JSON.stringify(event)).replace(/(?:https?:\/\/|ssh:\/\/|git@)\S+/g, '[remote]')
        await file.writeFile(`[${new Date().toISOString()}] action=${action}${error ? ` code=${error.code || 'internal'} status=${error.status || 500}` : ''}\n${detail}\n`)
      } finally { await file.close() }
    } catch { /* Logging must never replace the operation's failure. */ }
  }
  const bridgeFor = settings => config.bridge || (config.sessionBridge ? createDshBridge({
    persistence: ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence,
    query: ctx.get?.('sessionQuery') ?? ctx.sessionQuery,
    workspaceRegistry: ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry,
    sessions: ctx.get?.('sessions') ?? ctx.sessions, machineId: settings.machineId,
  }) : undefined)
  // UI/settings use repoUrl; the sync service deliberately calls it remoteUrl.
  const service = (settings, withBridge = false) => createMemorySync({ ...settings, remoteUrl: settings.repoUrl, bridge: withBridge ? bridgeFor(settings) : undefined, onProgress: event => log('sync', null, event.stage === 'start' ? { ...event, runtime } : event) })
  let busy = false
  async function operate(action, body = {}) {
    if (action === 'openLogs') return { ok: true, dir: root, file: logPath }
    const settings = await getSettings()
    if (action === 'status') {
      const sync = service(settings)
      return { ok: true, mode: 'portable-memory', version: RUNTIME_VERSION, runtime, ...settings,
        rootDir: root, logPath, logDir: root, configured, lastSync,
        repoExists: await fs.stat(path.join(settings.repoDir, '.git')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }),
        legacyRepository: await fs.access(path.join(settings.repoDir, 'hosts')).then(() => true, () => false) &&
          !await fs.access(path.join(settings.repoDir, 'memory-repository.json')).then(() => true, () => false),
        groups: await sync.workspace.list(await sync.workspace.load()), bridgeEnabled: Boolean(config.bridge || config.sessionBridge),
        settings: { autoSync: false, syncMemory: false } }
    }
    if (action === 'configure') {
      const next = { ...settings }
      for (const field of ['repoUrl', 'repoDir', 'mappingDir', 'machineName']) {
        if (body[field] !== undefined && (typeof body[field] !== 'string' || !body[field].trim())) throw apiError('bad-request', `${field} 不能为空`, 400)
        if (typeof body[field] === 'string') next[field] = body[field].trim()
      }
      next.repoDir = path.resolve(next.repoDir)
      next.mappingDir = path.resolve(next.mappingDir)
      try { service(next) } catch (error) { throw apiError('bad-request', error.message, 400) }
      // Configuration validates separate paths but never clones or syncs.
      await fs.mkdir(root, { recursive: true })
      await fs.writeFile(settingsFile, JSON.stringify(next, null, 2) + '\n')
      settingsPromise = Promise.resolve(next)
      configured = true
      return { ok: true, configured: true, rootDir: root }
    }
    if (action === 'listLocal') {
      const bridge = bridgeFor(settings)
      const local = bridge?.listLocal ? await bridge.listLocal() : []
      const bindings = await service(settings).workspace.bindings()
      return { ok: true, sessions: local, synced: Object.values(bindings).filter(b => b.owner === 'native').map(b => b.localId) }
    }
    if (action === 'enroll') {
      const bridge = bridgeFor(settings)
      if (!bridge?.enroll) throw apiError('bridge-disabled', '会话桥接尚未启用；当前可同步独立数据区', 409)
      if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) throw apiError('bad-request', '缺少 sessionId', 400)
      await bridge.enroll(body.sessionId, service(settings).workspace, settings)
      return { ok: true }
    }
    if (action === 'settings') return { ok: true, settings: { autoSync: false, syncMemory: false } }
    if (['sync', 'syncAll', 'push', 'pull'].includes(action)) {
      if (!settings.repoUrl) throw apiError('not-configured', '请先配置数据仓库', 409)
      const sync = service(settings, true)
      const result = await (action === 'pull' ? sync.download() : action === 'push' ? sync.upload() : sync.sync())
      lastSync = { at: new Date().toISOString(), message: result.message, partial: result.partial, readOnly: result.readOnly }
      return result
    }
    throw apiError('unknown-action', '未知操作，记忆文件和配置的自动采集暂未启用', 404)
  }
  async function handler(req, res) {
    const respond = (status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
    if (req.method !== 'POST' || new URL(req.url || '/', 'http://localhost').pathname !== '/roaming/api') return respond(404, { ok: false, error: { code: 'not-found', message: 'Not found' } })
    let action = 'request'
    try {
      const connection = ctx.get?.('connection') ?? ctx.connection
      const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : 403
      if (rejection !== undefined) throw apiError(rejection === 401 ? 'unauthorized' : 'forbidden', '无法验证请求身份', rejection)
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        // Drain oversized requests so the socket remains available for HTTP 413.
        if (size > 4 * 1024 * 1024) { chunks.length = 0; continue }
        chunks.push(chunk)
      }
      if (size > 4 * 1024 * 1024) throw apiError('too-large', '请求体过大', 413)
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw apiError('bad-json', '请求体不是 JSON', 400) }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') throw apiError('bad-request', '缺少 action', 400)
      action = body.action
      const writes = !['status', 'listLocal', 'openLogs'].includes(action)
      if (writes && busy) throw apiError('busy', '已有操作进行中', 409)
      if (writes) busy = true
      try { respond(200, await operate(action, body)) } finally { if (writes) busy = false }
    } catch (error) {
      // Unexpected filesystem/protocol failures are server errors, not bad requests.
      const status = error.status || (/^git .+ failed \(exit /.test(error.message) ? 502 : 500)
      const code = error.status ? error.code : status === 502 ? 'git-failed' : 'internal'
      await log(action, Object.assign(error, { status, code }))
      respond(status, { ok: false, error: { code, message: error.status < 500 ? error.message : '操作失败，详情见漫游日志', logPath } })
    }
  }
  const register = () => ctx.webServer.register({ kind: 'prefix', path: '/roaming', handler: (req, res) => { void handler(req, res).catch(async error => {
    await log('request', error)
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: '请求失败', logPath } })) }
  }) } })
  if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-roaming memory framework')
  else register()
  return { operate }
}
