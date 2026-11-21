import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// Shared only inside this DSH process. Plugin reloads must not start a second
// writer while an earlier instance is still finishing the same data root.
const registryKey = Symbol.for('dsh-roaming.sync-runners')
const registry = globalThis[registryKey] ||= new Map()

export function createSyncRunner({ statePath, execute, reportError = async () => {}, describeError = error => ({ message: error.message }) }) {
  const key = path.resolve(statePath)
  if (!registry.has(key)) registry.set(key, { state: { state: 'idle' }, loaded: null, flight: null })
  const entry = registry.get(key)
  const persist = async () => {
    try {
      await fs.mkdir(path.dirname(key), { recursive: true })
      await fs.writeFile(key, JSON.stringify(entry.state, null, 2) + '\n')
    } catch (error) { try { await reportError(error) } catch {} }
  }
  const restore = () => entry.loaded ||= (async () => {
    try {
      const saved = JSON.parse(await fs.readFile(key, 'utf8'))
      if (!saved || !['idle', 'running', 'succeeded', 'failed'].includes(saved.state)) throw new Error('Invalid saved sync state')
      entry.state = saved.state === 'running'
        ? { ...saved, state: 'failed', stage: 'interrupted', finishedAt: new Date().toISOString(), error: { code: 'interrupted', message: '上次同步随 DSH 退出而中断，可以重试。' } }
        : saved
    } catch (error) {
      if (error.code !== 'ENOENT') entry.state = { state: 'failed', error: { code: 'state-unreadable', message: '上次同步状态无法读取，可以重新同步。' } }
    }
  })()
  return {
    async getState() { await restore(); return { ...entry.state } },
    async start(trigger = 'manual', mode = 'sync') {
      await restore()
      if (entry.state.state === 'running') return { ok: true, accepted: false, syncState: { ...entry.state } }
      const runId = randomUUID()
      entry.state = { state: 'running', runId, trigger, mode, stage: 'queued', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null }
      // Assign the flight synchronously before any filesystem await, so manual
      // and hourly triggers are deduplicated even during queue persistence.
      entry.flight = (async () => {
        await persist()
        await new Promise(resolve => setImmediate(resolve))
        try {
          const result = await execute({ trigger, mode, runId, onProgress: event => {
            entry.state = { ...entry.state, stage: event.stage, elapsedMs: event.elapsedMs }
          } })
          entry.state = { ...entry.state, state: 'succeeded', stage: 'complete', result, error: null }
        } catch (error) {
          entry.state = { ...entry.state, state: 'failed', failedStage: entry.state.stage, stage: 'failed', error: describeError(error) }
          try { await reportError(error) } catch {}
        } finally {
          entry.state = { ...entry.state, finishedAt: new Date().toISOString() }
          await persist()
          entry.flight = null
        }
        return { ...entry.state }
      })()
      return { ok: true, accepted: true, syncState: { ...entry.state } }
    },
    async wait() { await restore(); return entry.flight ? entry.flight : { ...entry.state } },
  }
}
