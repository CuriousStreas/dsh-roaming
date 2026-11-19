import { conversationKey } from './revisions.js'

const SHA = /^[a-f0-9]{64}$/
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

// v3 repository layout: one mutable pointer per logical conversation, pointing
// to immutable, content-addressed objects (compression is transport-owned). Git fast-forward alone
// is not sufficient; the parent's digest must match the observed head too.
export function newManifest() {
  return { schema: 3, conversations: {} }
}

export function validateManifest(value) {
  if (!value || value.schema !== 3 || !value.conversations || typeof value.conversations !== 'object' || Array.isArray(value.conversations)) throw new Error('unsupported data protocol')
  for (const [key, entry] of Object.entries(value.conversations)) {
    conversationKey(key)
    if (!entry || !SHA.test(entry.head) || (entry.parent !== null && !SHA.test(entry.parent))) throw new Error('invalid conversation head')
  }
  return value
}

export function proposal(manifest, key, { expected, next }) {
  validateManifest(manifest)
  conversationKey(key)
  if (!SHA.test(next) || (expected !== null && !SHA.test(expected))) throw new Error('invalid proposal digest')
  const current = own(manifest.conversations, key) ? manifest.conversations[key].head : null
  if (current !== expected) return { accepted: false, reason: 'stale-head', current }
  if (current === next) return { accepted: false, reason: 'unchanged', current }
  return { accepted: true, manifest: { schema: 3, conversations: { ...manifest.conversations, [key]: { parent: expected, head: next } } } }
}
