/**
 * Durable named-session store for @local/dsh-subagent.
 *
 * Layout under `$DSH_SUBAGENT_HOME || ~/.dsh-subagent`:
 *   sessions/index.json     atomic session metadata cache
 *   sessions/<name>.jsonl   append-only turn & event transcript
 *
 * Zero external dependencies, Node >= 20, ESM only, Windows-safe atomic writes.
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  DEFAULT_MAX_SESSIONS,
  REASONING_EFFORTS,
  SAFETY_MODES,
  SESSION_STATUSES,
  SubagentError,
  cloneJson,
  isPlainObject,
  nowIso,
  optionalString,
  validateSessionName,
} from './protocol.js'

function createLogger(logger) {
  const call = (level) => (...args) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](...args)
    } catch {
      /* logging must never crash the store */
    }
  }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
}

export function resolveHome(options = {}, env = process.env) {
  const explicit = optionalString(options.home)
  if (explicit) return explicit
  const fromEnv = optionalString(env.DSH_SUBAGENT_HOME)
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh-subagent')
}

function normalizeSession(raw) {
  const now = nowIso()
  const status = SESSION_STATUSES.includes(raw.status) ? raw.status : 'open'
  const mode = SAFETY_MODES.includes(raw.mode) ? raw.mode : 'full'
  const allowCommands = Array.isArray(raw.allowCommands)
    ? raw.allowCommands.filter((c) => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
    : []
  return {
    name: String(raw.name ?? ''),
    status,
    mode,
    allowCommands,
    cwd: optionalString(raw.cwd) ?? null,
    model: optionalString(raw.model) ?? null,
    provider: optionalString(raw.provider) ?? null,
    reasoningEffort:
      typeof raw.reasoningEffort === 'string' && REASONING_EFFORTS.includes(raw.reasoningEffort)
        ? raw.reasoningEffort
        : null,
    dshSessionId: optionalString(raw.dshSessionId) ?? null,
    createdAt: optionalString(raw.createdAt) ?? now,
    updatedAt: optionalString(raw.updatedAt) ?? optionalString(raw.createdAt) ?? now,
    turnCount: Number.isInteger(raw.turnCount) && raw.turnCount >= 0 ? raw.turnCount : 0,
    lastRunId: optionalString(raw.lastRunId) ?? null,
    lastOutcome: optionalString(raw.lastOutcome) ?? null,
    lastError: optionalString(raw.lastError) ?? null,
    lastSummary: optionalString(raw.lastSummary) ?? null,
  }
}

async function writeFileAtomic(file, contents) {
  const tmp = join(
    dirname(file),
    '.' + basename(file) + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp',
  )
  const handle = await fs.open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // On Windows, brief antivirus/reader locks can cause EPERM/EBUSY on rename; retry briefly.
  let lastErr = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (error) {
      lastErr = error
      const code = error?.code
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)))
        continue
      }
      break
    }
  }
  await fs.rm(tmp, { force: true }).catch(() => {})
  throw lastErr
}

export function createStore(options = {}) {
  const env = options.env ?? process.env
  const home = resolveHome(options, env)
  const sessionsDir = join(home, 'sessions')
  const indexFile = join(sessionsDir, 'index.json')
  const logger = createLogger(options.logger)
  const maxSessions =
    Number.isInteger(options.maxSessions) && options.maxSessions >= 1
      ? options.maxSessions
      : DEFAULT_MAX_SESSIONS

  /** @type {Map<string, any>} */
  const sessions = new Map()
  /** @type {Map<string, any[]>} */
  const events = new Map()
  /** @type {Map<string, Promise<unknown>>} */
  const appendQueues = new Map()
  /** @type {Set<(evt: any) => void>} */
  const listeners = new Set()

  let initPromise = null
  let indexQueue = Promise.resolve()
  let closed = false

  function logFile(name) {
    return join(sessionsDir, name + '.jsonl')
  }

  function requireSessionSync(name) {
    const record = sessions.get(String(name ?? ''))
    if (!record) throw new SubagentError('not-found', `no subagent session named "${String(name)}"`)
    return record
  }

  function emit(evt) {
    for (const listener of listeners) {
      try {
        listener(evt)
      } catch (error) {
        logger.warn('store: subscriber error: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
  }

  function persistIndex() {
    const payload =
      JSON.stringify(
        { version: 1, updatedAt: nowIso(), sessions: [...sessions.values()].map((s) => cloneJson(s)) },
        null,
        2,
      ) + '\n'
    const run = indexQueue.then(() => writeFileAtomic(indexFile, payload))
    indexQueue = run.then(() => undefined, () => undefined)
    return run
  }

  function enqueueAppend(name, task) {
    const prev = appendQueues.get(name) ?? Promise.resolve()
    const run = prev.then(task, task)
    appendQueues.set(name, run.then(() => undefined, () => undefined))
    return run
  }

  async function loadIndex() {
    let raw
    try {
      raw = await fs.readFile(indexFile, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn('store: failed reading index.json: ' + error.message)
      return []
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed?.sessions) ? parsed.sessions : []
      return list.filter((s) => isPlainObject(s) && typeof s.name === 'string' && s.name !== '')
    } catch (error) {
      logger.warn('store: corrupt index.json (' + error.message + '), rebuilding from JSONL logs')
      return []
    }
  }

  async function loadEvents(name) {
    let raw
    try {
      raw = await fs.readFile(logFile(name), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn('store: failed reading ' + name + '.jsonl: ' + error.message)
      return []
    }
    const list = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (isPlainObject(parsed)) list.push({ ...parsed, seq: list.length })
      } catch {
        logger.warn('store: skipping corrupt JSONL line in ' + name + '.jsonl')
      }
    }
    return list
  }

  async function touchLog(name) {
    const handle = await fs.open(logFile(name), 'a', 0o600)
    await handle.close()
  }

  async function init() {
    if (initPromise) return initPromise
    initPromise = (async () => {
      await fs.mkdir(sessionsDir, { recursive: true, mode: 0o700 })
      for (const stored of await loadIndex()) {
        sessions.set(stored.name, normalizeSession(stored))
      }
      let entries = []
      try {
        entries = await fs.readdir(sessionsDir)
      } catch (error) {
        logger.warn('store: cannot list sessions dir: ' + error.message)
      }
      let recovered = false
      for (const file of entries) {
        if (!file.endsWith('.jsonl')) continue
        const name = file.slice(0, -'.jsonl'.length)
        const list = await loadEvents(name)
        events.set(name, list)
        if (!sessions.has(name)) {
          recovered = true
          const first = list[0]
          const last = list.at(-1)
          const lastDshId = [...list].reverse().find((e) => typeof e.dshSessionId === 'string')?.dshSessionId ?? null
          sessions.set(
            name,
            normalizeSession({
              name,
              status: 'open',
              cwd: first?.cwd ?? null,
              dshSessionId: lastDshId,
              createdAt: first?.at ?? nowIso(),
              updatedAt: last?.at ?? nowIso(),
              turnCount: list.filter((e) => e.kind === 'turn_end').length,
            }),
          )
        }
      }
      for (const name of sessions.keys()) {
        if (!events.has(name)) events.set(name, await loadEvents(name))
        await touchLog(name)
      }
      if (recovered) {
        await persistIndex().catch((e) => logger.warn('store: persist recovered index failed: ' + e.message))
      }
    })()
    return initPromise
  }

  async function createSession(input = {}) {
    await init()
    const name = validateSessionName(input.name)
    if (sessions.has(name)) {
      throw new SubagentError('conflict', `subagent session "${name}" already exists; use "send" to continue or choose another name`)
    }
    const now = nowIso()
    const record = normalizeSession({
      name,
      status: 'open',
      mode: optionalString(input.mode) ?? 'full',
      allowCommands: Array.isArray(input.allowCommands) ? input.allowCommands : [],
      cwd: optionalString(input.cwd) ?? null,
      model: optionalString(input.model) ?? null,
      provider: optionalString(input.provider) ?? null,
      reasoningEffort: optionalString(input.reasoningEffort) ?? null,
      dshSessionId: optionalString(input.dshSessionId) ?? null,
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
    })
    sessions.set(name, record)
    events.set(name, [])
    await touchLog(name)
    await persistIndex()
    const copy = cloneJson(record)
    emit({ type: 'session', session: copy })
    return copy
  }

  async function getSession(name) {
    await init()
    const rec = sessions.get(String(name ?? ''))
    return rec ? cloneJson(rec) : undefined
  }

  async function listSessions(filter = {}) {
    await init()
    let list = [...sessions.values()]
    const status = optionalString(filter.status)
    if (status) {
      if (!SESSION_STATUSES.includes(status)) {
        throw new SubagentError('bad-request', `"status" must be one of: ${SESSION_STATUSES.join(', ')}`)
      }
      list = list.filter((s) => s.status === status)
    }
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    if (Number.isInteger(filter.limit) && filter.limit > 0) {
      list = list.slice(0, filter.limit)
    }
    return list.map((s) => cloneJson(s))
  }

  async function updateSession(name, patch = {}) {
    await init()
    const rec = requireSessionSync(name)
    if (patch.cwd !== undefined) rec.cwd = optionalString(patch.cwd) ?? null
    if (patch.mode !== undefined && SAFETY_MODES.includes(patch.mode)) rec.mode = patch.mode
    if (Array.isArray(patch.allowCommands)) {
      rec.allowCommands = patch.allowCommands.filter((c) => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
    }
    if (patch.model !== undefined) rec.model = optionalString(patch.model) ?? null
    if (patch.provider !== undefined) rec.provider = optionalString(patch.provider) ?? null
    if (patch.reasoningEffort !== undefined) rec.reasoningEffort = optionalString(patch.reasoningEffort) ?? null
    if (patch.dshSessionId !== undefined) rec.dshSessionId = optionalString(patch.dshSessionId) ?? null
    if (patch.lastRunId !== undefined) rec.lastRunId = optionalString(patch.lastRunId) ?? null
    if (patch.lastOutcome !== undefined) rec.lastOutcome = optionalString(patch.lastOutcome) ?? null
    if (patch.lastError !== undefined) rec.lastError = optionalString(patch.lastError) ?? null
    if (patch.lastSummary !== undefined) rec.lastSummary = optionalString(patch.lastSummary) ?? null
    if (Number.isInteger(patch.turnCount) && patch.turnCount >= 0) rec.turnCount = patch.turnCount
    if (patch.status !== undefined) {
      if (!SESSION_STATUSES.includes(patch.status)) {
        throw new SubagentError('bad-request', `"status" must be one of: ${SESSION_STATUSES.join(', ')}`)
      }
      rec.status = patch.status
    }
    rec.updatedAt = nowIso()
    await persistIndex()
    const copy = cloneJson(rec)
    emit({ type: 'session', session: copy })
    return copy
  }

  async function closeSession(name) {
    await init()
    const rec = requireSessionSync(name)
    if (rec.status !== 'closed') {
      rec.status = 'closed'
      rec.updatedAt = nowIso()
      await persistIndex()
      emit({ type: 'session', session: cloneJson(rec) })
    }
    return cloneJson(rec)
  }

  async function appendEvent(name, entry = {}) {
    await init()
    const rec = requireSessionSync(name)
    return enqueueAppend(rec.name, async () => {
      const list = events.get(rec.name) ?? []
      const full = {
        seq: list.length,
        at: optionalString(entry.at) ?? nowIso(),
        ...cloneJson(entry),
      }
      const line = JSON.stringify(full) + '\n'
      const handle = await fs.open(logFile(rec.name), 'a', 0o600)
      try {
        await handle.write(line, null, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      list.push(full)
      events.set(rec.name, list)
      rec.updatedAt = nowIso()
      await persistIndex()
      const copy = cloneJson(full)
      emit({ type: 'event', name: rec.name, event: copy })
      return copy
    })
  }

  async function readEvents(name, options = {}) {
    await init()
    const rec = requireSessionSync(name)
    const list = events.get(rec.name) ?? []
    const after = Number.isInteger(options.after) && options.after > 0 ? options.after : 0
    let filtered = after > 0 ? list.filter((e) => e.seq >= after) : list.slice()
    if (Number.isInteger(options.tail) && options.tail > 0 && filtered.length > options.tail) {
      filtered = filtered.slice(-options.tail)
    }
    return filtered.map((e) => cloneJson(e))
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new SubagentError('bad-request', 'subscribe requires a function')
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function prune(limit = maxSessions) {
    await init()
    const overflow = sessions.size - limit
    if (overflow <= 0) return []
    const closedList = [...sessions.values()]
      .filter((s) => s.status === 'closed')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    const removed = []
    for (const s of closedList.slice(0, overflow)) {
      sessions.delete(s.name)
      events.delete(s.name)
      appendQueues.delete(s.name)
      removed.push(s.name)
      await fs.rm(logFile(s.name), { force: true }).catch(() => {})
    }
    if (removed.length > 0) await persistIndex()
    return removed
  }

  async function close() {
    if (closed) return
    closed = true
    listeners.clear()
    await indexQueue.catch(() => {})
  }

  return {
    home,
    sessionsDir,
    indexFile,
    logFile,
    init,
    createSession,
    getSession,
    listSessions,
    updateSession,
    closeSession,
    appendEvent,
    readEvents,
    subscribe,
    prune,
    close,
  }
}

export default createStore
