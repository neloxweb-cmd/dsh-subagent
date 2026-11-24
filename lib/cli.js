/**
 * Zero-dependency CLI client & auto-daemon manager for @local/dsh-subagent.
 *
 * Designed for BOTH Antigravity (`run_command` background) and Claude Code
 * (`Bash(run_in_background: true)`): the CLI waits in 25s long-poll slices
 * until DeepSeek finishes, asks for input, gets stuck, or errors, then exits
 * immediately with a deterministic exit code to wake up the parent agent.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  DEFAULT_BRIDGE_PORT,
  DEFAULT_POLL_WAIT_SEC,
  DEFAULT_PROFILE_NAME,
  DEFAULT_WEB_PORT,
  EXIT_CODES,
  LOOPBACK_HOST,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SAFETY_MODES,
  TERMINAL_RUN_STATUSES,
  exitCodeForRunStatus,
  optionalString,
} from './protocol.js'
import {
  fetchRemoteTokenViaSsh,
  loadHosts,
  openRemoteConnection,
  runSafeSshScript,
  saveHosts,
  validateAlias,
} from './hosts.js'
import { generateBugReport } from './reporter.js'
import { performUpdate, resolveUpdateSource } from './updater.js'

const COMMANDS = Object.freeze([
  'start',
  'send',
  'steer',
  'status',
  'list',
  'watch',
  'log',
  'cancel',
  'close',
  'doctor',
  'daemon',
  'host',
  'ssh-exec',
  'update',
  'report',
  'help',
])

const FLAGS = Object.freeze({
  '--json': { key: 'json', kind: 'boolean' },
  '--cwd': { key: 'cwd', kind: 'string' },
  '--model': { key: 'model', kind: 'string' },
  '--provider': { key: 'provider', kind: 'string' },
  '--effort': { key: 'effort', kind: 'string' },
  '--append-system': { key: 'appendSystem', kind: 'string' },
  '--file': { key: 'files', kind: 'list' },
  '--prompt-file': { key: 'promptFile', kind: 'string' },
  '--mode': { key: 'mode', kind: 'string' },
  '--readonly': { key: 'readonly', kind: 'boolean' },
  '--allow-cmd': { key: 'allowCommands', kind: 'list' },
  '--no-redact': { key: 'noRedact', kind: 'boolean' },
  '--idle': { key: 'idle', kind: 'number' },
  '--tool-idle': { key: 'toolIdle', kind: 'number' },
  '--timeout': { key: 'timeout', kind: 'number' },
  '--max-tool-errors': { key: 'maxToolErrors', kind: 'number' },
  '--tail': { key: 'tail', kind: 'number' },
  '--no-wait': { key: 'noWait', kind: 'boolean' },
  '--no-autostart': { key: 'noAutostart', kind: 'boolean' },
  '--fix': { key: 'fix', kind: 'boolean' },
  '--force': { key: 'force', kind: 'boolean' },
  '--verbose': { key: 'verbose', kind: 'boolean' },
  '--host': { key: 'host', kind: 'string' },
  '--ssh': { key: 'ssh', kind: 'string' },
  '--remote-port': { key: 'remotePort', kind: 'number' },
  '--url': { key: 'url', kind: 'string' },
  '--token': { key: 'token', kind: 'string' },
  '--profile': { key: 'profile', kind: 'string' },
  '--repo': { key: 'repo', kind: 'string' },
  '--branch': { key: 'branch', kind: 'string' },
  '--help': { key: 'help', kind: 'boolean' },
  '-h': { key: 'help', kind: 'boolean' },
  '--version': { key: 'version', kind: 'boolean' },
})

const HELP_TEXT = [
  'ds-subagent - DeepSeek Harness subagent CLI for Antigravity & Claude Code',
  '',
  'Usage:',
  '  ds-subagent start  <name> [options] <prompt>|-    start a named session & run first turn',
  '  ds-subagent send   <name> [options] <prompt>|-    continue an existing named session',
  '  ds-subagent steer  <name> <text>|-                inject mid-flight guidance into a running turn',
  '  ds-subagent status [name] [--json]                list sessions or inspect live progress',
  '  ds-subagent watch  [name]                         live minimalist tasklist viewer in terminal',
  '  ds-subagent log    <name> [--tail N] [--json]     read session transcript',
  '  ds-subagent cancel <name> [--json]                cleanly abort active turn (keeps session)',
  '  ds-subagent close  <name> [--force] [--json]      close a finished session',
  '  ds-subagent doctor [--fix] [--json]               diagnose (& optionally auto-start) daemon',
  '  ds-subagent daemon start|stop|status|autostart    manage local/systemd background daemon',
  '  ds-subagent host   add|list|remove                manage remote Linux servers (SSH / Tailscale)',
  '  ds-subagent ssh-exec <user@host> [--file f | -]   run a script safely over SSH via stdin',
  '  ds-subagent update [--repo owner/repo] [--branch main]  update to latest version from GitHub',
  '  ds-subagent report [--json]                       generate a safe, redacted bug report to share',
  '',
  'Turn options (start / send):',
  '  --cwd <dir>               working directory for the subagent (recommended for start)',
  '  --mode <mode>             safety mode: readonly | workspace | full (default: full)',
  '  --readonly                shorthand for --mode readonly',
  '  --allow-cmd <prefix>      allowed read-only shell command prefix (repeatable, readonly mode)',
  '  --no-redact               disable automatic secret redaction on turn output',
  '  --host <alias>            run against a configured remote host (from `ds-subagent host add`)',
  '  --effort <level>          low | medium | high | xhigh | max',
  '  --model <id>              override model id',
  '  --provider <id>           override provider id',
  '  --append-system <str|@f>  extra standing instructions (use @path to read from file)',
  '  --file <path>             attach context file contents (repeatable)',
  '  --prompt-file <path>      read prompt from UTF-8 file (avoids shell quoting limits)',
  '  --idle <sec>              idle watchdog without session events (default: 180)',
  '  --tool-idle <sec>         idle watchdog while a tool is running (default: 360)',
  '  --timeout <sec>           hard max turn duration (default: 1800)',
  '  --max-tool-errors <n>     consecutive failing tool calls before STUCK (default: 6; 0=off)',
  '  --no-wait                 queue turn and exit immediately with runId',
  '  --no-autostart            fail instead of auto-starting the DSH daemon',
  '  --verbose                 stream progress ticks to stderr while waiting',
  '  --json                    machine-readable JSON output on stdout',
  '',
  'Exit codes:',
  '  0   done            task completed cleanly',
  '  10  needs_input     subagent needs an answer/decision (reply with `ds-subagent send`)',
  '  11  stuck           idle timeout, max-turn timeout, or repeated tool error loop',
  '  12  cancelled       turn cancelled',
  '  13  blocked_policy  blocked by --mode readonly or --mode workspace',
  '  4   error           model/API/runtime error',
  '  2   bridge_down     daemon unreachable or failed to start',
  '  3   unauthorized    invalid or missing bearer token',
  '  1   usage           invalid CLI arguments',
  '',
].join('\n')

export class CliError extends Error {
  constructor(message, exitCode = EXIT_CODES.USAGE, code = 'error') {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.code = code
  }
}

export function parseArgs(argv = []) {
  const options = {}
  const tokens = []
  let i = 0
  while (i < argv.length) {
    const raw = String(argv[i])
    if (raw === '--') {
      for (let j = i + 1; j < argv.length; j += 1) tokens.push(String(argv[j]))
      break
    }
    if (raw === '-') {
      tokens.push(raw)
      i += 1
      continue
    }
    if (raw.startsWith('--') || raw === '-h') {
      let flag = raw
      let inline
      if (raw.startsWith('--')) {
        const eq = raw.indexOf('=')
        if (eq !== -1) {
          flag = raw.slice(0, eq)
          inline = raw.slice(eq + 1)
        }
      }
      const spec = FLAGS[flag]
      if (!spec) throw new CliError(`unknown option "${flag}"`, EXIT_CODES.USAGE, 'usage')
      if (spec.kind === 'boolean') {
        if (inline !== undefined) throw new CliError(`${flag} does not take a value`, EXIT_CODES.USAGE, 'usage')
        options[spec.key] = true
        i += 1
        continue
      }
      let value = inline
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new CliError(`${flag} requires a value`, EXIT_CODES.USAGE, 'usage')
        value = String(argv[i + 1])
        i += 2
      } else {
        i += 1
      }
      if (spec.kind === 'number') {
        const n = Number(value)
        if (!Number.isFinite(n) || n < 0) {
          throw new CliError(`${flag} must be a non-negative number`, EXIT_CODES.USAGE, 'usage')
        }
        options[spec.key] = n
      } else if (spec.kind === 'list') {
        if (!Array.isArray(options[spec.key])) options[spec.key] = []
        options[spec.key].push(value)
      } else {
        options[spec.key] = value
      }
      continue
    }
    if (raw.startsWith('-')) throw new CliError(`unknown option "${raw}"`, EXIT_CODES.USAGE, 'usage')
    tokens.push(raw)
    i += 1
  }
  return {
    command: tokens[0] ?? null,
    options,
    positional: tokens.slice(1),
  }
}

export function resolveHome(env = process.env) {
  return optionalString(env.DSH_SUBAGENT_HOME) ?? join(homedir(), '.dsh-subagent')
}

export function findDshBinary(env = process.env) {
  const override = optionalString(env.DSH_CMD)
  if (override && existsSync(override)) return override
  const candidates = [
    join(homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    'C:\\Program Files\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    join(homedir(), '.local', 'bin', 'dsh'),
    join(homedir(), 'bin', 'dsh'),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  const pathEnv = env.PATH || env.Path || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const names = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh'] : ['dsh']
  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue
    for (const n of names) {
      const full = join(dir, n)
      if (existsSync(full)) return full
    }
  }
  return null
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function readBridgeDiscovery(context) {
  const home = resolveHome(context.env)
  const bridgeFile = join(home, 'bridge.json')
  let record = null
  let recordError = null
  try {
    record = JSON.parse(readFileSync(bridgeFile, 'utf8'))
  } catch (err) {
    recordError = err?.code === 'ENOENT' ? 'missing' : err.message
  }
  const url =
    optionalString(context.options.url) ??
    optionalString(context.env.DSH_SUBAGENT_URL) ??
    optionalString(record?.url) ??
    `http://${LOOPBACK_HOST}:${DEFAULT_BRIDGE_PORT}`
  const token =
    optionalString(context.options.token) ??
    optionalString(context.env.DSH_SUBAGENT_TOKEN) ??
    optionalString(record?.token) ??
    ''
  return {
    home,
    bridgeFile,
    record,
    recordError,
    url: url.replace(/\/+$/, ''),
    token,
  }
}

async function httpJson(client, method, path, body, timeoutMs = 35_000) {
  const headers = { accept: 'application/json' }
  if (client.token) headers.authorization = `Bearer ${client.token}`
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let res
  try {
    res = await client.fetchImpl(client.url + path, init)
  } catch (err) {
    const code = err?.cause?.code ?? err?.name ?? 'network'
    throw new CliError(`bridge unreachable at ${client.url} (${code})`, EXIT_CODES.BRIDGE_DOWN, 'bridge_down')
  }
  const raw = await res.text()
  let payload = null
  if (raw) {
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = null
    }
  }
  if (!res.ok) {
    const errCode = optionalString(payload?.error?.code) ?? 'http'
    const msg = optionalString(payload?.error?.message) ?? (raw || `HTTP ${res.status}`)
    if (res.status === 401 || res.status === 403 || errCode === 'unauthorized') {
      throw new CliError(`unauthorized: ${msg}`, EXIT_CODES.UNAUTHORIZED, 'unauthorized')
    }
    if (errCode === 'host-unavailable' || errCode === 'turn-failed') {
      throw new CliError(msg, EXIT_CODES.ERROR, errCode)
    }
    throw new CliError(`${errCode}: ${msg}`, EXIT_CODES.USAGE, errCode)
  }
  return payload
}

async function probeHealth(context) {
  const disc = readBridgeDiscovery(context)
  if (!disc.token) return { ok: false, disc, health: null, error: 'no token found', exitCode: EXIT_CODES.BRIDGE_DOWN, code: 'bridge_down' }
  try {
    const health = await httpJson({ url: disc.url, token: disc.token, fetchImpl: context.fetchImpl }, 'GET', '/v1/health', undefined, 4000)
    return { ok: true, disc, health, error: null, exitCode: EXIT_CODES.OK, code: 'ok' }
  } catch (err) {
    return {
      ok: false,
      disc,
      health: null,
      error: err.message,
      exitCode: err instanceof CliError ? err.exitCode : EXIT_CODES.BRIDGE_DOWN,
      code: err instanceof CliError ? err.code : 'bridge_down',
    }
  }
}

async function startDaemon(context) {
  const existing = await probeHealth(context)
  if (existing.ok) return { alreadyRunning: true, health: existing.health, url: existing.disc.url }

  const dshBin = findDshBinary(context.env)
  if (!dshBin) {
    throw new CliError(
      'DeepSeek Harness CLI (dsh.cmd) not found; install DeepSeek Harness or set DSH_CMD',
      EXIT_CODES.BRIDGE_DOWN,
      'bridge_down',
    )
  }

  const home = resolveHome(context.env)
  mkdirSync(home, { recursive: true })
  const logPath = join(home, 'daemon.log')
  const pidPath = join(home, 'daemon.pid')
  const profile = optionalString(context.options.profile) ?? optionalString(context.env.DSH_SUBAGENT_PROFILE) ?? DEFAULT_PROFILE_NAME
  const webPort = Number(context.env.DSH_SUBAGENT_WEB_PORT || DEFAULT_WEB_PORT)

  const logFd = openSync(logPath, 'a')
  let child
  try {
    const args = ['--profile', profile, '--no-open', '--host', LOOPBACK_HOST, '--port', String(webPort)]
    const daemonEnv = {
      ...context.env,
      DSH_SUBAGENT_HOME: home,
      DSH_SUBAGENT_PROFILE: profile,
      DSH_WEB_URL: `http://${LOOPBACK_HOST}:${webPort}`,
      DSH_PERMISSION_MODE: 'danger-full-access',
    }
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(dshBin)) {
      // Resolve Electron host directly from dsh.cmd's layout to avoid cmd.exe quoting issues with spaces.
      const electronExe = resolve(dshBin, '..', '..', '..', '..', '..', 'DeepSeek Harness.exe')
      const cliEntry = resolve(dshBin, '..', '..', '..', '..', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
      if (existsSync(electronExe)) {
        child = spawn(electronExe, ['--expose-internals', cliEntry, ...args], {
          detached: true,
          windowsHide: true,
          stdio: ['ignore', logFd, logFd],
          env: { ...daemonEnv, ELECTRON_RUN_AS_NODE: '1' },
        })
      } else {
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `"${dshBin}"`, ...args], {
          detached: true,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['ignore', logFd, logFd],
          env: daemonEnv,
        })
      }
    } else {
      child = spawn(dshBin, args, {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
        env: daemonEnv,
      })
    }
    child.unref()
  } finally {
    closeSync(logFd)
  }

  if (child?.pid) {
    writeFileSync(pidPath, String(child.pid) + '\n', 'utf8')
  }

  // Wait up to 35s for the DSH host & plugin bridge to come online.
  const deadline = Date.now() + 35_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600))
    const check = await probeHealth(context)
    if (check.ok) {
      return { alreadyRunning: false, pid: check.health.pid ?? child?.pid, health: check.health, url: check.disc.url, logPath }
    }
  }

  throw new CliError(
    `DSH subagent daemon failed to become healthy within 35s; check ${logPath}`,
    EXIT_CODES.BRIDGE_DOWN,
    'bridge_down',
  )
}

function killPidTree(pid) {
  return new Promise((resolvePromise) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolvePromise(false)
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {
        resolvePromise(true)
      })
    } else {
      try {
        process.kill(pid, 'SIGTERM')
        resolvePromise(true)
      } catch {
        resolvePromise(false)
      }
    }
  })
}

async function stopDaemon(context) {
  const disc = readBridgeDiscovery(context)
  const pidPath = join(disc.home, 'daemon.pid')
  const pids = new Set()
  if (Number.isInteger(disc.record?.pid)) pids.add(disc.record.pid)
  try {
    const fromFile = Number(readFileSync(pidPath, 'utf8').trim())
    if (Number.isInteger(fromFile) && fromFile > 0) pids.add(fromFile)
  } catch {
    /* ignore */
  }
  const killed = []
  for (const pid of pids) {
    if (isPidAlive(pid)) {
      await killPidTree(pid)
      killed.push(pid)
    }
  }
  try {
    rmSync(pidPath, { force: true })
  } catch {
    /* ignore */
  }
  return { stopped: killed.length > 0, killedPids: killed }
}

async function ensureClient(context, allowAutostart = true) {
  const explicitEndpoint = Boolean(optionalString(context.options.url) || optionalString(context.env.DSH_SUBAGENT_URL))
  let probe = await probeHealth(context)
  if (!probe.ok && allowAutostart && !context.options.noAutostart && !explicitEndpoint) {
    if (context.options.verbose) {
      context.stderr.write('[ds-subagent] daemon offline, starting DSH subagent host...\n')
    }
    await startDaemon(context)
    probe = await probeHealth(context)
  }
  if (!probe.ok) {
    const disc = probe.disc
    if (!disc.token) {
      throw new CliError(
        `bridge unreachable and no token found at ${disc.bridgeFile}; run "ds-subagent daemon start"`,
        EXIT_CODES.BRIDGE_DOWN,
        'bridge_down',
      )
    }
    throw new CliError(probe.error || `bridge unreachable at ${disc.url}`, probe.exitCode ?? EXIT_CODES.BRIDGE_DOWN, probe.code ?? 'bridge_down')
  }
  return { url: probe.disc.url, token: probe.disc.token, fetchImpl: context.fetchImpl }
}

async function readStdinText(stdin) {
  if (typeof stdin === 'string') return stdin
  const chunks = []
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function resolvePrompt(context, positionalArgs) {
  if (context.options.promptFile) {
    const filePath = isAbsolute(context.options.promptFile)
      ? context.options.promptFile
      : resolve(context.cwd, context.options.promptFile)
    const content = readFileSync(filePath, 'utf8').trim()
    if (!content) throw new CliError(`prompt file is empty: ${filePath}`, EXIT_CODES.USAGE, 'usage')
    return content
  }
  if (positionalArgs.length === 0) {
    throw new CliError('prompt is required (pass inline text, --prompt-file <path>, or "-" for stdin)', EXIT_CODES.USAGE, 'usage')
  }
  if (positionalArgs.length === 1 && positionalArgs[0] === '-') {
    const content = (await readStdinText(context.stdin)).trim()
    if (!content) throw new CliError('stdin prompt is empty', EXIT_CODES.USAGE, 'usage')
    return content
  }
  return positionalArgs.join(' ').trim()
}

function resolveMaybeAtFile(value, cwd) {
  if (!value) return undefined
  if (value.startsWith('@')) {
    const rawPath = value.slice(1)
    const abs = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
    return readFileSync(abs, 'utf8')
  }
  return value
}

function fmtDuration(ms) {
  const sec = Math.max(0, Math.round((ms ?? 0) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${String(s).padStart(2, '0')}s`
}

function fmtTokens(usage) {
  if (!usage || typeof usage !== 'object') return ''
  const inp = Number(usage.inputTokens || 0)
  const out = Number(usage.outputTokens || 0)
  const cache = Number(usage.cacheReadTokens || 0)
  if (inp === 0 && out === 0) return ''
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  return `${k(inp)} in${cache > 0 ? ` (${k(cache)} cached)` : ''} / ${k(out)} out`
}

function renderTodoLines(todos) {
  if (!Array.isArray(todos) || todos.length === 0) return []
  return todos.map((t, idx) => {
    const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : t.status === 'cancelled' ? '×' : '○'
    return `  ${mark} ${idx + 1}. ${t.content}`
  })
}

function renderRunOutcome(context, run, session) {
  if (context.options.json) {
    context.stdout.write(JSON.stringify({ ok: run.status === 'done', run, session }, null, 2) + '\n')
    return
  }
  const p = run.progress ?? {}
  const tok = fmtTokens(p.usage)
  const lines = [
    `STATUS: ${String(run.status ?? 'unknown').toUpperCase()}${run.reason ? ` (${run.reason})` : ''}${run.mode && run.mode !== 'full' ? ` [mode: ${run.mode}]` : ''}`,
    `SESSION: ${run.name}${run.dshSessionId ? `  [dsh: ${run.dshSessionId}]` : ''}`,
    `STATS: ${fmtDuration(p.elapsedMs)} | steps: ${p.steps ?? 0} | tools: ${p.toolCalls ?? 0}${p.lastTool ? ` | last_tool: ${p.lastTool}` : ''}${tok ? ` | tokens: ${tok}` : ''}`,
  ]
  if (run.gitChanges?.changedThisTurn?.length > 0) {
    const label = run.gitChanges.isGitRepo === false ? 'CHANGED_FILES (fs)' : 'CHANGED_FILES'
    const files = run.gitChanges.changedThisTurn.map((f) => `${f.status} ${f.path}`).join(', ')
    lines.push(`${label}: ${files}`)
  }
  if (Array.isArray(p.todos) && p.todos.length > 0) {
    const done = p.todos.filter((t) => t.status === 'completed').length
    lines.push(`TASKS (${done}/${p.todos.length}):`)
    lines.push(...renderTodoLines(p.todos))
  }
  lines.push('---')
  if (run.status === 'needs_input') {
    lines.push(run.question?.text || run.reply || '(agent requested input)')
    lines.push('')
    lines.push(`Next: reply with \`ds-subagent send ${run.name} "<your answer>"\``)
  } else if (run.status === 'blocked_policy' || run.status === 'stuck' || run.status === 'error') {
    if (run.error?.message) lines.push(`ERROR: ${run.error.message}`)
    if (run.reply) {
      lines.push('')
      lines.push(run.reply)
    }
    const recent = Array.isArray(p.recentEvents) ? p.recentEvents.slice(-8) : []
    if (recent.length > 0) {
      lines.push('')
      lines.push('LAST_EVENTS:')
      for (const e of recent) lines.push(`  [${e.type}] ${e.detail}`)
    }
    lines.push('')
    lines.push(`Next: inspect with \`ds-subagent log ${run.name}\` or resume with \`ds-subagent send ${run.name} "<guidance>"\``)
  } else {
    lines.push(run.reply || '(empty reply)')
  }
  context.stdout.write(lines.join('\n') + '\n')
}

async function waitForRun(context, client, runId) {
  let consecutiveNetErrors = 0
  for (;;) {
    try {
      const data = await httpJson(
        client,
        'GET',
        `/v1/runs/${encodeURIComponent(runId)}?wait=${DEFAULT_POLL_WAIT_SEC}`,
        undefined,
        (DEFAULT_POLL_WAIT_SEC + 15) * 1000,
      )
      consecutiveNetErrors = 0
      const run = data.run
      if (TERMINAL_RUN_STATUSES.includes(run.status)) {
        return data
      }
      if (context.options.verbose) {
        const p = run.progress ?? {}
        context.stderr.write(
          `[ds-subagent:${run.name}] ${fmtDuration(p.elapsedMs)} · steps=${p.steps ?? 0} · tools=${p.toolCalls ?? 0} · last=${p.lastTool ?? '-'}\n`,
        )
      }
    } catch (err) {
      if (err instanceof CliError && err.code === 'bridge_down') {
        consecutiveNetErrors += 1
        if (consecutiveNetErrors <= 3) {
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }
      }
      throw err
    }
  }
}

async function commandStartOrSend(context, isStart) {
  const name = context.positional[0]
  if (!name) {
    throw new CliError(`"${isStart ? 'start' : 'send'}" requires <name> and <prompt>`, EXIT_CODES.USAGE, 'usage')
  }
  const prompt = await resolvePrompt(context, context.positional.slice(1))
  const client = await ensureClient(context, true)

  const mode = context.options.readonly ? 'readonly' : optionalString(context.options.mode)
  if (mode !== undefined && !SAFETY_MODES.includes(mode)) {
    throw new CliError(`--mode must be one of: ${SAFETY_MODES.join(', ')}`, EXIT_CODES.USAGE, 'usage')
  }
  const isRemote = Boolean(optionalString(context.options.host) || optionalString(context.options.url))
  const cwdValue = context.options.cwd
    ? isRemote
      ? context.options.cwd
      : resolve(context.cwd, context.options.cwd)
    : isStart && !isRemote
      ? context.cwd
      : undefined

  const body = {
    prompt,
    createIfMissing: isStart,
    cwd: cwdValue,
    mode,
    allowCommands: Array.isArray(context.options.allowCommands) ? context.options.allowCommands : undefined,
    redactSecrets: context.options.noRedact ? false : true,
    model: context.options.model,
    provider: context.options.provider,
    reasoningEffort: context.options.effort,
    appendSystem: resolveMaybeAtFile(context.options.appendSystem, context.cwd),
    files: Array.isArray(context.options.files)
      ? context.options.files.map((f) => (isAbsolute(f) ? f : resolve(context.cwd, f)))
      : undefined,
    idleTimeoutSec: context.options.idle,
    toolIdleTimeoutSec: context.options.toolIdle,
    maxTurnSec: context.options.timeout,
    maxConsecutiveToolErrors: context.options.maxToolErrors,
  }

  const started = await httpJson(
    client,
    'POST',
    `/v1/sessions/${encodeURIComponent(name)}/turns`,
    body,
    30_000,
  )

  if (context.options.noWait) {
    if (context.options.json) {
      context.stdout.write(JSON.stringify({ ok: true, run: started.run, session: started.session }, null, 2) + '\n')
    } else {
      context.stdout.write(`QUEUED: ${started.run.name} (${started.run.runId})\n`)
    }
    return EXIT_CODES.OK
  }

  const settled = await waitForRun(context, client, started.run.runId)
  renderRunOutcome(context, settled.run, settled.session)
  return exitCodeForRunStatus(settled.run.status)
}

async function commandSteer(context) {
  const name = context.positional[0]
  if (!name) throw new CliError('steer requires <name> and <text>', EXIT_CODES.USAGE, 'usage')
  const text = await resolvePrompt(context, context.positional.slice(1))
  const client = await ensureClient(context, false)
  const res = await httpJson(client, 'POST', `/v1/sessions/${encodeURIComponent(name)}/steer`, { text }, 15_000)
  if (context.options.json) context.stdout.write(JSON.stringify(res, null, 2) + '\n')
  else context.stdout.write(`STEERED: ${name} (${res.runId})\n`)
  return EXIT_CODES.OK
}

async function commandStatus(context) {
  const client = await ensureClient(context, false)
  const name = context.positional[0]
  if (name) {
    const data = await httpJson(client, 'GET', `/v1/sessions/${encodeURIComponent(name)}`, undefined, 15_000)
    if (context.options.json) {
      context.stdout.write(JSON.stringify(data, null, 2) + '\n')
      return EXIT_CODES.OK
    }
    const s = data.session
    const lines = [
      `SESSION: ${s.name}  (${s.status}${data.running ? ', RUNNING' : ''}${s.mode && s.mode !== 'full' ? `, mode=${s.mode}` : ''})`,
      `CWD:     ${s.cwd ?? '-'}`,
      `DSH_ID:  ${s.dshSessionId ?? '-'}`,
      `TURNS:   ${s.turnCount}  | last_outcome: ${s.lastOutcome ?? '-'}`,
    ]
    const liveProgress = data.activeRun?.progress ?? data.lastRun?.progress
    if (data.activeRun?.progress) {
      const p = data.activeRun.progress
      const tok = fmtTokens(p.usage)
      lines.push(
        `LIVE:    ${fmtDuration(p.elapsedMs)} elapsed | ${fmtDuration(p.idleMs)} idle | steps=${p.steps} | tools=${p.toolCalls}${tok ? ` | tokens: ${tok}` : ''}`,
      )
      if (p.currentActivity) lines.push(`NOW:     ${p.currentActivity}`)
    }
    if (Array.isArray(liveProgress?.todos) && liveProgress.todos.length > 0) {
      const done = liveProgress.todos.filter((t) => t.status === 'completed').length
      lines.push(`TASKS (${done}/${liveProgress.todos.length}):`)
      lines.push(...renderTodoLines(liveProgress.todos))
    }
    if (data.activeRun?.progress?.recentEvents?.length > 0) {
      for (const e of data.activeRun.progress.recentEvents.slice(-6)) {
        lines.push(`  [${e.type}] ${e.detail}`)
      }
    }
    context.stdout.write(lines.join('\n') + '\n')
    return EXIT_CODES.OK
  }

  const data = await httpJson(client, 'GET', '/v1/sessions', undefined, 15_000)
  if (context.options.json) {
    context.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return EXIT_CODES.OK
  }
  const sessions = data.sessions ?? []
  if (sessions.length === 0) {
    context.stdout.write('(no subagent sessions yet)\n')
    return EXIT_CODES.OK
  }
  for (const s of sessions) {
    const state = s.running ? 'RUNNING' : s.status.toUpperCase()
    const live = s.running && s.progress ? ` (${fmtDuration(s.progress.elapsedMs)}, tools=${s.progress.toolCalls})` : ''
    context.stdout.write(
      `${s.name.padEnd(20)} ${state.padEnd(8)} turns=${String(s.turnCount).padEnd(3)} outcome=${String(s.lastOutcome ?? '-').padEnd(11)}${live}  ${s.cwd ?? ''}\n`,
    )
  }
  return EXIT_CODES.OK
}

async function commandLog(context) {
  const name = context.positional[0]
  if (!name) throw new CliError('log requires <name>', EXIT_CODES.USAGE, 'usage')
  const tail = context.options.tail ?? 30
  const client = await ensureClient(context, false)
  const data = await httpJson(client, 'GET', `/v1/sessions/${encodeURIComponent(name)}/log?tail=${tail}`, undefined, 15_000)
  if (context.options.json) {
    context.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return EXIT_CODES.OK
  }
  for (const e of data.events ?? []) {
    const ts = String(e.at ?? '').replace('T', ' ').slice(0, 19)
    const detail = e.prompt || e.reply || e.text || e.error?.message || ''
    context.stdout.write(`[${ts}] ${e.kind}${e.status ? `(${e.status})` : ''}: ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}\n`)
  }
  return EXIT_CODES.OK
}

async function commandCancel(context) {
  const name = context.positional[0]
  if (!name) throw new CliError('cancel requires <name>', EXIT_CODES.USAGE, 'usage')
  const client = await ensureClient(context, false)
  const res = await httpJson(client, 'POST', `/v1/sessions/${encodeURIComponent(name)}/cancel`, {}, 15_000)
  if (context.options.json) context.stdout.write(JSON.stringify(res, null, 2) + '\n')
  else context.stdout.write(res.cancelled ? `CANCELLED: ${name}\n` : `IDLE: ${name} (nothing running)\n`)
  return EXIT_CODES.OK
}

async function commandClose(context) {
  const name = context.positional[0]
  if (!name) throw new CliError('close requires <name>', EXIT_CODES.USAGE, 'usage')
  const client = await ensureClient(context, false)
  const res = await httpJson(
    client,
    'POST',
    `/v1/sessions/${encodeURIComponent(name)}/close`,
    { force: context.options.force === true },
    15_000,
  )
  if (context.options.json) context.stdout.write(JSON.stringify(res, null, 2) + '\n')
  else context.stdout.write(`CLOSED: ${res.session.name}\n`)
  return EXIT_CODES.OK
}

async function commandWatch(context) {
  const client = await ensureClient(context, false)
  const targetName = context.positional[0]
  const isTty = Boolean(context.stdout.isTTY)
  for (;;) {
    const data = await httpJson(client, 'GET', '/v1/sessions', undefined, 10_000)
    const sessions = (data.sessions ?? []).filter((s) => (targetName ? s.name === targetName : s.running))
    const out = []
    if (sessions.length === 0) {
      out.push(targetName ? `Session "${targetName}" not found.` : 'Geen actieve DeepSeek-subagents op dit moment (Ctrl+C om te stoppen)...')
    } else {
      for (const s of sessions) {
        const p = s.progress ?? {}
        const tok = fmtTokens(p.usage)
        const badge = s.running ? '● BEZIG' : `○ ${String(s.lastOutcome ?? s.status).toUpperCase()}`
        out.push(
          `${badge}  ${s.name}  (${fmtDuration(p.elapsedMs)})  tools=${p.toolCalls ?? 0}${tok ? ` · ${tok}` : ''}`,
        )
        if (p.currentActivity) out.push(`  Nu: ${p.currentActivity}`)
        if (Array.isArray(p.todos) && p.todos.length > 0) {
          out.push(...renderTodoLines(p.todos))
        }
        out.push('')
      }
    }
    if (isTty) context.stdout.write('\x1b[2J\x1b[H')
    context.stdout.write(out.join('\n') + '\n')
    if (targetName && sessions.length > 0 && !sessions[0].running) return EXIT_CODES.OK
    await new Promise((r) => setTimeout(r, 1500))
  }
}

async function commandDoctor(context) {
  let probe = await probeHealth(context)
  let autoFixed = false
  const isRemote = Boolean(optionalString(context.options.host) || optionalString(context.options.url))
  if (context.options.fix && !isRemote) {
    if (!probe.ok) {
      if (!context.options.json) context.stderr.write('[ds-subagent] daemon offline — starting automatically (--fix)...\n')
      await startDaemon(context)
      probe = await probeHealth(context)
      autoFixed = probe.ok
    } else if (probe.health?.packageVersion && probe.health.packageVersion !== PACKAGE_VERSION) {
      if (!context.options.json) {
        context.stderr.write(
          `[ds-subagent] daemon version mismatch (${probe.health.packageVersion} != ${PACKAGE_VERSION}) — restarting (--fix)...\n`,
        )
      }
      await stopDaemon(context)
      await startDaemon(context)
      probe = await probeHealth(context)
      autoFixed = probe.ok
    }
  }
  const dshBin = findDshBinary(context.env)
  const tokenFp = probe.disc.token ? createHash('sha256').update(probe.disc.token).digest('hex').slice(0, 12) : null
  const report = {
    ok: probe.ok,
    autoFixed,
    home: probe.disc.home,
    dshBinary: dshBin,
    bridgeFile: {
      path: probe.disc.bridgeFile,
      exists: probe.disc.record !== null,
      pid: probe.disc.record?.pid ?? null,
      alive: isPidAlive(probe.disc.record?.pid),
      url: probe.disc.url,
    },
    tokenFingerprint: tokenFp,
    health: probe.health,
    error: probe.error,
  }
  if (context.options.json) {
    context.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    const lines = [
      `home        ${report.home}`,
      `dsh binary  ${dshBin ?? 'NOT FOUND'}`,
      `bridge      ${probe.ok ? `OK (${report.bridgeFile.url}, pid ${probe.health.pid})${autoFixed ? ' [auto-started]' : ''}` : `DOWN (${probe.error})`}`,
    ]
    if (probe.ok) {
      const r = probe.health.route ?? {}
      lines.push(`route       ${r.provider ?? '?'} / ${r.model ?? '?'}${r.reasoningEffort ? ` (effort: ${r.reasoningEffort})` : ''}`)
      if (probe.health.webUrl) lines.push(`web ui      ${probe.health.webUrl}`)
      lines.push(`sessions    ${probe.health.sessionCount} total, ${(probe.health.activeRuns ?? []).length} running`)
    } else if (!isRemote) {
      lines.push('tip         run "ds-subagent doctor --fix" to start the daemon automatically')
    }
    context.stdout.write(lines.join('\n') + '\n')
  }
  return probe.ok ? EXIT_CODES.OK : EXIT_CODES.BRIDGE_DOWN
}

function configureAutostart(context, enable) {
  if (process.platform === 'win32') {
    const startupDir = join(
      context.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
    )
    const target = join(startupDir, 'dsh-subagent-daemon.vbs')
    if (!enable) {
      rmSync(target, { force: true })
      return { enabled: false, path: target }
    }
    mkdirSync(startupDir, { recursive: true })
    const cmdPath = join(homedir(), 'bin', 'ds-subagent.cmd')
    const vbs = `CreateObject("WScript.Shell").Run """${cmdPath}"" daemon start", 0, False\r\n`
    writeFileSync(target, vbs, 'utf8')
    return { enabled: true, path: target }
  }

  // Linux systemd --user service
  const unitDir = join(homedir(), '.config', 'systemd', 'user')
  const unitPath = join(unitDir, 'dsh-subagent.service')
  const dshBin = findDshBinary(context.env) || 'dsh'
  const profile = optionalString(context.options.profile) ?? DEFAULT_PROFILE_NAME
  const webPort = Number(context.env.DSH_SUBAGENT_WEB_PORT || DEFAULT_WEB_PORT)
  if (!enable) {
    rmSync(unitPath, { force: true })
    return { enabled: false, path: unitPath }
  }
  mkdirSync(unitDir, { recursive: true })
  const unit = [
    '[Unit]',
    'Description=DeepSeek Harness Subagent Daemon',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${dshBin} --profile ${profile} --no-open --host 127.0.0.1 --port ${webPort}`,
    'Restart=always',
    'RestartSec=3',
    `Environment=DSH_SUBAGENT_PROFILE=${profile}`,
    'Environment=DSH_PERMISSION_MODE=danger-full-access',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
  writeFileSync(unitPath, unit, 'utf8')
  return { enabled: true, path: unitPath, next: 'systemctl --user daemon-reload && systemctl --user enable --now dsh-subagent.service' }
}

async function commandDaemon(context) {
  const sub = context.positional[0] ?? 'status'
  if (sub === 'status') return commandDoctor(context)
  if (sub === 'start') {
    const res = await startDaemon(context)
    if (context.options.json) context.stdout.write(JSON.stringify({ ok: true, ...res }, null, 2) + '\n')
    else context.stdout.write(res.alreadyRunning ? `DAEMON: already running at ${res.url}\n` : `DAEMON: started at ${res.url} (pid ${res.pid})\n`)
    return EXIT_CODES.OK
  }
  if (sub === 'stop') {
    const res = await stopDaemon(context)
    if (context.options.json) context.stdout.write(JSON.stringify({ ok: true, ...res }, null, 2) + '\n')
    else context.stdout.write(res.stopped ? `DAEMON: stopped pid(s) ${res.killedPids.join(', ')}\n` : 'DAEMON: not running\n')
    return EXIT_CODES.OK
  }
  if (sub === 'autostart') {
    const mode = context.positional[1]
    if (mode !== 'on' && mode !== 'off') {
      throw new CliError('usage: ds-subagent daemon autostart on|off', EXIT_CODES.USAGE, 'usage')
    }
    const res = configureAutostart(context, mode === 'on')
    if (context.options.json) context.stdout.write(JSON.stringify({ ok: true, ...res }, null, 2) + '\n')
    else {
      context.stdout.write(`AUTOSTART: ${res.enabled ? 'ENABLED' : 'DISABLED'} (${res.path})\n`)
      if (res.next) context.stdout.write(`Run once to activate: ${res.next}\n`)
    }
    return EXIT_CODES.OK
  }
  throw new CliError(`unknown daemon subcommand "${sub}"; use start | stop | status | autostart`, EXIT_CODES.USAGE, 'usage')
}

async function commandHost(context) {
  const home = resolveHome(context.env)
  const sub = context.positional[0] ?? 'list'
  const hosts = loadHosts(home)

  if (sub === 'list') {
    const entries = Object.entries(hosts).map(([alias, h]) => ({
      alias,
      type: h.type,
      target: h.type === 'ssh' ? `${h.ssh} (remote port ${h.remotePort ?? DEFAULT_BRIDGE_PORT})` : h.url,
      hasToken: Boolean(h.token),
    }))
    if (context.options.json) {
      context.stdout.write(JSON.stringify({ ok: true, hosts: entries }, null, 2) + '\n')
      return EXIT_CODES.OK
    }
    if (entries.length === 0) {
      context.stdout.write('(no remote hosts configured; add one with `ds-subagent host add <name> --ssh user@server`)\n')
      return EXIT_CODES.OK
    }
    for (const e of entries) {
      context.stdout.write(`${e.alias.padEnd(16)} ${e.type.padEnd(6)} ${e.target}  token=${e.hasToken ? 'ok' : 'MISSING'}\n`)
    }
    return EXIT_CODES.OK
  }

  if (sub === 'add') {
    const alias = validateAlias(context.positional[1])
    const ssh = optionalString(context.options.ssh)
    const url = optionalString(context.options.url)
    if (!ssh && !url) {
      throw new CliError('host add requires --ssh <user@server> OR --url <http://host:45720>', EXIT_CODES.USAGE, 'usage')
    }
    let token = optionalString(context.options.token) ?? ''
    if (ssh && !token) {
      token = fetchRemoteTokenViaSsh(ssh) ?? ''
    }
    hosts[alias] = ssh
      ? { type: 'ssh', ssh, remotePort: context.options.remotePort ?? DEFAULT_BRIDGE_PORT, token }
      : { type: 'http', url: url.replace(/\/+$/, ''), token }
    saveHosts(home, hosts)
    if (context.options.json) {
      context.stdout.write(JSON.stringify({ ok: true, alias, type: hosts[alias].type, hasToken: Boolean(token) }, null, 2) + '\n')
    } else {
      context.stdout.write(
        `HOST ADDED: ${alias} (${hosts[alias].type === 'ssh' ? ssh : url})${token ? '' : ' [note: pass --token or ensure remote daemon is running]'}\n`,
      )
    }
    return EXIT_CODES.OK
  }

  if (sub === 'remove' || sub === 'rm') {
    const alias = validateAlias(context.positional[1])
    if (!hosts[alias]) throw new CliError(`no remote host named "${alias}"`, EXIT_CODES.USAGE, 'usage')
    delete hosts[alias]
    saveHosts(home, hosts)
    if (context.options.json) context.stdout.write(JSON.stringify({ ok: true, removed: alias }) + '\n')
    else context.stdout.write(`HOST REMOVED: ${alias}\n`)
    return EXIT_CODES.OK
  }

  throw new CliError(`unknown host subcommand "${sub}"; use add | list | remove`, EXIT_CODES.USAGE, 'usage')
}

async function commandSshExec(context) {
  const target = context.positional[0]
  if (!target) throw new CliError('ssh-exec requires <user@host> and (--file <script.sh> or "-" stdin)', EXIT_CODES.USAGE, 'usage')
  let script = ''
  if (Array.isArray(context.options.files) && context.options.files.length > 0) {
    const fp = isAbsolute(context.options.files[0]) ? context.options.files[0] : resolve(context.cwd, context.options.files[0])
    script = readFileSync(fp, 'utf8')
  } else if (context.positional[1] === '-') {
    script = await readStdinText(context.stdin)
  } else if (context.positional.length > 1) {
    script = context.positional.slice(1).join(' ')
  } else {
    throw new CliError('ssh-exec requires script input via --file <path>, "-", or inline command', EXIT_CODES.USAGE, 'usage')
  }
  const res = runSafeSshScript(target, script)
  if (res.stdout) context.stdout.write(res.stdout)
  if (res.stderr) context.stderr.write(res.stderr)
  return typeof res.status === 'number' ? res.status : EXIT_CODES.ERROR
}

async function commandUpdate(context) {
  const home = resolveHome(context.env)
  const src = resolveUpdateSource({ options: context.options, env: context.env, home })
  const res = await performUpdate({
    repo: src.repo,
    branch: src.branch,
    home,
    fetchImpl: context.fetchImpl,
    stdout: context.stdout,
    stderr: context.stderr,
  })
  if (context.options.json) {
    context.stdout.write(JSON.stringify(res, null, 2) + '\n')
  }
  return EXIT_CODES.OK
}

async function commandReport(context) {
  const probe = await probeHealth(context)
  const dshBin = findDshBinary(context.env)
  const home = resolveHome(context.env)
  const { text, reportPath } = generateBugReport({
    home,
    dshHome: context.env.DSH_HOME,
    dshBin,
    probe,
  })
  if (context.options.json) {
    context.stdout.write(JSON.stringify({ ok: true, reportPath, report: text }, null, 2) + '\n')
  } else {
    context.stdout.write(text)
    if (reportPath) {
      context.stderr.write(`\nSaved safe redacted report to: ${reportPath}\n`)
      context.stderr.write('You can safely copy & send the block above (tokens, keys, and usernames are redacted).\n')
    }
  }
  return EXIT_CODES.OK
}

export async function runCli(argv = [], runtime = {}) {
  const context = {
    env: runtime.env ?? process.env,
    cwd: runtime.cwd ?? process.cwd(),
    stdout: runtime.stdout ?? process.stdout,
    stderr: runtime.stderr ?? process.stderr,
    stdin: runtime.stdin ?? process.stdin,
    fetchImpl: runtime.fetch ?? globalThis.fetch,
    options: {},
    positional: [],
  }

  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    context.stderr.write(`ds-subagent: ${err.message}\n`)
    return err instanceof CliError ? err.exitCode : EXIT_CODES.USAGE
  }

  context.options = parsed.options
  context.positional = parsed.positional

  if (parsed.options.version) {
    context.stdout.write(`${PACKAGE_NAME} ${PACKAGE_VERSION}\n`)
    return EXIT_CODES.OK
  }
  if (parsed.options.help || !parsed.command || parsed.command === 'help') {
    context.stdout.write(HELP_TEXT)
    return EXIT_CODES.OK
  }
  if (!COMMANDS.includes(parsed.command)) {
    context.stderr.write(`ds-subagent: unknown command "${parsed.command}"; run "ds-subagent help"\n`)
    return EXIT_CODES.USAGE
  }

  let remoteConn = null
  try {
    if (optionalString(context.options.host) && !['host', 'ssh-exec', 'update'].includes(parsed.command)) {
      const alias = validateAlias(context.options.host)
      const hosts = loadHosts(resolveHome(context.env))
      const entry = hosts[alias]
      if (!entry) {
        throw new CliError(`unknown remote host "${alias}"; add it with "ds-subagent host add ${alias} --ssh user@server"`, EXIT_CODES.USAGE, 'usage')
      }
      remoteConn = await openRemoteConnection(entry)
      context.options.url = remoteConn.url
      if (remoteConn.token && !context.options.token) context.options.token = remoteConn.token
      context.options.noAutostart = true
    }

    switch (parsed.command) {
      case 'start':
        return await commandStartOrSend(context, true)
      case 'send':
        return await commandStartOrSend(context, false)
      case 'steer':
        return await commandSteer(context)
      case 'status':
      case 'list':
        return await commandStatus(context)
      case 'watch':
        return await commandWatch(context)
      case 'log':
        return await commandLog(context)
      case 'cancel':
        return await commandCancel(context)
      case 'close':
        return await commandClose(context)
      case 'doctor':
        return await commandDoctor(context)
      case 'daemon':
        return await commandDaemon(context)
      case 'host':
        return await commandHost(context)
      case 'ssh-exec':
        return await commandSshExec(context)
      case 'update':
        return await commandUpdate(context)
      case 'report':
        return await commandReport(context)
      default:
        context.stdout.write(HELP_TEXT)
        return EXIT_CODES.OK
    }
  } catch (err) {
    const code = err instanceof CliError ? err.exitCode : EXIT_CODES.ERROR
    if (context.options.json) {
      context.stdout.write(JSON.stringify({ ok: false, code: err.code ?? 'error', error: err.message }) + '\n')
    } else {
      context.stderr.write(`ds-subagent: ${err.message}\n`)
      if (code === EXIT_CODES.BRIDGE_DOWN || code === EXIT_CODES.ERROR) {
        context.stderr.write('Tip: run "ds-subagent report" to create a safe diagnostic report to share.\n')
      }
    }
    return code
  } finally {
    if (remoteConn) await remoteConn.close().catch(() => {})
  }
}
