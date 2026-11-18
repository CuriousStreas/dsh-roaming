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
export const inject = ['webServer', 'workspaceRegistry']

const VERSION = '0.2.7'
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
    const line = `[dsh-roaming] [${new Date().toISOString()}] ${message}`
    console.log(line)
    try {
      // 落盘一份，方便事后排查（控制台可能看不到）。
      const dir = path.join(dshHome(cfg), 'roaming')
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, 'debug.log'), `${line}\n`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  const home = dshHome(cfg)
  const stateDir = path.join(home, 'roaming')
  const stateFile = path.join(stateDir, 'state.json')

  // ---- tiny local state (atomic write, 0600) ----
  function defaultState() {
    return {
      selfId: crypto.randomUUID(),
      host: safeHostname(),
      registeredAt: null,
      repoUrl: '',
      signatures: {}, // content fingerprint -> local session id
      imported: {},   // '<host>/<sessionId>' -> { localId, at }
      synced: {},     // local session id -> pushed-at ms (what autoSync re-pushes)
      source: {},    // local session id -> { host, sessionId } 反向映射（续聊覆盖回源）
      base: {},      // local session id -> 上次同步时的事件数（增量追加基准）
      settings: {
        autoSync: true,
        autoSyncIntervalMs: DEFAULT_AUTO_SYNC_MS,
        syncMemory: false, // 记忆同步默认关，用户主动打开才同步（不是人人装 mnemon）
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
        source: isPlainObject(raw.source) ? raw.source : {},
        base: isPlainObject(raw.base) ? raw.base : {},
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
  function syncRoot() {
    const root = typeof cfg.syncRoot === 'string' && cfg.syncRoot.length > 0
      ? cfg.syncRoot
      : typeof cfg.syncDir === 'string' && cfg.syncDir.length > 0
        ? cfg.syncDir
        : path.join(home, 'roaming', 'workspaces')
    return path.isAbsolute(root) ? root : path.resolve(root)
  }
  /** One workspace per host: <syncRoot>/<host>. The folder name becomes the
   *  workspace title in the GUI, so one machine's conversations stay grouped
   *  together instead of mixing into a single shared workspace. */
  function hostWorkspace(host) {
    let segment = String(host ?? '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+$/, '_')
    if (segment.length === 0 || segment === '.' || segment === '..') segment = 'machine'
    return path.join(syncRoot(), segment)
  }

  // ---- repository layout helpers ----
  const hostDir = () => path.join(repoDir(), 'hosts', state.host)
  const sessionFile = (id) => path.join(hostDir(), `${id}.json`)
  const machineFile = () => path.join(hostDir(), 'machine.json')
  const memoryDir = () => path.join(repoDir(), 'memory')
  const mnemonRuntimeDir = () => path.join(mnemonHome(cfg), 'runtime')

  /** Machine self-description written into hosts/<host>/machine.json. */
  function machineMarker() {
    return {
      selfId: state.selfId,
      host: state.host,
      registeredAt: state.registeredAt ?? Date.now(),
      lastSeen: Date.now(),
    }
  }

  /** Create this machine's host directory and write its marker file. */
  function writeMachineMarker() {
    fs.mkdirSync(hostDir(), { recursive: true })
    const marker = machineMarker()
    fs.writeFileSync(machineFile(), `${JSON.stringify(marker, null, 2)}\n`)
    if (state.registeredAt === null || state.registeredAt === undefined) state.registeredAt = marker.registeredAt
    return marker
  }

  /** Path to this machine's declarative config snapshot. */
  const configFile = () => path.join(hostDir(), 'config.md')

  /** Read every local DSH profile's plugin manifest (dependencies + bundles). */
  function readLocalProfiles() {
    const profilesRoot = path.join(home, 'profiles')
    const out = []
    let names
    try {
      names = fs.readdirSync(profilesRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return out
    }
    for (const dir of names) {
      const pkgPath = path.join(profilesRoot, dir.name, 'package.json')
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        if (!isPlainObject(pkg)) continue
        out.push({
          profile: dir.name,
          dependencies: isPlainObject(pkg.dependencies) ? pkg.dependencies : {},
          bundles: Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [],
        })
      } catch {
        /* a broken profile manifest just yields no config for it */
      }
    }
    return out
  }

  /** Render the declarative config snapshot as Markdown the agent can act on. */
  function renderConfigMd() {
    const profiles = readLocalProfiles()
    const lines = [
      `# 机器配置快照（${state.host}）`,
      '',
      `> 生成时间: ${new Date().toISOString()}`,
      '> 由 dsh-roaming 自动生成。要在新机器复刻本机配置，把本文件交给 DSH agent 执行。',
      '',
    ]
    if (profiles.length === 0) {
      lines.push('（未读取到任何 profile）')
      return lines.join('\n')
    }
    for (const p of profiles) {
      lines.push(`## profile: \`${p.profile}\``, '')
      const deps = Object.keys(p.dependencies)
      if (deps.length > 0) {
        lines.push('### 插件依赖 (dependencies)')
        for (const dep of deps) lines.push(`- \`${dep}\` \`${p.dependencies[dep]}\``)
        lines.push('')
      }
      if (p.bundles.length > 0) {
        lines.push('### 激活插件 (bundles)')
        for (const b of p.bundles) lines.push(`- \`${b}\``)
        lines.push('')
      }
    }
    lines.push('## 复刻说明')
    lines.push('')
    lines.push('在新机器上复刻本机配置：')
    lines.push('1. 对 dependencies 里的每个插件执行 `dsh plugin --profile <profile> add <包名>`（`link:` 协议的请改成 `file:` 或 `github:` 安装）。')
    lines.push('2. 确认 bundles 里列出的插件都已激活。')
    lines.push('3. 全部装完后重启 DSH 生效。')
    lines.push('')
    return lines.join('\n')
  }

  /** Write the config snapshot into hosts/<host>/config.md. */
  function writeConfigMd() {
    fs.mkdirSync(hostDir(), { recursive: true })
    fs.writeFileSync(configFile(), `${renderConfigMd()}\n`)
  }

  /** List every host directory in the repo with its machine marker, if any. */
  function knownHosts() {
    const hostsRoot = path.join(repoDir(), 'hosts')
    const out = []
    let dirs
    try {
      dirs = fs.readdirSync(hostsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
    } catch {
      return out
    }
    for (const dir of dirs) {
      let meta = null
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(hostsRoot, dir.name, 'machine.json'), 'utf8'))
        if (isPlainObject(parsed)) {
          meta = {
            selfId: typeof parsed.selfId === 'string' ? parsed.selfId : null,
            host: typeof parsed.host === 'string' ? parsed.host : dir.name,
            registeredAt: Number.isFinite(parsed.registeredAt) ? parsed.registeredAt : null,
            lastSeen: Number.isFinite(parsed.lastSeen) ? parsed.lastSeen : null,
          }
        }
      } catch {
        meta = { host: dir.name, selfId: null, registeredAt: null, lastSeen: null }
      }
      out.push({ host: dir.name, meta })
    }
    return out
  }

  /** Register this machine in the repo if its marker is not there yet. Runs on
   *  configure and on every full sync, so even a machine that only pulls (never
   *  pushes a session) is visible to its peers instead of staying invisible. */
  async function ensureRegistered() {
    if (typeof state.repoUrl !== 'string' || state.repoUrl.trim().length === 0) return 'not-configured'
    const repo = gitRepo()
    await repo.ensureRepo().catch(() => {})
    if (fs.existsSync(machineFile())) return 'already-registered'
    writeMachineMarker()
    writeConfigMd()
    saveState()
    const commit = await repo.commitAll(`register: machine ${state.host}`)
    if (commit === 'committed') await repo.push().catch((e) => log(`登记 push 失败: ${e?.message ?? e}`))
    return commit === 'committed' ? 'registered' : 'no-changes'
  }

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
      // 双向续聊：导入的会话覆盖回源 host 文件；本机会话写到本机目录
      const src = state.source[id]
      const targetDir = src ? path.join(repoDir(), 'hosts', src.host) : hostDir()
      const targetFile = src ? path.join(targetDir, src.sessionId) : sessionFile(id)
      fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(targetFile, `${JSON.stringify(payload, null, 2)}\n`)
      pushed.push({ id, title: payload.title ?? null, events: payload.events.length })
      state.synced[id] = Date.now()
      state.base[id] = payload.events.length
    }
    if (pushed.length === 0) return { pushed, commit: 'none' }
    writeMachineMarker()
    writeConfigMd()
    saveState()
    const commit = await repo.commitAll(`sync: push ${pushed.length} session(s) from ${state.host}`)
    if (commit === 'committed') await repo.push().catch((e) => log(`push 失败: ${e?.message ?? e}`))
    return { pushed, commit }
  }

  // ---- API ----
  let pullBusy = false // 串行化 import，避免双击/并发触发重复导入同一会话
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
        hosts: knownHosts(),
        settings: { ...state.settings },
      }
    },

    async configure({ repoUrl }) {
      const url = String(repoUrl ?? '').trim()
      if (url.length === 0) throw new SessionSyncError('bad-request', '缺少仓库地址', 400)
      state.repoUrl = url
      saveState()
      const repo = gitRepo()
      const outcome = await repo.ensureRepo()
      log(`配置仓库 ${url} → ${outcome}`)
      // 立刻把本机登记进仓库，避免出现只读、不露面的隐形机器。
      const registered = await ensureRegistered()
      const machine = machineMarker()
      // 仓库里已有的其它机器会话，配置完就直接导入，打通“下载→对话”。
      let pulled = { imported: [], skipped: [] }
      try {
        pulled = await api.pull()
      } catch (error) {
        log(`配置后自动导入失败: ${error?.message ?? error}`)
      }
      return { ok: true, outcome, repoDir: repoDir(), machine, registered, imported: pulled.imported }
    },

    async listLocal() {
      const sessions = await bridge.list({ limit: 500 })
      // 过滤掉插件后台子会话（如 [dsh-mnemon:delegated review] ...），只留真实对话
      const visible = sessions.filter((s) => !/^\[[^\]]+:/.test(s.title ?? ''))
      return { sessions: visible, synced: Object.keys(state.synced) }
    },

    /** Push the selected sessions and remember them for auto-sync. */
    async push({ sessionIds }) {
      const ids = Array.isArray(sessionIds) ? sessionIds.map((v) => String(v)) : []
      if (ids.length === 0) throw new SessionSyncError('bad-request', '缺少会话 id', 400)
      return { ok: true, ...(await doPush(ids)) }
    },

    /** Pull every other host's sessions, dedupe by fingerprint, import them. */
    async pull() {
      if (pullBusy) return { ok: true, imported: [], skipped: [], failed: [], busy: true }
      pullBusy = true
      try {
        return await this._pull()
      } finally {
        pullBusy = false
      }
    },

    /** Inner pull body; separated so the busy guard above stays a one-liner. */
    async _pull() {
      const repo = gitRepo()
      await repo.pull().catch(() => {})
      // Self-heal: forget imports whose local copy was deleted (e.g. a corrupt
      // import the user removed), so the next pull re-imports them cleanly.
      if (bridge.pruneDangling(state)) saveState()
      const hostsRoot = path.join(repoDir(), 'hosts')
      let dirs = []
      try {
        dirs = fs.readdirSync(hostsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
      } catch {
        dirs = []
      }
      const imported = []
      const skipped = []
      const failed = []
      for (const dir of dirs) {
        // 不跳过自己的目录：自己 push 过的靠指纹去重跳过，被别的机器续聊覆盖的
        // （指纹变了）会自然重新导入，这就是"拉取更新"，走的是同一套导入逻辑。
        let files = []
        try {
          files = fs.readdirSync(path.join(hostsRoot, dir.name)).filter((f) => f.endsWith('.json'))
        } catch {
          continue
        }
        for (const f of files) {
          if (f === 'machine.json') continue // 机器登记文件，不是会话
          const key = `${dir.name}/${f}`
          let payload
          try {
            payload = JSON.parse(fs.readFileSync(path.join(hostsRoot, dir.name, f), 'utf8'))
          } catch {
            failed.push({ key, error: '无法解析会话文件' })
            continue
          }
          if (!isPlainObject(payload?.session) || !Array.isArray(payload?.events)) { skipped.push(key); continue }
          // 绑定死 + 三路比较：base=上次同步事件数，local=本地当前，remote=远程当前
          const rec = state.imported[key]
          if (rec && typeof rec.localId === 'string') {
            const base = Number.isFinite(state.base?.[rec.localId]) ? state.base[rec.localId] : payload.events.length
            state.base[rec.localId] = base
            const remoteCount = payload.events.length
            // 读本地会话事件数，判断本地是否也续聊了
            let localCount = base
            try {
              const snap = await bridge.read(rec.localId)
              localCount = Array.isArray(snap?.events) ? snap.events.length : base
            } catch { /* 读失败按 base 处理 */ }
            if (remoteCount > base && localCount > base) {
              // 冲突：两边都续聊 → 远程另存副本，绝不覆盖本地
              try {
                const workspace = hostWorkspace(dir.name)
                fs.mkdirSync(workspace, { recursive: true })
                const fork = await bridge.importSession(
                  { session: payload.session, events: payload.events, sha256: payload.sha256 },
                  { cwd: workspace, title: `${payload.title ?? '未命名会话'}（冲突副本）` },
                )
                state.signatures[sessionSignature(payload.session, payload.events)] = fork.id
                imported.push({ key, localId: fork.id, conflict: true })
                log(`冲突 ${key}：本地与远程都续聊，远程已另存副本 ${fork.id}，待手动 merge`)
              } catch (error) {
                failed.push({ key, error: error?.message ?? String(error) })
              }
              continue
            }
            if (remoteCount > base) {
              // 只有远程续聊 → 原地追加
              try {
                const appended = payload.events.slice(base)
                await bridge.appendUpdate(rec.localId, appended, base)
                state.base[rec.localId] = remoteCount
                imported.push({ key, localId: rec.localId, appended: appended.length })
                log(`追加 ${key} → ${rec.localId} (+${appended.length} 事件)`)
              } catch (error) {
                log(`追加 ${key} 失败: ${error?.message ?? error}`)
                failed.push({ key, error: error?.message ?? String(error) })
              }
              continue
            }
            // 一致，或只有本地续聊（本地续聊由 push 上传）
            skipped.push(key)
            continue
          }
          const signature = sessionSignature(payload.session, payload.events)
          if (state.signatures[signature]) { skipped.push(key); continue }
          try {
            const workspace = hostWorkspace(dir.name)
            fs.mkdirSync(workspace, { recursive: true })
            const result = await bridge.importSession(
              { session: payload.session, events: payload.events, sha256: payload.sha256 },
              { cwd: workspace, title: payload.title },
            )
            const verify = await bridge.verify(result.id)
            if (!verify.ok) {
              log(`导入 ${key} 自检失败: ${verify.error}`)
              failed.push({ key, error: `导入后自检失败: ${verify.error}` })
              continue
            }
            state.imported[key] = { localId: result.id, at: Date.now() }
            state.source[result.id] = { host: dir.name, sessionId: f }
            state.base[result.id] = payload.events.length
            imported.push({ key, localId: result.id })
            log(`导入 ${key} → ${result.id} (${result.events} 事件) 自检通过`)
            // 关键：把会话挂到 DSH 的工作区注册表，否则 GUI 的工作区列表看不到它。
            try {
              const registry = ctx.get?.('workspaceRegistry')
              if (registry && typeof registry.create === 'function') {
                const entity = await registry.create(workspace, dir.name)
                if (entity && typeof entity.attachSession === 'function') {
                  await entity.attachSession(result.id)
                  log(`已把 ${result.id} 挂到工作区 ${dir.name}`)
                } else {
                  log('workspaceRegistry 未暴露 attachSession，会话可能不在工作区列表')
                }
              } else {
                log('workspaceRegistry 服务不可用，会话不会出现在工作区列表')
              }
            } catch (error) {
              log(`挂载工作区失败: ${error?.message ?? error}`)
            }
          } catch (error) {
            log(`导入 ${key} 失败: ${error?.message ?? error}`)
            failed.push({ key, error: error?.message ?? String(error) })
          }
        }
      }
      saveState()
      return { ok: true, imported, skipped, failed }
    },

    /** Full sync: pull the cloud, then push every session this machine has synced before. */
    async syncAll() {
      await ensureRegistered()
      const pulled = await this.pull()
      // 默认上传：同步时把本机所有真实对话都推上去（过滤插件后台子会话）
      const local = await bridge.list({ limit: 500 })
      const ids = local.filter((s) => !/^\[[^\]]+:/.test(s.title ?? '')).map((s) => s.id)
      const pushed = await doPush(ids)
      return { ok: true, pulled, pushed }
    },

    /** Update auto-sync settings and reschedule the timer. */
    async settings({ autoSync, autoSyncIntervalMs, syncMemory }) {
      if (typeof autoSync === 'boolean') state.settings.autoSync = autoSync
      if (Number.isFinite(autoSyncIntervalMs)) {
        const ms = Math.trunc(autoSyncIntervalMs)
        state.settings.autoSyncIntervalMs = Math.min(Math.max(ms, 60_000), 7 * 24 * 60 * 60 * 1000)
      }
      if (typeof syncMemory === 'boolean') state.settings.syncMemory = syncMemory
      saveState()
      startAutoSync()
      return { ok: true, settings: { ...state.settings } }
    },

    /** Snapshot this machine's config into config.md and push it. */
    async pushConfig() {
      const repo = gitRepo()
      await repo.pull().catch(() => {})
      writeMachineMarker()
      writeConfigMd()
      saveState()
      const commit = await repo.commitAll(`config: snapshot from ${state.host}`)
      if (commit === 'committed') await repo.push().catch((e) => log(`push 失败: ${e?.message ?? e}`))
      return { ok: true, commit }
    },

    /** Copy the local mnemon runtime files into memory/, commit+push. */
    async pushMemory() {
      if (state.settings.syncMemory !== true) {
        return { ok: true, skipped: true, reason: '记忆同步未开启（先打开「同步记忆」开关）' }
      }
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
      writeMachineMarker()
      const commit = await repo.commitAll(`sync: memory from ${state.host}`)
      if (commit === 'committed') await repo.push().catch((e) => log(`push 失败: ${e?.message ?? e}`))
      return { ok: true, copied, commit }
    },

    /** Copy the repo's memory/ files back into the local mnemon runtime dir. */
    async pullMemory() {
      if (state.settings.syncMemory !== true) {
        return { ok: true, skipped: true, reason: '记忆同步未开启（先打开「同步记忆」开关）' }
      }
      // 本机没装 mnemon（~/.mnemon 不存在）就不拉，避免凭空创建目录
      if (!fs.existsSync(mnemonHome(cfg))) {
        return { ok: true, skipped: true, reason: '本机未检测到 mnemon 记忆插件，已跳过' }
      }
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

  // 启动后自动同步一次，避免每次都要手动点「全量同步」；稍等让各服务就绪。
  if (typeof state.repoUrl === 'string' && state.repoUrl.trim().length > 0) {
    const bootSync = setTimeout(() => { void runAutoSync() }, 5000)
    bootSync.unref?.()
  }

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
      const result = await handler.call(api, payload)
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
