import { inspectMirror } from './transport.js'

// Read-only v3 data view. Git acquisition and freshness checks are the
// caller's responsibility; this layer never opens native DSH persistence.
export function previewV3Mirror(repo) {
  const inspected = inspectMirror(repo)
  const sessions = Object.entries(inspected.manifest.conversations)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => ({ key, revision: entry.head, parent: entry.parent }))
  return { sessions, manifestHead: inspected.manifestHead, objectCount: inspected.objectCount }
}
