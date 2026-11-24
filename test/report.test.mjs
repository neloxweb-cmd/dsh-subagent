import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runCli } from '../lib/cli.js'
import { generateBugReport, redactSecrets } from '../lib/reporter.js'

test('reporter: redactSecrets strips tokens, API keys, passwords, and usernames', () => {
  const dirty = [
    'Path: C:\\Users\\Alice\\AppData\\Local\\dsh.cmd',
    'Mac: /Users/Bob/bin/ds-subagent',
    'Auth: Authorization: Bearer super_secret_bearer_token_1234567890',
    'OpenAI: sk-live_abcdefghijklmnop123456',
    'GitHub: gho_1234567890abcdefghij',
    'JSON: {"token": "abcdef1234567890abcdef", "password": "myPassword123"}',
    'Bridge: EXACT_BRIDGE_TOKEN_99887766',
  ].join('\n')

  const clean = redactSecrets(dirty, {
    extraSecrets: ['EXACT_BRIDGE_TOKEN_99887766'],
    homePath: 'C:\\Users\\Alice',
  })

  assert.doesNotMatch(clean, /Alice/)
  assert.doesNotMatch(clean, /Bob/)
  assert.doesNotMatch(clean, /super_secret_bearer_token/)
  assert.doesNotMatch(clean, /sk-live_/)
  assert.doesNotMatch(clean, /gho_1234/)
  assert.doesNotMatch(clean, /abcdef1234567890/)
  assert.doesNotMatch(clean, /myPassword123/)
  assert.doesNotMatch(clean, /EXACT_BRIDGE_TOKEN_99887766/)
})

test('reporter: ds-subagent report creates safe bug-report.txt with daemon tail', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subagent-report-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  await writeFile(
    join(home, 'daemon.log'),
    'line1 ok\nError: Bearer secret_token_xyz12345 failed at C:\\Users\\Someone\\file.js\n',
    'utf8',
  )

  let stdout = ''
  let stderr = ''
  const code = await runCli(['report'], {
    env: { DSH_SUBAGENT_HOME: home, DSH_HOME: join(home, 'dsh') },
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
  })
  assert.equal(code, 0)
  assert.match(stdout, /=== dsh-subagent diagnostic report ===/)
  assert.match(stdout, /line1 ok/)
  assert.doesNotMatch(stdout, /secret_token_xyz12345/)
  assert.doesNotMatch(stdout, /Someone/)

  const saved = await readFile(join(home, 'bug-report.txt'), 'utf8')
  assert.equal(saved, stdout)
})

test('reporter: generateBugReport handles missing files gracefully', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subagent-empty-'))
  t.after(() => rm(home, { recursive: true, force: true }))

  const res = generateBugReport({
    home,
    dshHome: join(home, 'missing-dsh'),
    dshBin: null,
    probe: { ok: false, disc: { url: 'http://127.0.0.1:45720', token: '' }, error: 'offline' },
  })
  assert.match(res.text, /dsh binary:\s+NOT FOUND/)
  assert.match(res.text, /bridge:\s+DOWN/)
  assert.match(res.text, /\(no daemon\.log\)/)
})
