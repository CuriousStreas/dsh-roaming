/**
 * dsh-roaming — cross-machine session + memory sync over a git repository.
 *
 * Reuses the export/import bridge from dsh-session-sync (lib/sessions.js) and
 * swaps the LAN HTTP transport for a git remote. Repository layout:
 *
 *   memory/                 memory files, one copy for the whole user
 *     MEMORY.md / USER.md / memories.json
 *   hosts/
 *     <hostname>/           one folder per machine
 *       <sessionId>.json    one wire-format payload per session
 *
 * Local state (remote URL, clone path, fingerprint table, synced-set) lives in
 * <DSH_HOME>/roaming/state.json and never leaves the machine.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { SessionBridge, SessionSyncError, sessionSignature } from './sessions.js'
import { dshHome } from './state.js'
import { GitRepo } from './git.js'

export const name = 'dsh-roaming'
export const inject = ['webServer']

const VERSION = '0.2.0'
const API_PREFIX = '/roaming/api'
const DEFAULT_AUTO_SYNC_MS = 60 * 60 * 1000 // 1 hour

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeHostname() {
  return (os.hostname() || 'machine').replace(/[^a-zA-Z0-9._-]/g, '_')
}

function mnemonHome(cfg) {
  if (typeof cfg?.mnemonHome === 'string' && cfg.mnemonHome.length > 0) return cfg.mnemonHome
  return path.join(os.homedir(), '.mnemon')
}

export function apply(ctx, config = {}) {
  const cfg = isPlainObject(config) ? config : {}
  const log = (message) => {
    if (cfg.verbose === false) return
    console.log(`[dsh-roaming] ${message}`)
  }

  const home = dshHome(cfg)
  const stateDir = path.join(home, 'roaming')
  const stateFile = path.join(stateDir, 'state.json')

  // ---- tiny local state (atomic write, 0600) ----
  function defaultState() {
    return {
      selfId: crypto.randomUUID(),
      host: safeHostname(),
      repoUrl: '',
      signatures: {}, // content fingerprint -> local session id
      imported: {},   // '<host>/<sessionId>' -> { localId, at }
      synced: {},     // local session id -> pushed-at ms (what autoSync re-pushes)
      settings: {
        autoSync: true,
        autoSyncIntervalMs: DEFAULT_AUTO_SYNC_MS,
      },
    }
  }
  let state = loadState()
  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      const base = defaultState()
      return {
        ...base,
        ...raw,
        selfId: typeof raw.selfId === 'string' && raw.selfId.length > 0 ? raw.selfId : base.selfId,
        host: typeof raw.host === 'string' && raw.host.length > 0 ? raw.host : base.host,
        signatures: isPlainObject(raw.signatures) ? raw.signatures : {},
        imported: isPlainObject(raw.imported) ? raw.imported : {},
        synced: isPlainObject(raw.synced) ? raw.synced : {},
        settings: { ...base.settings, ...(isPlainObject(raw.settings) ? raw.settings : {}) },
      }
    } catch {
      return defaultState()
    }
  }
  function saveState() {
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const tmp = path.join(stateDir, `.state-${process.pid}-${Date.now()}.tmp`)
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(tmp, stateFile)
    } catch (error) {
      log(`状态写入失败: ${error?.message ?? error}`)
    }
  }

  const rememberSignature = (signature, localId) => {
    if (typeof signature === 'string' && signature.length > 0) state.signatures[signature] = localId
  }
  const bridge = new SessionBridge(ctx, { home, onImported: rememberSignature, onExported: rememberSignature })

  function repoDir() {
    return path.join(stateDir, 'repo')
  }
  function gitRepo() {
    return new GitRepo({ dir: repoDir(), remoteUrl: state.repoUrl, log })
  }
  function syncDir() {
    return typeof cfg.syncDir === 'string' && cfg.syncDir.length > 0 ? cfg.syncDir : process.cwd()
  }

  // ---- repository layout helpers ----
  const hostDir = () => path.join(repoDir(), 'hosts', state.host)
  const sessionFile = (id) => path.join(hostDir(), `${id}.json`)
  const memoryDir = () => path.join(repoDir(), 'memory')
  const mnemonRuntimeDir = () => path.join(mnemonHome(cfg), 'runtime')

  /** Export the given ids into hosts/<host>/<id>.json, then commit+push. */
  async function doPush(ids) {
    const repo = gitRepo()
    await repo.pull().catch(() => {})
    fs.mkdirSync(hostDir(), { recursive: true })
    const pushed = []
    for (const id of ids) {
      let payload
      try {
        payload = await bridge.exportSession(id)
      } catch (error) {
        log(`导出会话 ${id} 失败: ${error?.message ?? error}`)
        continue
      }
      fs.writeFileSync(sessionFile(id), `${JSON.stringify(payload, null, 2)}\n`)
      pushed.push({ id, title: payload.title ?? null, events: payload.events.length })
      state.synced[id] = Date.now()
    }
    saveState()
    if (pushed.length === 0) return { pushed, commit: 'none' }
    const commit = await repo.commitAll(`sync: push ${pushed.length} session(s) from ${state.host}`)
    if (commit === 'committed') await repo.push().catch((e) => log(`push 失败: ${e?.message ?? e}`))
    return { pushed, commit }
  }

  // ---- API ----
  const api = {
    async status() {
      return {
        version: VERSION,
        self: { id: state.selfId, host: state.host },
        repoUrl: state.repoUrl,
        repoDir: repoDir(),
        repoExists: fs.existsSync(path.join(repoDir(), '.git')),
        hasPersistence: bridge.hasPersistence,
        signatureCount: Object.keys(state.signatures).length,
        importedCount: Object.keys(state.imported).length,
        syncedCount: Object.keys(state.synced).length,
        settings: { ...state.settings },
      }
    },

    async configure({ repoUrl }) {
      const url = String(repoUrl ?? '').trim()
      if (url.length === 0) throw new SessionSyncError('bad-request', '缺少仓库地址', 400)
      state.repoUrl = url
      saveState()
      const outcome = await gitRepo().ensureRepo()
      log(`配置仓库 ${url} → ${outcome}`)
      return { ok: true, outcome, repoDir: repoDir() }
    },

    async listLocal() {
      const sessions = await bridge.list({ limit: 500 })
      return { sessions, synced: Object.keys(state.synced) }
    },

    /** Push the selected sessions and remember them for auto-sync. */
    async push({ sessionIds }) {
      const ids = Array.isArray(sessionIds) ? sessionIds.map((v) => String(v)) : []
      if (ids.length === 0) throw new SessionSyncError('bad-request', '缺少会话 id', 400)
      return { ok: true, ...(await doPush(ids)) }
    },

    /** Pull every other host's sessions, dedupe by fingerprint, import them. */
    async pull() {
      const repo = gitRepo()
      await repo.pull().catch(() => {})
      const hostsRoot = path.join(repoDir(), 'hosts')
      let dirs = []
      try {
        dirs = fs.readdirSync(hostsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
      } catch {
        dirs = []
      }
      const imported = []
      const skipped = []
      for (const dir of dirs) {
        if (dir.name === state.host) continue // 跳过自己的主机目录
        let files = []
        try {
          files = fs.readdirSync(path.join(hostsRoot, dir.name)).filter((f) => f.endsWith('.json'))
        } catch {
          continue
        }
        for (const f of files) {
          const key = `${dir.name}/${f}`
          if (state.imported[key]) { skipped.push(key); continue }
          let payload
          try {
            payload = JSON.parse(fs.readFileSync(path.join(hostsRoot, dir.name, f), 'utf8'))
          } catch {
            continue
          }
          if (!isPlainObject(payload?.session) || !Array.isArray(payload?.events)) continue
          const signature = sessionSignature(payload.session, payload.events)
          if (state.signatures[signature]) { skipped.push(key); continue }
          const result = await bridge.importSession(
            { session: payload.session, events: payload.events, sha256: payload.sha256 },
            { cwd: syncDir(), title: payload.title },
          )
          state.imported[key] = { localId: result.id, at: Date.now() }
          imported.push({ key, localId: result.id })
        }
      }
      saveState()
      return { ok: true, imported, skipped }
    },

    /** Full sync: pull the cloud, then push every session this machine has synced before. */
    async syncAll() {
      const pulled = await this.pull()
      const pushed = await doPush(Object.keys(state.synced))
      return { ok: true, pulled, pushed }
    },

    /** Update auto-sync settings and reschedule the timer. */
    async settings({ autoSync, autoSyncIntervalMs }) {
      if (typeof autoSync === 'boolean') state.settings.autoSync = autoSync
      if (Number.isFinite(autoSyncIntervalMs)) {
        const ms = Math.trunc(autoSyncIntervalMs)
        state.settings.autoSyncIntervalMs = Math.min(Math.max(ms, 60_000), 7 * 24 * 60 * 60 * 1000)
      }
      saveState()
      startAutoSync()
      return { ok: true, settings: { ...state.settings } }
    },

    /** Copy the local mnemon runtime files into memory/, commit+push. */
    async pushMemory() {
      const runtime = mnemonRuntimeDir()
      if (!fs.existsSync(runtime)) {
        return { ok: true, skipped: true, reason: '未检测到 mnemon 记忆（~/.mnemon/runtime），已跳过' }
      }
      const repo = gitRepo()
      await repo.pull().catch(() => {})
      fs.mkdirSync(memoryDir(), { recursive: true })
      const copied = []
      for (const file of ['memories.json', 'MEMORY.md', 'USER.md']) {
        const src = path.join(runtime, file)
        if (!fs.existsSync(src)) continue
        fs.copyFileSync(src, path.join(memoryDir(), file))
        copied.push(file)
      }
      const commit = await repo.commitAll(`sync: memory from ${state.host}`)
      if (commit === 'committed') await repo.push().catch((e) => log(`push 失败: ${e?.message ?? e}`))
      return { ok: true, copied, commit }
    },

    /** Copy the repo's memory/ files back into the local mnemon runtime dir. */
    async pullMemory() {
      const repo = gitRepo()
      await repo.pull().catch(() => {})
      const srcDir = memoryDir()
      if (!fs.existsSync(srcDir)) return { ok: true, skipped: true, reason: '仓库里没有 memory 目录' }
      const runtime = mnemonRuntimeDir()
      fs.mkdirSync(runtime, { recursive: true })
      const pulled = []
      for (const file of ['memories.json', 'MEMORY.md', 'USER.md']) {
        const src = path.join(srcDir, file)
        if (!fs.existsSync(src)) continue
        fs.copyFileSync(src, path.join(runtime, file))
        pulled.push(file)
      }
      return { ok: true, pulled }
    },
  }

  // ---- auto-sync timer ----
  let autoTimer = null
  let autoRunning = false
  function startAutoSync() {
    if (autoTimer !== null) {
      clearInterval(autoTimer)
      autoTimer = null
    }
    if (state.settings.autoSync !== true) return
    const ms = Number.isFinite(state.settings.autoSyncIntervalMs) ? state.settings.autoSyncIntervalMs : DEFAULT_AUTO_SYNC_MS
    autoTimer = setInterval(() => {
      void runAutoSync()
    }, ms)
    autoTimer.unref?.()
    log(`自动同步已开启：每 ${Math.round(ms / 60_000)} 分钟一次`)
  }
  async function runAutoSync() {
    if (autoRunning) return
    autoRunning = true
    try {
      const result = await api.syncAll()
      log(`自动同步完成：拉取 ${result.pulled.imported.length}，推送 ${result.pushed.pushed.length}`)
    } catch (error) {
      log(`自动同步失败: ${error?.message ?? error}`)
    } finally {
      autoRunning = false
    }
  }
  startAutoSync()

  // ---- GUI API wiring ----
  const handleApi = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh-roaming.internal')
    if (url.pathname === `${API_PREFIX}/version`) {
      writeJson(res, 200, { ok: true, version: VERSION })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'method', message: '只接受 POST' } })
      return
    }
    const connection = ctx.get?.('connection') ?? ctx.connection
    if (typeof connection?.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: '请求被连接策略拒绝' } })
        return
      }
    }
    let payload = {}
    try {
      payload = await readBody(req)
    } catch (error) {
      writeJson(res, 400, { ok: false, error: apiError(error) })
      return
    }
    const action = String(payload.action ?? url.searchParams.get('action') ?? '')
    const handler = Object.hasOwn(api, action) ? api[action] : undefined
    if (typeof handler !== 'function') {
      writeJson(res, 404, { ok: false, error: { code: 'unknown-action', message: `未知操作: ${action}` } })
      return
    }
    try {
      const result = await handler(payload)
      writeJson(res, 200, { ok: true, ...result })
    } catch (error) {
      const mapped = error instanceof SessionSyncError
        ? { code: error.code, message: error.message }
        : apiError(error)
      if (!(error instanceof SessionSyncError)) log(`操作 ${action} 失败: ${error?.stack ?? error}`)
      writeJson(res, error instanceof SessionSyncError ? error.status : 500, { ok: false, error: mapped })
    }
  }

  const register = () => ctx.webServer.register({
    kind: 'prefix',
    path: '/roaming',
    handler: (req, res) => {
      handleApi(req, res).catch((error) => {
        writeJson(res, 500, { ok: false, error: apiError(error) })
      })
    },
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(register, 'dsh-roaming: GUI API routes')
    ctx.effect(() => () => { if (autoTimer !== null) clearInterval(autoTimer) }, 'dsh-roaming: auto-sync timer')
  } else {
    register()
  }

  log(`已就绪：设备 ${state.host}`)
  return { state, bridge }
}

function apiError(error) {
  if (error instanceof SessionSyncError) return { code: error.code, message: error.message }
  return { code: 'internal', message: String(error?.message ?? error) }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 4 * 1024 * 1024) {
        reject(new SessionSyncError('too-large', '请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new SessionSyncError('bad-json', '请求体不是合法 JSON', 400))
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, value) {
  if (res.headersSent) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
