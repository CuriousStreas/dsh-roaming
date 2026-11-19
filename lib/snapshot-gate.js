import { digest } from './revisions.js'

const MAX_BYTES = 8 * 1024 * 1024
const MAX_EVENTS = 50_000

// Offline admission gate, NOT a DSH import/replay validator. No persistence,
// network or native-session service is reachable from this module. The caller
// must explicitly bind the source ID; a ZIP export alone is insufficient.
export function inspectSnapshotCandidate({ enrollment, header, inheritedEventCount, events, attachments = [] }) {
  if (!enrollment || enrollment.owner !== 'native-readonly' || typeof enrollment.localId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(enrollment.localId) || enrollment.localId !== header?.id) {
    throw new Error('explicit native-readonly source enrollment required')
  }
  if (!header || typeof header !== 'object' || Array.isArray(header) || !Number.isSafeInteger(header.version)) {
    throw new Error('native header/version must be preserved')
  }
  if (typeof header.isSeeded !== 'boolean') throw new Error('explicit native fork lineage required')
  if (!Array.isArray(events) || events.length > MAX_EVENTS ||
      !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length ||
      (header.isSeeded === true ? inheritedEventCount === 0 : inheritedEventCount !== 0)) {
    throw new Error('exact fork inherited-event count required')
  }
  for (let i = 0; i < events.length; i++) {
    if (!events[i] || typeof events[i] !== 'object' || Array.isArray(events[i]) || events[i].seq !== i) {
      throw new Error('events must preserve contiguous original seq')
    }
  }
  // This gate cannot verify media bytes or unknown plugin-owned references.
  // Preserve them as unsupported instead of incorrectly blessing a partial ZIP.
  if (!Array.isArray(attachments) || attachments.length !== 0) throw new Error('attachments require independent byte and reference validation')
  const value = { header, inheritedEventCount, events, attachments }
  let bytes
  try { bytes = Buffer.from(JSON.stringify(value)) }
  catch { throw new Error('snapshot candidate cannot be encoded') }
  if (bytes.length > MAX_BYTES) throw new Error('snapshot candidate exceeds byte limit')
  return Object.freeze({ revision: digest(bytes), bytes: bytes.length, eventCount: events.length, inheritedEventCount })
}
