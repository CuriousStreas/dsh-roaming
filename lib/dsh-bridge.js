import fs from 'node:fs/promises'
import path from 'node:path'
import { contentRevision } from './portable-memory.js'
import { createLedger, enroll } from './ledger.js'
import { readEnrolledSnapshot } from './read-only-snapshot.js'
import { inspectSnapshotCandidate } from './snapshot-gate.js'

// The ONLY native-session adapter. Git, data codecs and UI know no DSH log
// rules. Originals are read-only; writable handles are limited to bound mapped
// copies in dedicated workspace cwds. MVP: text, unseeded v4, prefix appends.
export function createDshBridge({ persistence, query, workspaceRegistry, sessions, machineId }) {
  const read = async id => {
    const key = 'a'.repeat(64)
    const ledger = enroll(createLedger('dsh-adapter'), { key, localId: id })
    return (await readEnrolledSnapshot({ persistence, ledger, key })).snapshot
  }
  const supported = data => {
    inspectSnapshotCandidate({ enrollment: { localId: data.header.id, owner: 'native-readonly' }, ...data })
    if (data.header.version !== 4 || data.header.isSeeded || data.inheritedEventCount !== 0 || data.header.parentSession) {
      throw new Error('最小桥接目前仅支持无附件、非分叉的 v4 对话')
    }
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
      for (const [key, binding] of Object.entries(await workspace.bindings())) {
        if (!conversations[key]) continue
        const current = await read(binding.localId)
        supported(current)
        if (binding.owner === 'native' && binding.sourceRevision &&
            contentRevision(conversations[key].data) !== binding.sourceRevision &&
            contentRevision(conversations[key].data) !== contentRevision(current)) {
          throw new Error('本机会话有尚未写回的远端更新，已保留在映射区；不能用旧原生内容覆盖')
        }
        if (binding.owner === 'native') await workspace.bind(key, binding.localId, { sourceRevision: contentRevision(current) })
        // Local id/cwd are runtime addresses, never a new portable identity.
        const data = binding.owner === 'mapped' ? { ...current, header: conversations[key].data.header } : current
        conversations[key] = { ...conversations[key], data }
      }
      return { ...document, conversations, machines: { ...document.machines, [machineId]: document.machines[machineId] || { name: machineId } } }
    },
    async materialize(document, workspace) {
      const bindings = await workspace.bindings()
      const result = { created: [], updated: [], pendingNative: [] }
      for (const group of await workspace.list(document)) {
        for (const row of group.sessions) {
          const entry = document.conversations[row.key]
          if (row.hidden) {
            // Incoming changes for original sessions need a separate explicit
            // writeback decision; data sync never acquires their write handle.
            if (bindings[row.key]?.owner === 'native') {
              const local = await read(bindings[row.key].localId)
              if (contentRevision(local) !== contentRevision(entry.data)) result.pendingNative.push(row.key)
            }
            continue
          }
          if (entry.format !== 'dsh/session-v4') continue
          supported(entry.data)
          let binding = bindings[row.key]
          if (binding?.owner === 'native') throw new Error('外机会话不能写入原生绑定')
          if (binding) {
            const local = await read(binding.localId)
            if (contentRevision(local.events) !== contentRevision(entry.data.events.slice(0, local.events.length))) {
              // A conflict copy may now own the history already on this device.
              // Move its handle binding instead of rewriting that history.
              const split = Object.entries(document.conversations).find(([otherKey, other]) => otherKey !== row.key &&
                (other.conflictOf === row.key || entry.conflictOf === otherKey || (entry.conflictOf && other.conflictOf === entry.conflictOf)) &&
                contentRevision(other.data.events) === contentRevision(local.events))
              if (!split) throw new Error('映射会话不是追加关系，需先按三路规则分裂')
              bindings[split[0]] = await workspace.bind(split[0], binding.localId, { owner: 'mapped' })
              binding = undefined
            }
          }
          await fs.mkdir(row.workspacePath, { recursive: true })
          const registered = workspaceRegistry ? await workspaceRegistry.create(row.workspacePath, group.machineName) : null
          const id = binding?.localId || `roaming-${contentRevision({ key: row.key, data: entry.data }).slice(0, 40)}`
          if (!binding) {
            const cwd = registered?.path || path.resolve(row.workspacePath)
            const prepared = sessions?.prepare(id, { seed: entry.data.events, meta: { cwd, createdAt: entry.data.header.createdAt, isSeeded: false } })
            const header = prepared?.header || { ...entry.data.header, id, cwd }
            const handle = await persistence.create(header)
            try { await handle.append(entry.data.events); await handle.flush() } finally { await handle.close() }
            bindings[row.key] = await workspace.bind(row.key, id, { owner: 'mapped' })
            result.created.push(id)
          } else {
            if (sessions?.get(id)) throw new Error('映射会话正在运行，请结束当前轮后再同步')
            const handle = await persistence.open(id, 'write')
            try {
              const { events: stored } = await handle.read()
              const prefix = entry.data.events.slice(0, stored.length)
              if (contentRevision(prefix) !== contentRevision(stored)) throw new Error('映射会话不是追加关系，需先按三路规则分裂')
              sessions?.prepare(id, { seed: entry.data.events, meta: { cwd: handle.header.cwd, createdAt: handle.header.createdAt, isSeeded: false } })
              if (entry.data.events.length > stored.length) {
                await handle.append(entry.data.events.slice(stored.length))
                await handle.flush()
                result.updated.push(id)
              }
            } finally { await handle.close() }
          }
          if (registered) await registered.attachSession(id)
        }
      }
      return result
    },
  }
}
