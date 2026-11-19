import { validateLedger } from './ledger.js'
import { conversationKey, digest } from './revisions.js'
import { inspectSnapshotCandidate } from './snapshot-gate.js'

const PAGE = 256
const MAX_EVENTS = 50_000
const MAX_BYTES = 8 * 1024 * 1024

// Offline prototype only: this is NOT wired to the plugin API. It takes an
// explicitly enrolled source through the public read handle; it never calls
// open('write'), flush, append, create, or scans local sessions. Equal opaque
// stat revisions bracket the read on the SAME persistence instance.
export async function readEnrolledSnapshot({ persistence, ledger, key }) {
  validateLedger(ledger)
  conversationKey(key)
  const binding = Object.hasOwn(ledger.bindings, key) ? ledger.bindings[key] : undefined
  if (!binding || binding.owner !== 'native-readonly') throw new Error('explicit native-readonly source enrollment required')
  if (!persistence || typeof persistence.stat !== 'function' || typeof persistence.open !== 'function') throw new Error('read-only persistence service required')
  const id = binding.localId
  const before = await persistence.stat(id)
  if (!before || typeof before.revision !== 'string' || !before.revision) throw new Error('source revision unavailable')
  const handle = await persistence.open(id, 'read')
  let failure
  let answer
  try {
    if (!handle || handle.access !== 'read' || handle.id !== id || typeof handle.read !== 'function' || typeof handle.close !== 'function') throw new Error('read-only handle required')
    const events = []
    while (true) {
      const result = await handle.read(events.length, PAGE)
      const page = result?.events
      if (!Array.isArray(page) || page.length > PAGE || events.length + page.length > MAX_EVENTS) throw new Error('snapshot exceeds bounded read')
      if (page.length === 0) break
      for (const event of page) {
        if (event?.seq !== events.length) throw new Error('source event sequence changed during read')
        // Persistence may supply shared-frozen event values. Detach at the
        // page boundary so later reads cannot alter an earlier page by alias.
        try { events.push(structuredClone(event)) }
        catch { throw new Error('source event cannot be detached') }
      }
      // An exact MAX_EVENTS prefix is legal; the next bounded read must still
      // confirm EOF before the snapshot can be accepted.
    }
    // Detach header as well: it is not an ownership grant and the persistence
    // handle may expose shared data whose producer can still mutate it.
    let header
    try { header = structuredClone(handle.header) }
    catch { throw new Error('source header cannot be detached') }
    const inheritedEventCount = handle.inheritedEventCount
    const after = await persistence.stat(id)
    if (!after || after.revision !== before.revision) throw new Error('source changed during read')
    const enrollment = { localId: id, owner: binding.owner }
    const inspected = inspectSnapshotCandidate({ enrollment, header, inheritedEventCount, events })
    // A second stat ensures no concurrent append slipped between the first
    // bracket and serialization. Source may still change AFTER this read;
    // publishing must compare against its own verified common baseline.
    const snapshot = JSON.parse(JSON.stringify({ header, inheritedEventCount, events, attachments: [] }))
    const candidateBytes = Buffer.from(JSON.stringify(snapshot))
    if (candidateBytes.length > MAX_BYTES || digest(candidateBytes) !== inspected.revision) throw new Error('source changed while detaching snapshot')
    const final = await persistence.stat(id)
    if (!final || final.revision !== before.revision) throw new Error('source changed during read')
    answer = { ...inspected, snapshot }
  } catch (error) {
    failure = error
    throw error
  } finally {
    try { await handle?.close?.() }
    catch (error) { if (!failure) throw error }
  }
  // Close is a lifecycle boundary: reject any mutation while it runs. This
  // remains an observation, not a lock against subsequent source appends.
  const closed = await persistence.stat(id)
  if (!closed || closed.revision !== before.revision) throw new Error('source changed while closing read handle')
  return answer
}
