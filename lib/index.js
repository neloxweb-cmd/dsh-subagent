/**
 * @local/dsh-subagent — Cordis plugin for DeepSeek Harness.
 *
 * Mounts an authenticated loopback HTTP/SSE subagent control bridge inside a
 * DSH host process (dedicated `subagent` web profile or Desktop app).
 *
 * Zero static `@deepseek-ai/*` imports: runs cleanly inside DSH's bundled
 * app.asar / runtime and unit-tests cleanly under plain Node >= 20.
 */

import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { createBridge } from './bridge.js'
import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_PROFILE_NAME,
  LOOPBACK_HOST,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROTOCOL_VERSION,
  SubagentError,
  newToken,
  nowIso,
  optionalString,
  requireString,
} from './protocol.js'
import { redactSecrets } from './reporter.js'
import { createStore, resolveHome } from './store.js'
import { checkToolPolicy, watchAgentTurn } from './watcher.js'

export const name = 'dsh-subagent'
export const inject = []

const BRIDGE_FILE = 'bridge.json'

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'target',
  '.turbo',
  'logs',
  'tmp',
  'temp',
  'sessions',
  'run',
  'pids',
])

const SKIP_FS_FILE_RE = /\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3|sqlite-wal|sqlite-shm|sqlite3-wal|sqlite3-shm|log|pid|lock|sock|tmp|swp|swo)$|\.log\.\d+(\.gz)?$|~$/i

/** Standing contract appended on the first turn of every subagent session. */
export const SUBAGENT_CONTRACT = [
  '[SUBAGENT PROTOCOL]',
  'You are executing as an autonomous DeepSeek coding subagent orchestrated by a parent agent (Antigravity or Claude Code).',
  'Rules:',
  '1. Work autonomously inside the workspace directory. Read relevant code before editing, make clean changes, and verify them (tests, typecheck, build) whenever applicable.',
  '2. For multi-step tasks (3+ steps), maintain a short live checklist using your todo tool (`todo_write`) so the user can see progress in real time.',
  '3. If you hit an ambiguity, missing credential, architectural choice, or blocker that requires input from the parent agent or user, STOP immediately and start your reply with `[NEEDS_INPUT]` followed by the concise question and concrete options.',
  '4. Never fabricate test results or claim files were modified when they were not. Never output secrets, API keys, passwords, or `.env` values.',
  '5. When finished, return a concise, factual summary: what changed (file paths), what verification ran and its exact result, and any follow-up caveats.',
].join('\n')

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

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

export function normalizeConfig(raw = {}) {
  const src = raw ?? {}
  const host = src.host === undefined ? LOOPBACK_HOST : requireString(src.host, 'host')
  if (host !== LOOPBACK_HOST) {
    throw new SubagentError('bad-request', 'dsh-subagent refuses to bind anything except 127.0.0.1')
  }
  const port = src.port === undefined ? DEFAULT_BRIDGE_PORT : src.port
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new SubagentError('bad-request', '"port" must be an integer between 0 and 65535')
  }
  return {
    enabled: src.enabled !== false,
    host,
    port,
    home: optionalString(src.home) ?? '',
    token: optionalString(src.token) ?? '',
    profile: optionalString(src.profile) ?? optionalString(process.env.DSH_SUBAGENT_PROFILE) ?? DEFAULT_PROFILE_NAME,
    webUrl: optionalString(src.webUrl) ?? optionalString(process.env.DSH_WEB_URL) ?? null,
    maxSessions:
      Number.isInteger(src.maxSessions) && src.maxSessions >= 1 ? src.maxSessions : DEFAULT_MAX_SESSIONS,
    provider: optionalString(src.provider) ?? '',
    defaultModel: optionalString(src.defaultModel) ?? '',
    defaultEffort: optionalString(src.defaultEffort) ?? '',
    agentPreset: src.agentPreset === '' ? '' : optionalString(src.agentPreset) ?? 'standard',
  }
}

export function buildUserMessage(deps, text, sourceKind = 'dsh-subagent') {
  const content = [{ type: 'text', text }]
  if (typeof deps?.createUserMessage === 'function') {
    return deps.createUserMessage({ content, source: { kind: sourceKind } })
  }
  return {
    id: 'msg_' + randomUUID().replaceAll('-', '').slice(0, 24),
    role: 'user',
    content,
    createdAt: nowIso(),
    source: { kind: sourceKind },
  }
}

async function renderFiles(files, cwd) {
  if (!Array.isArray(files) || files.length === 0) return ''
  const parts = []
  let budget = 192 * 1024
  for (const file of files.slice(0, 32)) {
    const target = isAbsolute(file) ? file : resolve(cwd ?? process.cwd(), file)
    try {
      const raw = await readFile(target, 'utf8')
      const slice = budget > 0 ? raw.slice(0, budget) : ''
      budget -= slice.length
      parts.push(`### file: ${target}\n${slice}`)
    } catch (err) {
      parts.push(`### file: ${target}\n(unreadable: ${errorMessage(err)})`)
    }
  }
  return parts.length === 0 ? '' : 'Context files supplied by parent agent:\n\n' + parts.join('\n\n')
}

export async function composePrompt({ prompt, cwd, files, appendSystem, isFirstTurn, mode = 'full', allowCommands = [] }) {
  const sections = []
  if (isFirstTurn) sections.push(SUBAGENT_CONTRACT)
  if (mode === 'readonly') {
    const allowedText =
      Array.isArray(allowCommands) && allowCommands.length > 0
        ? `Only these read-only shell command prefixes are allowed (no shell pipes/chaining/redirection): ${allowCommands.join(', ')}.`
        : 'Shell execution is disabled in readonly mode.'
    sections.push(
      `[READ-ONLY MODE ENFORCED]\nYou are in strict read-only mode. Do NOT modify, create, or delete any files. ${allowedText} Blocked write or shell attempts will be denied with an error — if one action is denied, do not retry it; continue completing the remaining read-only parts of the task.`,
    )
  } else if (mode === 'workspace' && cwd) {
    sections.push(
      `[WORKSPACE-ONLY MODE ENFORCED]\nYou may only modify files inside "${cwd}". Writes outside this directory are automatically blocked.`,
    )
  }
  if (optionalString(appendSystem)) sections.push(String(appendSystem).trim())
  const renderedFiles = await renderFiles(files, cwd)
  if (renderedFiles) sections.push(renderedFiles)
  sections.push(String(prompt))
  return sections.join('\n\n')
}

function runGit(cwd, args) {
  return new Promise((resolvePromise) => {
    if (!cwd) return resolvePromise(null)
    execFile('git', args, { cwd, timeout: 5000, windowsHide: true, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) return resolvePromise(null)
      resolvePromise(String(stdout ?? ''))
    })
  })
}

async function captureGitStatus(cwd) {
  const out = await runGit(cwd, ['status', '--porcelain=v1', '-uall'])
  if (out === null) return null
  /** @type {Map<string, {code: string, sig: string}>} */
  const map = new Map()
  for (const line of out.split(/\r?\n/)) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const filePath = line.slice(3).trim()
    if (!filePath) continue
    let sig = ''
    try {
      const st = await stat(resolve(cwd, filePath))
      sig = `${Math.floor(st.mtimeMs)}:${st.size}`
    } catch {
      sig = 'missing'
    }
    map.set(filePath, { code, sig })
  }
  return map
}

async function captureFsSnapshot(cwd) {
  const map = new Map()
  const deadline = Date.now() + 2500
  const maxFiles = 25000
  let truncated = false

  async function walk(dir) {
    if (truncated || Date.now() > deadline) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (map.size >= maxFiles || Date.now() > deadline) {
        truncated = true
        return
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(join(dir, entry.name))
      } else if (entry.isFile()) {
        if (SKIP_FS_FILE_RE.test(entry.name)) continue
        const full = join(dir, entry.name)
        try {
          const st = await stat(full)
          const rel = relative(cwd, full).replaceAll('\\', '/')
          map.set(rel, { code: 'F', sig: `${Math.floor(st.mtimeMs)}:${st.size}` })
        } catch {
          /* ignore transient file */
        }
      }
    }
  }

  await walk(cwd)
  return { mode: 'fs', map, truncated }
}

export async function captureWorkspaceSnapshot(cwd) {
  if (!cwd) return null
  const gitMap = await captureGitStatus(cwd)
  if (gitMap !== null) return { mode: 'git', map: gitMap, truncated: false }
  return captureFsSnapshot(cwd)
}

export async function computeWorkspaceChanges(cwd, beforeSnap, opts = {}) {
  if (!beforeSnap || !cwd) return null
  if (beforeSnap.mode === 'git') {
    const afterMap = await captureGitStatus(cwd)
    if (!afterMap) return null
    const changed = []
    for (const [file, after] of afterMap) {
      const before = beforeSnap.map.get(file)
      if (!before || before.code !== after.code || before.sig !== after.sig) {
        changed.push({ path: file, status: after.code.trim() || 'M' })
      }
    }
    for (const [file] of beforeSnap.map) {
      if (!afterMap.has(file)) changed.push({ path: file, status: 'reverted' })
    }
    const diffStat = await runGit(cwd, ['diff', '--stat'])
    return {
      mode: 'git',
      isGitRepo: true,
      dirtyTotal: afterMap.size,
      changedThisTurn: changed.slice(0, 100),
      diffStat: diffStat ? diffStat.trim().slice(0, 2000) : '',
    }
  }

  const touchedList = Array.isArray(opts.touchedFiles) ? opts.touchedFiles : []
  const hadShellCalls = opts.hadShellCalls !== false
  const rootAbs = resolve(cwd)
  /** @type {Map<string, string>} relPath -> status */
  const changedByPath = new Map()

  for (const rawPath of touchedList) {
    const abs = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootAbs, rawPath)
    const rel = relative(rootAbs, abs).replaceAll('\\', '/')
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    let existsNow = false
    try {
      await stat(abs)
      existsNow = true
    } catch {
      existsNow = false
    }
    const existedBefore = beforeSnap.map.has(rel)
    if (!existsNow && existedBefore) changedByPath.set(rel, 'D')
    else if (existsNow && !existedBefore) changedByPath.set(rel, 'A')
    else if (existsNow) changedByPath.set(rel, 'M')
  }

  let truncated = Boolean(beforeSnap.truncated)
  if (hadShellCalls) {
    const afterSnap = await captureFsSnapshot(cwd)
    truncated = truncated || afterSnap.truncated
    for (const [file, after] of afterSnap.map) {
      const before = beforeSnap.map.get(file)
      if (!before) {
        if (!truncated && !changedByPath.has(file)) changedByPath.set(file, 'A')
      } else if (before.sig !== after.sig && !changedByPath.has(file)) {
        changedByPath.set(file, 'M')
      }
    }
    if (!truncated) {
      for (const [file] of beforeSnap.map) {
        if (!afterSnap.map.has(file) && !changedByPath.has(file)) changedByPath.set(file, 'D')
      }
    }
  }

  const changed = [...changedByPath.entries()].map(([path, status]) => ({ path, status }))
  return {
    mode: 'fs',
    isGitRepo: false,
    dirtyTotal: changed.length,
    truncated,
    changedThisTurn: changed.slice(0, 100),
    diffStat: '',
  }
}

export function createDshHost(ctx, config, deps = {}, internals = {}) {
  const logger = internals.logger ?? createLogger(ctx?.logger)
  const sessionSeq = deps.SessionSeq ?? ((n) => n)
  /** @type {Map<string, any>} sessionName -> live DSH agent during an active turn */
  const activeAgents = new Map()
  /** @type {Map<string, string[]>} sessionName -> queued steer messages while agent is booting */
  const pendingSteers = new Map()
  /** @type {Map<string, {mode: string, allowCommands: string[], cwd?: string}>} dshSessionId -> policy */
  const agentPolicies = new Map()

  let disposeToolGuard = null
  let preExecutionGuardActive = false

  function ensureToolGuard() {
    if (preExecutionGuardActive) return true
    const tools = ctx?.get?.('tools')
    if (!tools || typeof tools.guard !== 'function') return false
    try {
      disposeToolGuard = tools.guard((exec) => {
        const sid = exec?.agent?.session?.id
        if (!sid) return undefined
        const policy = agentPolicies.get(sid)
        if (!policy || policy.mode === 'full') return undefined
        const violation = checkToolPolicy(policy, String(exec.name ?? ''), exec.arguments)
        if (!violation) return undefined
        return {
          reason: `${violation}. Do not retry this blocked action; use a read-only alternative or continue with the remaining read-only parts of the task.`,
          info: { name: 'PolicyDeniedError', code: 'policy_denied', reason: violation },
        }
      })
      preExecutionGuardActive = true
      logger.info('dsh-subagent: mounted synchronous pre-execution tool guard on ctx.tools')
      return true
    } catch (err) {
      logger.warn('dsh-subagent: failed to mount tools.guard(): ' + errorMessage(err))
      return false
    }
  }

  function listDshSessions() {
    const agents = ctx?.get?.('agents')
    if (!agents || typeof agents.list !== 'function') return []
    return agents.list().map((agent) => ({
      id: agent.id ?? agent.session?.id,
      title: agent.session?.header?.title ?? null,
      status: agent.status ?? 'unknown',
    }))
  }

  function latestRouteFromAgent(agent) {
    const session = agent?.session
    if (!session || typeof session.eventAt !== 'function' || typeof session.seq !== 'number') return null
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const evt = session.eventAt(sessionSeq(seq))
      if (evt?.type !== 'request/header') continue
      const cfg = evt.data?.header?.config
      if (typeof cfg?.provider === 'string' && typeof cfg?.model === 'string') {
        return {
          provider: cfg.provider,
          model: cfg.model,
          reasoningEffort: typeof cfg.reasoningEffort === 'string' ? cfg.reasoningEffort : undefined,
        }
      }
    }
    return null
  }

  function resolveRoute(overrideProvider, overrideModel, overrideEffort) {
    const defaults = ctx?.get?.('agentDefaultModel')
    let selection = {}
    try {
      selection = defaults?.currentSelection?.() ?? {}
    } catch {
      selection = {}
    }
    let inherited = null
    const agents = ctx?.get?.('agents')
    if (agents && typeof agents.list === 'function') {
      const list = agents.list()
      for (const a of list) {
        const r = latestRouteFromAgent(a)
        if (r) {
          inherited = r
          break
        }
      }
    }
    return {
      provider: overrideProvider || config.provider || selection.provider || inherited?.provider || undefined,
      model: overrideModel || config.defaultModel || selection.model || inherited?.model || undefined,
      reasoningEffort:
        overrideEffort || config.defaultEffort || selection.reasoningEffort || inherited?.reasoningEffort || undefined,
    }
  }

  function describeRoute() {
    return resolveRoute(undefined, undefined, undefined)
  }

  async function runTurn(input) {
    const agents = ctx?.get?.('agents')
    const sessions = ctx?.get?.('sessions')
    if (!agents) {
      throw new SubagentError('host-unavailable', 'DSH host has no "agents" registry mounted')
    }

    const mode = input.mode ?? 'full'
    const allowCommands = Array.isArray(input.allowCommands) ? input.allowCommands : []
    const shouldRedact = input.redactSecrets !== false

    const promptText = await composePrompt({
      prompt: input.prompt,
      cwd: input.cwd,
      files: input.files,
      appendSystem: input.appendSystem,
      isFirstTurn: input.isFirstTurn === true,
      mode,
      allowCommands,
    })

    const route = resolveRoute(input.provider, input.model, input.reasoningEffort)
    const agentOptions = {}
    if (route.provider) agentOptions.provider = route.provider
    if (route.model) agentOptions.model = route.model
    if (route.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort
    if (mode === 'readonly') agentOptions.permissionPreset = 'read-only'
    else if (mode === 'workspace') agentOptions.permissionPreset = 'workspace-write'

    const effectivePreset = config.agentPreset
    const resumeSessionId = optionalString(input.resumeSessionId)
    const beforeSnap = mode === 'readonly' ? null : await captureWorkspaceSnapshot(input.cwd)

    let handle
    try {
      if (resumeSessionId) {
        handle = await agents.resume({ resumeSessionId, agentOptions })
      } else {
        handle = await agents.create({
          sessionId: 'session-' + randomUUID(),
          meta: {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(effectivePreset ? { agentPreset: effectivePreset } : {}),
            title: `subagent:${input.name}`,
          },
          agentOptions,
        })
      }
    } catch (err) {
      throw new SubagentError('turn-failed', 'DSH failed to start/resume in-process agent: ' + errorMessage(err))
    }

    const agent = handle.agent
    const guardMounted = ensureToolGuard()
    if (agent?.session?.id && mode !== 'full') {
      agentPolicies.set(agent.session.id, { mode, allowCommands, cwd: input.cwd })
    }
    // Apply real DSH harness permission preset (sandbox + approval policy) BEFORE the turn executes.
    const permissionPresets = ctx?.get?.('permissionPresets')
    const approval = ctx?.get?.('approval')
    if (permissionPresets && typeof permissionPresets.apply === 'function') {
      const targetPreset =
        mode === 'readonly' ? 'read-only' : mode === 'workspace' ? 'workspace-write' : null
      if (targetPreset && (!Array.isArray(permissionPresets.names) || permissionPresets.names.includes(targetPreset))) {
        try {
          permissionPresets.apply(agent.session, targetPreset, (policy) => {
            approval?.setPolicy?.(agent, policy)
          })
        } catch (err) {
          logger.warn(`dsh-subagent: applying permission preset "${targetPreset}" failed: ${errorMessage(err)}`)
        }
      }
    }
    activeAgents.set(input.name, agent)
    try {
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      agent.followup(buildUserMessage(deps, promptText, 'dsh-subagent'))
      const queuedSteers = pendingSteers.get(input.name)
      if (queuedSteers && queuedSteers.length > 0) {
        pendingSteers.delete(input.name)
        for (const text of queuedSteers) {
          const sm = buildUserMessage(deps, `[PARENT STEER] ${text}`, 'dsh-subagent')
          if (typeof agent.steer === 'function') agent.steer(sm)
          else agent.followup(sm)
        }
      }

      const watched = await watchAgentTurn({
        agent,
        ctx,
        firstSeq,
        toSeq: sessionSeq,
        mode,
        allowCommands,
        cwd: input.cwd,
        preExecutionGuardActive: guardMounted,
        idleTimeoutMs: input.idleTimeoutMs,
        toolIdleTimeoutMs: input.toolIdleTimeoutMs,
        maxTurnMs: input.maxTurnMs,
        maxConsecutiveToolErrors: input.maxConsecutiveToolErrors,
        pollIntervalMs: deps.pollIntervalMs,
        askTrapGraceMs: deps.askTrapGraceMs,
        signal: input.signal,
        onProgress: input.onProgress,
      })

      if (sessions && typeof sessions.flush === 'function') {
        await sessions.flush(agent.session).catch((e) => {
          logger.warn('dsh-subagent: session flush failed: ' + errorMessage(e))
        })
      }

      const gitChanges =
        mode === 'readonly'
          ? null
          : await computeWorkspaceChanges(input.cwd, beforeSnap, {
              touchedFiles: watched.touchedFiles,
              hadShellCalls: watched.hadShellCalls,
            })
      const redactOpts = { redactPaths: false }
      const cleanText = shouldRedact ? redactSecrets(watched.text ?? '', redactOpts) : watched.text
      const cleanQuestion = watched.question
        ? { ...watched.question, text: shouldRedact ? redactSecrets(watched.question.text ?? '', redactOpts) : watched.question.text }
        : null
      const cleanError = watched.error
        ? { ...watched.error, message: shouldRedact ? redactSecrets(watched.error.message ?? '', redactOpts) : watched.error.message }
        : null
      const cleanStats = watched.stats
        ? {
            ...watched.stats,
            recentEvents: Array.isArray(watched.stats.recentEvents)
              ? watched.stats.recentEvents.map((ev) => ({
                  ...ev,
                  detail: shouldRedact ? redactSecrets(ev.detail ?? '', redactOpts) : ev.detail,
                }))
              : [],
          }
        : watched.stats

      return {
        ...watched,
        text: cleanText,
        question: cleanQuestion,
        error: cleanError,
        stats: cleanStats,
        sessionId: agent.session.id,
        resumed: Boolean(resumeSessionId),
        gitChanges,
      }
    } finally {
      if (agent?.session?.id) agentPolicies.delete(agent.session.id)
      activeAgents.delete(input.name)
      pendingSteers.delete(input.name)
      try {
        await handle.dispose()
      } catch (err) {
        logger.warn('dsh-subagent: agent dispose failed: ' + errorMessage(err))
      }
    }
  }

  async function steerTurn(sessionName, text) {
    const agent = activeAgents.get(sessionName)
    if (!agent) {
      // Turn is still booting (e.g. git status snapshot); queue so it is delivered immediately on start.
      const list = pendingSteers.get(sessionName) ?? []
      list.push(text)
      pendingSteers.set(sessionName, list)
      return
    }
    const msg = buildUserMessage(deps, `[PARENT STEER] ${text}`, 'dsh-subagent')
    if (typeof agent.steer === 'function') agent.steer(msg)
    else agent.followup(msg)
  }

  return {
    listDshSessions,
    describeRoute,
    resolveRoute,
    runTurn,
    steerTurn,
    dispose: async () => {
      agentPolicies.clear()
      if (typeof disposeToolGuard === 'function') {
        try {
          disposeToolGuard()
        } catch {
          /* ignore */
        }
        disposeToolGuard = null
        preExecutionGuardActive = false
      }
    },
  }
}

async function resolveToken(home, configured) {
  if (configured) return configured
  try {
    const raw = await readFile(join(home, BRIDGE_FILE), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.token === 'string' && parsed.token.length >= 32) return parsed.token
  } catch {
    /* create fresh token */
  }
  return newToken()
}

async function writeBridgeFile(home, record) {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const file = join(home, BRIDGE_FILE)
  await writeFile(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  try {
    await chmod(file, 0o600)
  } catch {
    /* non-POSIX filesystem */
  }
}

async function clearBridgeFile(home, token) {
  const file = join(home, BRIDGE_FILE)
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.token === token) await rm(file, { force: true })
  } catch {
    /* ignore */
  }
}

async function listenWithFallback(options, logger) {
  let bridge = createBridge(options)
  try {
    return { bridge, url: await bridge.listen() }
  } catch (err) {
    if (err?.code !== 'EADDRINUSE' || options.config.port === 0) throw err
    logger.warn(`dsh-subagent: port ${options.config.port} in use, falling back to OS-assigned port`)
    await bridge.close().catch(() => {})
    bridge = createBridge({ ...options, config: { ...options.config, port: 0 } })
    return { bridge, url: await bridge.listen() }
  }
}

export function createSubagentPlugin(deps = {}) {
  return {
    name,
    inject,
    async apply(ctx, rawConfig = {}) {
      const config = normalizeConfig(rawConfig)
      if (!config.enabled) return undefined
      const logger = deps.logger ?? createLogger(ctx?.logger)
      const home = resolveHome({ home: config.home })
      const store = createStore({ home, maxSessions: config.maxSessions, logger })
      await store.init()
      const host = createDshHost(ctx, config, deps, { logger })
      const token = await resolveToken(home, config.token)

      const liveFile = join(home, 'live.json')
      let liveWriteQueue = Promise.resolve()
      const writeLiveSnapshot = (snapshot) => {
        const body = JSON.stringify(snapshot) + '\n'
        liveWriteQueue = liveWriteQueue
          .then(async () => {
            const tmp = join(home, `.live.${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
            await writeFile(tmp, body, 'utf8')
            try {
              await rename(tmp, liveFile)
            } catch {
              await writeFile(liveFile, body, 'utf8')
              await rm(tmp, { force: true }).catch(() => {})
            }
          })
          .catch(() => {})
      }

      const { bridge, url } = await listenWithFallback(
        {
          store,
          host,
          onLiveSnapshot: writeLiveSnapshot,
          config: {
            host: config.host,
            port: config.port,
            token,
            profile: config.profile,
            webUrl: config.webUrl,
          },
          logger,
        },
        logger,
      )

      await writeBridgeFile(home, {
        version: PROTOCOL_VERSION,
        package: PACKAGE_NAME,
        packageVersion: PACKAGE_VERSION,
        url,
        token,
        pid: process.pid,
        profile: config.profile,
        webUrl: config.webUrl,
        startedAt: nowIso(),
      })
      logger.info(`dsh-subagent: listening at ${url} (home ${home})`)

      let closed = false
      const shutdown = async () => {
        if (closed) return
        closed = true
        await host.dispose?.().catch(() => {})
        await bridge.close().catch(() => {})
        await rm(liveFile, { force: true }).catch(() => {})
        await clearBridgeFile(home, token).catch(() => {})
        await store.close().catch(() => {})
      }

      if (typeof ctx?.effect === 'function') {
        ctx.effect(() => () => shutdown())
      }

      return { config, home, store, host, bridge, url, shutdown }
    },
  }
}

export async function apply(ctx, rawConfig = {}) {
  const plugin = createSubagentPlugin({ logger: createLogger(ctx?.logger) })
  await plugin.apply(ctx, rawConfig)
}

export default { name, inject, apply, createSubagentPlugin, normalizeConfig }
