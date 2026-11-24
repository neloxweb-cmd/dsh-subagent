import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runCli } from '../lib/cli.js'
import { captureWorkspaceSnapshot, computeWorkspaceChanges } from '../lib/index.js'
import { EXIT_CODES } from '../lib/protocol.js'
import { redactSecrets } from '../lib/reporter.js'
import { checkToolPolicy, normalizeTodos, watchAgentTurn } from '../lib/watcher.js'

test('v2 safety: checkToolPolicy enforces readonly, allowlist, chaining guard, and workspace boundary', () => {
  // readonly blocks write tools
  assert.match(checkToolPolicy({ mode: 'readonly' }, 'edit_file', { path: 'a.js' }) ?? '', /readonly/)
  assert.equal(checkToolPolicy({ mode: 'readonly' }, 'read_file', { path: 'a.js' }), null)

  // readonly blocks shell without allowlist
  assert.match(checkToolPolicy({ mode: 'readonly', allowCommands: [] }, 'bash', { command: 'ls' }) ?? '', /disabled/)

  // readonly allows whitelisted prefix, blocks non-whitelisted and shell chaining
  const ro = { mode: 'readonly', allowCommands: ['git status', 'ls'] }
  assert.equal(checkToolPolicy(ro, 'bash', { command: 'git status' }), null)
  assert.equal(checkToolPolicy(ro, 'bash', { command: 'ls -la' }), null)
  assert.match(checkToolPolicy(ro, 'bash', { command: 'rm -rf /' }) ?? '', /not in allowlist/)
  assert.match(checkToolPolicy(ro, 'bash', { command: 'git status && rm -rf /' }) ?? '', /chaining/)
  assert.match(checkToolPolicy(ro, 'bash', { command: 'ls > out.txt' }) ?? '', /chaining/)

  // workspace blocks writes outside cwd
  const ws = { mode: 'workspace', cwd: 'C:\\repo\\app' }
  assert.equal(checkToolPolicy(ws, 'write_file', { path: 'src/index.js' }), null)
  assert.match(checkToolPolicy(ws, 'write_file', { path: '..\\other\\evil.js' }) ?? '', /outside workspace/)
})

test('v2 watcher: tracks live todo/write checklist and immediately cancels on readonly violation', async () => {
  const events = []
  const agent = {
    status: 'running',
    cancelled: false,
    session: {
      id: 'session-v2',
      get seq() {
        return events.length
      },
      eventAt: (i) => events[i],
    },
    whenIdle: () => Promise.resolve(),
    cancel: async () => {
      agent.cancelled = true
      agent.status = 'idle'
    },
  }

  events.push({ type: 'turn/start', data: { turn: 1 } })
  events.push({
    type: 'todo/write',
    data: {
      todos: [
        { content: 'Inspect config', status: 'completed' },
        { content: 'Check logs', status: 'in_progress' },
      ],
    },
  })
  events.push({ type: 'tool/call', data: { callId: 'w1', name: 'write_file', arguments: '{"path":"prod.env"}' } })

  const res = await watchAgentTurn({ agent, firstSeq: 0, mode: 'readonly', pollIntervalMs: 10 })
  assert.equal(res.status, 'blocked_policy')
  assert.equal(agent.cancelled, true)
  assert.equal(res.stats.todos.length, 2)
  assert.equal(res.stats.todos[0].status, 'completed')
  assert.equal(res.stats.todos[1].status, 'in_progress')
})

test('v2 redaction: strips PEM keys, DB URLs, JWTs while preserving paths when redactPaths:false', () => {
  const raw = [
    'File: C:\\Users\\Alice\\repo\\app.js',
    'DB: postgresql://admin:SuperSecret99@db.internal:5432/prod',
    'JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF1234567890',
    'Key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  ].join('\n')

  const clean = redactSecrets(raw, { redactPaths: false })
  assert.match(clean, /C:\\Users\\Alice\\repo\\app\.js/)
  assert.doesNotMatch(clean, /SuperSecret99/)
  assert.doesNotMatch(clean, /eyJhbGciOiJIUzI1NiJ9/)
  assert.doesNotMatch(clean, /MIIEowIBAAKCAQEA/)
})

test('v2 non-git changes: detects added, modified, and deleted files without git', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-subagent-nongit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  await writeFile(join(dir, 'keep.txt'), 'v1', 'utf8')
  await writeFile(join(dir, 'remove.txt'), 'bye', 'utf8')

  const before = await captureWorkspaceSnapshot(dir)
  assert.equal(before.mode, 'fs')

  await writeFile(join(dir, 'keep.txt'), 'version 2 updated content', 'utf8')
  await writeFile(join(dir, 'added.txt'), 'hello', 'utf8')
  await rm(join(dir, 'remove.txt'))

  const diff = await computeWorkspaceChanges(dir, before)
  assert.equal(diff.mode, 'fs')
  assert.equal(diff.isGitRepo, false)
  const byPath = new Map(diff.changedThisTurn.map((c) => [c.path, c.status]))
  assert.equal(byPath.get('added.txt'), 'A')
  assert.equal(byPath.get('keep.txt'), 'M')
  assert.equal(byPath.get('remove.txt'), 'D')
})

test('v2 hosts CLI: add, list, and remove remote hosts cleanly', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subagent-hosts-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const run = async (argv) => {
    let stdout = ''
    let stderr = ''
    const code = await runCli(argv, {
      env: { DSH_SUBAGENT_HOME: home },
      stdout: { write: (s) => (stdout += s) },
      stderr: { write: (s) => (stderr += s) },
    })
    return { code, stdout, stderr }
  }

  const added = await run(['host', 'add', 'prod', '--url', 'http://100.64.0.10:45720', '--token', 'tok_123456', '--json'])
  assert.equal(added.code, EXIT_CODES.OK)
  assert.equal(JSON.parse(added.stdout).alias, 'prod')

  const listed = await run(['host', 'list', '--json'])
  assert.equal(listed.code, EXIT_CODES.OK)
  assert.equal(JSON.parse(listed.stdout).hosts.length, 1)

  const removed = await run(['host', 'remove', 'prod', '--json'])
  assert.equal(removed.code, EXIT_CODES.OK)
})

test('v2 normalizeTodos handles varied DSH todo shapes', () => {
  const out = normalizeTodos([
    { title: 'Step 1', completed: true },
    { content: 'Step 2', status: 'running' },
    { text: 'Step 3', status: 'pending' },
  ])
  assert.deepEqual(
    out.map((x) => x.status),
    ['completed', 'in_progress', 'pending'],
  )
})
