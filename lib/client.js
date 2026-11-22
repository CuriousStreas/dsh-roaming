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
.gs-root{box-sizing:border-box;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#0d0d0f);color:var(--dsw-alias-label-primary,#f4f4f5);font:14px/22px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);overflow:hidden;-webkit-font-smoothing:antialiased}
.gs-page{display:flex;flex-direction:column;gap:14px;flex:1;min-height:0;padding:18px 20px 24px;overflow:auto}
.gs-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}
.gs-title{margin:0;font-size:18px;line-height:26px;font-weight:650;letter-spacing:-.01em}
.gs-subtitle{margin:3px 0 0;color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:12px;line-height:18px}
.gs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
@media (max-width:640px){.gs-grid{grid-template-columns:1fr}}
/* card */
.gs-card{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#17171a);overflow:hidden;display:flex;flex-direction:column}
.gs-card-head{display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.gs-card-title{flex:1;min-width:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.gs-card-body{display:flex;flex-direction:column;gap:10px;padding:14px}
.gs-badge{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2,#1e1e22);color:var(--dsw-alias-label-secondary,#c9c9d1);font-size:11px;font-weight:500;line-height:1}
.gs-badge.ok{color:#86efac;border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.08)}
.gs-badge.warn{color:#fcd34d;border-color:rgba(250,204,21,.3);background:rgba(250,204,21,.08)}
.gs-badge.accent{color:var(--dsw-alias-brand-primary,#7c93ff);border-color:rgba(124,147,255,.3);background:rgba(124,147,255,.08)}
/* status */
.gs-state{display:inline-flex;align-items:center;gap:7px;height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-1,#17171a);font-size:11.5px;color:var(--dsw-alias-label-secondary,#c9c9d1);white-space:nowrap}
.gs-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#6b7280)}
.gs-dot.ok{background:var(--dsw-alias-state-success-primary,#4ade80)}
.gs-dot.error{background:var(--dsw-alias-state-error-primary,#f87171)}
.gs-dot.warn{background:#fcd34d}
.gs-dot.running{background:var(--dsw-alias-brand-primary,#7c93ff);animation:gs-pulse 1.4s ease-in-out infinite}
@keyframes gs-pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(124,147,255,.4)}50%{opacity:.55;box-shadow:0 0 0 5px rgba(124,147,255,0)}}
/* sync box */
.gs-sync-hero{display:flex;flex-direction:column;gap:12px}
.gs-sync-machine{display:flex;align-items:center;gap:10px}
.gs-sync-machine-name{font-size:15px;font-weight:650;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gs-sync-meta{color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:12px;line-height:18px}
.gs-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 16px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:var(--dsw-alias-bg-layer-2,#1e1e22);color:var(--dsw-alias-label-primary,#f4f4f5);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}
.gs-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.gs-btn.primary{background:var(--dsw-alias-button-primary-fill,#ededf0);color:var(--dsw-alias-label-primary-foreground,#131316);border-color:transparent;font-weight:550}
.gs-btn.primary.accent{background:var(--dsw-alias-brand-primary,#7c93ff);color:#fff}
.gs-btn:disabled{opacity:.42;cursor:default}
.gs-btn:focus-visible,.gs-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#7c93ff);outline-offset:2px}
.gs-sync-foot{color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:12px;line-height:18px}
/* result strip */
.gs-result{display:flex;align-items:flex-start;gap:9px;padding:9px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07));background:var(--dsw-alias-bg-layer-2,#1e1e22);font-size:12.5px;line-height:18px}
.gs-result.ok{border-color:rgba(74,222,128,.25)}
.gs-result.error{border-color:rgba(248,113,113,.35)}
.gs-result .gs-dot{margin-top:5px}
.gs-result-text{color:var(--dsw-alias-label-secondary,#c9c9d1);overflow-wrap:anywhere}
.gs-result.error .gs-result-text{color:var(--dsw-alias-state-error-primary,#f87171)}
/* machine topology */
.gs-topo{position:relative;display:flex;flex-direction:column;gap:12px;min-height:96px;border-radius:11px;padding:14px;background:
  radial-gradient(120% 160% at 50% 0%,rgba(124,147,255,.08),transparent 60%),
  repeating-linear-gradient(0deg,transparent 0 22px,rgba(255,255,255,.025) 22px 23px),
  repeating-linear-gradient(90deg,transparent 0 22px,rgba(255,255,255,.025) 22px 23px)}
.gs-topo-hub{display:flex;align-items:center;gap:10px}
.gs-topo-nodes{display:flex;flex-wrap:wrap;gap:10px}
.gs-node{display:flex;flex-direction:column;align-items:center;gap:6px;min-width:86px;padding:10px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));border-radius:11px;background:var(--dsw-alias-bg-layer-2,#1e1e22)}
.gs-node.hub{border-color:rgba(124,147,255,.4);box-shadow:0 0 0 3px rgba(124,147,255,.08)}
.gs-node-icon{display:flex;align-items:center;justify-content:center;width:34px;height:26px;color:var(--dsw-alias-brand-primary,#7c93ff)}
.gs-node.hub .gs-node-icon{color:var(--dsw-alias-brand-primary,#7c93ff)}
.gs-node-name{max-width:86px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,#c9c9d1)}
.gs-node-sub{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b8b96)}
/* form */
.gs-field{display:flex;flex-direction:column;gap:6px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#c9c9d1)}
.gs-field>span{font-weight:500}
.gs-input{width:100%;box-sizing:border-box;min-width:0;height:32px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:9px;background:var(--dsw-alias-bg-layer-2,#1e1e22);color:var(--dsw-alias-label-primary,#f4f4f5);font:inherit;font-size:13px;outline:0}
.gs-input:focus-visible{border-color:var(--dsw-alias-brand-primary,#7c93ff);box-shadow:0 0 0 3px rgba(124,147,255,.15)}
.gs-details{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06));border-radius:9px;padding:2px 10px}
.gs-details summary{list-style:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#c9c9d1);font-size:12.5px}
.gs-details summary::-webkit-details-marker{display:none}
/* lists */
.gs-list{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow:auto}
.gs-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px}
.gs-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.04))}
.gs-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.gs-row-sub{color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:11.5px}
.gs-machine-head{display:flex;align-items:center;gap:8px;padding:8px 4px 4px;color:var(--dsw-alias-label-secondary,#c9c9d1);font-size:12px;font-weight:600}
.gs-machine-head::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#7c93ff);opacity:.6}
.gs-empty{padding:16px;text-align:center;color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:12.5px}
.gs-note{margin:0;color:var(--dsw-alias-label-tertiary,#8b8b96);font-size:12px;line-height:19px;overflow-wrap:anywhere}
.gs-note.error{color:var(--dsw-alias-state-error-primary,#f87171)}
.gs-note.ok{color:var(--dsw-alias-state-success-primary,#4ade80)}
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
    const StatusDot = ({ state }) => h('span', { className: `gs-dot ${state === 'running' ? 'running' : state === 'succeeded' ? 'ok' : state === 'failed' ? 'error' : state === 'warn' ? 'warn' : ''}`, 'aria-hidden': true })
    const Badge = ({ children, tone }) => h('span', { className: `gs-badge${tone ? ` ${tone}` : ''}` }, children)
    const Section = ({ title, badge, open, onToggle, children }) => h('details', { className: 'gs-section', open: open === true, onToggle: onToggle && (e => onToggle(e.currentTarget.open)) },
      h('summary', null,
        h('span', { className: 'gs-section-title' }, title),
        badge !== undefined && badge !== null && h(Badge, { tone: badge.tone }, badge.text),
        h('span', { className: 'gs-chevron' }, '▸')),
      children)
    const Panel = ({ title, badge, children }) => h('div', { className: 'gs-panel' },
      h('div', { className: 'gs-panel-head' },
        h('span', { className: 'gs-panel-title' }, title),
        badge !== undefined && badge !== null && h(Badge, { tone: badge.tone }, badge.text)),
      children)
    const relTime = at => {
      if (!at) return '—'
      const ms = Date.now() - Date.parse(at)
      if (!Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 60_000) return '刚刚'
      if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`
      if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`
      return new Date(at).toLocaleDateString()
    }
    const stateLabel = state => state === 'running' ? '同步中' : state === 'succeeded' ? '已同步' : state === 'failed' ? '同步失败' : '待机'
    const Card = ({ title, badge, children }) => h('div', { className: 'gs-card' },
      h('div', { className: 'gs-card-head' },
        h('span', { className: 'gs-card-title' }, title),
        badge !== undefined && badge !== null && h(Badge, { tone: badge.tone }, badge.text)),
      h('div', { className: 'gs-card-body' }, children))
    const MonitorIcon = ({ size = 16 }) => h('svg', { width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
      h('rect', { x: 2, y: 3, width: 16, height: 11, rx: 2 }),
      h('path', { d: 'M7 17h6M10 14v3' }))
    function MachineTopology({ localName, groups, syncState }) {
      const remote = groups.map(g => ({
        name: g.machineName || g.machineId,
        total: rows(g.sessions).filter(s => !s.hidden).length,
        linked: rows(g.sessions).filter(s => !s.hidden && s.localId).length,
      }))
      const nodeTone = node => node.total === 0 ? '' : node.linked === node.total ? 'ok' : node.linked > 0 ? 'warn' : ''
      return h('div', { className: 'gs-topo' },
        h('div', { className: 'gs-topo-hub' },
          h('div', { className: 'gs-node hub' },
            h('div', { className: 'gs-node-icon' }, h(MonitorIcon)),
            h('span', { className: 'gs-node-name' }, localName || '本机'),
            h('span', { className: 'gs-node-sub' }, '本机'),
            h(StatusDot, { state: syncState })),
          h('span', { className: 'gs-note' }, remote.length ? `已连接 ${remote.length} 台设备` : '暂无其他设备')),
        remote.length
          ? h('div', { className: 'gs-topo-nodes' }, remote.map(node => h('div', { className: 'gs-node', key: node.name },
              h('div', { className: 'gs-node-icon', style: { color: 'var(--dsw-alias-label-secondary,#c9c9d1)' } }, h(MonitorIcon)),
              h('span', { className: 'gs-node-name', title: node.name }, node.name),
              h('span', { className: 'gs-node-sub' }, `${node.total} 会话`),
              h(StatusDot, { state: nodeTone(node) }))))
          : h('p', { className: 'gs-empty' }, '完成同步后，这里会显示其他设备及其状态'))
    }
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
      return h('div', { className: 'gs-list' },
        error && h('div', { className: 'gs-result error' },
          h(StatusDot, { state: 'failed' }),
          h('span', { className: 'gs-result-text' }, error),
          h('button', { className: 'gs-btn', disabled: loading, onClick: retry }, '重试')),
        loading && h('p', { className: 'gs-note', role: 'status' }, '正在读取本机会话…'),
        !loading && !error && locals && sessions.length === 0 && h('p', { className: 'gs-empty' }, '暂无会话'),
        sessions.map(row => h('div', { className: 'gs-row', key: String(row.id) },
          h('span', { className: 'gs-row-title', title: `${row.cwd || ''}\n${row.id || ''}` }, String(row.title || '未命名会话')),
          enrolled.includes(row.id)
            ? h(Badge, { tone: 'ok' }, '已加入')
            : h('button', { className: 'gs-btn', disabled: busy || !isConfigured(status), onClick: () => enroll(row.id) }, '加入同步'))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 } },
          h('button', { className: 'gs-btn', disabled: loading, onClick: () => loadLocal({ refresh: true }) }, '刷新'),
          locals && h('span', { className: 'gs-row-sub' }, `已显示 ${sessions.length}${Number.isFinite(locals.total) ? ` / ${locals.total}` : ''}${locals.cached ? ' · 缓存' : ''}`),
          locals?.hasMore && h('button', { className: 'gs-btn', disabled: loading, onClick: () => loadLocal({ offset: (Number(locals.offset) || 0) + 50 }) }, '加载更多')))
    }
    function GitSyncPanel() {
      const [status, setStatus] = React.useState(panelCache.status)
      const [repoInput, setRepoInput] = React.useState(panelCache.status?.repoUrl || '')
      const [machineInput, setMachineInput] = React.useState(panelCache.status?.machineName || '')
      const [repoDirInput, setRepoDirInput] = React.useState(panelCache.status?.repoDir || '')
      const [mappingDirInput, setMappingDirInput] = React.useState(panelCache.status?.mappingDir || '')
      const [configOpen, setConfigOpen] = React.useState(false)
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
      React.useEffect(() => {
        // Local list is now always visible; load its first page once the bridge is known.
        if (status?.bridgeEnabled && !locals && !localLoading) void loadLocal()
      }, [status?.bridgeEnabled, locals, localLoading, loadLocal])

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
      const syncState = status?.syncState?.state
      const field = (label, value, setValue, placeholder) => h('label', { className: 'gs-field' },
        h('span', null, label), h('input', { className: 'gs-input', value, placeholder, disabled: busy, onChange: e => setValue(e.target.value) }))
      const resultTone = note?.failed ? 'error' : syncState === 'failed' ? 'error' : 'ok'

      return h('div', { className: 'gs-root' }, h('div', { className: 'gs-page' },
        h('div', { className: 'gs-head' },
          h('div', null,
            h('h1', { className: 'gs-title' }, '漫游同步'),
            h('p', { className: 'gs-subtitle' }, '跨设备 Git 同步 · 单键操作')),
          h('span', { className: 'gs-state' }, h(StatusDot, { state: syncState }), stateLabel(syncState))),
        h('div', { className: 'gs-grid' },
          h(Card, { title: '同步', badge: syncRunning ? { text: '运行中', tone: 'accent' } : undefined },
            h('div', { className: 'gs-sync-hero' },
              h('div', { className: 'gs-sync-machine' },
                h(StatusDot, { state: syncState }),
                h('span', { className: 'gs-sync-machine-name' }, status ? status.machineName || '本机' : '正在读取…')),
              h('button', { className: 'gs-btn primary accent', disabled: busy || syncRunning || !configured, onClick: () => run('sync') },
                syncRunning ? '同步中…' : !configured ? '先配置仓库' : '立即同步'),
              h('p', { className: 'gs-sync-foot' }, status?.autoSync?.enabled ? '每小时自动 · 关闭面板后后台继续' : '关闭面板不影响后台任务')),
            note && h('div', { className: `gs-result${resultTone === 'error' ? ' error' : ' ok'}`, role: resultTone === 'error' ? 'alert' : 'status', style: { marginTop: 4 } },
              h(StatusDot, { state: note.failed ? 'failed' : 'succeeded' }),
              h('span', { className: 'gs-result-text' }, note.text)),
            error && h('div', { className: 'gs-result error', role: 'alert', style: { marginTop: 4 } },
              h(StatusDot, { state: 'failed' }), h('span', { className: 'gs-result-text' }, error))),
          h(Card, { title: '设备网络', badge: { text: `${groups.length} 台`, tone: groups.length ? 'accent' : undefined } },
            h(MachineTopology, { localName: status?.machineName, groups, syncState })),
          h(Card, { title: '本机对话同步', badge: status?.bridgeEnabled ? { text: '手动加入', tone: 'accent' } : { text: '未启用', tone: 'warn' } },
            !status?.bridgeEnabled
              ? h('p', { className: 'gs-empty' }, '会话桥接未启用，仅同步数据')
              : h(LocalErrorBoundary, { onRetry: () => loadLocal({ refresh: true }) },
                h(LocalConversations, {
                  status, locals, loading: localLoading, error: localError, busy: busy || syncRunning, loadLocal,
                  retry: () => loadLocal(localRetry.current),
                  enroll: sessionId => run('enroll', { sessionId }, '已加入，下次同步生效'),
                }))),
          h(Card, { title: '配置', badge: configured ? { text: '已配置', tone: 'ok' } : { text: '待配置', tone: 'warn' } },
            field('仓库 URL', repoInput, setRepoInput, 'HTTPS / SSH'),
            field('机器名称', machineInput, setMachineInput),
            h('details', { className: 'gs-details' }, h('summary', null, '高级目录设置'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 10 } },
                field('本地仓库', repoDirInput, setRepoDirInput),
                field('会话目录', mappingDirInput, setMappingDirInput))),
            h('button', { className: 'gs-btn', disabled: busy || syncRunning || !repoInput.trim(), onClick: () => {
              const payload = { repoUrl: repoInput.trim() }
              if (machineInput.trim()) payload.machineName = machineInput.trim()
              if (repoDirInput.trim()) payload.repoDir = repoDirInput.trim()
              if (mappingDirInput.trim()) payload.mappingDir = mappingDirInput.trim()
              void run('configure', payload, '配置已保存')
            } }, '保存配置'),
            h('p', { className: 'gs-note' }, `日志：${status?.logPath || '暂无'}`))),
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
