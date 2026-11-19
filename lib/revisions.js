import crypto from 'node:crypto'

export function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

// Identities are immutable conversation keys, never paths or event counts.
export function conversationKey(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32,64}$/.test(value)) throw new TypeError('invalid conversation key')
  return value
}

export function compareThreeWay({ base, local, remote }) {
  if (![base, local, remote].every((value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))) {
    throw new TypeError('three-way comparison requires three full SHA-256 revisions')
  }
  if (local === remote) return 'equal'
  if (base === remote) return 'publish-local'
  if (base === local) return 'adopt-remote'
  return 'conflict'
}

// No baseline means we have not proven shared ancestry. Never guess that one
// side can overwrite another merely from timestamps, event counts, or a title.
export function compareOptional({ base, local, remote }) {
  if (typeof base !== 'string') return local === remote ? 'unbound-equal' : 'unbound-conflict'
  return compareThreeWay({ base, local, remote })
}
