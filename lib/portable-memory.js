import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { readLegacyMemoryRepository } from './legacy-memory.js';

const INDEX = 'memory-repository.json';
const KINDS = ['machines', 'conversations', 'memories'];
const ABSENT = Symbol('absent');
const owns = (object, key) => Object.hasOwn(object, key);
const isRecord = value => value !== null && typeof value === 'object'
  && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function assert(condition, message) {
  if (!condition) throw new TypeError(message);
}

// Serialize keys directly: JSON.stringify would reorder integer-like keys.
function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'Portable memory requires finite JSON numbers');
    return JSON.stringify(value);
  }
  assert(Array.isArray(value) || isRecord(value), 'Portable memory requires ordinary JSON values');
  assert(!ancestors.has(value), 'Portable memory cannot contain cyclic JSON');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    const items = [];
    for (let i = 0; i < value.length; i += 1) {
      assert(owns(value, i), 'Portable memory cannot contain sparse arrays');
      items.push(canonical(value[i], ancestors));
    }
    result = `[${items.join(',')}]`;
  } else {
    result = `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`).join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}

function put(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

function assertEnvelope(document) {
  assert(isRecord(document) && document.format === 'portable-memory' && document.version === 1,
    'Expected portable-memory version 1');
  for (const kind of KINDS) assert(isRecord(document[kind]), `Expected a ${kind} JSON object`);
}

function assertDocument(document) {
  assertEnvelope(document);
  for (const machine of Object.values(document.machines)) {
    assert(isRecord(machine), 'Machine entries must be generic JSON records');
  }
  for (const [key, conversation] of Object.entries(document.conversations)) {
    assert(isRecord(conversation) && conversation.key === key,
      'Conversation key must match its map key');
    for (const field of ['machineId', 'title', 'format']) {
      assert(typeof conversation[field] === 'string', `Conversation ${field} must be a string`);
    }
    assert(owns(conversation, 'data'), 'Conversation data is required');
  }
  canonical(document);
}

export function emptyMemory() {
  return { format: 'portable-memory', version: 1, machines: {}, conversations: {}, memories: {} };
}

export function contentRevision(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export async function readMemoryRepository(dir) {
  let text;
  try {
    text = await readFile(join(dir, INDEX), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let entries;
    try {
      entries = await readdir(dir);
    } catch (directoryError) {
      if (directoryError.code === 'ENOENT') return emptyMemory();
      throw directoryError;
    }
    if (entries.includes('hosts')) return readLegacyMemoryRepository(dir);
    if (entries.some(name => name !== '.git')) {
      throw new Error('Repository index is absent but existing files are present; legacy format requires explicit migration');
    }
    return emptyMemory();
  }
  const index = JSON.parse(text);
  assertEnvelope(index);
  const document = emptyMemory();
  document.machines = index.machines;
  for (const kind of ['conversations', 'memories']) {
    for (const [key, reference] of Object.entries(index[kind])) {
      assert(isRecord(reference) && /^[a-f0-9]{64}$/.test(reference.revision),
        `Invalid object revision for ${kind}:${key}`);
      const compressed = await readFile(join(dir, 'objects', `${reference.revision}.json.zst`));
      const value = JSON.parse(zstdDecompressSync(compressed).toString('utf8'));
      assert(contentRevision(value) === reference.revision, `Object revision mismatch for ${kind}:${key}`);
      put(document[kind], key, value);
    }
  }
  assertDocument(document);
  return document;
}

export async function writeMemoryRepository(dir, document) {
  assertDocument(document);
  const index = emptyMemory();
  index.machines = document.machines;
  await mkdir(join(dir, 'objects'), { recursive: true });
  for (const kind of ['conversations', 'memories']) {
    for (const key of Object.keys(document[kind]).sort()) {
      const value = document[kind][key];
      const revision = contentRevision(value);
      const path = join(dir, 'objects', `${revision}.json.zst`);
      try {
        await writeFile(path, zstdCompressSync(Buffer.from(canonical(value), 'utf8')), { flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      put(index[kind], key, { revision });
    }
  }
  // Objects precede the index; unrelated files and old objects are untouched.
  await writeFile(join(dir, INDEX), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

const get = (map, key) => owns(map, key) ? map[key] : ABSENT;
const equal = (left, right) => left === ABSENT || right === ABSENT
  ? left === right : canonical(left) === canonical(right);
const clone = value => JSON.parse(canonical(value));

export function reconcileMemory({ base, local, remote }) {
  for (const document of [base, local, remote]) assertDocument(document);
  const document = emptyMemory();
  const conflicts = [];
  for (const kind of KINDS) {
    const pendingCopies = [];
    const keys = [...new Set([
      ...Object.keys(base[kind]), ...Object.keys(local[kind]), ...Object.keys(remote[kind]),
    ])].sort();
    for (const key of keys) {
      const before = get(base[kind], key);
      const ours = get(local[kind], key);
      const theirs = get(remote[kind], key);
      let chosen;
      if (equal(ours, theirs) || equal(theirs, before)) chosen = ours;
      else if (equal(ours, before)) chosen = theirs;
      else {
        chosen = ours;
        pendingCopies.push({ key, theirs });
      }
      if (chosen !== ABSENT) put(document[kind], key, clone(chosen));
    }
    // Allocate after merging ordinary keys so a real entry can never be overwritten by a copy.
    for (const { key, theirs } of pendingCopies) {
      if (theirs === ABSENT) {
        conflicts.push({ kind, key, copyKey: null });
        continue;
      }
      const revision = contentRevision(theirs);
      const copy = kind === 'conversations' ? { ...theirs, conflictOf: key } : clone(theirs);
      const stem = `${key}~remote-${revision}`;
      let copyKey = stem;
      let collision = 0;
      while (true) {
        if (kind === 'conversations') copy.key = copyKey;
        const existing = get(document[kind], copyKey);
        if (existing === ABSENT || equal(existing, copy)) break;
        collision += 1;
        copyKey = `${stem}~${collision}`;
      }
      put(document[kind], copyKey, copy);
      conflicts.push({ kind, key, copyKey });
    }
  }
  return { document, conflicts };
}
