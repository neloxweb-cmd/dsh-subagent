import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyAssistantOutput, formatInteractiveQuestion, watchAgentTurn } from '../lib/watcher.js'

function makeFakeAgent() {
  const events = []
  let idleResolvers = []
  const agent = {
    status: 'running',
    cancelled: false,
    session: {
      id: 'session-fake-1',
      get seq() {
        return events.length
      },
      eventAt(seq) {
        return events[seq]
      },
    },
    push(event) {
      events.push(event)
    },
    setIdle() {
      agent.status = 'idle'
      for (const r of idleResolvers) r()
      idleResolvers = []
    },
    whenIdle() {
      if (agent.status === 'idle') return Promise.resolve()
      return new Promise((resolve) => idleResolvers.push(resolve))
    },
    async cancel() {
      agent.cancelled = true
      agent.setIdle()
    },
  }
  return agent
}

test('watcher: completed turn collects text, tool calls, steps, and usage', async () => {
  const agent = makeFakeAgent()
  agent.push({ type: 'turn/start', data: { turn: 1 } })
  agent.push({ type: 'step/start', data: { turn: 1, step: 1 } })
  agent.push({ type: 'tool/call', data: { callId: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' } })
  agent.push({ type: 'tool/result', data: { callId: 'c1', message: { content: [{ type: 'text', text: 'ok' }] } } })
  agent.push({
    type: 'assistant/message',
    data: {
      message: { content: [{ type: 'text', text: 'Refactored a.ts and tests pass.' }] },
      usage: { input: 1000, output: 200, cacheRead: 800 },
    },
  })
  agent.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  agent.setIdle()

  const res = await watchAgentTurn({ agent, firstSeq: 0, pollIntervalMs: 10 })
  assert.equal(res.status, 'done')
  assert.equal(res.text, 'Refactored a.ts and tests pass.')
  assert.equal(res.stats.steps, 1)
  assert.equal(res.stats.toolCalls, 1)
  assert.equal(res.stats.lastTool, 'read_file')
  assert.equal(res.stats.usage.inputTokens, 1000)
  assert.equal(res.stats.usage.cacheReadTokens, 800)
})

test('watcher: traps ask_user_question and cancels blocked agent with needs_input', async () => {
  const agent = makeFakeAgent()
  agent.push({ type: 'turn/start', data: { turn: 1 } })
  agent.push({
    type: 'tool/call',
    data: {
      callId: 'q1',
      name: 'ask_user_question',
      arguments: JSON.stringify({ question: 'Use PostgreSQL or SQLite?', options: ['PostgreSQL', 'SQLite'] }),
    },
  })

  const res = await watchAgentTurn({
    agent,
    firstSeq: 0,
    pollIntervalMs: 10,
    askTrapGraceMs: 40,
    idleTimeoutMs: 5000,
  })
  assert.equal(res.status, 'needs_input')
  assert.equal(res.reason, 'ask_user_question')
  assert.equal(agent.cancelled, true)
  assert.match(res.text, /PostgreSQL or SQLite/)
  assert.match(res.text, /Options: PostgreSQL \| SQLite/)
})

test('watcher: classifies [NEEDS_INPUT] and [BLOCKED] assistant output', async () => {
  assert.equal(classifyAssistantOutput('[NEEDS_INPUT] Which port?').needsInput, true)
  assert.equal(classifyAssistantOutput('**[BLOCKED]:** Missing API key').needsInput, true)
  assert.equal(classifyAssistantOutput('All tests passed.').needsInput, false)

  const agent = makeFakeAgent()
  agent.push({ type: 'turn/start', data: { turn: 1 } })
  agent.push({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '[NEEDS_INPUT] Confirm schema drop?' }] } },
  })
  agent.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  agent.setIdle()

  const res = await watchAgentTurn({ agent, firstSeq: 0, pollIntervalMs: 10 })
  assert.equal(res.status, 'needs_input')
  assert.equal(res.text, 'Confirm schema drop?')
})

test('watcher: breaks repeated consecutive tool error loops as stuck', async () => {
  const agent = makeFakeAgent()
  agent.push({ type: 'turn/start', data: { turn: 1 } })
  for (let i = 0; i < 3; i += 1) {
    agent.push({ type: 'tool/call', data: { callId: `e${i}`, name: 'edit_file', arguments: '{}' } })
    agent.push({
      type: 'tool/result',
      data: {
        callId: `e${i}`,
        isError: true,
        message: { content: [{ type: 'text', text: 'target string not found' }] },
      },
    })
  }

  const res = await watchAgentTurn({
    agent,
    firstSeq: 0,
    pollIntervalMs: 10,
    maxConsecutiveToolErrors: 3,
    idleTimeoutMs: 5000,
  })
  assert.equal(res.status, 'stuck')
  assert.equal(res.reason, 'repeated_tool_error')
  assert.equal(agent.cancelled, true)
  assert.match(res.error.message, /edit_file.*3 times/)
})

test('watcher: trips idle watchdog when session goes silent', async () => {
  const agent = makeFakeAgent()
  agent.push({ type: 'turn/start', data: { turn: 1 } })

  const res = await watchAgentTurn({
    agent,
    firstSeq: 0,
    pollIntervalMs: 15,
    idleTimeoutMs: 80,
    toolIdleTimeoutMs: 80,
    maxTurnMs: 5000,
  })
  assert.equal(res.status, 'stuck')
  assert.equal(res.reason, 'idle_timeout')
  assert.equal(agent.cancelled, true)
})

test('watcher: respects caller AbortSignal as cancelled', async () => {
  const agent = makeFakeAgent()
  agent.push({ type: 'turn/start', data: { turn: 1 } })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 30)

  const res = await watchAgentTurn({
    agent,
    firstSeq: 0,
    pollIntervalMs: 10,
    idleTimeoutMs: 5000,
    signal: ac.signal,
  })
  assert.equal(res.status, 'cancelled')
  assert.equal(agent.cancelled, true)
})

test('watcher: formatInteractiveQuestion handles multi-question payloads', () => {
  const q = formatInteractiveQuestion('ask_user_question', {
    questions: [{ question: 'DB?', options: ['PG', 'SQLite'] }],
  })
  assert.match(q.text, /1\. DB\? \[PG \/ SQLite\]/)
})
