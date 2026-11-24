import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBridge } from '../lib/bridge.js'
import { estimateCostEur, runCli } from '../lib/cli.js'
import { buildPackageBundle } from '../lib/hosts.js'
import { captureWorkspaceSnapshot, computeWorkspaceChanges } from '../lib/index.js'
import { EXIT_CODES } from '../lib/protocol.js'
import { redactSecrets } from '../lib/reporter.js'
import { createStore } from '../lib/store.js'
import { checkToolPolicy, normalizeTodos, validateReadonlyAllowCommands, watchAgentTurn } from '../lib/watcher.js'

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
  assert.match(checkToolPolicy(ro, 'bash', { command: 'rm -rf /' }) ?? '', /forbidden/)
  assert.match(checkToolPolicy(ro, 'bash', { command: 'cat /etc/hosts' }) ?? '', /not in allowlist/)
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

test('v2.1 readonly allowlist blocks ssh/scp/rsync/shells/mutating subcommands and allows safe reads', () => {
  for (const bad of [
    'ssh user@prod',
    'scp a b',
    'rsync -av a b',
    'sftp prod',
    'bash -c ls',
    'pwsh -Command ls',
    'node -e 1',
    'python -c 1',
    'curl https://example.com',
    'git push origin main',
    'docker exec -it app sh',
    'systemctl restart nginx',
    'ls && rm -rf /',
  ]) {
    const err = validateReadonlyAllowCommands([bad])
    assert.ok(err, `expected "${bad}" to be rejected in readonly mode`)
  }
  assert.match(validateReadonlyAllowCommands(['ssh prod']) ?? '', /--host/)

  for (const ok of ['git status', 'git log', 'ls', 'rg', 'systemctl status nginx', 'docker ps']) {
    assert.equal(validateReadonlyAllowCommands([ok]), null, `expected "${ok}" to be allowed`)
  }
})

test('v2.1 redaction: strips Amazon refresh/LWA/client tokens and generic .env KEY/SECRET/TOKEN lines', () => {
  const fakePayload = [
    'REFRESH_TOKEN=Atzr|IwEBIA_FAKE_AMAZON_REFRESH_TOKEN_1234567890ABCDEF',
    'LWA_SECRET=amzn1.oa2-cs.v1.a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
    'LWA_CLIENT=amzn1.application-oa2-client.00112233445566778899aabbccddeeff',
    'export MY_CUSTOM_SECRET=SuperFakeEnvSecretValue99',
    'SP_API_KEY="AnotherFakeKeyValue12345"',
    'NORMAL_LINE=hello_world',
  ].join('\n')

  const clean = redactSecrets(fakePayload, { redactPaths: false })
  assert.doesNotMatch(clean, /IwEBIA_FAKE_AMAZON_REFRESH_TOKEN/)
  assert.doesNotMatch(clean, /a1b2c3d4e5f6a1b2c3d4e5f6/)
  assert.doesNotMatch(clean, /00112233445566778899aabbccddeeff/)
  assert.doesNotMatch(clean, /SuperFakeEnvSecretValue99/)
  assert.doesNotMatch(clean, /AnotherFakeKeyValue12345/)
  assert.match(clean, /NORMAL_LINE=hello_world/)
})

test('v2.1 bridge + CLI: blocks --allow-cmd ssh upfront, blocks mode switch on existing session, shows EUR cost & remote non-git CHANGED_FILES', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subagent-v21-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const store = createStore({ home })
  await store.init()
  const receivedCwds = []
  const host = {
    listDshSessions: () => [],
    describeRoute: () => ({ provider: 'mistral', model: 'deepseek-v4-1-flash-1017' }),
    runTurn: async (input) => {
      receivedCwds.push(input.cwd)
      return {
        status: 'done',
        text: 'All done on server.',
        sessionId: 'dsh-s1',
        gitChanges: {
          mode: 'fs',
          isGitRepo: false,
          dirtyTotal: 1,
          changedThisTurn: [{ path: 'config.yml', status: 'M' }],
          diffStat: '',
        },
        stats: {
          elapsedMs: 1200,
          steps: 2,
          toolCalls: 3,
          lastTool: 'edit',
          usage: { inputTokens: 12000, cacheReadTokens: 4000, outputTokens: 1500 },
          todos: [],
          recentEvents: [],
        },
      }
    },
  }

  const bridge = createBridge({
    store,
    host,
    config: { host: '127.0.0.1', port: 0, token: 'test-token-v21-0123456789abcdef' },
  })
  const url = await bridge.listen()
  t.after(() => bridge.close())

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

  // 1. --readonly --allow-cmd ssh must be rejected upfront
  const badSsh = await run([
    'start',
    'badssh',
    '--url',
    url,
    '--token',
    'test-token-v21-0123456789abcdef',
    '--readonly',
    '--allow-cmd',
    'ssh',
    'check server',
  ])
  assert.notEqual(badSsh.code, EXIT_CODES.OK)
  assert.match(badSsh.stderr, /forbidden in --readonly/)

  // 2. Remote --cwd /srv/app must stay POSIX verbatim, and output must show EUR cost + CHANGED_FILES (fs)
  const okRun = await run([
    'start',
    'srvjob',
    '--url',
    url,
    '--token',
    'test-token-v21-0123456789abcdef',
    '--cwd',
    '/srv/app',
    'update config',
  ])
  assert.equal(okRun.code, EXIT_CODES.OK)
  assert.equal(receivedCwds[0], '/srv/app')
  assert.match(okRun.stdout, /~€/)
  assert.match(okRun.stdout, /CHANGED_FILES \(fs\): M config\.yml/)

  // 3. Status later also shows EUR cost and CHANGED_FILES (fs)
  const st = await run(['status', 'srvjob', '--url', url, '--token', 'test-token-v21-0123456789abcdef'])
  assert.equal(st.code, EXIT_CODES.OK)
  assert.match(st.stdout, /~€/)
  assert.match(st.stdout, /CHANGED_FILES \(fs\): M config\.yml/)

  // 4. Attempting to resume a full-mode session with --readonly must fail (409 conflict)
  const modeSwitch = await run([
    'send',
    'srvjob',
    '--url',
    url,
    '--token',
    'test-token-v21-0123456789abcdef',
    '--readonly',
    'check again',
  ])
  assert.notEqual(modeSwitch.code, EXIT_CODES.OK)
  assert.match(modeSwitch.stderr, /cannot change safety mode/)
})

test('v2.1 estimateCostEur and buildPackageBundle work as expected', () => {
  const eur = estimateCostEur({ inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000 })
  assert.ok(eur > 0.9 && eur < 1.0, `unexpected EUR estimate: ${eur}`)

  const bundle = buildPackageBundle()
  assert.ok(bundle['package.json'])
  assert.ok(bundle['lib/index.js'])
  assert.ok(bundle['lib/bridge.js'])
  assert.ok(bundle['lib/watcher.js'])
  assert.ok(bundle['bin/ds-subagent.mjs'])
})
