import { digest } from './revisions.js'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 50_000
const MAX_NESTING = 96
const HEADER_FIELDS = new Set(['version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset'])
const EVENT_FIELDS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])

function losslessJson(value, seen = new Set(), depth = 0) {
  if (depth > MAX_NESTING) throw new Error('snapshot candidate exceeds nesting limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || seen.has(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null && !Array.isArray(value)) || typeof value.toJSON === 'function') throw new Error('snapshot candidate is not lossless JSON')
  seen.add(value)
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).some((key) => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(String(key)) || Number(key) >= value.length))) throw new Error('snapshot candidate is not lossless JSON')
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new Error('snapshot candidate is not lossless JSON')
      losslessJson(value[i], seen, depth + 1)
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) throw new Error('snapshot candidate is not lossless JSON')
      losslessJson(value[key], seen, depth + 1)
    }
  }
  seen.delete(value)
}

function containsMedia(value, seen = new Set(), depth = 0) {
  if (depth > MAX_NESTING) throw new Error('snapshot candidate exceeds nesting limit')
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  // A malformed/migrated media block without `attachment` is still not safe
  // to mirror: the missing bytes must never be mistaken for text-only content.
  if (value.type === 'image' || value.type === 'file' || Object.hasOwn(value, 'attachment') || Object.hasOwn(value, 'attachmentId')) return true
  return Object.values(value).some((nested) => containsMedia(nested, seen, depth + 1))
}

// Offline admission gate, NOT a DSH import/replay validator. No persistence,
// network or native-session service is reachable from this module. The caller
// must explicitly bind the source ID; a ZIP export alone is insufficient.
export function inspectSnapshotCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
      Reflect.ownKeys(candidate).some((key) => !['enrollment', 'header', 'inheritedEventCount', 'events', 'attachments'].includes(key))) throw new Error('unsupported snapshot candidate fields')
  const { enrollment, header, inheritedEventCount, events, attachments = [] } = candidate
  if (Object.hasOwn(candidate, 'attachments') && candidate.attachments === undefined) throw new Error('attachments must be explicit')
  if (!enrollment || enrollment.owner !== 'native-readonly' || typeof enrollment.localId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(enrollment.localId) || enrollment.localId !== header?.id) {
    throw new Error('explicit native-readonly source enrollment required')
  }
  if (!header || typeof header !== 'object' || Array.isArray(header) || header.version !== 4 ||
      !Number.isSafeInteger(header.createdAt) || header.createdAt < 0 ||
      (header.cwd !== undefined && (typeof header.cwd !== 'string' || !/^(?:[a-zA-Z]:[\\/]|[\\/])/.test(header.cwd)))) {
    throw new Error('native header/version must be preserved')
  }
  if (typeof header.isSeeded !== 'boolean') throw new Error('explicit native fork lineage required')
  if (Reflect.ownKeys(header).some((key) => !HEADER_FIELDS.has(key)) ||
      (header.parentSession !== undefined && typeof header.parentSession !== 'string') ||
      (header.origin !== undefined && header.origin !== 'subagent') ||
      (header.delegationDepth !== undefined && (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0)) ||
      (header.agentPreset !== undefined && typeof header.agentPreset !== 'string')) throw new Error('invalid native header fields')
  if (!Array.isArray(events) || events.length > MAX_EVENTS ||
      !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length ||
      (header.isSeeded === true ? inheritedEventCount === 0 : inheritedEventCount !== 0)) {
    throw new Error('exact fork inherited-event count required')
  }
  for (let i = 0; i < events.length; i++) {
    if (!events[i] || typeof events[i] !== 'object' || Array.isArray(events[i]) || events[i].seq !== i ||
        typeof events[i].type !== 'string' || !Number.isSafeInteger(events[i].time) || events[i].data === undefined ||
        Reflect.ownKeys(events[i]).some((key) => !EVENT_FIELDS.has(key)) ||
        (events[i].ignorable !== undefined && events[i].ignorable !== true)) {
      throw new Error('events must preserve contiguous original seq and envelope')
    }
  }
  // This gate cannot verify media bytes or unknown plugin-owned references.
  // Preserve them as unsupported instead of incorrectly blessing a partial ZIP.
  if (!Array.isArray(attachments) || attachments.length !== 0) throw new Error('attachments require independent byte and reference validation')
  const value = { header, inheritedEventCount, events, attachments }
  losslessJson(value)
  if (containsMedia(events)) throw new Error('embedded media requires independent byte and reference validation')
  let bytes
  try { bytes = Buffer.from(JSON.stringify(value)) }
  catch { throw new Error('snapshot candidate cannot be encoded') }
  if (bytes.length > MAX_BYTES) throw new Error('snapshot candidate exceeds byte limit')
  return Object.freeze({ revision: digest(bytes), bytes: bytes.length, eventCount: events.length, inheritedEventCount })
}
