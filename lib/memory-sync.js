import fs from 'node:fs/promises'
import path from 'node:path'
import { GitRepo } from './git.js'
import { emptyMemory, readMemoryRepository, writeMemoryRepository, reconcileMemory } from './portable-memory.js'
import { createMappingWorkspace } from './mapping-workspace.js'

// Thin orchestration only. The portable repository does not depend on DSH.
// Native exports/materialization are optional injected bridge operations.
export function createMemorySync({ repoDir, mappingDir, remoteUrl, machineId, machineName, bridge }) {
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
    try {
      await repo.ensureRepo()
      let local = await workspace.load()
      if (bridge?.collect) local = await bridge.collect(local, workspace)
      local = await workspace.save(local)
      const base = await readBase()
      // Work in a disposable clone; a rejected push never commits into the
      // user's local Git mirror. No reset, history rewrite, or remote repair.
      temporary = await fs.mkdtemp(path.join(path.dirname(repoDir), '.memory-sync-'))
      const stageDir = path.join(temporary, 'repository')
      const stage = new GitRepo({ dir: stageDir, remoteUrl })
      await stage.ensureRepo()
      const remote = await readMemoryRepository(stageDir)
      const { document, conflicts } = reconcileMemory({ base, local, remote })
      if (direction === 'upload') {
        await writeMemoryRepository(stageDir, document)
        await stage.commitAll('Sync portable memory data')
        await stage.push()
      }
      // Keep the ordinary repository path as the fetched, human-inspectable
      // data mirror. Local changes in it are not silently reset or overwritten.
      if (await stage.probe(['rev-parse', '--verify', '--quiet', 'HEAD'], 'inspect memory HEAD')) await repo.pull()
      // Preserve the new data even if later DSH materialization fails. Binding
      // confirmation belongs to the bridge, never to Git publication.
      await workspace.save(document)
      await fs.writeFile(baselineFile, JSON.stringify(direction === 'upload' ? document : remote, null, 2) + '\n')
      const materialized = bridge?.materialize ? await bridge.materialize(document, workspace) : { pending: true }
      return { ok: true, direction, conflicts, groups: await workspace.list(document), materialized,
        conversations: Object.keys(document.conversations).length, memories: Object.keys(document.memories).length }
    } finally {
      busy = false
      if (temporary) {
        const target = path.resolve(temporary)
        if (path.dirname(target) !== path.dirname(repoDir) || !path.basename(target).startsWith('.memory-sync-')) throw new Error('unexpected staging cleanup path')
        await fs.rm(target, { recursive: true, force: true })
      }
    }
  }
  return { workspace, upload: () => run('upload'), download: () => run('download') }
}
