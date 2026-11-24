/**
 * Loopback HTTP + SSE bridge for @local/dsh-subagent.
 *
 * Key design choices for long-running 10k+ LOC coding turns:
 * - Turning is ALWAYS async: POST /v1/sessions/:name/turns returns 202 with a runId.
 * - Clients wait via short 25s long-poll slices on GET /v1/runs/:runId?wait=25,
 *   so Node/undici HTTP headersTimeout NEVER kills a 20-minute coding turn.
 * - Strict per-session concurrency lock prevents two turns from colliding on the
 *   same DSH session.
 * - Live inspection, mid-flight steering, and clean cancellation are first-class.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import http from 'node:http'

import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_IDLE_TIMEOUT_SEC,
  DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
  DEFAULT_MAX_TURN_SEC,
  DEFAULT_POLL_WAIT_SEC,
  DEFAULT_TOOL_IDLE_TIMEOUT_SEC,
  LOOPBACK_HOST,
  MAX_BODY_BYTES,
  MAX_POLL_WAIT_SEC,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  REASONING_EFFORTS,
  SAFETY_MODES,
  SubagentError,
  TERMINAL_RUN_STATUSES,
  clampNumber,
  cloneJson,
  isPlainObject,
  newRunId,
  newToken,
  nowIso,
  nowMs,
  optionalString,
  requireString,
  statusForCode,
  toSubagentError,
  validateSessionName,
} from './protocol.js'

const SSE_HEARTBEAT_MS = 15_000
const SSE_BUFFER_SIZE = 500
const MAX_STORED_RUNS = 500

function digest(value) {
  return createHash('sha256').update(String(value)).digest()
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function createLogger(logger) {
  const call = (level) => (...args) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](...args)
    } catch {
      /* ignore */
    }
  }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
}

export function matchRoute(pattern, pathname) {
  const pParts = pattern.split('/').filter(Boolean)
  const uParts = pathname.split('/').filter(Boolean)
  if (pParts.length !== uParts.length) return null
  const params = {}
  for (let i = 0; i < pParts.length; i += 1) {
    if (pParts[i].startsWith(':')) {
      try {
        params[pParts[i].slice(1)] = decodeURIComponent(uParts[i])
      } catch {
        params[pParts[i].slice(1)] = uParts[i]
      }
    } else if (pParts[i] !== uParts[i]) {
      return null
    }
  }
  return params
}

export function createBridge(options = {}) {
  const { store, host } = options
  if (!store) throw new SubagentError('internal', 'createBridge requires a store')
  if (!host || typeof host.runTurn !== 'function') {
    throw new SubagentError('internal', 'createBridge requires a host with runTurn()')
  }

  const cfg = options.config ?? {}
  const bindHost = optionalString(cfg.host) ?? LOOPBACK_HOST
  if (bindHost !== LOOPBACK_HOST) {
    throw new SubagentError('bad-request', 'dsh-subagent bridge refuses to bind anything except 127.0.0.1')
  }
  const requestedPort = Number.isInteger(cfg.port) ? cfg.port : DEFAULT_BRIDGE_PORT
  if (requestedPort < 0 || requestedPort > 65535) {
    throw new SubagentError('bad-request', '"port" must be an integer between 0 and 65535')
  }
  const token = optionalString(cfg.token) ?? newToken()
  const tokenDigest = digest(token)
  const logger = createLogger(options.logger)
  const onLiveSnapshot = typeof options.onLiveSnapshot === 'function' ? options.onLiveSnapshot : null
  const startedAt = nowMs()

  /** @type {Map<string, any>} runId -> run record */
  const runs = new Map()
  /** @type {Map<string, {runId: string, controller: AbortController}>} sessionName -> active turn */
  const activeBySession = new Map()
  /** @type {Map<string, Set<() => void>>} runId -> settlement waiters */
  const runWaiters = new Map()
  /** @type {Set<{res: http.ServerResponse}>} */
  const sseClients = new Set()
  /** @type {Array<{seq: number, event: any}>} */
  const eventBuffer = []

  let eventSeq = 0
  let boundPort = requestedPort
  let url = ''
  let listenPromise = null
  let closed = false

  const routes = []
  function addRoute(method, pattern, handler) {
    routes.push({ method: method.toUpperCase(), pattern, handler })
  }

  function emitLiveSnapshot() {
    if (!onLiveSnapshot) return
    const active = [...activeBySession.entries()].map(([name, entry]) => {
      const r = runs.get(entry.runId)
      return {
        name,
        runId: entry.runId,
        mode: r?.mode ?? 'full',
        status: r?.status ?? 'running',
        startedAt: r?.startedAt ?? null,
        progress: r?.progress ?? null,
      }
    })
    try {
      void onLiveSnapshot({ updatedAt: nowIso(), activeRuns: active })
    } catch {
      /* ignore snapshot errors */
    }
  }

  function broadcast(event) {
    const seq = (eventSeq += 1)
    const payload = { ...cloneJson(event), seq, at: nowIso() }
    eventBuffer.push({ seq, event: payload })
    if (eventBuffer.length > SSE_BUFFER_SIZE) eventBuffer.shift()
    if (event?.type === 'run' || event?.type === 'progress') emitLiveSnapshot()
    const chunk = `id: ${seq}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of [...sseClients]) {
      if (client.res.destroyed || client.res.writableEnded) {
        sseClients.delete(client)
        continue
      }
      try {
        client.res.write(chunk)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  const unsubStore =
    typeof store.subscribe === 'function' ? store.subscribe((evt) => broadcast(evt)) : () => {}

  function notifyRunSettled(runId) {
    const set = runWaiters.get(runId)
    if (!set) return
    for (const fn of [...set]) fn()
    runWaiters.delete(runId)
  }

  function waitForRunSettlement(runId, waitSec, signal) {
    const run = runs.get(runId)
    if (!run || TERMINAL_RUN_STATUSES.includes(run.status) || waitSec <= 0 || closed || signal?.aborted) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        runWaiters.get(runId)?.delete(finish)
        if (runWaiters.get(runId)?.size === 0) runWaiters.delete(runId)
        if (signal) signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, waitSec * 1000)
      if (typeof timer.unref === 'function') timer.unref()
      if (signal) signal.addEventListener('abort', finish, { once: true })
      let set = runWaiters.get(runId)
      if (!set) {
        set = new Set()
        runWaiters.set(runId, set)
      }
      set.add(finish)
    })
  }

  function pruneOldRuns() {
    if (runs.size <= MAX_STORED_RUNS) return
    for (const [id, r] of runs) {
      if (runs.size <= MAX_STORED_RUNS) break
      if (TERMINAL_RUN_STATUSES.includes(r.status)) runs.delete(id)
    }
  }

  function authorized(header) {
    const value = typeof header === 'string' ? header.trim() : ''
    const m = /^Bearer\s+(.+)$/i.exec(value)
    if (!m) {
      safeEqual(digest(''), tokenDigest)
      return false
    }
    return safeEqual(digest(m[1].trim()), tokenDigest)
  }

  function sendJson(res, status, payload) {
    if (res.destroyed || res.writableEnded) return
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function sendError(res, error) {
    const err = toSubagentError(error, 'internal')
    if (!(error instanceof SubagentError)) {
      logger.error('bridge: unexpected error: ' + err.message)
    }
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
      return
    }
    sendJson(res, err.status ?? statusForCode(err.code), {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details === undefined ? {} : { details: err.details }),
      },
    })
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let bytes = 0
      let tooLarge = false
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        reject(err)
      }
      req.on('data', (chunk) => {
        if (settled) return
        bytes += chunk.length
        if (bytes > MAX_BODY_BYTES) {
          tooLarge = true
          chunks.length = 0
          return
        }
        chunks.push(chunk)
      })
      req.on('error', (err) => fail(new SubagentError('bad-request', 'failed reading request body: ' + err.message)))
      req.on('end', () => {
        if (settled) return
        settled = true
        if (tooLarge) {
          reject(new SubagentError('payload-too-large', `request body exceeds ${MAX_BODY_BYTES} bytes`, undefined, 413))
          return
        }
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        if (!raw) {
          resolve({})
          return
        }
        try {
          const parsed = JSON.parse(raw)
          if (!isPlainObject(parsed)) {
            reject(new SubagentError('bad-request', 'request body must be a JSON object'))
            return
          }
          resolve(parsed)
        } catch (err) {
          reject(new SubagentError('bad-request', 'invalid JSON body: ' + err.message))
        }
      })
    })
  }

  // ---- Core programmatic operations ----------------------------------------

  async function health() {
    const allSessions = await store.listSessions()
    const route = typeof host.describeRoute === 'function' ? host.describeRoute() : null
    const liveDshSessions = typeof host.listDshSessions === 'function' ? host.listDshSessions() : []
    return {
      ok: true,
      version: PROTOCOL_VERSION,
      packageVersion: PACKAGE_VERSION,
      uptimeMs: nowMs() - startedAt,
      pid: process.pid,
      profile: cfg.profile ?? null,
      webUrl: cfg.webUrl ?? null,
      route,
      sessionCount: allSessions.length,
      activeRuns: [...activeBySession.entries()].map(([name, entry]) => {
        const r = runs.get(entry.runId)
        return {
          name,
          runId: entry.runId,
          startedAt: r?.startedAt ?? null,
          progress: r?.progress ?? null,
        }
      }),
      dshSessions: liveDshSessions,
    }
  }

  async function startTurn(name, input = {}) {
    const sessionName = validateSessionName(name)
    const prompt = requireString(input.prompt, 'prompt')

    if (activeBySession.has(sessionName)) {
      const existing = activeBySession.get(sessionName)
      const activeRun = runs.get(existing.runId)
      throw new SubagentError(
        'turn-running',
        `session "${sessionName}" already has an active run (${existing.runId}); use "status", "steer", or "cancel"`,
        { runId: existing.runId, progress: activeRun?.progress ?? null },
      )
    }

    let session = await store.getSession(sessionName)
    const reqMode = optionalString(input.mode)
    if (reqMode !== undefined && !SAFETY_MODES.includes(reqMode)) {
      throw new SubagentError('bad-request', `"mode" must be one of: ${SAFETY_MODES.join(', ')}`)
    }
    const reqAllowCommands = Array.isArray(input.allowCommands)
      ? input.allowCommands.filter((c) => typeof c === 'string' && c.trim() !== '').map((c) => c.trim())
      : undefined

    if (!session) {
      if (input.createIfMissing !== true) {
        throw new SubagentError('not-found', `no subagent session named "${sessionName}"`)
      }
      session = await store.createSession({
        name: sessionName,
        mode: reqMode ?? 'full',
        allowCommands: reqAllowCommands ?? [],
        cwd: optionalString(input.cwd),
        model: optionalString(input.model),
        provider: optionalString(input.provider),
        reasoningEffort: optionalString(input.reasoningEffort),
      })
    } else if (session.status === 'closed') {
      throw new SubagentError('session-closed', `session "${sessionName}" is closed; start a new named session`)
    } else {
      const patch = {}
      if (optionalString(input.cwd)) patch.cwd = optionalString(input.cwd)
      if (reqMode) patch.mode = reqMode
      if (reqAllowCommands) patch.allowCommands = reqAllowCommands
      if (optionalString(input.model)) patch.model = optionalString(input.model)
      if (optionalString(input.provider)) patch.provider = optionalString(input.provider)
      if (optionalString(input.reasoningEffort)) patch.reasoningEffort = optionalString(input.reasoningEffort)
      if (Object.keys(patch).length > 0) {
        session = await store.updateSession(sessionName, patch)
      }
    }

    const effectiveMode = reqMode ?? session.mode ?? 'full'
    const effectiveAllowCommands = reqAllowCommands ?? session.allowCommands ?? []
    const shouldRedact = input.redactSecrets !== false

    const effort = optionalString(input.reasoningEffort) ?? session.reasoningEffort ?? undefined
    if (effort !== undefined && !REASONING_EFFORTS.includes(effort)) {
      throw new SubagentError('bad-request', `"reasoningEffort" must be one of: ${REASONING_EFFORTS.join(', ')}`)
    }

    const idleTimeoutSec = clampNumber(input.idleTimeoutSec, 10, 3600, DEFAULT_IDLE_TIMEOUT_SEC)
    const toolIdleTimeoutSec = clampNumber(
      input.toolIdleTimeoutSec,
      10,
      3600,
      Math.max(idleTimeoutSec, DEFAULT_TOOL_IDLE_TIMEOUT_SEC),
    )
    const maxTurnSec = clampNumber(input.maxTurnSec, 15, 7200, DEFAULT_MAX_TURN_SEC)
    const maxConsecutiveToolErrors = clampNumber(
      input.maxConsecutiveToolErrors,
      0,
      50,
      DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
    )
    const files = Array.isArray(input.files)
      ? input.files.filter((f) => typeof f === 'string' && f.trim() !== '')
      : []

    const runId = newRunId()
    const controller = new AbortController()
    const startedAtIso = nowIso()

    const run = {
      runId,
      name: sessionName,
      mode: effectiveMode,
      status: 'running',
      reason: null,
      startedAt: startedAtIso,
      finishedAt: null,
      dshSessionId: session.dshSessionId,
      resumed: Boolean(session.dshSessionId),
      cwd: session.cwd,
      reply: '',
      question: null,
      error: null,
      gitChanges: null,
      progress: {
        elapsedMs: 0,
        idleMs: 0,
        steps: 0,
        toolCalls: 0,
        lastTool: null,
        currentActivity: 'Starting...',
        todos: [],
        activeTools: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        recentEvents: [],
      },
    }

    runs.set(runId, run)
    pruneOldRuns()
    activeBySession.set(sessionName, { runId, controller })

    await store.updateSession(sessionName, { lastRunId: runId })
    await store.appendEvent(sessionName, {
      kind: 'turn_start',
      runId,
      cwd: session.cwd,
      prompt: prompt.slice(0, 4000),
      files,
      effort: effort ?? null,
    })
    broadcast({ type: 'run', run: cloneJson(run) })

    // Kick off turn asynchronously on the host.
    void (async () => {
      try {
        const result = await host.runTurn({
          name: sessionName,
          runId,
          prompt,
          mode: effectiveMode,
          allowCommands: effectiveAllowCommands,
          redactSecrets: shouldRedact,
          cwd: session.cwd ?? undefined,
          model: optionalString(input.model) ?? session.model ?? undefined,
          provider: optionalString(input.provider) ?? session.provider ?? undefined,
          reasoningEffort: effort,
          appendSystem: optionalString(input.appendSystem),
          files,
          resumeSessionId: session.dshSessionId ?? undefined,
          isFirstTurn: session.turnCount === 0,
          idleTimeoutMs: idleTimeoutSec * 1000,
          toolIdleTimeoutMs: toolIdleTimeoutSec * 1000,
          maxTurnMs: maxTurnSec * 1000,
          maxConsecutiveToolErrors,
          signal: controller.signal,
          onProgress(snapshot) {
            run.progress = snapshot
            broadcast({ type: 'progress', name: sessionName, runId, progress: snapshot })
          },
        })

        run.status = result.status ?? 'done'
        run.reason = result.reason ?? null
        run.finishedAt = nowIso()
        run.dshSessionId = result.sessionId ?? run.dshSessionId
        run.resumed = Boolean(result.resumed)
        run.reply = typeof result.text === 'string' ? result.text : ''
        run.question = result.question ?? null
        run.error = result.error ?? null
        run.gitChanges = result.gitChanges ?? null
        if (result.stats) run.progress = result.stats

        const currentSession = (await store.getSession(sessionName)) ?? session
        await store.updateSession(sessionName, {
          dshSessionId: run.dshSessionId,
          turnCount: currentSession.turnCount + 1,
          lastRunId: runId,
          lastOutcome: run.status,
          lastError: run.error?.message ?? null,
          lastSummary: (run.reply || run.error?.message || '').slice(0, 400),
        })
        await store.appendEvent(sessionName, {
          kind: 'turn_end',
          runId,
          status: run.status,
          reason: run.reason,
          dshSessionId: run.dshSessionId,
          reply: run.reply.slice(0, 8000),
          question: run.question,
          error: run.error,
          gitChanges: run.gitChanges,
          stats: {
            elapsedMs: run.progress?.elapsedMs ?? 0,
            steps: run.progress?.steps ?? 0,
            toolCalls: run.progress?.toolCalls ?? 0,
            lastTool: run.progress?.lastTool ?? null,
            usage: run.progress?.usage ?? null,
          },
        })
      } catch (err) {
        const mapped = toSubagentError(err, 'turn-failed')
        run.status = controller.signal.aborted ? 'cancelled' : 'error'
        run.reason = controller.signal.aborted ? 'cancelled' : mapped.code
        run.finishedAt = nowIso()
        run.error = { code: mapped.code, message: mapped.message }
        await store.updateSession(sessionName, {
          lastRunId: runId,
          lastOutcome: run.status,
          lastError: mapped.message,
        }).catch(() => {})
        await store.appendEvent(sessionName, {
          kind: 'turn_end',
          runId,
          status: run.status,
          reason: run.reason,
          error: run.error,
        }).catch(() => {})
      } finally {
        activeBySession.delete(sessionName)
        broadcast({ type: 'run', run: cloneJson(run) })
        notifyRunSettled(runId)
      }
    })()

    return { run: cloneJson(run), session: (await store.getSession(sessionName)) ?? session }
  }

  async function steerSession(name, text) {
    const sessionName = validateSessionName(name)
    const msg = requireString(text, 'text')
    const active = activeBySession.get(sessionName)
    if (!active) {
      throw new SubagentError('conflict', `session "${sessionName}" has no running turn to steer; use "send" instead`)
    }
    if (typeof host.steerTurn !== 'function') {
      throw new SubagentError('host-unavailable', 'host does not support mid-turn steering')
    }
    await host.steerTurn(sessionName, msg)
    await store.appendEvent(sessionName, { kind: 'steer', runId: active.runId, text: msg.slice(0, 2000) })
    return { ok: true, name: sessionName, runId: active.runId }
  }

  async function cancelSession(name) {
    const sessionName = validateSessionName(name)
    const active = activeBySession.get(sessionName)
    if (!active) {
      return { ok: true, name: sessionName, cancelled: false, note: 'no running turn' }
    }
    active.controller.abort(new SubagentError('cancelled', 'cancelled by caller'))
    await waitForRunSettlement(active.runId, 5, undefined)
    const run = runs.get(active.runId)
    return { ok: true, name: sessionName, cancelled: true, run: run ? cloneJson(run) : null }
  }

  // ---- HTTP routes ---------------------------------------------------------

  addRoute('GET', '/v1/health', async (ctx) => {
    sendJson(ctx.res, 200, await health())
  })

  addRoute('GET', '/v1/sessions', async (ctx) => {
    const filter = {}
    if (optionalString(ctx.query.status)) filter.status = optionalString(ctx.query.status)
    const list = await store.listSessions(filter)
    const enriched = list.map((s) => {
      const active = activeBySession.get(s.name)
      const r = active ? runs.get(active.runId) : s.lastRunId ? runs.get(s.lastRunId) : null
      return {
        ...s,
        running: Boolean(active),
        activeRunId: active?.runId ?? null,
        progress: active ? r?.progress ?? null : null,
      }
    })
    sendJson(ctx.res, 200, { sessions: enriched })
  })

  addRoute('POST', '/v1/sessions', async (ctx) => {
    const session = await store.createSession(ctx.body)
    sendJson(ctx.res, 201, { session })
  })

  addRoute('GET', '/v1/sessions/:name', async (ctx) => {
    const name = validateSessionName(ctx.params.name)
    const session = await store.getSession(name)
    if (!session) throw new SubagentError('not-found', `no subagent session named "${name}"`)
    const active = activeBySession.get(name)
    const run = active ? runs.get(active.runId) : session.lastRunId ? runs.get(session.lastRunId) : null
    const recentLog = await store.readEvents(name, { tail: 20 })
    sendJson(ctx.res, 200, {
      session,
      running: Boolean(active),
      activeRun: active ? cloneJson(run) : null,
      lastRun: run ? cloneJson(run) : null,
      recentLog,
    })
  })

  addRoute('GET', '/v1/sessions/:name/log', async (ctx) => {
    const name = validateSessionName(ctx.params.name)
    const session = await store.getSession(name)
    if (!session) throw new SubagentError('not-found', `no subagent session named "${name}"`)
    const after = Number.isFinite(Number(ctx.query.after)) ? Math.max(0, Math.floor(Number(ctx.query.after))) : 0
    const tail = Number.isFinite(Number(ctx.query.tail)) ? Math.max(0, Math.floor(Number(ctx.query.tail))) : 50
    const events = await store.readEvents(name, { after, tail })
    sendJson(ctx.res, 200, { session, events })
  })

  addRoute('POST', '/v1/sessions/:name/turns', async (ctx) => {
    const result = await startTurn(ctx.params.name, ctx.body)
    sendJson(ctx.res, 202, result)
  })

  addRoute('GET', '/v1/runs/:runId', async (ctx) => {
    const runId = requireString(ctx.params.runId, 'runId')
    const run = runs.get(runId)
    if (!run) throw new SubagentError('not-found', `no run found with id "${runId}"`)
    const waitSec = clampNumber(ctx.query.wait, 0, MAX_POLL_WAIT_SEC, 0)
    if (waitSec > 0 && run.status === 'running') {
      await waitForRunSettlement(runId, waitSec, ctx.signal)
    }
    const latest = runs.get(runId)
    const session = await store.getSession(latest.name)
    sendJson(ctx.res, 200, { run: cloneJson(latest), session })
  })

  addRoute('POST', '/v1/sessions/:name/steer', async (ctx) => {
    const res = await steerSession(ctx.params.name, ctx.body.text)
    sendJson(ctx.res, 200, res)
  })

  addRoute('POST', '/v1/sessions/:name/cancel', async (ctx) => {
    const res = await cancelSession(ctx.params.name)
    sendJson(ctx.res, 200, res)
  })

  addRoute('POST', '/v1/sessions/:name/close', async (ctx) => {
    const name = validateSessionName(ctx.params.name)
    if (activeBySession.has(name)) {
      if (ctx.body.force === true) {
        await cancelSession(name)
      } else {
        throw new SubagentError('turn-running', `session "${name}" is still running; cancel it first or pass force:true`)
      }
    }
    const session = await store.closeSession(name)
    sendJson(ctx.res, 200, { session })
  })

  addRoute('GET', '/v1/events', async (ctx) => {
    const after = Number.isFinite(Number(ctx.query.after)) ? Math.max(0, Math.floor(Number(ctx.query.after))) : 0
    const { req, res } = ctx
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    for (const entry of eventBuffer) {
      if (entry.seq > after) res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry.event)}\n\n`)
    }
    const client = { res }
    sseClients.add(client)
    const hb = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n')
    }, SSE_HEARTBEAT_MS)
    if (typeof hb.unref === 'function') hb.unref()
    const cleanup = () => {
      clearInterval(hb)
      sseClients.delete(client)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  })

  // ---- HTTP dispatcher -----------------------------------------------------

  async function handle(req, res) {
    try {
      const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = parsedUrl.pathname
      if (!authorized(req.headers.authorization)) {
        req.resume()
        throw new SubagentError('unauthorized', 'missing or invalid bearer token; check ~/.dsh-subagent/bridge.json')
      }
      const method = (req.method ?? 'GET').toUpperCase()
      let matched = null
      for (const r of routes) {
        const params = matchRoute(r.pattern, pathname)
        if (params !== null && (r.method === method || r.method === '*')) {
          matched = { handler: r.handler, params }
          break
        }
      }
      if (!matched) throw new SubagentError('not-found', `no route for ${method} ${pathname}`)
      const query = {}
      for (const [k, v] of parsedUrl.searchParams.entries()) query[k] = v
      const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req)
      const controller = new AbortController()
      const onClose = () => controller.abort()
      res.on('close', onClose)
      try {
        await matched.handler({ req, res, body, query, params: matched.params, signal: controller.signal })
      } finally {
        res.off('close', onClose)
      }
    } catch (error) {
      sendError(res, error)
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })
  server.requestTimeout = 0
  server.keepAliveTimeout = 65_000

  function listen() {
    if (listenPromise) return listenPromise
    if (closed) return Promise.reject(new SubagentError('internal', 'bridge is closed'))
    listenPromise = new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening)
        listenPromise = null
        reject(err)
      }
      const onListening = () => {
        server.off('error', onError)
        const addr = server.address()
        boundPort = addr && typeof addr === 'object' ? addr.port : requestedPort
        url = `http://${bindHost}:${boundPort}`
        resolve(url)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(requestedPort, bindHost)
    })
    return listenPromise
  }

  async function close() {
    if (closed) return
    closed = true
    try {
      unsubStore()
    } catch {
      /* ignore */
    }
    for (const [, entry] of [...activeBySession]) {
      try {
        entry.controller.abort(new SubagentError('cancelled', 'bridge shutting down'))
      } catch {
        /* ignore */
      }
    }
    activeBySession.clear()
    for (const runId of [...runWaiters.keys()]) notifyRunSettled(runId)
    for (const client of [...sseClients]) {
      try {
        client.res.end()
      } catch {
        /* ignore */
      }
    }
    sseClients.clear()
    await new Promise((resolve) => {
      if (!server.listening) return resolve()
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return {
    server,
    token,
    handle,
    listen,
    close,
    health,
    startTurn,
    steerSession,
    cancelSession,
    getRun: (runId) => (runs.has(runId) ? cloneJson(runs.get(runId)) : undefined),
    get url() {
      return url
    },
    get port() {
      return boundPort
    },
  }
}

export default createBridge
