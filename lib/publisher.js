import { createLedger, enroll, validateLedger, acknowledge, decide } from './ledger.js'
import { newManifest, validateManifest, proposal } from './manifest.js'
import { conversationKey, digest } from './revisions.js'

const SHA = /^[a-f0-9]{64}$/
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const bytesOf = (bytes) => {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('snapshot must be bytes')
  return Buffer.from(bytes)
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
  if (!SHA.test(revision)) throw new TypeError('invalid object revision')
  const encoded = store?.[revision]
  if (typeof encoded !== 'string' || !own(store, revision)) return null
  const bytes = Buffer.from(encoded, 'base64')
  if (digest(bytes) !== revision) throw new Error('corrupt immutable object')
  return bytes
}
export function putObject(store, bytes) {
  const data = bytesOf(bytes)
  const revision = digest(data)
  if (!store || typeof store !== 'object' || Array.isArray(store)) throw new TypeError('invalid object store')
  if (own(store, revision)) {
    if (!readObject(store, revision)?.equals(data)) throw new Error('immutable object collision')
    return { store, revision }
  }
  return { store: Object.freeze(Object.assign(Object.create(null), store, { [revision]: data.toString('base64') })), revision }
}

export function createPublication({ deviceId, ledger = createLedger(deviceId), manifest = newManifest(), objects = newObjectStore() } = {}) {
  const state = { ledger: ledgerCopy(ledger), manifest: manifestCopy(manifest), objects, pending: null }
  for (const revision of Object.keys(objects)) readObject(objects, revision)
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
