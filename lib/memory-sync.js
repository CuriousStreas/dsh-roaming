import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { GitRepo } from './git.js'
import { emptyMemory, readMemoryRepository, writeMemoryRepository, reconcileMemory } from './portable-memory.js'
import { createMappingWorkspace } from './mapping-workspace.js'
import { writeLegacyMemoryRepository } from './legacy-memory.js'

// Old readers used a host-derived local key even when machine.json already had
// selfId. Align only proven identities, not display names, before comparison.
function alignMachineIds(document, remote) {
  const aliases = new Map()
  for (const [id, machine] of Object.entries(document.machines)) {
    const identity = machine.selfId || machine.fingerprint
    const match = identity && Object.entries(remote.machines).find(([, other]) => identity === (other.selfId || other.fingerprint))
    if (match) aliases.set(id, match[0])
  }
  const machines = {}
  for (const [id, machine] of Object.entries(document.machines)) {
    const target = aliases.get(id) || id
    machines[target] = { ...machines[target], ...machine }
  }
  return { ...document, machines, conversations: Object.fromEntries(Object.entries(document.conversations).map(([key, value]) =>
    [key, { ...value, machineId: aliases.get(value.machineId) || value.machineId }])) }
}

// Thin orchestration only. The portable repository does not depend on DSH.
// Native exports/materialization are optional injected bridge operations.
export function createMemorySync({ repoDir, mappingDir, remoteUrl, machineId, machineName, bridge, onProgress }) {
  repoDir = path.resolve(repoDir)
  mappingDir = path.resolve(mappingDir)
  if (repoDir === mappingDir || mappingDir.startsWith(repoDir + path.sep) || repoDir.startsWith(mappingDir + path.sep)) {
    throw new Error('本地 Git 仓库与映射区必须是互不包含的独立目录')
  }
  const workspace = createMappingWorkspace({ mappingDir, machineId, machineName })
  const repo = new GitRepo({ dir: repoDir, remoteUrl })
  const baselineFile = path.join(mappingDir, 'baseline.json')
  let busy = false
  const readBase = async () => {
    try { return JSON.parse(await fs.readFile(baselineFile, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return emptyMemory(); throw error }
  }
  const run = async (direction) => {
    if (busy) throw new Error('已有同步操作进行中')
    if (!remoteUrl) throw new Error('请先配置数据仓库')
    busy = true
    let temporary
    const runId = randomUUID()
    const startedAt = Date.now()
    let currentStage = 'start'
    const progress = async (stage, detail = {}) => {
      currentStage = stage
      // Progress contains operation metadata, never message bodies or credentials.
      try { await onProgress?.({ runId, direction, stage, elapsedMs: Date.now() - startedAt, ...detail }) } catch { /* Diagnostics do not interrupt synchronization. */ }
    }
    try {
      await progress('start')
      await progress('local-repository')
      await repo.ensureRepo()
      // Work in a disposable clone; a rejected push never commits into the
      // user's local Git mirror. No reset, history rewrite, or remote repair.
      temporary = await fs.mkdtemp(path.join(path.dirname(repoDir), '.memory-sync-'))
      const stageDir = path.join(temporary, 'repository')
      const stage = new GitRepo({ dir: stageDir, remoteUrl })
      await progress('fetch')
      await stage.ensureRepo()
      const remote = await readMemoryRepository(stageDir)
      await progress('collect')
      let local = alignMachineIds(await workspace.load(), remote)
      const base = alignMachineIds(await readBase(), remote)
      if (bridge?.collect) local = await bridge.collect(local, workspace)
      const collectFailures = local.bridgeFailures || []
      delete local.bridgeFailures
      local = await workspace.save(local)
      await progress('reconcile', { collectFailures: collectFailures.length })
      let { document, conflicts } = reconcileMemory({ base, local, remote })
      const publish = direction !== 'download'
      await progress('publish', { skipped: !publish, encoding: remote.legacy ? 'existing-hosts' : 'portable', conflicts: conflicts.length })
      if (publish) {
        if (remote.legacy) document = await writeLegacyMemoryRepository(stageDir, document)
        else await writeMemoryRepository(stageDir, document)
        await stage.commitAll('Sync memory data')
        await stage.push()
      }
      // Keep the ordinary repository path as the fetched, human-inspectable
      // data mirror. Local changes in it are not silently reset or overwritten.
      await progress('local-repository-update')
      if (await stage.probe(['rev-parse', '--verify', '--quiet', 'HEAD'], 'inspect memory HEAD')) await repo.pull()
      // Preserve the new data even if later DSH materialization fails. Binding
      // confirmation belongs to the bridge, never to Git publication.
      await progress('mapping')
      await workspace.save(document)
      await fs.writeFile(baselineFile, JSON.stringify(publish ? document : remote, null, 2) + '\n')
      await progress('sessions', { skipped: !bridge?.materialize })
      const materialized = bridge?.materialize ? await bridge.materialize(document, workspace) : { pending: true }
      const failed = [...collectFailures, ...(materialized.failed || [])]
      const readOnly = direction === 'download'
      const partial = Boolean(failed.length || materialized.pendingNative?.length)
      await progress('session-result', { created: materialized.created?.length || 0, updated: materialized.updated?.length || 0,
        pendingNative: materialized.pendingNative?.length || 0, failed })
      const result = { ok: true, direction, uploaded: publish, readOnly, partial, failed, conflicts, groups: await workspace.list(document), materialized,
        message: failed.length ? '数据已同步，部分会话处理失败，详情见日志。' : partial ? '数据已同步，部分本机会话更新尚未写回。' : '同步完成',
        conversations: Object.keys(document.conversations).length, memories: Object.keys(document.memories).length }
      await progress('complete', { uploaded: publish, readOnly, partial, conflicts: conflicts.length, conversations: result.conversations, memories: result.memories })
      return result
    } catch (error) {
      const failedStage = currentStage
      await progress('failed', { failedStage, code: error.code || 'internal' })
      throw error
    } finally {
      busy = false
      if (temporary) {
        const target = path.resolve(temporary)
        if (path.dirname(target) !== path.dirname(repoDir) || !path.basename(target).startsWith('.memory-sync-')) throw new Error('unexpected staging cleanup path')
        await fs.rm(target, { recursive: true, force: true })
      }
    }
  }
  return { workspace, sync: () => run('sync'), upload: () => run('upload'), download: () => run('download') }
}
