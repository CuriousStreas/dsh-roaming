import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { GitRepo } from './git.js'
import { proposal, validateManifest } from './manifest.js'
import { conversationKey, digest } from './revisions.js'
import { manifestRevision } from './publisher.js'

// Experimental data-repository adapter; deliberately not exported by the plugin API.
// The repository must already be an ordinary, clean, schema-3 mirror.
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
const SHA = /^[a-f0-9]{64}$/
const MANIFEST = 'manifest.json'
const SCHEMA_FILE = 'SCHEMA_VERSION'
const OBJECTS = 'objects'
const MAX_MANIFEST_BYTES = 512 * 1024
const MAX_OBJECTS = 256
const MAX_TOTAL_OBJECT_BYTES = 32 * 1024 * 1024

// Use a file rather than piped child stdio (which is unavailable in confined
// environments). Never include Git output, arguments or URLs in errors.
function gitText(repo, args) {
  const output = path.join(path.dirname(repo.dir), `.transport-output-${process.pid}-${Math.random().toString(36).slice(2)}`)
  const fd = fs.openSync(output, 'wx', 0o600)
  try {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    // Git status may otherwise refresh and write the original mirror index.
    env.GIT_OPTIONAL_LOCKS = '0'
    execFileSync('git', args, { cwd: repo.dir, env, stdio: ['ignore', fd, 'ignore'], timeout: 60_000 })
    return fs.readFileSync(output, 'utf8').trim()
  } catch {
    throw new Error('Git repository inspection failed')
  } finally {
    fs.closeSync(fd)
    fs.rmSync(output, { force: true })
  }
}

function strictManifest(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('invalid schema-3 manifest') }
  validateManifest(value)
  if (Object.keys(value).sort().join(',') !== 'conversations,schema') throw new Error('unexpected manifest fields')
  if (Object.getPrototypeOf(value.conversations) !== Object.prototype) throw new Error('invalid conversations')
  for (const entry of Object.values(value.conversations)) {
    if (Object.keys(entry).sort().join(',') !== 'head,parent') throw new Error('unexpected conversation fields')
  }
  return value
}

function filesIn(dir) {
  const results = []
  function visit(directory, prefix) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && item.name === '.git') continue
      const relative = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isSymbolicLink()) throw new Error('unsafe data-repository symlink')
      if (item.isDirectory()) visit(path.join(directory, item.name), relative)
      else if (item.isFile()) results.push(relative)
      else throw new Error('unsafe data-repository entry')
    }
  }
  visit(dir, '')
  return results
}

// Pure local repository inspection; callers must independently establish that
// this checkout matches the fresh remote commit before treating it as preview.
export function inspectMirror(repo) {
  const paths = filesIn(repo.dir)
  if (!paths.includes(MANIFEST)) throw new Error('schema-3 manifest required; legacy repositories are unsupported')
  const schemaPath = path.join(repo.dir, SCHEMA_FILE)
  if (!paths.includes(SCHEMA_FILE) || fs.lstatSync(schemaPath).size > 16 || fs.readFileSync(schemaPath, 'utf8').trim() !== '3') throw new Error('schema-3 marker required')
  if (fs.lstatSync(path.join(repo.dir, MANIFEST)).size > MAX_MANIFEST_BYTES || paths.length > MAX_OBJECTS + 2) throw new Error('data repository exceeds limits')
  const bytes = fs.readFileSync(path.join(repo.dir, MANIFEST))
  const manifest = strictManifest(bytes)
  const objects = new Set()
  let totalObjectBytes = 0
  for (const file of paths) {
    if (file === MANIFEST || file === SCHEMA_FILE) continue
    const match = /^objects\/([a-f0-9]{64})\.bin$/.exec(file)
    if (!match) throw new Error('unexpected data-repository content')
    const objectFile = path.join(repo.dir, OBJECTS, `${match[1]}.bin`)
    const objectBytes = fs.statSync(objectFile).size
    totalObjectBytes += objectBytes
    if (objectBytes > MAX_ARTIFACT_BYTES || totalObjectBytes > MAX_TOTAL_OBJECT_BYTES) throw new Error('invalid immutable artifact')
    const object = fs.readFileSync(objectFile)
    if (digest(object) !== match[1]) throw new Error('invalid immutable artifact')
    objects.add(match[1])
  }
  for (const entry of Object.values(manifest.conversations)) {
    if (!objects.has(entry.head)) throw new Error('manifest references missing artifact')
  }
  return { manifest, bytes, manifestHead: manifestRevision(manifest), objectCount: objects.size, totalObjectBytes }
}

async function clean(repo) {
  if (gitText(repo, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('data-repository mirror is dirty')
  // An ignored file must not be silently included in an otherwise clean mirror.
  if (gitText(repo, ['ls-files', '--others', '--ignored', '--exclude-standard'])) throw new Error('data-repository mirror has ignored content')
}

// Git rewrites URLs before clone/push even when the command receives an explicit
// URL. Refuse ambiguous effective configuration (including global/includes and
// per-command -c settings), rather than trusting origin's fetch URL alone.
function rejectAmbiguousRemote(repo) {
  const lines = gitText(repo, ['config', '--includes', '--list']).split(/\r?\n/)
  const urls = lines.filter((line) => /^remote\.origin\.url=/i.test(line))
  if (urls.length !== 1 || urls[0].slice('remote.origin.url='.length) !== repo.remoteUrl ||
      lines.some((line) => /^(?:remote\.origin\.pushurl|url\..*\.(?:insteadof|pushinsteadof))=/i.test(line))) {
    throw new Error('ambiguous Git remote push destination')
  }
}

async function independentRemote(repo, branch, parent, key) {
  rejectAmbiguousRemote(repo)
  const dir = fs.mkdtempSync(path.join(parent, '.transport-remote-'))
  const clone = path.join(dir, 'snapshot')
  try {
    await repo.run(['clone', '--no-local', '--single-branch', '--branch', branch, '--', repo.remoteUrl, clone], { cwd: dir, operation: 'verify remote clone' })
    const snapshot = new GitRepo({ dir: clone, remoteUrl: repo.remoteUrl })
    await snapshot.verifyRepo()
    await clean(snapshot)
    const observed = { commit: gitText(snapshot, ['rev-parse', '--verify', 'HEAD']), ...inspectMirror(snapshot) }
    if (key !== undefined) {
      const head = observed.manifest.conversations[key]?.head
      if (!head) throw new Error('remote conversation not found')
      const objectPath = path.join(clone, OBJECTS, `${head}.bin`)
      if (fs.statSync(objectPath).size > MAX_ARTIFACT_BYTES) throw new Error('invalid immutable artifact')
      const object = fs.readFileSync(objectPath)
      if (digest(object) !== head) throw new Error('invalid immutable artifact')
      return { ...observed, head, object }
    }
    return observed
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Observe a logical key from a fresh remote clone without changing the local mirror.
 * This is evidence for reconciliation, not a publication receipt or authorization.
 */
export async function observeRemoteArtifact({ repo, key }) {
  if (!(repo instanceof GitRepo) || !repo.isRepo()) throw new Error('existing data-repository mirror required')
  conversationKey(key)
  await repo.verifyRepo()
  // Read the symbolic branch directly: gitText would create a temporary output
  // file inside the local .git directory, which an observation must not do.
  const ref = fs.readFileSync(path.join(repo.dir, '.git', 'HEAD'), 'utf8').trim()
  if (!ref.startsWith('ref: refs/heads/')) throw new Error('unsafe branch name')
  const branch = ref.slice('ref: refs/heads/'.length)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('.lock')) throw new Error('unsafe branch name')
  const remote = await independentRemote(repo, branch, path.dirname(repo.dir), key)
  return { manifest: remote.manifest, manifestHead: remote.manifestHead, head: remote.head, object: remote.object }
}

/** Recover a receipt from a fresh remote observation after an interrupted push.
 * Does not authorize publication; caller must still match the full committed
 * manifest digest to the persisted pending transaction before acknowledging.
 */
export async function verifyPublishedArtifact({ repo, key, expected, artifact }) {
  if (!(repo instanceof GitRepo) || !repo.isRepo()) throw new Error('existing data-repository mirror required')
  conversationKey(key)
  if (expected !== null && !SHA.test(expected)) throw new Error('invalid expected conversation revision')
  if (!(artifact instanceof Uint8Array) || !artifact.byteLength || artifact.byteLength > MAX_ARTIFACT_BYTES) throw new Error('artifact exceeds bounded binary payload')
  await repo.verifyRepo()
  const branch = gitText(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('.lock')) throw new Error('unsafe branch name')
  const remote = await independentRemote(repo, branch, path.dirname(repo.dir))
  const head = digest(artifact)
  const pointer = remote.manifest.conversations[key]
  if (!pointer || pointer.head !== head || pointer.parent !== expected) throw new Error('remote publication not acknowledged')
  return { remoteAccepted: true, head, manifestHead: remote.manifestHead }
}

/** Publish a single immutable artifact after a complete manifest compare-and-swap.
 * Requires { repo: GitRepo, key, expected: null|SHA256, expectedManifestHead: SHA256, artifact: Buffer|Uint8Array }.
 * A rejected or unverified push never returns an accepted receipt.
 */
export async function publishArtifact({ repo, key, expected, expectedManifestHead, artifact }) {
  if (!(repo instanceof GitRepo) || !repo.isRepo()) throw new Error('existing data-repository mirror required')
  conversationKey(key)
  if (expected !== null && !SHA.test(expected)) throw new Error('invalid expected conversation revision')
  if (!SHA.test(expectedManifestHead)) throw new Error('full expected manifest digest required')
  if (!(artifact instanceof Uint8Array) || !artifact.byteLength || artifact.byteLength > MAX_ARTIFACT_BYTES) throw new Error('artifact exceeds bounded binary payload')
  const bytes = Buffer.from(artifact)
  const next = digest(bytes)
  // The caller must provide a stable, explicitly enrolled logical key; this
  // transport never reads or writes native DSH sessions or their mappings.
  // A lock only coordinates cooperating transports; the repeated HEAD/status
  // checks and the non-forced push protect against independent writers.
  await repo.verifyRepo()
  rejectAmbiguousRemote(repo)
  const branch = gitText(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('.lock')) throw new Error('unsafe branch name')
  await clean(repo)
  const localCommit = gitText(repo, ['rev-parse', '--verify', 'HEAD'])
  const local = inspectMirror(repo)
  if (local.manifestHead !== expectedManifestHead) throw new Error('stale complete manifest')
  const change = proposal(local.manifest, key, { expected, next })
  if (!change.accepted) throw new Error(`conversation proposal rejected: ${change.reason}`)
  if (Object.keys(local.manifest.conversations).length >= MAX_OBJECTS && !local.manifest.conversations[key]) throw new Error('data repository exceeds limits')
  const objectPath = `${OBJECTS}/${next}.bin`
  const reuse = fs.existsSync(path.join(repo.dir, objectPath))
  if (reuse && (!fs.lstatSync(path.join(repo.dir, objectPath)).isFile() || digest(fs.readFileSync(path.join(repo.dir, objectPath))) !== next)) throw new Error('invalid immutable artifact')
  if (!reuse && (local.objectCount >= MAX_OBJECTS || local.totalObjectBytes + bytes.length > MAX_TOTAL_OBJECT_BYTES)) throw new Error('data repository exceeds limits')
  const parent = path.dirname(repo.dir)
  const temporary = fs.mkdtempSync(path.join(parent, '.transport-stage-'))
  const clone = path.join(temporary, 'snapshot')
  try {
    // A fresh clone is an independent read of the configured remote, not a
    // copy of the local mirror or its potentially stale index/objects.
    rejectAmbiguousRemote(repo)
    await repo.run(['clone', '--no-local', '--single-branch', '--branch', branch, '--', repo.remoteUrl, clone], { cwd: temporary, operation: 'verify remote clone' })
    const stage = new GitRepo({ dir: clone, remoteUrl: repo.remoteUrl })
    await stage.verifyRepo()
    await clean(stage)
    const remote = { commit: gitText(stage, ['rev-parse', '--verify', 'HEAD']), ...inspectMirror(stage) }
    if (remote.commit !== localCommit || remote.manifestHead !== local.manifestHead) throw new Error('remote and mirror diverged')
    if (gitText(repo, ['rev-parse', '--verify', 'HEAD']) !== localCommit) throw new Error('mirror HEAD changed')
    await clean(repo)
    if (inspectMirror(repo).manifestHead !== local.manifestHead) throw new Error('manifest changed before stage')
    if (reuse) {
      if (!fs.existsSync(path.join(clone, objectPath)) || digest(fs.readFileSync(path.join(clone, objectPath))) !== next) throw new Error('remote immutable artifact changed')
    } else {
      if (fs.existsSync(path.join(clone, objectPath))) throw new Error('remote immutable artifact changed')
      fs.mkdirSync(path.join(clone, OBJECTS), { recursive: true })
      fs.writeFileSync(path.join(clone, objectPath), bytes, { flag: 'wx' })
    }
    const newBytes = Buffer.from(`${JSON.stringify(change.manifest)}\n`)
    if (newBytes.length > MAX_MANIFEST_BYTES) throw new Error('data repository exceeds limits')
    fs.writeFileSync(path.join(clone, MANIFEST), newBytes)
    await stage.run(['add', '--', MANIFEST, ...(!reuse ? [objectPath] : [])], { operation: 'stage data transaction' })
    const staged = gitText(stage, ['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean).sort()
    if (staged.join('\n') !== [MANIFEST, ...(!reuse ? [objectPath] : [])].sort().join('\n')) throw new Error('unexpected staged changes')
    await stage.run(['-c', 'user.name=dsh-roaming', '-c', 'user.email=dsh-roaming@localhost', '-c', `core.hooksPath=${path.join(clone, '.git', 'transport-no-hooks')}`, 'commit', '-m', 'Publish immutable conversation artifact'], { operation: 'commit data transaction' })
    const publishedCommit = gitText(stage, ['rev-parse', '--verify', 'HEAD'])
    rejectAmbiguousRemote(repo)
    // Explicit URL avoids remote.origin.pushurl and named-remote push routing.
    await stage.run(['push', '--', repo.remoteUrl, `HEAD:refs/heads/${branch}`], { operation: 'push data transaction' })
    const verified = await independentRemote(repo, branch, parent)
    if (verified.commit !== publishedCommit || verified.manifestHead !== manifestRevision(change.manifest) || JSON.stringify(verified.manifest) !== JSON.stringify(change.manifest) || verified.manifest.conversations[key]?.head !== next || verified.manifest.conversations[key]?.parent !== expected) throw new Error('remote transaction could not be verified')
    return { remoteAccepted: true, head: next, manifestHead: verified.manifestHead }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
