// dsh-roaming safe-preview runtime. The v2 state and mirror are intentionally never opened
// for writing: they contain unacknowledged Git commits and unverified session bindings.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { SessionSyncError, sessionDigest } from './sessions.js'
import { dshHome } from './state.js'
import { GitRepo } from './git.js'

export const name = 'dsh-roaming'
export const inject = ['webServer', 'connection']
const VERSION = '0.3.0-preview'
const API_PREFIX = '/roaming/api'
const SCHEMA_VERSION = '3'
const MAX_PAYLOAD = 16 * 1024 * 1024
const MAX_PREVIEW_FILES = 100
const ACTIONS = new Set(['status', 'listLocal', 'configure', 'pull', 'syncAll', 'settings', 'push', 'pushMemory', 'pullMemory', 'pushConfig', 'openLogs'])

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new SessionSyncError('too-large', '请求体过大', 413))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new SessionSyncError('bad-json', '请求体不是 JSON', 400)) }
    })
    req.on('error', reject)
  })
}

function safeSegment(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const home = dshHome(cfg)
  const root = path.join(home, 'roaming', 'v3')
  const statePath = path.join(root, 'state.json')
  const repoDir = path.join(root, 'repo')
  const logPath = path.join(root, 'debug.log')
  let pathError = null
  try {
    if (fs.existsSync(root) && (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== path.resolve(root))) throw new Error('unsafe roaming root')
    if (fs.existsSync(repoDir) && (!fs.lstatSync(repoDir).isDirectory() || fs.realpathSync(repoDir) !== path.resolve(repoDir))) throw new Error('unsafe roaming mirror')
  } catch (error) { pathError = error?.message ?? 'unsafe roaming path' }
  const log = (message, error) => {
    try {
      if (pathError || (fs.existsSync(logPath) && (fs.lstatSync(logPath).isSymbolicLink() || !fs.lstatSync(logPath).isFile()))) return
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== path.resolve(root)) return
      // Never append through an attacker-supplied link; a failed diagnostic
      // must remain confined to the plugin-owned directory.
      const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
      try {
        if (!fs.fstatSync(fd).isFile()) return
        const extra = error ? `\n${error?.stack ?? String(error)}` : ''
        fs.writeSync(fd, `[${new Date().toISOString()}] ${message}${extra}\n`)
      } finally { fs.closeSync(fd) }
    } catch { /* diagnostics must not affect native DSH */ }
  }
  const freshState = () => ({ deviceId: crypto.randomUUID(), repoUrl: '', enrolled: {}, settings: { autoSync: false, syncMemory: false } })
  let state
  let stateError = pathError
  try {
    if (pathError) throw new Error(pathError)
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (!safeSegment(saved.deviceId) || typeof saved.repoUrl !== 'string' || (saved.repoUrl && !/^(?:git@[^\s:]+:[^\s]+|ssh:\/\/[^\s]+)$/.test(saved.repoUrl)) || !saved.enrolled || typeof saved.enrolled !== 'object') throw new Error('invalid state')
    state = saved
  } catch (error) {
    state = freshState()
    // Bad state must block all operations without taking DSH offline.
    if (fs.existsSync(statePath) || pathError) {
      stateError = `roaming v3 state unavailable: ${error?.message ?? error}`
      if (!pathError) log(stateError)
    }
  }
  const saveState = () => {
    if (stateError) throw new Error(stateError)
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const tmp = path.join(root, `.state-${process.pid}-${crypto.randomUUID()}.tmp`)
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, statePath)
  }
  const git = () => new GitRepo({ dir: repoDir, remoteUrl: state.repoUrl, log })
  let busy = false
  async function serial(task) {
    if (stateError) throw new SessionSyncError('invalid-state', stateError, 409)
    if (busy) throw new SessionSyncError('busy', '已有漫游操作进行中', 409)
    busy = true
    try { return await task() } finally { busy = false }
  }
  function schema() {
    const marker = path.join(repoDir, 'SCHEMA_VERSION')
    if (!fs.existsSync(marker)) return { version: null, compatible: false }
    const version = fs.readFileSync(marker, 'utf8').trim()
    return { version, compatible: version === SCHEMA_VERSION }
  }
  function readPayload(file) {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_PAYLOAD || fs.lstatSync(file).isSymbolicLink()) throw new Error('artifact unavailable or exceeds size limit')
    const bytes = fs.readFileSync(file)
    const payload = JSON.parse(file.endsWith('.zst') ? zstdDecompressSync(bytes, { maxOutputLength: MAX_PAYLOAD }).toString('utf8') : bytes.toString('utf8'))
    if (!payload || !payload.session || !Array.isArray(payload.events) || !payload.sha256) throw new Error('invalid artifact')
    if (sessionDigest(payload.session, payload.events) !== payload.sha256.toLowerCase()) throw new Error('artifact checksum mismatch')
    return payload
  }
  async function preview() {
    if (stateError) throw new SessionSyncError('invalid-state', stateError, 409)
    if (!state.repoUrl) throw new SessionSyncError('not-configured', '先配置数据仓库', 400)
    await git().pull() // failure is fatal; never treat a stale mirror as current
    const rootHosts = path.join(repoDir, 'hosts')
    const sessions = []
    const failed = []
    if (fs.existsSync(rootHosts)) {
      if (!fs.lstatSync(rootHosts).isDirectory() || fs.lstatSync(rootHosts).isSymbolicLink()) throw new Error('unsafe hosts directory')
      let visited = 0
      for (const host of fs.readdirSync(rootHosts, { withFileTypes: true })) {
        if (!host.isDirectory() || !safeSegment(host.name)) continue
        const folder = path.join(rootHosts, host.name)
        if (fs.lstatSync(folder).isSymbolicLink()) continue
        for (const name of fs.readdirSync(folder)) {
          if (++visited > MAX_PREVIEW_FILES) throw new Error('preview limit reached (100 artifacts)')
          if (!/^[-\w]+\.json(\.zst)?$/.test(name) || name === 'machine.json') continue
          const key = `${host.name}/${name}`
          try {
            const payload = readPayload(path.join(folder, name))
            sessions.push({ key, title: payload.title ?? null, digest: payload.sha256, events: payload.events.length })
          } catch (error) {
            failed.push({ key, reason: error?.message ?? String(error) })
            log(`preview invalid: ${key}`, error)
          }
        }
      }
    }
    return { ok: true, mode: 'read-only-preview', schema: schema(), sessions, failed, imported: [], skipped: [], count: sessions.length }
  }
  const disabled = () => { throw new SessionSyncError('preview-only', '安全重构尚未完成：此版本只提供仓库预览；禁止上传、导入及记忆覆盖', 409) }
  const api = {
    status: async () => ({ ok: !stateError, version: VERSION, mode: 'read-only-preview', stateError, repoUrl: stateError ? '' : state.repoUrl, repoDir, repoExists: fs.existsSync(path.join(repoDir, '.git')), settings: { autoSync: false, syncMemory: false }, syncedCount: 0, synced: [], importedCount: 0, hosts: [], logPath, logDir: root, schema: fs.existsSync(path.join(repoDir, '.git')) ? schema() : null }),
    listLocal: async () => ({ ok: true, sessions: [], synced: [], reason: '安全预览期不扫描原生会话；加入漫游尚未启用' }),
    configure: async ({ repoUrl }) => serial(async () => {
      const url = String(repoUrl ?? '').trim()
      if (!url || !/^(?:git@[^\s:]+:[^\s]+|ssh:\/\/[^\s]+)$/.test(url) || /@[^/@]+@/.test(url)) throw new SessionSyncError('bad-request', '仅允许不含嵌入凭据的 SSH 仓库地址', 400)
      if (state.repoUrl && state.repoUrl !== url) throw new SessionSyncError('repo-locked', '更换数据仓库需要新建隔离 profile，不复用现有状态', 409)
      const repo = new GitRepo({ dir: repoDir, remoteUrl: url, log })
      await repo.ensureRepo() // no automatic registration or import
      state.repoUrl = url
      saveState()
      return { ok: true, mode: 'read-only-preview', repoDir, schema: schema() }
    }),
    pull: async () => serial(preview),
    syncAll: async () => serial(preview),
    settings: async () => ({ ok: true, settings: { autoSync: false, syncMemory: false }, reason: '安全预览期不开放自动同步' }),
    push: disabled, pushMemory: disabled, pullMemory: disabled, pushConfig: disabled,
    openLogs: async () => ({ ok: true, dir: root, file: logPath }),
  }
  const handler = async (req, res) => {
    if (req.method !== 'POST' || new URL(req.url ?? '/', 'http://localhost').pathname !== API_PREFIX) {
      json(res, 404, { ok: false, error: { code: 'not-found', message: 'Not found' } })
      return
    }
    try {
      const connection = ctx.get?.('connection') ?? ctx.connection
      if (typeof connection?.requestRejection !== 'function' || connection.requestRejection(req) !== undefined) {
        json(res, 403, { ok: false, error: { code: 'forbidden', message: '无法验证请求身份' } })
        return
      }
      const payload = await bodyOf(req)
      if (stateError) throw new SessionSyncError('invalid-state', stateError, 409)
      const action = payload?.action
      if (!ACTIONS.has(action)) { json(res, 404, { ok: false, error: { code: 'unknown-action', message: '未知操作' } }); return }
      json(res, 200, await api[action](payload))
    } catch (error) {
      log('API operation failed', error)
      json(res, error instanceof SessionSyncError ? error.status : 500, { ok: false, error: { code: error?.code ?? 'internal', message: error instanceof SessionSyncError ? error.message : '操作失败，详情见漫游日志' } })
    }
  }
  const register = () => ctx.webServer.register({ kind: 'prefix', path: '/roaming', handler: (req, res) => { void handler(req, res).catch((error) => { log('request failed', error); if (!res.headersSent) json(res, 500, { ok: false, error: { code: 'internal', message: '请求失败' } }) }) } })
  try {
    if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-roaming: safe preview API')
    else register()
  } catch (error) { log('roaming route unavailable', error) }
  return { state }
}
