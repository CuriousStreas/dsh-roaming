import crypto from 'node:crypto'
import { compareOptional, conversationKey } from './revisions.js'

const SHA = /^[a-f0-9]{64}$/
const ID = /^[a-zA-Z0-9_-]{1,128}$/
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

export function newConversationKey() {
  return crypto.randomBytes(32).toString('hex')
}

// A Git filename is encoding, not an identity. Conversation keys are stable
// across machines and all sessions on a device must have exactly one owner.
export function validateLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || ledger.format !== 1 || !ID.test(ledger.deviceId) || !ledger.bindings || typeof ledger.bindings !== 'object' || Array.isArray(ledger.bindings) || ![null, Object.prototype].includes(Object.getPrototypeOf(ledger.bindings))) throw new Error('invalid ledger')
  const localIds = new Set()
  for (const [key, binding] of Object.entries(ledger.bindings)) {
    conversationKey(key)
    if (!binding || typeof binding !== 'object' || !ID.test(binding.localId) || !['native-readonly', 'roaming-owned'].includes(binding.owner)) throw new Error('invalid binding')
    if (localIds.has(binding.localId)) throw new Error('local Session ID already bound to another conversation')
    localIds.add(binding.localId)
    if (binding.base !== null && !SHA.test(binding.base)) throw new Error('invalid common baseline')
    if (binding.published !== null && !SHA.test(binding.published)) throw new Error('invalid published revision')
  }
  return ledger
}

export function createLedger(deviceId) {
  return validateLedger({ format: 1, deviceId, bindings: {} })
}

// Native source enrollment may only come from an explicit per-session action.
// This function records authority to read/export, NEVER authority to open/write.
export function enroll(ledger, { key = newConversationKey(), localId, owner = 'native-readonly' }) {
  validateLedger(ledger)
  conversationKey(key)
  if (!ID.test(localId) || own(ledger.bindings, key) || Object.values(ledger.bindings).some((item) => item.localId === localId)) throw new Error('binding already exists or invalid Session ID')
  if (owner !== 'native-readonly') throw new Error('new enrollment may not claim roaming ownership')
  return validateLedger({ ...ledger, bindings: { ...ledger.bindings, [key]: { localId, owner, base: null, published: null } } })
}

// Local revision must come from a validated exported snapshot, remote revision
// from the same logical conversation key and validated manifest (not path names).
export function decide(ledger, key, { local, remote }) {
  validateLedger(ledger)
  const binding = ledger.bindings[conversationKey(key)]
  if (!binding || !SHA.test(local) || !SHA.test(remote)) throw new Error('unbound conversation or invalid revision')
  return compareOptional({ base: binding.base, local, remote })
}

// Update the baseline only AFTER the Git remote has confirmed the manifest
// commit. A local commit or a successful export cannot advance this record.
export function acknowledge(ledger, key, revision, receipt) {
  validateLedger(ledger)
  if (!own(ledger.bindings, conversationKey(key)) || !SHA.test(revision) || !receipt || receipt.remoteAccepted !== true || !SHA.test(receipt.head) || receipt.head !== revision) throw new Error('missing verified remote acknowledgement')
  const prev = ledger.bindings[key]
  return validateLedger({ ...ledger, bindings: { ...ledger.bindings, [key]: { ...prev, base: revision, published: revision } } })
}
