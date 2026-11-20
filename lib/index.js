// dsh-roaming safe-preview runtime. The v2 state and mirror are intentionally never opened
// for writing: they contain unacknowledged Git commits and unverified session bindings.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import { SessionSyncError, sessionDigest } from './sessions.js'
import { dshHome } from './state.js'
import { GitRepo } from './git.js'
import { previewV3Mirror } from './v3-preview.js'
import { applyFramework, RUNTIME_VERSION } from './framework.js'

export const name = 'dsh-roaming'
// Cordis 4 accepts service-name arrays/maps, not { required, optional }.
// Native services are resolved lazily by explicit bridge operations only.
export const inject = ['webServer', 'connection']
const VERSION = '0.3.0-preview'
const API_PREFIX = '/roaming/api'
const SCHEMA_VERSION = '3'
const MAX_PAYLOAD = 16 * 1024 * 1024
const MAX_PREVIEW_FILES = 100
const ACTIONS = new Set(['status', 'listLocal', 'configure', 'pull', 'syncAll', 'settings', 'push', 'pushMemory', 'pullMemory', 'pushConfig', 'openLogs'])

// Do not parse v3 immutable objects with the quarantined hosts/*.json reader.
export function assertLegacyPreviewSchema(repositorySchema) {
  if (repositorySchema.compatible) throw new SessionSyncError('unsupported-preview', 'v3 数据仓库预览尚未接入安全解析器', 409)
  if (repositorySchema.version !== null) throw new SessionSyncError('unsupported-preview', '未知仓库协议，禁止使用旧版 hosts 读器', 409)
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        settled = true
        chunks.length = 0
        // Do not destroy the request before the HTTP 413 response can be sent.
        // Remaining body bytes are drained without being retained or parsed.
        reject(new SessionSyncError('too-large', '请求体过大', 413))
      } else chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new SessionSyncError('bad-json', '请求体不是 JSON', 400)) }
    })
    req.on('aborted', () => { if (!settled) { settled = true; reject(new SessionSyncError('aborted', '请求已中断', 400)) } })
    req.on('error', (error) => { if (!settled) { settled = true; reject(error) } })
  })
}

function safeSegment(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  // Console-only startup evidence: no profile, session, or plugin-data I/O.
  try { console.info(`[dsh-roaming] startup runtime=${RUNTIME_VERSION} pid=${process.pid} mode=${cfg.mode === 'preview' ? 'preview' : 'framework'} source=${import.meta.url}`) } catch { /* diagnostics must not affect boot */ }
  // Preview is an explicit legacy opt-in, not the default for file installs.
  if (cfg.mode !== 'preview') return applyFramework(ctx, cfg)
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
    const info = fs.lstatSync(marker)
    if (!info.isFile() || info.size > 32 || info.isSymbolicLink()) throw new Error('unsafe data protocol marker')
    const version = fs.readFileSync(marker, 'utf8').trim()
    return { version, compatible: version === SCHEMA_VERSION }
  }
  function readPayload(file) {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_PAYLOAD || fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== path.resolve(file)) throw new Error('artifact unavailable or exceeds size limit')
    const bytes = fs.readFileSync(file)
    if (bytes.length > MAX_PAYLOAD) throw new Error('artifact exceeds size limit')
    const payload = JSON.parse(file.endsWith('.zst') ? zstdDecompressSync(bytes, { maxOutputLength: MAX_PAYLOAD }).toString('utf8') : bytes.toString('utf8'))
    if (!payload || !payload.session || !Array.isArray(payload.events) || !payload.sha256) throw new Error('invalid artifact')
    if (sessionDigest(payload.session, payload.events) !== payload.sha256.toLowerCase()) throw new Error('artifact checksum mismatch')
    return payload
  }
  async function preview() {
    if (stateError) throw new SessionSyncError('invalid-state', stateError, 409)
    if (!state.repoUrl) throw new SessionSyncError('not-configured', '先配置数据仓库', 400)
    await git().previewPull() // failure is fatal; never treat a stale mirror as current
    const repositorySchema = schema()
    if (repositorySchema.compatible) {
      const viewed = previewV3Mirror(git())
      return { ok: true, mode: 'read-only-preview', schema: repositorySchema,
        sessions: viewed.sessions, failed: [], imported: [], skipped: [], count: viewed.sessions.length,
        manifestHead: viewed.manifestHead, objectCount: viewed.objectCount }
    }
    // The old hosts/*.json reader cannot interpret a versioned v3 mirror.
    assertLegacyPreviewSchema(repositorySchema)
    const rootHosts = path.join(repoDir, 'hosts')
    const sessions = []
    const failed = []
    if (fs.existsSync(rootHosts)) {
      if (!fs.lstatSync(rootHosts).isDirectory() || fs.lstatSync(rootHosts).isSymbolicLink() || fs.realpathSync(rootHosts) !== path.resolve(rootHosts)) throw new Error('unsafe hosts directory')
      let visited = 0
      for (const host of fs.readdirSync(rootHosts, { withFileTypes: true })) {
        if (!host.isDirectory() || !safeSegment(host.name)) continue
        const folder = path.join(rootHosts, host.name)
        if (fs.lstatSync(folder).isSymbolicLink() || fs.realpathSync(folder) !== path.resolve(folder)) continue
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
      await repo.ensurePreviewRepo() // no automatic registration or import
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
