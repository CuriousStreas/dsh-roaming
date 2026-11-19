# Portable memory repository, version 1

This is an independent data format, not a plugin database or a DSH schema. Any consumer (including a future Codex adapter) can read and write it without loading this plugin. No UI, Git, profile lookup, or application-specific interpretation is part of the format.

## Logical document

```json
{
  "format": "portable-memory",
  "version": 1,
  "machines": {
    "machine-a": { "fingerprint": "synthetic-fingerprint", "name": "Example laptop", "config": {} }
  },
  "conversations": {
    "conversation-a": {
      "key": "conversation-a",
      "machineId": "machine-a",
      "title": "Example conversation",
      "format": "example-native-v1",
      "data": { "opaque": "native JSON payload" }
    }
  },
  "memories": {
    "example-memory": { "text": "A global memory" }
  }
}
```

- The three collections are maps keyed by opaque strings. Keys are identifiers, not filesystem paths.
- Machines are generic JSON records: fingerprints, names, configurations, and other consumer-defined fields are stored without interpretation.
- Conversations have string `key`, `machineId`, `title`, and `format` fields plus JSON `data`. `key` equals the collection key. `machineId` identifies the origin machine; consumers need not have that machine record locally. `format` identifies the producer's native payload format. The repository does not translate, normalize, or inspect `data`. Additional conversation fields are preserved.
- Memories are global, independent of any machine, and may contain any ordinary JSON value, including `null`, arrays, strings, and records.
- Values must be ordinary JSON: finite numbers, strings, booleans, null, dense arrays, and plain records. No undefined, cycles, dates, buffers, functions, or other runtime-native values. Producers needing binary data must define a JSON encoding inside their opaque payload.
- Top-level fields are the five shown above; extension data belongs inside records/payloads. Unknown top-level fields are not carried through repository reads or reconciliation.

## On-disk representation

```text
memory-repository.json
objects/<revision>.json.zst
```

The UTF-8 index has the same `format`, `version`, and three collection names. Machines remain inline. Each conversation and memory value is replaced with `{ "revision": "<64 lowercase hex characters>" }`. Each referenced object is one Zstandard-compressed UTF-8 JSON value, not an archive or an application-native database.

A revision is lowercase SHA-256 of canonical JSON encoded as UTF-8. Canonicalization recursively sorts record keys lexicographically by UTF-16 code units, emits compact JSON with no trailing newline, keeps array order, and uses ECMAScript `JSON.stringify` string escaping and finite-number serialization (`-0` becomes `0`). It does not normalize Unicode. Keys, metadata, and payload all contribute to the revision; compression settings do not. Other implementations must reproduce these canonical bytes.

Objects are immutable and shared by content. Readers verify the decompressed value's revision. Writers create missing objects before replacing the index, retain existing objects, preserve unrelated files, and never garbage-collect. A missing index denotes an empty repository only when the directory is absent, empty, or contains only `.git`. If any other entry exists without the index, reading fails with an actionable `legacy format requires explicit migration` error rather than hiding existing data. A malformed index or missing/corrupt referenced object is also an error. This format performs no automatic migration or interpretation of legacy files.

## JavaScript API

Import directly from `./lib/portable-memory.js`. The module uses only Node built-ins; native Zstandard support in `node:zlib` is required (Node 22.15+ or a newer supported release).

```js
const document = emptyMemory();
const revision = contentRevision({ b: 2, a: 1 });
await writeMemoryRepository(directory, document); // resolves with no value
const loaded = await readMemoryRepository(directory);
const { document: merged, conflicts } = reconcileMemory({ base, local, remote });
```

`emptyMemory()` returns fresh empty maps. Reads and writes are asynchronous; revision calculation and reconciliation are synchronous. There are no imports of plugin or DSH modules. The module is not added to package export maps by this change.

### Three-way reconciliation

Supply the common ancestor as `base`, or `emptyMemory()` when none exists. Each collection entry is compared as a whole using exact canonical content, not field-level merging, timestamps, titles, machine preference, or payload interpretation. A missing entry means deletion and differs from JSON `null`.

1. Equal local/remote values are kept once.
2. If either side equals the base, the other side wins, including deletion.
3. Otherwise the local entry stays at its original key, and the remote entry is preserved at a deterministic copy key: `<original>~remote-<remote-revision>`.

Conversation copies have their `key` rewritten to the copy key and `conflictOf` set to the original key; their native `data` is untouched. Machine and memory copies retain their exact generic values, without injecting metadata. Conflicts are `{ kind, key, copyKey }`, where `kind` is `machines`, `conversations`, or `memories`.

An identical existing copy is reused. If a copy key already holds different content, deterministic numeric suffixes (`~1`, `~2`, …) avoid overwriting it. Repeating the same reconciliation with its prior result as local does not create duplicate copies. The original conflict may still be reported until the caller advances the baseline or explicitly resolves it.

For change-versus-deletion conflicts, a local deletion leaves the original absent and preserves the changed remote entry as a copy. A remote deletion has no value to copy: the changed local entry is retained and the conflict reports `copyKey: null`. No tombstone object is invented. Inputs are not mutated.

## Boundaries

This is a minimal single-writer storage API, not a synchronization transport. Callers own baseline persistence, locking, conflict resolution, object retention policy, and consumer-specific interpretation. Index replacement is not crash-atomic; concurrent writes require external coordination. Existing object files are trusted as immutable by writers, while readers detect corruption. Do not place secrets in a repository unless its storage and sharing policy permits them.
