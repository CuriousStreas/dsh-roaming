import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'
import { sessionDigest, WIRE_FORMAT } from './sessions.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const MAX_FILE_BYTES = 16 * 1024 * 1024
const INDEX = '.roaming-index.json'
const indexFormat = 'dsh-roaming-legacy/1'
const own = (object, key) => Object.hasOwn(object, key)
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
const canonical = value => JSON.stringify(value === null || typeof value !== 'object' ? value
  : Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])))

async function bytesOf(file) {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('Unsafe or oversized legacy data file')
  return readFile(file)
}

// Check every component, including existing parents, before reading or writing.
async function safePath(dir, relative) {
  if (typeof relative !== 'string' || relative.split('/').some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part)) || path.isAbsolute(relative)) throw new Error('Unsafe legacy path')
  let target = path.resolve(dir)
  for (const part of ['', ...relative.split('/')]) {
    target = part ? path.join(target, part) : target
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Unsafe legacy link') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return target
}

async function readIndex(dir) {
  try {
    const index = JSON.parse((await bytesOf(await safePath(dir, INDEX))).toString('utf8'))
    if (index.format !== indexFormat || !record(index.conversations) || !record(index.memories) || !record(index.machines)) throw new Error('Invalid legacy roaming index')
    return index
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { format: indexFormat, conversations: {}, memories: {}, machines: {} }
  }
}

export async function readLegacyMemoryRepository(dir) {
  const index = await readIndex(dir)
  const document = { format: 'portable-memory', version: 1, legacy: true, machines: {}, conversations: {}, memories: {} }
  const hostsDir = await safePath(dir, 'hosts')
  if (!(await lstat(hostsDir)).isDirectory()) throw new Error('Legacy hosts must be a directory')
  for (const host of await readdir(hostsDir, { withFileTypes: true })) {
    if (host.isSymbolicLink()) throw new Error('Unsafe legacy host link')
    if (!host.isDirectory()) continue
    const folder = await safePath(dir, `hosts/${host.name}`)
    let metadata = {}
    try { metadata = JSON.parse((await bytesOf(path.join(folder, 'machine.json'))).toString('utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!record(metadata)) throw new Error('Invalid legacy machine metadata')
    // Keep the old origin for pre-index conversation keys, even when selfId fixes machine identity.
    const origin = typeof metadata.fingerprint === 'string' && metadata.fingerprint ? `fingerprint:${metadata.fingerprint}` : `host:${host.name}`
    const machineId = typeof metadata.selfId === 'string' && metadata.selfId ? metadata.selfId : index.machines[host.name]?.machineId || `legacy-${hash(origin)}`
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
      const legacyPath = `hosts/${host.name}/${entry.name}`
      const mapping = index.conversations[legacyPath]
      const originalId = typeof payload.session.id === 'string' && payload.session.id ? payload.session.id : entry.name.replace(/\.json(?:\.zst)?$/, '')
      const key = mapping?.entry?.key || `legacy-${hash(JSON.stringify([origin, originalId]))}`
      if (own(document.conversations, key)) throw new Error('Duplicate legacy session identity')
      document.conversations[key] = { key, machineId, title: typeof payload.title === 'string' ? payload.title : originalId,
        format: WIRE_FORMAT, originalId, ...mapping?.entry, legacyPath,
        data: mapping?.entry?.format === 'dsh/session-v4'
          ? { ...mapping.nativeExtras, header: payload.session, events: payload.events } : payload }
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
        const mapping = index.memories[legacyPath]
        if (mapping?.entry?.format === 'legacy-file/text') data = text
        if (mapping?.entry?.format === 'legacy-file/base64') data = bytes.toString('base64')
        const key = mapping?.key || `legacy-${hash(legacyPath)}`
        if (own(document.memories, key)) throw new Error('Duplicate legacy memory identity')
        document.memories[key] = mapping?.generic ? data : { format, ...mapping?.entry, legacyPath, data }
      }
    }
    await walk(await safePath(dir, section))
  }
  return document
}

// Existing host files remain authoritative; the small index carries only identities
// and native-only metadata. Binding/base and session event history never live here.
export async function writeLegacyMemoryRepository(dir, document) {
  const index = await readIndex(dir)
  const save = async (relative, bytes, json = false) => {
    const file = await safePath(dir, relative)
    try {
      const previous = await bytesOf(file)
      if (previous.equals(bytes)) return
      if (json) {
        const oldText = relative.endsWith('.zst') ? zstdDecompressSync(previous).toString('utf8') : previous.toString('utf8')
        const newText = relative.endsWith('.zst') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
        const oldValue = JSON.parse(oldText), newValue = JSON.parse(newText)
        if (canonical(oldValue) === canonical(newValue)) return
        // Legacy digests are key-order sensitive; canonical cloning alone is not an edit.
        if (oldValue?.session && Array.isArray(oldValue.events) && typeof oldValue.sha256 === 'string' &&
          oldValue.sha256.toLowerCase() === sessionDigest(oldValue.session, oldValue.events) &&
          canonical(omit(oldValue, ['sha256'])) === canonical(omit(newValue, ['sha256']))) return
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }
  await safePath(dir, 'hosts')
  await mkdir(path.join(dir, 'hosts'), { recursive: true })
  const hosts = new Map()
  for (const [machineId, machine] of Object.entries(document.machines || {})) {
    let host = Object.keys(index.machines).find(name => index.machines[name].machineId === machineId) || machine.legacyHost || `machine-${hash(machineId).slice(0, 24)}`
    const conflictingHost = [...hosts].some(([id, name]) => name === host && id !== machineId) || (index.machines[host] && index.machines[host].machineId !== machineId)
    if (conflictingHost) host = `${host}-${hash(machineId).slice(0, 16)}`
    const relative = `hosts/${host}/machine.json`
    await safePath(dir, relative)
    let previous = {}
    try { previous = JSON.parse((await bytesOf(path.join(dir, ...relative.split('/')))).toString('utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const metadata = { ...previous, ...omit(machine, ['legacyHost']) }
    if (!own(previous, 'name') && machine.name === (previous.hostname || host)) delete metadata.name
    // Do not add selfId to existing machine files merely to normalize their identity.
    if (conflictingHost || (!Object.keys(previous).length && !metadata.selfId)) metadata.selfId = machineId
    await save(relative, Buffer.from(JSON.stringify(metadata, null, 2) + '\n'), true)
    index.machines[host] = { machineId }
    hosts.set(machineId, host)
  }
  const allocated = new Set()
  const allocate = async (section, key, entry, mappings, suffix) => {
    const mapped = Object.keys(mappings).find(name => (mappings[name].entry?.key || mappings[name].key) === key)
    let relative = mapped || (!entry.conflictOf && entry.legacyPath)
    if (!mapped && relative && (allocated.has(relative) || (mappings[relative] && (mappings[relative].entry?.key || mappings[relative].key) !== key))) relative = undefined
    if (relative && !relative.startsWith(`${section}/`)) throw new Error('Invalid legacy section path')
    if (!relative) {
      const revision = hash(JSON.stringify(entry.data ?? entry)).slice(0, 16)
      relative = `${section}/roaming-${hash(key).slice(0, 24)}-${revision}${suffix}`
      try { await lstat(await safePath(dir, relative)); throw new Error('Legacy allocation would overwrite an unknown file') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await safePath(dir, relative)
    if (allocated.has(relative) || (mappings[relative] && (mappings[relative].entry?.key || mappings[relative].key) !== key)) throw new Error('Duplicate legacy output path')
    allocated.add(relative)
    return relative
  }
  for (const [key, entry] of Object.entries(document.conversations || {})) {
    const host = hosts.get(entry.machineId)
    if (!host) throw new Error('Legacy conversation has no machine')
    const relative = await allocate(`hosts/${host}`, key, entry, index.conversations, '.json')
    const native = entry.format === 'dsh/session-v4'
    const payload = native ? { format: WIRE_FORMAT, session: entry.data.header, events: entry.data.events, title: entry.title } : { ...entry.data }
    if (!payload.session || !Array.isArray(payload.events) || (!native && entry.format !== WIRE_FORMAT)) throw new Error('Unsupported legacy conversation format')
    const digest = sessionDigest(payload.session, payload.events)
    if (typeof payload.sha256 !== 'string' || payload.sha256.toLowerCase() !== digest) payload.sha256 = digest
    let bytes = Buffer.from(JSON.stringify(payload, null, 2) + '\n')
    if (relative.endsWith('.zst')) bytes = zstdCompressSync(bytes)
    await save(relative, bytes, true)
    index.conversations[relative] = { entry: { ...omit(entry, ['data', 'legacyPath']), key },
      ...(native ? { nativeExtras: omit(entry.data, ['header', 'events']) } : {}) }
  }
  for (const [key, entry] of Object.entries(document.memories || {})) {
    const wrapper = record(entry) && typeof entry.format === 'string' && entry.format.startsWith('legacy-file/') && own(entry, 'data')
    const section = wrapper && entry.legacyPath?.startsWith('config/') ? 'config' : 'memory'
    const relative = await allocate(section, key, record(entry) ? entry : {}, index.memories, '.json')
    const bytes = wrapper && entry.format === 'legacy-file/base64' ? Buffer.from(entry.data, 'base64')
      : Buffer.from(wrapper && entry.format === 'legacy-file/text' ? entry.data : JSON.stringify(wrapper ? entry.data : entry, null, 2) + '\n')
    await save(relative, bytes, !wrapper || entry.format === 'legacy-file/json')
    index.memories[relative] = wrapper ? { key, entry: omit(entry, ['data', 'legacyPath']) } : { key, generic: true }
  }
  await save(INDEX, Buffer.from(JSON.stringify(index, null, 2) + '\n'), true)
  return readLegacyMemoryRepository(dir)
}
