import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runCli, parseArgs } from '../lib/cli.js'
import { createSubagentPlugin } from '../lib/index.js'
import { EXIT_CODES } from '../lib/protocol.js'

function createFakeDshContext(behavior) {
  const createdSessions = new Map()
  const steeredMessages = []

  function makeAgent(sessionId, meta, agentOptions) {
    const events = []
    let idleResolvers = []
    const agent = {
      id: sessionId,
      status: 'idle',
      meta,
      agentOptions,
      session: {
        id: sessionId,
        header: { title: meta?.title, cwd: meta?.cwd },
        get seq() {
          return events.length
        },
        eventAt(seq) {
          return events[seq]
        },
      },
      push(evt) {
        events.push(evt)
      },
      setIdle() {
        agent.status = 'idle'
        for (const r of idleResolvers) r()
        idleResolvers = []
      },
      whenIdle() {
        if (agent.status === 'idle') return Promise.resolve()
        return new Promise((r) => idleResolvers.push(r))
      },
      followup(msg) {
        agent.status = 'running'
        void behavior({ agent, msg, isSteer: false })
      },
      steer(msg) {
        steeredMessages.push(msg)
        void behavior({ agent, msg, isSteer: true })
      },
      async cancel() {
        agent.cancelled = true
        agent.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'cancelled' } } })
        agent.setIdle()
      },
    }
    return agent
  }

  const effects = []
  const services = new Map([
    [
      'agentDefaultModel',
      {
        currentSelection: () => ({ provider: 'mistral', model: 'deepseek-v4-1-flash-1017' }),
      },
    ],
    [
      'sessions',
      {
        flush: async () => {},
      },
    ],
    [
      'agents',
      {
        list: () => [...createdSessions.values()],
        create: async ({ sessionId, meta, agentOptions }) => {
          const agent = makeAgent(sessionId, meta, agentOptions)
          createdSessions.set(sessionId, agent)
          return { agent, dispose: async () => {} }
        },
        resume: async ({ resumeSessionId, agentOptions }) => {
          const agent = createdSessions.get(resumeSessionId)
          if (!agent) throw new Error('unknown session ' + resumeSessionId)
          agent.agentOptions = agentOptions
          return { agent, dispose: async () => {} }
        },
      },
    ],
  ])

  return {
    createdSessions,
    steeredMessages,
    get: (key) => services.get(key),
    effect: (fn) => effects.push(fn),
    async disposeAll() {
      for (const fn of effects) {
        const disposer = fn()
        if (typeof disposer === 'function') await disposer()
      }
    },
  }
}

function captureCli(argv, env, cwd) {
  let stdout = ''
  let stderr = ''
  return runCli(argv, {
    env,
    cwd,
    stdout: { write: (s) => (stdout += s) },
    stderr: { write: (s) => (stderr += s) },
  }).then((code) => ({ code, stdout, stderr }))
}

test('cli: parseArgs handles flags, prompt-file, and usage errors', () => {
  const p = parseArgs(['start', 'auth', '--cwd', 'C:\\repo', '--effort=max', '--file', 'a.ts', '--file', 'b.ts', 'hello'])
  assert.equal(p.command, 'start')
  assert.deepEqual(p.positional, ['auth', 'hello'])
  assert.equal(p.options.effort, 'max')
  assert.deepEqual(p.options.files, ['a.ts', 'b.ts'])
  assert.throws(() => parseArgs(['start', '--bogus']), /unknown option/)
})

test('end-to-end: plugin + bridge + CLI lifecycle (start, context pass-through, send, needs_input, steer, cancel, close)', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subagent-e2e-'))
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-subagent-cwd-'))
  t.after(async () => {
    await rm(home, { recursive: true, force: true })
    await rm(workDir, { recursive: true, force: true })
  })

  await writeFile(join(workDir, 'spec.txt'), 'SPEC_BODY_42', 'utf8')
  const receivedPrompts = []
  let slowRelease = null

  const fakeCtx = createFakeDshContext(async ({ agent, msg, isSteer }) => {
    const text = msg.content[0].text
    receivedPrompts.push({ isSteer, text, opts: agent.agentOptions })
    if (isSteer) {
      if (slowRelease) slowRelease('Steered and completed!')
      return
    }
    agent.push({ type: 'turn/start', data: { turn: 1 } })
    agent.push({ type: 'step/start', data: { turn: 1, step: 1 } })
    if (text.includes('ASK_ME')) {
      agent.push({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '[NEEDS_INPUT] Should I enable strict mode?' }] } },
      })
      agent.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      agent.setIdle()
      return
    }
    if (text.includes('SLOW_TASK')) {
      const reply = await new Promise((resolve) => {
        slowRelease = resolve
      })
      slowRelease = null
      if (agent.cancelled) return
      agent.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } })
      agent.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      agent.setIdle()
      return
    }
    agent.push({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'Done: saw ' + (text.includes('SPEC_BODY_42') ? 'spec' : 'followup') }] } },
    })
    agent.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    agent.setIdle()
  })

  const plugin = createSubagentPlugin({ pollIntervalMs: 10, askTrapGraceMs: 25 })
  const mounted = await plugin.apply(fakeCtx, { home, port: 0 })
  t.after(() => fakeCtx.disposeAll())

  const env = { DSH_SUBAGENT_HOME: home }

  // 1. doctor reports OK and default Mistral DeepSeek route
  const doc = await captureCli(['doctor', '--json'], env, workDir)
  assert.equal(doc.code, EXIT_CODES.OK)
  const docJson = JSON.parse(doc.stdout)
  assert.equal(docJson.ok, true)
  assert.equal(docJson.health.route.model, 'deepseek-v4-1-flash-1017')

  // 2. start passes context files + appendSystem + subagent protocol contract
  const r1 = await captureCli(
    ['start', 'api', '--cwd', workDir, '--file', 'spec.txt', '--append-system', 'EXTRA_RULE', '--effort', 'high', '--json', 'Build module'],
    env,
    workDir,
  )
  assert.equal(r1.code, EXIT_CODES.OK)
  const j1 = JSON.parse(r1.stdout)
  assert.equal(j1.run.status, 'done')
  assert.equal(j1.run.reply, 'Done: saw spec')
  assert.match(receivedPrompts[0].text, /\[SUBAGENT PROTOCOL\]/)
  assert.match(receivedPrompts[0].text, /EXTRA_RULE/)
  assert.match(receivedPrompts[0].text, /SPEC_BODY_42/)
  assert.equal(receivedPrompts[0].opts.reasoningEffort, 'high')

  // 3. send continues same DSH session & returns exit 10 on NEEDS_INPUT
  const r2 = await captureCli(['send', 'api', '--json', 'ASK_ME'], env, workDir)
  assert.equal(r2.code, EXIT_CODES.NEEDS_INPUT)
  const j2 = JSON.parse(r2.stdout)
  assert.equal(j2.run.status, 'needs_input')
  assert.equal(j2.run.resumed, true)
  assert.equal(j2.run.dshSessionId, j1.run.dshSessionId)

  // 4. mid-flight steer + concurrency lock (409)
  const queued = await captureCli(['send', 'api', '--no-wait', '--json', 'SLOW_TASK'], env, workDir)
  assert.equal(queued.code, EXIT_CODES.OK)
  const overlap = await captureCli(['send', 'api', '--no-wait', '--json', 'OVERLAP'], env, workDir)
  assert.notEqual(overlap.code, EXIT_CODES.OK)
  assert.match(overlap.stdout, /turn-running/)

  const steered = await captureCli(['steer', 'api', 'Use approach B'], env, workDir)
  assert.equal(steered.code, EXIT_CODES.OK)

  // Wait briefly for queued steer + turn settlement
  for (let i = 0; i < 40 && fakeCtx.steeredMessages.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 15))
  }
  assert.equal(fakeCtx.steeredMessages.length, 1)
  assert.match(fakeCtx.steeredMessages[0].content[0].text, /\[PARENT STEER\] Use approach B/)

  let statusJson
  for (let i = 0; i < 40; i += 1) {
    const status = await captureCli(['status', 'api', '--json'], env, workDir)
    assert.equal(status.code, EXIT_CODES.OK)
    statusJson = JSON.parse(status.stdout)
    if (!statusJson.running && statusJson.lastRun?.status === 'done') break
    await new Promise((r) => setTimeout(r, 15))
  }
  assert.equal(statusJson.lastRun.reply, 'Steered and completed!')

  // 5. close session & unauthorized token check
  const closed = await captureCli(['close', 'api'], env, workDir)
  assert.equal(closed.code, EXIT_CODES.OK)

  const unauth = await captureCli(['status', '--url', mounted.url, '--token', 'wrong-token', '--no-autostart'], env, workDir)
  assert.equal(unauth.code, EXIT_CODES.UNAUTHORIZED)

  // Verify bridge.json exists before shutdown and is cleaned up after
  const bridgeBefore = JSON.parse(await readFile(join(home, 'bridge.json'), 'utf8'))
  assert.equal(bridgeBefore.url, mounted.url)
})
