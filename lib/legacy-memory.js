import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { sessionDigest, WIRE_FORMAT } from './sessions.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const MAX_FILE_BYTES = 16 * 1024 * 1024

async function bytesOf(file) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('Unsafe or oversized legacy data file')
  return readFile(file)
}

// Read compatibility only: retain wire payloads, never reinterpret them as native
// session-v4 snapshots, and never write or migrate the source repository.
export async function readLegacyMemoryRepository(dir) {
  const document = { format: 'portable-memory', version: 1, legacy: true, machines: {}, conversations: {}, memories: {} }
  const hostsDir = path.join(dir, 'hosts')
  if (!(await lstat(hostsDir)).isDirectory()) throw new Error('Legacy hosts must be a directory')
  for (const host of await readdir(hostsDir, { withFileTypes: true })) {
    if (host.isSymbolicLink()) throw new Error('Unsafe legacy host link')
    if (!host.isDirectory()) continue
    const folder = path.join(hostsDir, host.name)
    let metadata = {}
    try { metadata = JSON.parse((await bytesOf(path.join(folder, 'machine.json'))).toString('utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid legacy machine metadata')
    // Host names are labels, not proof that this is the current local machine.
    const origin = typeof metadata.fingerprint === 'string' && metadata.fingerprint ? `fingerprint:${metadata.fingerprint}` : `host:${host.name}`
    const machineId = `legacy-${hash(origin)}`
    document.machines[machineId] = { ...metadata, name: metadata.name || metadata.hostname || host.name, legacyHost: host.name }
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === 'machine.json') continue
      if (entry.isSymbolicLink()) throw new Error('Unsafe legacy session link')
      if (!entry.isFile() || !/\.json(?:\.zst)?$/.test(entry.name)) continue
      const bytes = await bytesOf(path.join(folder, entry.name))
      const text = entry.name.endsWith('.zst') ? zstdDecompressSync(bytes, { maxOutputLength: MAX_FILE_BYTES }).toString('utf8') : bytes.toString('utf8')
      const payload = JSON.parse(text)
      if (!payload?.session || !Array.isArray(payload.events) || (payload.format && payload.format !== WIRE_FORMAT)) throw new Error('Invalid legacy session payload')
      if (typeof payload.sha256 !== 'string' || sessionDigest(payload.session, payload.events) !== payload.sha256.toLowerCase()) throw new Error('Legacy session checksum mismatch')
      const originalId = typeof payload.session.id === 'string' && payload.session.id ? payload.session.id : entry.name.replace(/\.json(?:\.zst)?$/, '')
      const key = `legacy-${hash(JSON.stringify([origin, originalId]))}`
      if (Object.hasOwn(document.conversations, key)) throw new Error('Duplicate legacy session identity')
      document.conversations[key] = { key, machineId, title: typeof payload.title === 'string' ? payload.title : originalId,
        format: WIRE_FORMAT, originalId, legacyPath: `hosts/${host.name}/${entry.name}`, data: payload }
    }
  }
  for (const section of ['config', 'memory']) {
    const walk = async (folder, relative = '') => {
      let entries
      try {
        if (!(await lstat(folder)).isDirectory()) throw new Error('Unsafe legacy memory directory')
        entries = await readdir(folder, { withFileTypes: true })
      }
      catch (error) { if (error.code === 'ENOENT') return; throw error }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error('Unsafe legacy memory link')
        const file = path.join(folder, entry.name)
        const name = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) { await walk(file, name); continue }
        const bytes = await bytesOf(file)
        const text = bytes.toString('utf8')
        let data = text, format = 'legacy-file/text'
        if (!Buffer.from(text, 'utf8').equals(bytes)) { data = bytes.toString('base64'); format = 'legacy-file/base64' }
        else if (entry.name.endsWith('.json')) {
          try { data = JSON.parse(text); format = 'legacy-file/json' } catch { /* Preserve malformed JSON as opaque text. */ }
        }
        const legacyPath = `${section}/${name}`
        document.memories[`legacy-${hash(legacyPath)}`] = { format, legacyPath, data }
      }
    }
    await walk(path.join(dir, section))
  }
  return document
}
