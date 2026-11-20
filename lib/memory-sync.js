import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { GitRepo } from './git.js'
import { emptyMemory, readMemoryRepository, writeMemoryRepository, reconcileMemory } from './portable-memory.js'
import { createMappingWorkspace } from './mapping-workspace.js'

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
      await progress('collect')
      let local = await workspace.load()
      if (bridge?.collect) local = await bridge.collect(local, workspace)
      local = await workspace.save(local)
      const base = await readBase()
      // Work in a disposable clone; a rejected push never commits into the
      // user's local Git mirror. No reset, history rewrite, or remote repair.
      temporary = await fs.mkdtemp(path.join(path.dirname(repoDir), '.memory-sync-'))
      const stageDir = path.join(temporary, 'repository')
      const stage = new GitRepo({ dir: stageDir, remoteUrl })
      await progress('fetch')
      await stage.ensureRepo()
      const remote = await readMemoryRepository(stageDir)
      if (direction === 'upload' && remote.legacy) throw Object.assign(new Error('旧版仓库当前仅支持下载读取；上传前需要明确执行格式迁移，未修改远端仓库'), { code: 'legacy-migration-needed', status: 409 })
      await progress('reconcile')
      const { document, conflicts } = reconcileMemory({ base, local, remote })
      const publish = direction === 'upload' || (direction === 'sync' && !remote.legacy)
      await progress('publish', { skipped: !publish, reason: remote.legacy ? 'legacy-read-only' : publish ? null : 'download-only', conflicts: conflicts.length })
      if (publish) {
        await writeMemoryRepository(stageDir, document)
        await stage.commitAll('Sync portable memory data')
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
      const readOnly = Boolean(remote.legacy) || direction === 'download'
      const partial = direction === 'sync' && Boolean(remote.legacy) || Boolean(materialized.pendingNative?.length)
      const result = { ok: true, direction, uploaded: publish, readOnly, partial, conflicts, groups: await workspace.list(document), materialized,
        message: direction === 'sync' && remote.legacy ? '本地数据已更新；旧格式仓库的回传尚未接通。' : partial ? '数据已同步，部分本机会话更新尚未写回。' : '同步完成',
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
