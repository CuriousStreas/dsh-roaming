/**
 * dsh-roaming — browser half.
 *
 * Hand-written bundle (no build step, no JSX), mirroring the dsh-session-sync
 * client contract: register under `window.__ModuleLoader__.load`, take `react`
 * from the platform seeds, and claim two slots:
 *
 *   - `sidebar.panellist` → the sidebar entry row
 *   - `main`              → the keyed panel that row opens
 *
 * All data comes from the host half's same-origin route `/roaming/api`.
 */
;(() => {
const MODULE_ID = 'dsh-roaming'

window.__ModuleLoader__.load({
  id: MODULE_ID,
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API_PATH = '/roaming/api'
    const PANEL_ID = 'roaming'

    // ── styles ────────────────────────────────────────────────────────────
    const CSS = `
.gs-root{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;
  background:var(--dsw-alias-bg-base,#0d0d0f);color:var(--dsw-alias-label-primary,#f4f4f5);
  font:14px/22px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);
  -webkit-font-smoothing:antialiased;overflow:hidden}
.gs-page{display:flex;flex-direction:column;gap:14px;flex:1;min-height:0;padding:20px 24px 0;overflow:auto}
.gs-h1{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.015em}
.gs-sub{color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:12.5px;line-height:18px;margin:2px 0 0}
.gs-card{border:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));border-radius:12px;
  background:var(--dsw-alias-bg-layer-1,#17171a);padding:14px}
.gs-field{display:flex;align-items:center;gap:10px}
.gs-field+.gs-field{margin-top:10px}
.gs-input{flex:1;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));
  border-radius:8px;background:var(--dsw-alias-bg-layer-2,#1e1e22);color:var(--dsw-alias-label-primary,#f4f4f5);
  font:inherit;font-size:13px;outline:0;min-width:0}
.gs-input:focus{border-color:var(--dsw-alias-brand-primary,#7c93ff)}
.gs-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;
  border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));background:transparent;
  color:var(--dsw-alias-label-primary,#f4f4f5);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}
.gs-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.gs-btn.primary{background:var(--dsw-alias-button-primary-fill,#ededf0);color:var(--dsw-alias-label-primary-foreground,#131316);border-color:transparent;font-weight:550}
.gs-btn.sm{height:26px;padding:0 10px;font-size:12.5px}
.gs-btn:disabled{opacity:.42;pointer-events:none}
.gs-row{display:flex;align-items:center;gap:10px;padding:8px 4px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.gs-row:first-child{border-top:0}
.gs-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
.gs-row-meta{color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:11.5px;flex:none}
.gs-note{color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:12px;line-height:18px}
.gs-note.error{color:var(--dsw-alias-state-error-primary,#f87171)}
.gs-note.ok{color:var(--dsw-alias-state-success-primary,#4ade80)}
.gs-switch{position:relative;width:36px;height:22px;flex:none;padding:0;border:0;border-radius:99px;
  background:var(--dsw-alias-border-l3,rgba(255,255,255,.17));cursor:pointer}
.gs-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;
  background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform 180ms var(--ds-ease-in-out,cubic-bezier(.32,.72,0,1))}
.gs-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#7c93ff)}
.gs-switch[aria-checked="true"]::after{transform:translateX(14px)}
.gs-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:28px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b8b96)}
.gs-meta{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:11.5px}
.gs-meta b{color:var(--dsw-alias-label-secondary,#adadb6);font-weight:550;font-variant-numeric:tabular-nums}
`

    const STYLE_ID = `${MODULE_ID}/client.css`
    if (typeof document !== 'undefined') {
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
      if (existing === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = MODULE_ID
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
    }

    // ── host API ──────────────────────────────────────────────────────────
    async function api(action, payload = {}) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      let response
      try {
        response = await fetch(new URL(API_PATH.slice(1), document.baseURI).toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...payload }),
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        })
      } catch (error) {
        throw new Error(error?.name === 'AbortError' ? '请求超时' : `无法连接插件服务：${error?.message ?? error}`)
      } finally {
        clearTimeout(timer)
      }
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`服务返回了无法解析的数据（${response.status}）`)
      }
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error?.message ?? `服务返回 ${response.status}`)
      }
      return body
    }

    // ── components ────────────────────────────────────────────────────────
    function SidebarIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25' }),
        h('path', { d: 'M16 12l-4-4-4 4' }),
        h('path', { d: 'M12 8v12' }),
      )
    }

    // 跨 mount 缓存，避免每次进面板都白屏重新加载
    const panelCache = { status: null, sessions: [], synced: [], repoInput: '' }

    function GitSyncPanel() {
      const [status, setStatus] = React.useState(panelCache.status)
      const [sessions, setSessions] = React.useState(panelCache.sessions)
      const [synced, setSynced] = React.useState(panelCache.synced)
      const [repoInput, setRepoInput] = React.useState(panelCache.repoInput)
      const [repoDirInput, setRepoDirInput] = React.useState(panelCache.status?.repoDir || '')
      const [mappingDirInput, setMappingDirInput] = React.useState(panelCache.status?.mappingDir || '')
      const [machineNameInput, setMachineNameInput] = React.useState(panelCache.status?.machineName || '')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [note, setNote] = React.useState(null)
      const [remotePreview, setRemotePreview] = React.useState(null)

      const reload = React.useCallback(async () => {
        try {
          const [s, l] = await Promise.all([api('status'), api('listLocal')])
          setStatus(s)
          setSessions(Array.isArray(l.sessions) ? l.sessions : [])
          setSynced(Array.isArray(l.synced) ? l.synced : [])
          setRepoInput(s.repoUrl ?? '')
          setRepoDirInput(s.repoDir || '')
          setMappingDirInput(s.mappingDir || '')
          setMachineNameInput(s.machineName || '')
          panelCache.status = s
          panelCache.sessions = Array.isArray(l.sessions) ? l.sessions : []
          panelCache.synced = Array.isArray(l.synced) ? l.synced : []
          panelCache.repoInput = s.repoUrl ?? ''
          setError(null)
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }, [])

      React.useEffect(() => {
        void reload()
      }, [reload])

      const run = async (fn, okNote) => {
        setBusy(true)
        setNote(null)
        try {
          const result = await fn()
           if (result?.mode === 'read-only-preview' && Array.isArray(result.sessions)) setRemotePreview(result)
          setNote((okNote ?? (typeof result?.commit === 'string' ? `已提交（${result.commit}）` : '完成')) + (result?.conflicts?.length ? `；分裂保留 ${result.conflicts.length} 项冲突` : '') + (result?.materialized?.pendingNative?.length ? `；${result.materialized.pendingNative.length} 条本机会话有待处理的远端更新` : ''))
          await reload()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }

      const framework = status?.mode === 'portable-memory'
      const configured = Boolean(status?.repoUrl) && (!framework || status?.configured)
      const autoSync = false
      const syncMemory = false

      return h('div', { className: 'gs-root' },
        h('div', { className: 'gs-page' },
          h('div', null,
            h('h1', { className: 'gs-h1' }, framework ? '记忆仓库同步' : '漫游安全预览'),
            h('p', { className: 'gs-sub' }, framework ? '独立数据仓库 ↔ 本地仓库 ↔ 会话映射区；仅同步明确选中的本机会话。' : '当前版本只读取隔离镜像，不上传、不导入、不修改原生会话或记忆。旧版数据不会自动迁移。'),
          ),
          h('div', { className: 'gs-meta' },
            h('span', null, '模式 ', h('b', null, framework ? '数据同步' : '只读')),
            h('span', null, '旧数据 ', h('b', null, '隔离，不自动迁移')),
            h('span', null, '仓库 ', h('b', null, status?.repoExists ? '已连接' : '未连接')),
          ),
          error && h('p', { className: 'gs-note error' }, error),
          note && h('p', { className: 'gs-note ok' }, note),

          // 配置仓库
          h('div', { className: 'gs-card' },
            h('div', { className: 'gs-field' },
              h('input', {
                className: 'gs-input',
                placeholder: framework ? '数据仓库 URL（HTTPS / SSH）' : 'git@github.com:owner/private-data.git（只允许 SSH）',
                value: repoInput,
                onChange: (e) => setRepoInput(e.target.value),
              }),
              h('button', {
                className: 'gs-btn',
                disabled: busy || repoInput.trim().length === 0,
                onClick: () => run(() => api('configure', { repoUrl: repoInput.trim(), repoDir: repoDirInput, mappingDir: mappingDirInput, machineName: machineNameInput }), '配置已保存'),
              }, configured ? '更新仓库' : '配置仓库'),
            ),
            framework && h('div', { className: 'gs-field' }, h('span', null, '本地仓库'), h('input', { className: 'gs-input', value: repoDirInput, onChange: e => setRepoDirInput(e.target.value) })),
            framework && h('div', { className: 'gs-field' }, h('span', null, '映射区域'), h('input', { className: 'gs-input', value: mappingDirInput, onChange: e => setMappingDirInput(e.target.value) })),
            framework && h('div', { className: 'gs-field' }, h('span', null, '机器名称'), h('input', { className: 'gs-input', value: machineNameInput, onChange: e => setMachineNameInput(e.target.value) })),
            framework && !status?.bridgeEnabled && h('p', { className: 'gs-note' }, '数据同步已接通；DSH 会话桥接未启用，不会创建或修改对话。'),
          ),

          // 日志索引（详细日志落盘 debug.log，供事后排查/AI 自诊断）
          h('div', { className: 'gs-card' },
            h('div', { className: 'gs-field' },
              h('span', { className: 'gs-row-title' }, '日志'),
              h('span', { className: 'gs-note' }, status?.logPath ? `详细日志：${status.logPath}` : ''),
              h('button', {
                className: 'gs-btn',
                disabled: busy,
                onClick: () => run(() => api('openLogs'), '日志位置已显示'),
              }, '查看日志位置'),
            ),
          ),

          // 全量同步 + 记忆
          h('div', { className: 'gs-field' },
            h('button', {
              className: 'gs-btn primary',
              disabled: busy || !configured,
              onClick: () => run(() => api('syncAll'), framework ? '数据已上传' : '镜像预览已读取（未导入）'),
            }, framework ? '↑ 上传同步区' : '⟳ 读取仓库预览'),
            framework && h('button', { className: 'gs-btn', disabled: busy || !configured, onClick: () => run(() => api('pull'), '数据已下载到映射区') }, '↓ 下载到映射区'),
            h('button', { className: 'gs-btn', disabled: true, onClick: () => run(() => api('pushMemory'), '记忆已上传') }, '上传记忆'),
            h('button', { className: 'gs-btn', disabled: true, onClick: () => run(() => api('pullMemory'), '记忆已下载') }, '下载记忆'),
          ),

          // 自动同步
          h('div', { className: 'gs-card' },
            h('div', { className: 'gs-field' },
              h('span', { className: 'gs-row-title' }, '自动同步'),
              h('span', { className: 'gs-note' }, status?.settings?.autoSyncIntervalMs ? `每 ${Math.round(status.settings.autoSyncIntervalMs / 60000)} 分钟` : ''),
              h('button', {
                className: 'gs-switch',
                'aria-checked': String(autoSync),
                disabled: true,
              }),
            ),
            h('p', { className: 'gs-note' }, '安全预览期禁用自动上传与自动导入。'),
          ),

          // 同步记忆（opt-in）
          h('div', { className: 'gs-card' },
            h('div', { className: 'gs-field' },
              h('span', { className: 'gs-row-title' }, '同步记忆（长期记忆）'),
              h('button', {
                className: 'gs-switch',
                'aria-checked': String(syncMemory),
                disabled: true,
              }),
            ),
            h('p', { className: 'gs-note' }, '记忆文件不作直接覆盖；安全方案验收前此功能停用。'),
          ),

          // 已发现设备
          h('div', { className: 'gs-card' },
            h('p', { className: 'gs-sub', style: { marginBottom: 6 } }, framework ? '按机器分组的映射会话' : '仓库镜像预览（不导入）'),
            framework && (status?.groups || []).filter(group => !group.hidden).map(group => h('div', { key: group.machineId },
              h('p', { className: 'gs-sub' }, group.machineName),
              group.sessions.filter(row => !row.hidden).map(row => h('div', { className: 'gs-row', key: row.key }, h('span', { className: 'gs-row-title' }, row.title), h('span', { className: 'gs-note' }, row.localId ? '已映射为 DSH 对话' : '已下载，待会话桥接'))))),
             h('div', { className: 'gs-note' }, remotePreview ? `可读取 ${remotePreview.sessions.length} 条；失败 ${remotePreview.failed.length} 条；仓库协议 ${remotePreview.schema?.version ?? '无'}` : '点击「读取仓库预览」查看条目'),
             remotePreview?.sessions?.slice(0, 100).map((s) => h('div', { className: 'gs-row', key: s.key }, h('div', { className: 'gs-row-title' }, s.title || s.key), h('div', { className: 'gs-row-meta' }, s.revision ? `对象 ${s.revision.slice(0, 12)}` : `${s.events} 事件 · ${s.digest.slice(0, 12)}`))),
             remotePreview?.failed?.slice(0, 20).map((s) => h('div', { className: 'gs-note error', key: s.key }, `${s.key}: ${s.reason}`)),
             h('p', { className: 'gs-sub', style: { marginBottom: 6 } }, '旧设备登记（此预览版不登记设备）'),
            (() => {
              const hosts = Array.isArray(status?.hosts) ? status.hosts : []
              if (hosts.length === 0) return h('div', { className: 'gs-empty' }, '暂无其它设备')
              return hosts.map((row) => {
                const meta = row.meta ?? {}
                const isSelf = row.host === status?.self?.host
                const seen = Number.isFinite(meta.lastSeen) ? new Date(meta.lastSeen).toLocaleString() : '—'
                return h('div', { className: 'gs-row', key: row.host },
                  h('div', { className: 'gs-row-title' }, isSelf ? `${row.host}（本机）` : row.host),
                  h('div', { className: 'gs-row-meta' }, `最近活跃 ${seen}`),
                )
              })
            })(),
          ),

          // 会话列表
          h('div', { className: 'gs-card' },
            h('p', { className: 'gs-sub', style: { marginBottom: 6 } }, framework && status?.bridgeEnabled ? '本机会话（手动加入后才上传）' : '本机会话（尚未启用桥接）'),
            sessions.length === 0
              ? h('div', { className: 'gs-empty' }, '暂无会话')
              : [...sessions].sort((a, b) => (synced.includes(a.id) === synced.includes(b.id) ? 0 : synced.includes(a.id) ? -1 : 1)).map((s) => {
                  const isSynced = synced.includes(s.id)
                  return h('div', { className: 'gs-row', key: s.id },
                    h('div', { className: 'gs-row-title' }, s.title || '未命名会话'),
                    h('div', { className: 'gs-row-meta' }, isSynced ? '已同步' : '未同步'),
                    h('button', {
                      className: 'gs-btn sm',
                      disabled: busy || !framework || !status?.bridgeEnabled || isSynced,
                      onClick: () => run(() => api('enroll', { sessionId: s.id }), '已加入本机隐藏映射，下次上传同步'),
                    }, isSynced ? '已加入同步' : framework && status?.bridgeEnabled ? '加入同步' : '暂不可上传'),
                  )
                }),
          ),
        ),
      )
    }

    // ── plugin face ───────────────────────────────────────────────────────
    const name = MODULE_ID
    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 6,
        label: () => 'Git 同步',
      }, SidebarIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, GitSyncPanel))
    }

    return { name, inject, apply }
  },
})
})()
