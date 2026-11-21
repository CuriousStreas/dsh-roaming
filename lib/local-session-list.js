// Bridge objects are request-scoped; service instances (and this cache) are not.
// Never use title/surface readers here: their public query implementation reads
// complete persisted event logs, even when only a title is requested.
import fs from 'node:fs/promises'
import path from 'node:path'

const caches = new WeakMap()
const TTL_MS = 60_000
const DEADLINE_MS = 5_000
const PAGE_SIZE = 50

function cacheFor(query, persistence) {
  let byPersistence = caches.get(query)
  if (!byPersistence) caches.set(query, byPersistence = new WeakMap())
  const identity = persistence && (typeof persistence === 'object' || typeof persistence === 'function') ? persistence : query
  let cache = byPersistence.get(identity)
  if (!cache) byPersistence.set(identity, cache = { rows: null, updatedAt: 0, flight: null, titles: new Map(), active: 0, waiting: [] })
  return cache
}

function ordinary(row) {
  const header = row?.header
  return typeof header?.id === 'string' && !header.id.startsWith('roaming-') &&
    header.origin !== 'subagent' && !(header.delegationDepth > 0) &&
    header.archived !== true && row.archived !== true &&
    header.archivedAt == null && row.archivedAt == null
}

function titleOf(header) {
  const title = typeof header.title === 'string' ? header.title.split(/\r?\n/, 1)[0].trim() : ''
  return title.slice(0, 200) || `未命名会话 ${header.id.replace(/^session-/, '').slice(0, 8)}`
}

// This is an optional, existing projection artifact, NOT a session log. Only
// recognize the exact leading root/record/identity/rows/title layout. If the
// complete title cell is not in the bounded prefix, do not scan further.
const jsonString = String.raw`"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`
const titlePrefix = new RegExp(String.raw`^\s*\{\s*"version"\s*:\s*\d+\s*,\s*"record"\s*:\s*\{\s*"identity"\s*:\s*\{(?:${jsonString}|[^{}"])*\}\s*,\s*"rows"\s*:\s*\{\s*"title"\s*:\s*\{\s*"ver"\s*:\s*1\s*,\s*"seq"\s*:\s*-?\d+\s*,\s*"val"\s*:\s*${jsonString}\s*\}`)

async function projectionTitle(home, id) {
  // IDs are filenames here; never let a listed id select arbitrary paths.
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return undefined
  let handle
  try {
    handle = await fs.open(path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), 'r')
    const bytes = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const match = titlePrefix.exec(bytes.subarray(0, bytesRead).toString('utf8'))
    if (!match) return undefined
    const value = JSON.parse(`${match[0]}}}}`).record.rows.title.val
    return value.split(/\r?\n/, 1)[0].trim().slice(0, 200) || undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function titleSlot(cache, read) {
  if (cache.active >= 8) await new Promise(resolve => cache.waiting.push(resolve))
  else cache.active++
  try { return await read() }
  finally {
    const next = cache.waiting.shift()
    if (next) next()
    else cache.active--
  }
}

function cachedProjectionTitle(cache, home, id, refresh) {
  const key = `${home}\0${id}`
  const previous = cache.titles.get(key)
  if (previous && (previous.pending || (!refresh && previous.expires > Date.now()))) return previous.promise
  const entry = { pending: true, expires: 0, promise: null }
  entry.promise = titleSlot(cache, () => projectionTitle(home, id)).then(title => {
    entry.pending = false
    entry.expires = Date.now() + TTL_MS
    return title
  })
  cache.titles.set(key, entry)
  return entry.promise
}

function startListing(cache, query) {
  const controller = new AbortController()
  const flight = { promise: null }
  cache.flight = flight
  // Keep the flight registered until the *underlying* operation settles. A
  // backend ignoring cancellation must not start another scan after timeout.
  const work = Promise.resolve().then(() => query.listSessions(controller.signal)).then(rows => {
    cache.rows = rows.filter(ordinary).map(({ header }) => ({
      id: header.id, title: titleOf(header), cwd: header.cwd,
      headerTitle: typeof header.title === 'string' && Boolean(header.title.trim()),
    }))
    cache.updatedAt = Date.now()
    return cache.rows
  })
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = Object.assign(new Error('本机会话列表读取超时，请稍后重试'), { code: 'LOCAL_SESSION_LIST_TIMEOUT' })
      reject(error)
      controller.abort(error)
    }, DEADLINE_MS)
  })
  flight.promise = Promise.race([work, deadline])
  const settled = () => {
    clearTimeout(timer)
    if (cache.flight === flight) cache.flight = null
  }
  // Both fulfillment and rejection are observed independently of API callers.
  work.then(settled, settled)
  return flight
}

export async function listLocalSessions({ query, persistence, home }, options = {}) {
  const startedAt = Date.now()
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(PAGE_SIZE, Math.floor(options.limit))) : PAGE_SIZE
  if (!query) return { sessions: [], offset, hasMore: false, total: 0, cached: false }
  const cache = cacheFor(query, persistence)
  const fresh = cache.rows !== null && Date.now() - cache.updatedAt < TTL_MS
  let rows
  let cached = false
  if (fresh && options.refresh !== true) {
    rows = cache.rows
    cached = true
  } else {
    cached = cache.flight !== null
    rows = await (cache.flight || startListing(cache, query)).promise
  }
  let titleTimer
  let sessions
  try {
    sessions = await Promise.race([
      Promise.all(rows.slice(offset, offset + limit).map(async ({ headerTitle, ...row }) => {
        if (typeof home === 'string' && home && !headerTitle) {
          row.title = await cachedProjectionTitle(cache, home, row.id, options.refresh === true) || row.title
        }
        return row
      })),
      new Promise((_, reject) => { titleTimer = setTimeout(() => reject(Object.assign(new Error('本机会话列表读取超时，请稍后重试'), { code: 'LOCAL_SESSION_LIST_TIMEOUT' })), Math.max(0, DEADLINE_MS - (Date.now() - startedAt))) }),
    ])
  } finally { clearTimeout(titleTimer) }
  return {
    sessions,
    offset, hasMore: offset + limit < rows.length, total: rows.length, cached,
  }
}
