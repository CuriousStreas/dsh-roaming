import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { emptyMemory } from './portable-memory.js'

const fingerprint = id => createHash('sha256').update(id).digest('hex')
const safeName = name => String(name || 'machine')
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
  .replace(/^[.\s]+|[.\s]+$/g, '')
  .slice(0, 64) || 'machine'

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback()
    throw error
  }
}

/**
 * Local, uncompressed mapping descriptors, independent of any Git repository.
 * workspacePath is a proposed isolated location, NOT a registered DSH workspace.
 * This module neither mounts workspaces nor accesses or writes native sessions.
 * Construction, load and list never create files or workspace directories.
 */
export function createMappingWorkspace({ mappingDir, machineId, machineName }) {
  const root = path.resolve(mappingDir)
  const memoryFile = path.join(root, 'memory.json')
  const bindingsFile = path.join(root, 'bindings.json')

  function withMachine(document) {
    return {
      ...document,
      machines: {
        ...document.machines,
        [machineId]: {
          ...document.machines?.[machineId],
          name: machineName || machineId,
          fingerprint: fingerprint(machineId),
        },
      },
    }
  }

  async function writeJson(file, value) {
    await mkdir(root, { recursive: true })
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  }

  async function bindings() {
    return readJson(bindingsFile, () => ({}))
  }

  return {
    async load() {
      return readJson(memoryFile, emptyMemory)
    },

    async save(document) {
      const saved = withMachine(document)
      await writeJson(memoryFile, saved)
      return saved
    },

    bindings,

    async bind(key, localId, { owner = 'native', sourceRevision } = {}) {
      if (owner !== 'native' && owner !== 'mapped') throw new Error('invalid binding owner')
      if (typeof key !== 'string' || !key || typeof localId !== 'string' || !localId) {
        throw new Error('binding requires a key and localId')
      }
      const binding = { localId, owner, ...(sourceRevision ? { sourceRevision } : {}) }
      await writeJson(bindingsFile, { ...await bindings(), [key]: binding })
      return binding
    },

    async unbind(key) {
      const bound = await bindings()
      delete bound[key]
      await writeJson(bindingsFile, bound)
    },

    async list(document) {
      const bound = await bindings()
      const groups = new Map()
      for (const [key, conversation] of Object.entries(document.conversations || {})) {
        const origin = conversation.machineId
        const hidden = !conversation.conflictOf && (origin === machineId || bound[key]?.owner === 'native')
        if (!groups.has(origin)) {
          const name = document.machines?.[origin]?.name || origin
          groups.set(origin, {
            machineId: origin,
            machineName: name,
            hidden,
            // Never reuse an original workspace path carried in portable data.
            workspacePath: path.join(root, 'workspaces', `${safeName(name)}-${fingerprint(origin).slice(0, 8)}`),
            sessions: [],
          })
        }
        const group = groups.get(origin)
        group.hidden = group.hidden && hidden
        group.sessions.push({
          key,
          title: conversation.title || key,
          machineId: origin,
          hidden,
          localId: Object.hasOwn(bound, key) ? bound[key].localId : null,
          workspacePath: hidden ? null : group.workspacePath,
        })
      }
      return [...groups.values()]
    },

    // Explicitly bound native entries only; no service scan, native writes, or
    // implicit save. The caller supplies an export function and saves the result.
    async refreshNative({ document, exportSession }) {
      const conversations = { ...document.conversations }
      for (const [key, binding] of Object.entries(await bindings())) {
        if (binding.owner !== 'native' || !Object.hasOwn(conversations, key)) continue
        const conversation = conversations[key]
        const exported = await exportSession(binding.localId)
        conversations[key] = {
          ...conversation,
          data: exported.data,
          title: exported.title ?? conversation.title,
          format: exported.format ?? conversation.format ?? 'dsh/session-v4',
        }
      }
      return withMachine({ ...document, conversations })
    },
  }
}
