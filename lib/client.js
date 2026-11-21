/** Browser half: platform React seeds and the existing sidebar/main slots. */
;(() => {
const MODULE_ID = 'dsh-roaming'
window.__ModuleLoader__.load({
  id: MODULE_ID,
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API_PATH = '/roaming/api'
    const PANEL_ID = 'roaming'
    const CSS = `
.gs-root{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#0d0d0f);color:var(--dsw-alias-label-primary,#f4f4f5);font:14px/22px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);overflow:hidden}
.gs-page{display:flex;flex-direction:column;gap:16px;flex:1;min-height:0;padding:20px 24px;overflow:auto}
.gs-h1{margin:0;font-size:20px;line-height:28px;font-weight:600}
.gs-note{margin:0;color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:12px;line-height:19px;overflow-wrap:anywhere}
.gs-note.error{color:var(--dsw-alias-state-error-primary,#f87171)}
.gs-note.ok{color:var(--dsw-alias-label-secondary,#adadb6)}
.gs-details{border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));padding-top:12px}
.gs-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#adadb6);font-size:13px}
.gs-content{display:flex;flex-direction:column;gap:12px;padding-top:12px}
.gs-field{display:flex;align-items:center;gap:10px;font-size:13px}
.gs-field>span{width:72px;flex:none}
.gs-input{flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));border-radius:8px;background:var(--dsw-alias-bg-layer-2,#1e1e22);color:var(--dsw-alias-label-primary,#f4f4f5);font:inherit}
.gs-input:focus-visible,.gs-btn:focus-visible, .gs-details summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#7c93ff);outline-offset:2px}
.gs-btn{align-self:flex-start;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));background:transparent;color:var(--dsw-alias-label-primary,#f4f4f5);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}
.gs-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.gs-btn.primary{background:var(--dsw-alias-button-primary-fill,#ededf0);color:var(--dsw-alias-label-primary-foreground,#131316);border-color:transparent;font-weight:550}
.gs-btn:disabled{opacity:.42;cursor:default}
.gs-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.gs-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
`
    const STYLE_ID = `${MODULE_ID}/client.css`
    if (typeof document !== 'undefined') {
      let tag = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
      if (!tag) {
        tag = document.createElement('style')
        tag.dataset.plugin = MODULE_ID
        tag.dataset.pluginCss = STYLE_ID
        document.head.appendChild(tag)
      }
      tag.textContent = CSS
    }

    async function api(action, payload = {}, signal) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, action === 'listLocal' ? 7_000 : 30_000)
      try {
        const response = await fetch(new URL(API_PATH.slice(1), document.baseURI).toString(), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...payload }), credentials: 'same-origin',
          cache: 'no-store', signal: controller.signal,
        })
        let body
        try { body = await response.json() } catch (error) {
          if (error?.name === 'AbortError') throw error
          throw new Error(`服务返回了无法解析的数据（HTTP ${response.status}）`)
        }
        if (!response.ok || body?.ok === false) {
          const detail = body?.error
          throw Object.assign(new Error(`${detail?.message ?? '请求失败'}（HTTP ${response.status}${detail?.code ? ` / ${detail.code}` : ''}）${detail?.logPath ? `；日志：${detail.logPath}` : ''}`), { code: detail?.code, status: response.status })
        }
        return body
      } catch (error) {
        if (error?.name === 'AbortError') {
          if (signal?.aborted) throw error
          throw new Error(action === 'listLocal' ? '读取本机会话超时（7 秒），已保留缓存，可在此重试。' : '请求超时；操作可能仍在服务端进行，请查看状态后重试')
        }
        if (error instanceof TypeError) throw new Error(`无法连接插件服务：${error.message}`)
        throw error
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    }

    function SidebarIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25' }),
        h('path', { d: 'M16 12l-4-4-4 4M12 8v12' }))
    }

    class GitSyncErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false, revision: 0 }
      }
      static getDerivedStateFromError() { return { failed: true } }
      componentDidCatch(error, info) {
        // Report only bounded exception diagnostics, never panel/session state.
        try {
          void api('clientError', {
            message: String(error?.message ?? 'Panel render error').slice(0, 4096),
            stack: String(error?.stack ?? '').slice(0, 8192),
            componentStack: String(info?.componentStack ?? '').slice(0, 8192),
          }).catch(() => {})
        } catch (_) { /* Logging must not take down the fallback. */ }
      }
      render() {
        if (this.state.failed) return h('div', { className: 'gs-root' },
          h('div', { className: 'gs-page' },
            h('p', { className: 'gs-note error', role: 'alert' }, '同步面板异常，请重试（正在尝试记录诊断日志）'),
            h('button', { className: 'gs-btn', onClick: () => this.setState(state => ({ failed: false, revision: state.revision + 1 })) }, '重试')))
        return h(GitSyncPanel, { key: this.state.revision })
      }
    }

    class LocalErrorBoundary extends GitSyncErrorBoundary {
      render() {
        if (this.state.failed) return h('div', { className: 'gs-content' },
          h('p', { className: 'gs-note error', role: 'alert' }, '本机会话显示异常，其他功能仍可使用。'),
          h('button', { className: 'gs-btn', onClick: () => {
            this.setState(state => ({ failed: false, revision: state.revision + 1 }))
            this.props.onRetry()
          } }, '重试本机会话'))
        return h(React.Fragment, { key: this.state.revision }, this.props.children)
      }
    }

    const panelCache = { status: null, note: null, locals: null }
    const rows = value => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : []
    const isConfigured = s => Boolean(s?.repoUrl) && (s?.mode !== 'portable-memory' || Boolean(s?.configured))
    const errorText = error => String(error?.message ?? error ?? '未知错误')
    function resultNote(result, fallback) {
      const neutral = Boolean(result?.partial || result?.readOnly)
      const conflicts = result?.conflicts?.length || 0
      const pending = result?.materialized?.pendingNative?.length || result?.pendingNative?.length || 0
      const failures = result?.failed?.length || result?.failures?.length || 0
      const message = result?.message || (neutral ? '本次仅完成部分操作或只读检查，未完成完整同步' : fallback)
      return { neutral, text: `${message || '操作已完成'}${conflicts ? `；保留 ${conflicts} 项冲突` : ''}${pending ? `；${pending} 条本机会话有待处理的远端更新` : ''}${failures ? `；${failures} 项失败，请查看日志` : ''}` }
    }

    function LocalConversations({ status, locals, loading, error, busy, loadLocal, retry, enroll }) {
      const sessions = rows(locals?.sessions)
      const enrolled = Array.isArray(locals?.synced) ? locals.synced : []
      if (!status?.bridgeEnabled) return h('p', { className: 'gs-note' }, '会话桥接尚未启用，不会自动加入本机会话。')
      return h(React.Fragment, null,
        h('p', { className: 'gs-note' }, '仅手动加入的会话参与同步，不会自动加入。'),
        h('button', { className: 'gs-btn', disabled: loading, onClick: () => loadLocal({ refresh: true }) }, '刷新本机会话'),
        error && h('div', null,
          h('p', { className: 'gs-note error', role: 'alert' }, error),
          h('button', { className: 'gs-btn', disabled: loading, onClick: retry }, '重试')),
        loading && h('p', { className: 'gs-note', role: 'status' }, '正在读取本机会话…'),
        !loading && !error && locals && sessions.length === 0 && h('p', { className: 'gs-note' }, '暂无会话'),
        sessions.map(row => h('div', { className: 'gs-row', key: String(row.id) },
          h('span', { className: 'gs-row-title', title: `${row.cwd || ''}\n${row.id || ''}` }, String(row.title || '未命名会话')),
          enrolled.includes(row.id) ? h('span', { className: 'gs-note' }, '已加入同步') : h('button', {
            className: 'gs-btn', disabled: busy || !isConfigured(status),
            onClick: () => enroll(row.id),
          }, '加入同步'))),
        locals && h('p', { className: 'gs-note' }, `已显示 ${sessions.length}${Number.isFinite(locals.total) ? ` / ${locals.total}` : ''} 条${locals.cached ? ' · 缓存' : ''}`),
        locals?.hasMore && h('button', { className: 'gs-btn', disabled: loading, onClick: () => loadLocal({ offset: (Number(locals.offset) || 0) + 50 }) }, '加载更多'))
    }
    function GitSyncPanel() {
      const [status, setStatus] = React.useState(panelCache.status)
      const [repoInput, setRepoInput] = React.useState(panelCache.status?.repoUrl || '')
      const [machineInput, setMachineInput] = React.useState(panelCache.status?.machineName || '')
      const [repoDirInput, setRepoDirInput] = React.useState(panelCache.status?.repoDir || '')
      const [mappingDirInput, setMappingDirInput] = React.useState(panelCache.status?.mappingDir || '')
      const [configOpen, setConfigOpen] = React.useState(false)
      const [localOpen, setLocalOpen] = React.useState(false)
      const [locals, setLocals] = React.useState(panelCache.locals)
      const [localLoading, setLocalLoading] = React.useState(false)
      const [localError, setLocalError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [note, setNote] = React.useState(panelCache.note)
      const operation = React.useRef(false)
      const localRequest = React.useRef(false)
      const localRetry = React.useRef({})
      const mounted = React.useRef(false)
      const observedSync = React.useRef(null)

      const applySyncState = React.useCallback(sync => {
        if (!sync) return
        const key = `${sync.runId || ''}:${sync.state}`
        if (observedSync.current === key) return
        observedSync.current = key
        if (sync.state === 'succeeded' || sync.state === 'failed') {
          const nextNote = resultNote(sync.result, sync.state === 'failed' ? '同步失败' : '同步完成')
          if (sync.error) {
            nextNote.neutral = true
            nextNote.text += `；${errorText(sync.error)}`
          }
          if (sync.state === 'failed') { nextNote.neutral = true; nextNote.failed = true }
          panelCache.note = nextNote
          setNote(nextNote)
        }
      }, [])
      const reload = React.useCallback(async (updateInputs = false, signal) => {
        const s = await api('status', {}, signal)
        if (!mounted.current || signal?.aborted) return s
        panelCache.status = s
        setStatus(s)
        applySyncState(s.syncState)
        if (updateInputs) {
          setRepoInput(s.repoUrl || '')
          setMachineInput(s.machineName || '')
          setRepoDirInput(s.repoDir || '')
          setMappingDirInput(s.mappingDir || '')
        }
        return s
      }, [applySyncState])
      const loadLocal = React.useCallback(async (options = {}) => {
        if (localRequest.current) return
        const request = { offset: 0, limit: 50, refresh: false, ...options }
        localRetry.current = request
        localRequest.current = true
        setLocalLoading(true)
        setLocalError(null)
        try {
          const page = await api('listLocal', request)
          if (!mounted.current) return
          const previous = request.offset > 0 ? rows(panelCache.locals?.sessions) : []
          const combined = new Map(previous.map(row => [row.id, row]))
          for (const row of rows(page.sessions)) combined.set(row.id, row)
          const next = { ...page, sessions: [...combined.values()] }
          panelCache.locals = next
          setLocals(next)
        } catch (e) {
          if (mounted.current) setLocalError(errorText(e))
        } finally {
          localRequest.current = false
          if (mounted.current) setLocalLoading(false)
        }
      }, [])
      React.useEffect(() => {
        mounted.current = true
        void reload(true).catch(e => { if (mounted.current) setError(errorText(e)) })
        return () => { mounted.current = false }
      }, [reload])
      const syncRunning = status?.syncState?.state === 'running'
      React.useEffect(() => {
        if (!syncRunning) return
        let stopped = false
        let timer
        const controller = new AbortController()
        const poll = async () => {
          let keepPolling = true
          try { keepPolling = (await reload(false, controller.signal))?.syncState?.state === 'running' }
          catch (e) { if (!stopped && mounted.current) setError(errorText(e)) }
          if (!stopped && keepPolling) timer = setTimeout(poll, 2_000)
        }
        timer = setTimeout(poll, 2_000)
        return () => { stopped = true; clearTimeout(timer); controller.abort() }
      }, [syncRunning, reload])

      const run = async (action, payload, success) => {
        if (operation.current || (action === 'sync' && syncRunning)) return
        operation.current = true
        setBusy(true)
        setError(null)
        try {
          const result = await api(action, payload)
          if (!mounted.current) return
          if (action === 'sync') {
            // Acceptance starts a server-owned task; only terminal syncState is a result.
            if (result.syncState) {
              const nextStatus = { ...panelCache.status, syncState: result.syncState }
              panelCache.status = nextStatus
              setStatus(nextStatus)
              applySyncState(result.syncState)
            } else await reload()
            return
          }
          const nextNote = resultNote(result, success)
          panelCache.note = nextNote
          setNote(nextNote)
          if (action === 'enroll' && panelCache.locals) {
            const next = { ...panelCache.locals, synced: [...new Set([...(panelCache.locals.synced || []), payload.sessionId])] }
            panelCache.locals = next
            setLocals(next)
          }
          await reload(action === 'configure')
          if (mounted.current && action === 'configure') setConfigOpen(false)
        } catch (e) {
          if (mounted.current) setError(errorText(e))
        } finally {
          operation.current = false
          if (mounted.current) setBusy(false)
        }
      }

      const configured = isConfigured(status)
      const groups = rows(status?.groups).filter(g => !g.hidden)
      const count = groups.reduce((sum, g) => sum + rows(g.sessions).filter(s => !s.hidden).length, 0)
      const field = (label, value, setValue, placeholder) => h('label', { className: 'gs-field' },
        h('span', null, label), h('input', { className: 'gs-input', value, placeholder, disabled: busy, onChange: e => setValue(e.target.value) }))

      return h('div', { className: 'gs-root' }, h('div', { className: 'gs-page' },
        h('h1', { className: 'gs-h1' }, '漫游同步'),
        h('p', { className: 'gs-note' }, status ? `${status.machineName || status.self?.host || '本机'} · ${count} 条会话${!configured ? ' · 请先配置' : ''}` : '正在读取状态…'),
        h('button', { className: 'gs-btn primary', disabled: busy || syncRunning || !configured, onClick: () => run('sync') }, syncRunning ? '同步中…' : busy ? '处理中…' : '同步'),
        h('p', { className: 'gs-note' }, status?.autoSync?.enabled ? '每小时自动同步；关闭面板后任务仍在后台继续。' : '关闭面板不影响后台任务。'),
        syncRunning && h('p', { className: 'gs-note', role: 'status' }, '后台同步进行中…'),
        h('p', { className: `gs-note${note?.failed ? ' error' : note?.neutral ? '' : ' ok'}`, role: note?.failed ? 'alert' : 'status' }, note ? `上次结果：${note.text}` : '尚无已完成的同步结果'),
        error && h('p', { className: 'gs-note error', role: 'alert' }, error),
        h('details', { className: 'gs-details', open: configOpen === true, onToggle: e => setConfigOpen(e.currentTarget.open) },
          h('summary', null, '配置'),
          h('div', { className: 'gs-content' },
            field('仓库 URL', repoInput, setRepoInput, 'HTTPS / SSH'),
            field('机器名称', machineInput, setMachineInput),
            h('details', { className: 'gs-details' }, h('summary', null, '高级目录设置'),
              h('div', { className: 'gs-content' }, field('本地仓库', repoDirInput, setRepoDirInput), field('会话目录', mappingDirInput, setMappingDirInput))),
            h('button', { className: 'gs-btn', disabled: busy || syncRunning || !repoInput.trim(), onClick: () => {
              const payload = { repoUrl: repoInput.trim() }
              if (machineInput.trim()) payload.machineName = machineInput.trim()
              if (repoDirInput.trim()) payload.repoDir = repoDirInput.trim()
              if (mappingDirInput.trim()) payload.mappingDir = mappingDirInput.trim()
              void run('configure', payload, '配置已保存')
            } }, '保存配置'))),
        h('details', { className: 'gs-details' }, h('summary', null, '远端机器与会话'),
          h('div', { className: 'gs-content' }, groups.length ? groups.map(group => h('div', { key: group.machineId },
            h('p', { className: 'gs-note' }, group.machineName || group.machineId),
            rows(group.sessions).filter(row => !row.hidden).map(row => h('div', { className: 'gs-row', key: row.key },
              h('span', { className: 'gs-row-title' }, row.title || '未命名会话'),
              h('span', { className: 'gs-note' }, row.localId ? '已关联本地对话' : '待会话桥接'))))) : h('p', { className: 'gs-note' }, '暂无远端会话'))),
        h('details', { className: 'gs-details', open: localOpen, onToggle: e => {
          const open = e.currentTarget.open
          setLocalOpen(open)
          if (open && !localOpen && status?.bridgeEnabled) void loadLocal()
        } },
          h('summary', null, '本机会话 · 手动加入同步'),
          localOpen && h(LocalErrorBoundary, { onRetry: () => loadLocal({ refresh: true }) },
            h('div', { className: 'gs-content' }, h(LocalConversations, {
              status, locals, loading: localLoading, error: localError, busy: busy || syncRunning, loadLocal,
              retry: () => loadLocal(localRetry.current),
              enroll: sessionId => run('enroll', { sessionId }, '已加入，下次同步生效'),
            })))),
        h('details', { className: 'gs-details' }, h('summary', null, '日志'),
          h('div', { className: 'gs-content' }, h('p', { className: 'gs-note' }, status?.logPath || '暂无日志路径'))),
      ))
    }

    const name = MODULE_ID
    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: PANEL_ID, order: 6, label: () => '漫游同步',
      }, SidebarIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, GitSyncErrorBoundary))
    }
    return { name, inject, apply }
  },
})
})()
