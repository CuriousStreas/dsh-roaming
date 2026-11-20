import fs from 'node:fs/promises'
import path from 'node:path'
import { contentRevision } from './portable-memory.js'
import { createLedger, enroll } from './ledger.js'
import { readEnrolledSnapshot } from './read-only-snapshot.js'
import { inspectSnapshotCandidate } from './snapshot-gate.js'
import { sessionDigest, WIRE_FORMAT } from './sessions.js'

const failure = (key, error) => ({ key, code: String(error?.code || 'bridge-conversation-failed'), message: error?.message || String(error) })
const fail = message => { throw new Error(message) }

function snapshot(entry) {
  if (entry.format === 'dsh/session-v4') return entry.data
  if (entry.format !== WIRE_FORMAT) return fail('不支持的映射会话格式')
  const data = entry.data
  if (!data?.session || !Array.isArray(data.events) || typeof data.sha256 !== 'string' ||
      sessionDigest(data.session, data.events) !== data.sha256.toLowerCase()) return fail('会话校验失败：sha256 不匹配')
  return { header: data.session, events: data.events, inheritedEventCount: data.inheritedEventCount ?? 0, attachments: data.attachments ?? [] }
}

// Only declared durable message slots are interpreted. Tool arguments, text,
// plugin records and historical generation captures remain opaque.
function addressedEvents(events, from, to, version) {
  const message = value => {
    const source = value?.source
    if (source?.kind !== 'session-reference' || source.form !== 'recall' || source.version !== 1 || !Array.isArray(source.references)) return value
    return { ...value, source: { ...source, references: source.references.map(ref =>
      ref.sessionId === from && ref.capturedFormatVersion === version ? { ...ref, sessionId: to } : ref) } }
  }
  return events.map(event => {
    let data = event.data
    if (event.type === 'session-log-deepseek/delivery-accepted' && (data?.sessionFormatVersion ?? 0) === version && data.sessionId === from) {
      data = { ...data, sessionId: to }
    } else if (event.type === 'user/message') data = message(data)
    else if (['system/message', 'developer/message', 'assistant/message', 'tool/result'].includes(event.type) && data?.message) data = { ...data, message: message(data.message) }
    else if (event.type === 'agent/inbox/spliced' && Array.isArray(data?.inserted)) data = { ...data, inserted: data.inserted.map(message) }
    else if (event.type === 'session/title-llm-request' && Array.isArray(data?.messages)) data = { ...data, messages: data.messages.map(message) }
    return data === event.data ? event : { ...event, data }
  })
}

function portableData(entry, current) {
  const original = snapshot(entry)
  const events = addressedEvents(current.events, current.header.id, original.header.id, original.header.version)
  // Retain the original wire bytes/checksum for an unchanged transcript, even
  // when the native backend reconstructs equivalent objects in another order.
  if (contentRevision(events) === contentRevision(original.events)) return entry.data
  if (entry.format === WIRE_FORMAT) return { ...entry.data, session: original.header, events, sha256: sessionDigest(original.header, events) }
  return { ...entry.data, header: original.header, events }
}

function supported(data) {
  inspectSnapshotCandidate({ enrollment: { localId: data.header.id, owner: 'native-readonly' }, ...data })
  if (data.header.version !== 4 || data.header.isSeeded || data.inheritedEventCount !== 0 || data.header.parentSession) {
    fail('最小桥接目前仅支持无附件、非分叉的 v4 对话')
  }
}

// Native originals are read-only. Only explicit mapped bindings grant writes.
export function createDshBridge({ persistence, query, workspaceRegistry, sessions, machineId }) {
  const read = async id => {
    const key = 'a'.repeat(64)
    const ledger = enroll(createLedger('dsh-adapter'), { key, localId: id })
    return (await readEnrolledSnapshot({ persistence, ledger, key })).snapshot
  }
  const cachedReader = () => {
    const cache = new Map()
    return id => { if (!cache.has(id)) cache.set(id, read(id)); return cache.get(id) }
  }
  const ownBinding = async (key, entry, workspace, bindings, currentRead) => {
    if (bindings[key] || entry.machineId !== machineId || entry.conflictOf) return bindings[key]
    const source = snapshot(entry)
    const id = source.header.id
    if (entry.originalId !== undefined && entry.originalId !== id) fail('原始会话 ID 与持久化源头不符')
    const current = await currentRead(id)
    if (current.header.id !== id) fail('原始会话 ID 不匹配')
    bindings[key] = await workspace.bind(key, id, { owner: 'native', sourceRevision: contentRevision(entry.data) })
    return bindings[key]
  }
  return {
    async listLocal() {
      if (!query) return []
      const rows = await query.listSessions()
      const titles = query.readTitleSnapshots ? await query.readTitleSnapshots(rows.map(row => row.header.id)) : []
      const named = new Map(titles.filter(row => row.status === 'fulfilled').map(row => [row.value.session.id, row.value.title]))
      return rows.filter(row => !row.header.id.startsWith('roaming-')).map(row => ({ id: row.header.id, title: named.get(row.header.id) || row.header.id, cwd: row.header.cwd }))
    },
    async enroll(id, workspace, settings) {
      const document = await workspace.load()
      const bindings = await workspace.bindings()
      const previous = Object.entries(bindings).find(([, value]) => value.owner === 'native' && value.localId === id)
      const key = previous?.[0] || contentRevision({ machineId: settings.machineId, sessionId: id })
      const data = await read(id)
      supported(data)
      document.conversations[key] = { key, machineId: settings.machineId, title: id, format: 'dsh/session-v4', data }
      await workspace.bind(key, id, { sourceRevision: contentRevision(data) })
      await workspace.save(document)
    },
    async collect(document, workspace) {
      const conversations = { ...document.conversations }
      const bindings = await workspace.bindings()
      const currentRead = cachedReader()
      const bridgeFailures = []
      for (const [key, entry] of Object.entries(conversations)) {
        try {
          const binding = await ownBinding(key, entry, workspace, bindings, currentRead)
          if (!binding) continue
          const current = await currentRead(binding.localId)
          supported(current)
          const data = portableData(entry, current)
          if (binding.owner === 'native' && binding.sourceRevision && contentRevision(entry.data) !== binding.sourceRevision && contentRevision(entry.data) !== contentRevision(data)) {
            fail('本机会话有尚未写回的远端更新，已保留在映射区；不能用旧原生内容覆盖')
          }
          if (binding.owner === 'native') await workspace.bind(key, binding.localId, { sourceRevision: contentRevision(data) })
          conversations[key] = { ...entry, data }
        } catch (error) { bridgeFailures.push(failure(key, error)) }
      }
      return { ...document, conversations, machines: { ...document.machines, [machineId]: document.machines[machineId] || { name: machineId } }, ...(bridgeFailures.length ? { bridgeFailures } : {}) }
    },
    async materialize(document, workspace) {
      const bindings = await workspace.bindings()
      const currentRead = cachedReader()
      const result = { created: [], updated: [], pendingNative: [], failed: [] }
      for (const group of await workspace.list(document)) {
        for (const row of group.sessions) {
          try {
            const entry = document.conversations[row.key]
            let binding = await ownBinding(row.key, entry, workspace, bindings, currentRead)
            if (row.hidden) {
              if (binding?.owner === 'native') {
                const local = await currentRead(binding.localId)
                if (contentRevision(portableData(entry, local)) !== contentRevision(entry.data)) result.pendingNative.push(row.key)
              }
              continue
            }
            const source = snapshot(entry)
            supported(source)
            if (binding?.owner === 'native') fail('外机会话不能写入原生绑定')
            if (binding) {
              const local = await currentRead(binding.localId)
              const portable = portableData(entry, local)
              if (contentRevision(portable.events) !== contentRevision(source.events.slice(0, local.events.length))) {
                const split = Object.entries(document.conversations).find(([otherKey, other]) => otherKey !== row.key &&
                  (other.conflictOf === row.key || entry.conflictOf === otherKey || (entry.conflictOf && other.conflictOf === entry.conflictOf)) &&
                  contentRevision(snapshot(other).events) === contentRevision(portable.events))
                if (!split) fail('映射会话不是追加关系，需先按三路规则分裂')
                bindings[split[0]] = await workspace.bind(split[0], binding.localId, { owner: 'mapped' })
                await workspace.unbind(row.key)
                delete bindings[row.key]
                binding = undefined
              }
            }
            const id = binding?.localId || `roaming-${contentRevision({ key: row.key, data: entry.data }).slice(0, 40)}`
            if (sessions?.get?.(id)) fail('映射会话正在运行，请结束当前轮后再同步')
            const events = addressedEvents(source.events, source.header.id, id, source.header.version)
            const cwd = path.resolve(row.workspacePath)
            const header = { ...source.header, id, cwd }
            // Validate before creating any durable log or binding. No format migration.
            sessions?.prepare(id, { seed: events, meta: header, inheritedEventCount: 0 })
            await fs.mkdir(cwd, { recursive: true })
            const registered = workspaceRegistry ? await workspaceRegistry.create(cwd, group.machineName) : null
            if (!binding) {
              const handle = await persistence.create(header)
              try {
                // Persistence has no delete primitive: retain a recoverable owner
                // even when append/flush/attach fails after create.
                bindings[row.key] = await workspace.bind(row.key, id, { owner: 'mapped' })
                await handle.append(events)
                await handle.flush()
              } finally { await handle.close() }
              result.created.push(id)
            } else {
              const handle = await persistence.open(id, 'write')
              try {
                if (handle.header.id !== id || path.resolve(handle.header.cwd || '') !== cwd) fail('映射绑定的会话地址不匹配')
                const { events: stored } = await handle.read()
                if (contentRevision(events.slice(0, stored.length)) !== contentRevision(stored)) fail('映射会话不是追加关系，需先按三路规则分裂')
                if (events.length > stored.length) {
                  await handle.append(events.slice(stored.length))
                  await handle.flush()
                  result.updated.push(id)
                }
              } finally { await handle.close() }
            }
            if (registered) await registered.attachSession(id)
          } catch (error) { result.failed.push(failure(row.key, error)) }
        }
      }
      return result
    },
  }
}
