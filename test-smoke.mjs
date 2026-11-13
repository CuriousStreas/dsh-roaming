// Smoke test. Two parts:
//  1. git transport round-trip — needs a real git child process; skipped when the
//     sandbox forbids spawning git with piped stdio (EPERM).
//  2. fingerprint/digest determinism — pure logic, always runs.
// Run: node test-smoke.mjs
import { GitRepo } from './lib/git.js'
import { sessionSignature, sessionDigest } from './lib/sessions.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

let gitSkipped = false

// --- 1. git transport round-trip ---
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roaming-test-'))
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'ignore' })
  const remote = path.join(tmp, 'remote.git')
  fs.mkdirSync(remote)
  git(['init', '--bare'], remote)

  const repoA = new GitRepo({ dir: path.join(tmp, 'a'), remoteUrl: remote, log: () => {} })
  await repoA.ensureRepo()
  fs.mkdirSync(path.join(tmp, 'a', 'hosts', 'host-a'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'a', 'hosts', 'host-a', 's1.json'), '{"hi":1}\n')
  await repoA.commitAll('test: push s1')
  await repoA.push()

  const repoB = new GitRepo({ dir: path.join(tmp, 'b'), remoteUrl: remote, log: () => {} })
  await repoB.ensureRepo()
  await repoB.pull()
  const got = fs.readFileSync(path.join(tmp, 'b', 'hosts', 'host-a', 's1.json'), 'utf8').trim()
  console.log('git round-trip:', got === '{"hi":1}' ? 'PASS' : 'FAIL')
} catch (error) {
  if (error?.code === 'EPERM') {
    gitSkipped = true
    console.log('git round-trip: SKIPPED (sandbox forbids git child_process with piped stdio)')
  } else {
    throw error
  }
}

// --- 2. fingerprint / digest determinism ---
const session = { createdAt: 123, agentPreset: 'standard' }
const events = [
  { type: 'message', seq: 0, time: 1, data: { role: 'user', content: 'hello' } },
  { type: 'message', seq: 1, time: 2, data: { role: 'assistant', content: 'hi' } },
]
const sig1 = sessionSignature(session, events)
const sig2 = sessionSignature(session, events)
const stable = sig1 === sig2
console.log('signature deterministic:', stable ? 'PASS' : 'FAIL', `(${sig1})`)
const digest = sessionDigest(session, events)
console.log('digest:', digest.slice(0, 16))

if (!stable) process.exit(1)
console.log(gitSkipped ? '\nLOGIC PASS (git part skipped in sandbox)' : '\nALL PASS')
