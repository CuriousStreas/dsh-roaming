import { createLedger, enroll, validateLedger, acknowledge, decide } from './ledger.js'
import { newManifest, validateManifest, proposal } from './manifest.js'
import { conversationKey, digest } from './revisions.js'

const SHA = /^[a-f0-9]{64}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
export const OBJECT_LIMITS = Object.freeze({ objectBytes: 8 * 1024 * 1024, objectCount: 256, totalBytes: 32 * 1024 * 1024 })
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const bytesOf = (bytes) => {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('snapshot must be bytes')
  if (bytes.byteLength > OBJECT_LIMITS.objectBytes) throw new RangeError('object exceeds byte quota')
  return Buffer.from(bytes)
}
const storeEntries = (store) => {
  if (!store || typeof store !== 'object' || Array.isArray(store) || ![null, Object.prototype].includes(Object.getPrototypeOf(store))) throw new TypeError('invalid object store')
  const keys = Reflect.ownKeys(store)
  if (keys.length > OBJECT_LIMITS.objectCount) throw new RangeError('object store exceeds count quota')
  let total = 0
  return keys.map((revision) => {
    if (typeof revision !== 'string' || !SHA.test(revision)) throw new TypeError('invalid object store revision')
    const descriptor = Object.getOwnPropertyDescriptor(store, revision)
    const encoded = descriptor?.value
    if (!descriptor || !own(descriptor, 'value') || typeof encoded !== 'string') throw new TypeError('invalid object store encoding')
    // Check encoded length before regexp or Buffer.from: Buffer silently accepts
    // malformed base64, and a huge string must never reach the decoder.
    if (encoded.length > Math.ceil(OBJECT_LIMITS.objectBytes / 3) * 4) throw new RangeError('object exceeds byte quota')
    if (encoded.length % 4 !== 0 || !BASE64.test(encoded) || (encoded.includes('=') && !/={1,2}$/.test(encoded))) throw new TypeError('invalid object store encoding')
    const length = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
    if (length > OBJECT_LIMITS.objectBytes) throw new RangeError('object exceeds byte quota')
    total += length
    if (total > OBJECT_LIMITS.totalBytes) throw new RangeError('object store exceeds total byte quota')
    return [revision, encoded]
  })
}
const decodeObject = (revision, encoded) => {
  const data = Buffer.from(encoded, 'base64')
  if (digest(data) !== revision || data.toString('base64') !== encoded) throw new Error('corrupt immutable object')
  return data
}
const validateObjectStore = (store) => {
  const entries = storeEntries(store)
  for (const [revision, encoded] of entries) decodeObject(revision, encoded)
  return Object.freeze(Object.assign(Object.create(null), Object.fromEntries(entries)))
}
const manifestCopy = (manifest) => {
  validateManifest(manifest)
  return { schema: 3, conversations: Object.fromEntries(Object.entries(manifest.conversations).map(([key, entry]) => [key, { head: entry.head, parent: entry.parent }])) }
}
const ledgerCopy = (ledger) => {
  validateLedger(ledger)
  return { format: 1, deviceId: ledger.deviceId, bindings: Object.fromEntries(Object.entries(ledger.bindings).map(([key, value]) => [key, { ...value }])) }
}
// This is a digest of the whole manifest, not just a conversation head. It is
// the optimistic compare-and-swap token for an independently observed checkout.
export function manifestRevision(manifest) {
  const copy = manifestCopy(manifest)
  return digest(JSON.stringify({ schema: 3, conversations: Object.fromEntries(Object.entries(copy.conversations).sort(([a], [b]) => a.localeCompare(b))) }))
}

// A pure immutable byte store. Base64 strings prevent callers from mutating
// stored bytes through a Buffer alias. Digest collisions/mismatched data fail.
export function newObjectStore() {
  return Object.freeze(Object.create(null))
}
export function readObject(store, revision) {
  if (typeof revision !== 'string' || !SHA.test(revision)) throw new TypeError('invalid object revision')
  const entries = storeEntries(store)
  const encoded = entries.find(([key]) => key === revision)?.[1]
  return encoded === undefined ? null : decodeObject(revision, encoded)
}
export function putObject(store, bytes) {
  const data = bytesOf(bytes)
  const entries = storeEntries(store)
  const revision = digest(data)
  // Reject corrupted or invalid imported stores, including unrelated entries.
  for (const [key, encoded] of entries) decodeObject(key, encoded)
  if (own(store, revision)) return { store, revision }
  if (entries.length >= OBJECT_LIMITS.objectCount) throw new RangeError('object store exceeds count quota')
  const total = entries.reduce((sum, [, encoded]) => sum + encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0), 0)
  if (total + data.length > OBJECT_LIMITS.totalBytes) throw new RangeError('object store exceeds total byte quota')
  return { store: Object.freeze(Object.assign(Object.create(null), store, { [revision]: data.toString('base64') })), revision }
}

// The caller persists this plain state between runs. Recovery does not imply
// that a remote push or receipt was verified; acknowledgement still requires
// fresh caller-supplied remote evidence through acknowledgePublication.
export function createPublication({ deviceId, ledger = createLedger(deviceId), manifest = newManifest(), objects = newObjectStore(), pending = null } = {}) {
  const state = { ledger: ledgerCopy(ledger), manifest: manifestCopy(manifest), objects: validateObjectStore(objects), pending: null }
  if (pending !== null) {
    if (!pending || typeof pending !== 'object' || Array.isArray(pending) || !['prepared', 'committed'].includes(pending.stage) ||
      typeof pending.key !== 'string' || !own(state.ledger.bindings, conversationKey(pending.key)) ||
      typeof pending.revision !== 'string' || !SHA.test(pending.revision) ||
      typeof pending.expectedManifest !== 'string' || !SHA.test(pending.expectedManifest) ||
      (pending.expectedHead !== null && (typeof pending.expectedHead !== 'string' || !SHA.test(pending.expectedHead))) ||
      !readObject(objects, pending.revision)) throw new Error('invalid persisted pending publication')
    if (pending.stage === 'prepared') {
      if (own(pending, 'committedManifest') || manifestRevision(state.manifest) !== pending.expectedManifest ||
        (state.manifest.conversations[pending.key]?.head ?? null) !== pending.expectedHead) throw new Error('invalid persisted pending publication')
    } else if (typeof pending.committedManifest !== 'string' || !SHA.test(pending.committedManifest) ||
      manifestRevision(state.manifest) !== pending.committedManifest ||
      state.manifest.conversations[pending.key]?.head !== pending.revision ||
      state.manifest.conversations[pending.key]?.parent !== pending.expectedHead) throw new Error('invalid persisted pending publication')
    state.pending = { key: pending.key, revision: pending.revision, expectedManifest: pending.expectedManifest,
      expectedHead: pending.expectedHead, stage: pending.stage,
      ...(pending.stage === 'committed' ? { committedManifest: pending.committedManifest } : {}) }
  }
  return state
}

// Only an explicit call can enroll a local session. Never claims write access
// to a native DSH session; callers supply validated, exported snapshot bytes.
export function enrollPublication(state, { key, localId }) {
  if (state.pending) throw new Error('finish pending publication before enrollment')
  return { ...state, ledger: enroll(state.ledger, { key, localId }) }
}

export function preparePublication(state, { key, bytes, observedManifest }) {
  conversationKey(key)
  if (!own(state.ledger.bindings, key)) throw new Error('explicit enrollment required')
  if (state.pending) throw new Error('publication already pending')
  if (!observedManifest) throw new Error('observed manifest required')
  const observed = manifestCopy(observedManifest)
  const { store, revision } = putObject(state.objects, bytes)
  return { ...state, objects: store, pending: { key, revision, expectedManifest: manifestRevision(observed), expectedHead: observed.conversations[key]?.head ?? null, stage: 'prepared' } }
}

// This is a LOCAL manifest commit only. The caller must separately obtain a
// remote acknowledgement; a commit cannot advance the ledger's baseline.
export function commitPublication(state, { key, observedManifest }) {
  conversationKey(key)
  const pending = state.pending
  if (!pending || pending.key !== key) throw new Error('no prepared publication for key')
  if (pending.stage === 'committed') return { status: 'local-committed', state }
  if (!observedManifest) throw new Error('observed manifest required')
  const observed = manifestCopy(observedManifest)
  const remoteHead = observed.conversations[key]?.head ?? null
  if (manifestRevision(observed) !== pending.expectedManifest || remoteHead !== pending.expectedHead) {
    return { status: 'conflict', reason: 'stale-manifest', state }
  }
  // A full-manifest CAS also prevents accidentally dropping another key's
  // update. A stale local checkout is never silently overwritten.
  if (manifestRevision(state.manifest) !== pending.expectedManifest) {
    return { status: 'conflict', reason: 'stale-local-manifest', state }
  }
  if (remoteHead !== null) {
    if (!readObject(state.objects, remoteHead)) throw new Error('remote head object unavailable')
    const choice = decide(state.ledger, key, { local: pending.revision, remote: remoteHead })
    if (choice === 'equal' || choice === 'unbound-equal') return { status: 'unchanged', state }
    if (choice !== 'publish-local') return { status: 'conflict', reason: choice, state }
  } else if (state.ledger.bindings[key].base !== null) {
    return { status: 'conflict', reason: 'remote-head-missing', state }
  }
  const result = proposal(observed, key, { expected: remoteHead, next: pending.revision })
  if (!result.accepted) return { status: result.reason === 'unchanged' ? 'unchanged' : 'conflict', reason: result.reason, state }
  const manifest = manifestCopy(result.manifest)
  return {
    status: 'local-committed',
    state: { ...state, manifest, pending: { ...pending, stage: 'committed', committedManifest: manifestRevision(manifest) } },
  }
}

// Convergence without publishing: update the baseline only on independent
// remote observation of exactly the same bounded bytes and complete manifest.
// The caller must obtain `observation` from a fresh remote checkout; this pure
// function validates consistency but cannot authenticate the caller itself.
export function acknowledgeObservedEquality(state, { key, localBytes, observation }) {
  conversationKey(key)
  if (!own(state.ledger.bindings, key)) throw new Error('explicit enrollment required')
  if (state.pending?.stage === 'committed' || (state.pending && state.pending.key !== key)) throw new Error('another publication is pending')
  const local = bytesOf(localBytes)
  if (!(observation?.object instanceof Uint8Array)) throw new Error('independent remote object required')
  const remoteBytes = bytesOf(observation.object)
  const remote = manifestCopy(observation.manifest)
  if (typeof observation.manifestHead !== 'string' || observation.manifestHead !== manifestRevision(remote) ||
      observation.manifestHead !== manifestRevision(state.manifest)) throw new Error('stale or unverified complete manifest')
  const head = remote.conversations[key]?.head
  if (!head || head !== observation.head || digest(local) !== head || digest(remoteBytes) !== head || !local.equals(remoteBytes)) throw new Error('remote and local objects differ')
  if (state.pending && (state.pending.revision !== head || state.pending.expectedManifest !== observation.manifestHead || state.pending.expectedHead !== head)) throw new Error('prepared publication differs from observed remote')
  if (!readObject(state.objects, head)?.equals(local)) throw new Error('local immutable object unavailable')
  const classification = decide(state.ledger, key, { local: head, remote: head })
  if (classification !== 'equal' && classification !== 'unbound-equal') throw new Error('not a converged revision')
  return { ...state, ledger: acknowledge(state.ledger, key, head, { remoteAccepted: true, head }), pending: null }
}

// Receipt is an assertion about a *verified* remote manifest, not a successful
// local Git commit or a push attempt. No remote data transport is performed.
export function acknowledgePublication(state, { key, receipt, remoteManifest }) {
  conversationKey(key)
  const pending = state.pending
  if (!pending || pending.key !== key || pending.stage !== 'committed') throw new Error('no locally committed publication')
  if (receipt?.remoteAccepted !== true || !SHA.test(receipt.head) || !SHA.test(receipt.manifestHead) || !remoteManifest) throw new Error('missing verified remote acknowledgement')
  const remote = manifestCopy(remoteManifest)
  if (receipt.head !== pending.revision || receipt.manifestHead !== pending.committedManifest || manifestRevision(remote) !== pending.committedManifest || remote.conversations[key]?.head !== pending.revision || remote.conversations[key]?.parent !== pending.expectedHead) {
    throw new Error('remote acknowledgement does not match committed manifest')
  }
  return { ...state, ledger: acknowledge(state.ledger, key, pending.revision, receipt), pending: null }
}
