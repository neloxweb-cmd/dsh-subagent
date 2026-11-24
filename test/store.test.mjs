import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createStore } from '../lib/store.js'

async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-subagent-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('store: create, get, update, list, close, and reject duplicate names', async (t) => {
  const home = await tempHome(t)
  const store = createStore({ home })
  await store.init()

  const created = await store.createSession({ name: 'auth-api', cwd: 'C:\\repo', reasoningEffort: 'high' })
  assert.equal(created.name, 'auth-api')
  assert.equal(created.status, 'open')
  assert.equal(created.turnCount, 0)

  await assert.rejects(() => store.createSession({ name: 'auth-api' }), /already exists/)
  await assert.rejects(() => store.createSession({ name: '../bad' }), /must start with/)

  const updated = await store.updateSession('auth-api', { dshSessionId: 'session-123', turnCount: 1, lastOutcome: 'done' })
  assert.equal(updated.dshSessionId, 'session-123')
  assert.equal(updated.turnCount, 1)

  const list = await store.listSessions()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, 'auth-api')

  const closed = await store.closeSession('auth-api')
  assert.equal(closed.status, 'closed')
  await store.close()
})

test('store: concurrent appends stay strictly ordered and recover from corrupt index.json', async (t) => {
  const home = await tempHome(t)
  const store = createStore({ home })
  await store.createSession({ name: 'worker-1', cwd: 'C:\\proj' })

  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      store.appendEvent('worker-1', { kind: 'turn_end', dshSessionId: 'session-abc', idx: i }),
    ),
  )
  assert.deepEqual(
    results.map((r) => r.seq),
    Array.from({ length: 12 }, (_, i) => i),
  )
  await store.close()

  // Corrupt index.json and reload from JSONL logs
  await writeFile(join(home, 'sessions', 'index.json'), '{not-valid-json', 'utf8')
  const recovered = createStore({ home })
  await recovered.init()
  const sess = await recovered.getSession('worker-1')
  assert.ok(sess)
  assert.equal(sess.dshSessionId, 'session-abc')
  assert.equal(sess.turnCount, 12)
  const tail = await recovered.readEvents('worker-1', { tail: 3 })
  assert.equal(tail.length, 3)
  assert.equal(tail[2].seq, 11)
  await recovered.close()
})
