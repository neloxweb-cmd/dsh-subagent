/**
 * Real-time DSH session event monitor, live todo/tasklist tracker, activity
 * watchdog, safety policy tripwire (readonly/workspace), ask_user_question trap,
 * and repeated-tool-error loop detector.
 *
 * Pure JS (zero external imports) so it can be thoroughly unit-tested with fake
 * DSH agents and run inside the DSH Cordis host process.
 */

import { isAbsolute, relative, resolve } from 'node:path'

import {
  DEFAULT_IDLE_TIMEOUT_SEC,
  DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
  DEFAULT_MAX_TURN_SEC,
  DEFAULT_TOOL_IDLE_TIMEOUT_SEC,
  nowIso,
  nowMs,
} from './protocol.js'

const INTERACTIVE_TOOL_RE = /^(ask_user_question|ask_user|request_approval|confirm_action|user_input)$/i
const NEEDS_INPUT_MARKER_RE = /^\s*(?:\*{1,2})?\[(NEEDS_INPUT|BLOCKED)\](?:\*{1,2})?:?\s*/i

const WRITE_TOOL_RE = /^(write|write_file|create_file|edit|edit_file|multi_edit|patch|apply_patch|delete|delete_file|remove_file|rm|mv|rename|mkdir|notebook_edit|fs_write|fs_edit)$/i
const SHELL_TOOL_RE = /^(pwsh|powershell|bash|sh|shell|exec|run_command|command|terminal|cmd)$/i
const ALWAYS_FORBIDDEN_SHELL_RE = /[`\r\n]|\$\(/

/**
 * Detect shell chaining/redirection/subshell operators outside quotes
 * (and always reject backticks, newlines, and `$(...)` anywhere).
 */
export function hasShellChaining(cmd) {
  const s = String(cmd ?? '')
  if (ALWAYS_FORBIDDEN_SHELL_RE.test(s)) return true
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < s.length) {
        i += 1
        continue
      }
      if (ch === '"') quote = null
      continue
    }
    if (ch === '\\' && i + 1 < s.length) {
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>' || ch === '(' || ch === ')') {
      return true
    }
  }
  return false
}

const SQLITE_DANGEROUS_DOT_RE = /(?:^|[\s"'`])\.(shell|system|output|once|save|backup|restore|import|load|read|open|clone|excel|log|cd|auth|vfsname|parameter)\b/i
const SQLITE_MUTATING_SQL_RE = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex)\b|\bpragma\s+\w+\s*=/i

/**
 * Validate a `sqlite3` command in `--readonly` mode.
 * Allows ONLY `sqlite3 -readonly ...` (or `--readonly`) with read-only SQL
 * and no dangerous dot-commands or stacked `;` statements.
 */
export function validateSqliteReadonlyCommand(cmd) {
  const tokens = String(cmd ?? '').trim().split(/\s+/)
  const hasReadonlyFlag = tokens.slice(1).some((t) => t === '-readonly' || t === '--readonly')
  if (!hasReadonlyFlag) {
    return '"sqlite3" without -readonly is forbidden in --readonly mode. Use "sqlite3 -readonly" for safe read-only queries.'
  }
  if (SQLITE_DANGEROUS_DOT_RE.test(cmd)) {
    return 'sqlite3 dot-commands that execute shell commands or write files are forbidden in --readonly mode.'
  }
  if (SQLITE_MUTATING_SQL_RE.test(cmd)) {
    return 'mutating SQL statements (INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/ATTACH/VACUUM) are forbidden in --readonly mode.'
  }
  if (cmd.includes(';')) {
    return 'multiple/semicolon-terminated SQL statements are forbidden in --readonly mode (omit trailing ";").'
  }
  return null
}

/**
 * Binaries/prefixes that can NEVER be whitelisted in --readonly mode because
 * they open an unrestricted shell, execute arbitrary code, or mutate remote/local state.
 */
const FORBIDDEN_READONLY_BINS = new Set([
  'ssh', 'scp', 'rsync', 'sftp', 'ftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet',
  'curl', 'wget',
  'bash', 'sh', 'zsh', 'fish', 'dash', 'pwsh', 'powershell', 'cmd', 'cmd.exe',
  'node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'lua', 'awk', 'sed',
  'rm', 'mv', 'cp', 'dd', 'tee', 'chmod', 'chown', 'chgrp', 'mkdir', 'rmdir', 'touch', 'truncate',
  'sudo', 'su', 'doas', 'env', 'xargs', 'find',
  'npm', 'npx', 'pnpm', 'yarn', 'pip', 'pip3',
  'psql', 'mysql', 'redis-cli', 'mongosh',
])

const FORBIDDEN_READONLY_SUBCOMMANDS = [
  /^git\s+(push|commit|reset|checkout|switch|clean|rebase|merge|cherry-pick|apply|am|rm|mv|add|stash|tag|branch\s+-[dDmM]|config)/i,
  /^docker\s+(exec|run|rm|rmi|kill|stop|start|restart|build|cp|compose\s+(up|down|exec|run))/i,
  /^kubectl\s+(exec|apply|delete|edit|patch|create|replace|scale|rollout)/i,
  /^systemctl\s+(start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload)/i,
]

/**
 * Validate a list of `--allow-cmd` prefixes for `--mode readonly`.
 * Returns an error string if any entry is unsafe, or null if all are safe.
 * @param {string[]} allowCommands
 * @returns {string|null}
 */
export function validateReadonlyAllowCommands(allowCommands) {
  if (!Array.isArray(allowCommands)) return null
  for (const raw of allowCommands) {
    const cmd = String(raw ?? '').trim()
    if (!cmd) continue
    if (hasShellChaining(cmd)) {
      return `Invalid --allow-cmd "${cmd}": shell operators/chaining are not allowed in readonly mode`
    }
    const firstToken = cmd.split(/\s+/)[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
    if (firstToken === 'sqlite3') {
      const sqliteErr = validateSqliteReadonlyCommand(cmd)
      if (sqliteErr) return sqliteErr
      continue
    }
    if (FORBIDDEN_READONLY_BINS.has(firstToken)) {
      const hint = ['ssh', 'scp', 'rsync', 'sftp'].includes(firstToken)
        ? ' Use "--host <alias> --readonly" so readonly is enforced on the remote server itself.'
        : ''
      return `"${firstToken}" is forbidden in --readonly mode (can bypass readonly restrictions).${hint}`
    }
    for (const re of FORBIDDEN_READONLY_SUBCOMMANDS) {
      if (re.test(cmd)) {
        return `"${cmd}" is forbidden in --readonly mode (mutating/exec subcommand).`
      }
    }
  }
  return null
}

/**
 * Extract readable text from a DSH assistant/tool message content array.
 * @param {any} content
 * @returns {string}
 */
export function extractText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function preview(value, maxLen = 160) {
  let text = ''
  if (typeof value === 'string') text = value
  else if (value !== undefined && value !== null) {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > maxLen ? compact.slice(0, maxLen - 3) + '...' : compact
}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Normalize DSH `todo/write` items into a compact, UI-friendly array.
 * @param {unknown} rawTodos
 * @returns {Array<{content: string, status: string}>}
 */
export function normalizeTodos(rawTodos) {
  if (!Array.isArray(rawTodos)) return []
  return rawTodos
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const content = String(item.content ?? item.title ?? item.text ?? item.task ?? '').trim()
      const rawStatus = String(item.status ?? (item.completed ? 'completed' : 'pending')).toLowerCase()
      const status = ['completed', 'done'].includes(rawStatus)
        ? 'completed'
        : ['in_progress', 'running', 'active'].includes(rawStatus)
          ? 'in_progress'
          : ['cancelled', 'canceled', 'skipped'].includes(rawStatus)
            ? 'cancelled'
            : 'pending'
      return { content, status }
    })
    .filter((item) => item.content !== '')
    .slice(0, 30)
}

/**
 * Turn a DSH tool call into a short, human-readable current activity label.
 * @param {string} toolName
 * @param {unknown} rawArgs
 * @returns {string}
 */
export function formatActivity(toolName, rawArgs) {
  const args = parseToolArgs(rawArgs)
  if (args && typeof args === 'object') {
    const file = args.path ?? args.file_path ?? args.filePath ?? args.target ?? args.file
    if (typeof file === 'string' && file.trim()) {
      const short = file.split(/[\\/]/).slice(-2).join('/')
      return `${toolName}: ${short}`
    }
    const cmd = args.command ?? args.cmd ?? args.script
    if (typeof cmd === 'string' && cmd.trim()) {
      return `${toolName}: ${preview(cmd, 64)}`
    }
    const query = args.pattern ?? args.query ?? args.glob
    if (typeof query === 'string' && query.trim()) {
      return `${toolName}: ${preview(query, 64)}`
    }
  }
  return toolName
}

/**
 * Check whether a tool call violates the active safety mode (`readonly` or `workspace`).
 * @param {{mode: string, allowCommands?: string[], cwd?: string}} policy
 * @param {string} toolName
 * @param {unknown} rawArgs
 * @returns {string|null} violation message, or null when allowed
 */
export function checkToolPolicy(policy, toolName, rawArgs) {
  const mode = policy?.mode ?? 'full'
  if (mode === 'full') return null

  const args = parseToolArgs(rawArgs)

  if (mode === 'readonly') {
    if (WRITE_TOOL_RE.test(toolName)) {
      return `Blocked by --mode readonly: write/edit tool "${toolName}" is not permitted`
    }
    if (SHELL_TOOL_RE.test(toolName)) {
      const allow = Array.isArray(policy.allowCommands)
        ? policy.allowCommands.map((c) => String(c).trim()).filter(Boolean)
        : []
      if (allow.length === 0) {
        return `Blocked by --mode readonly: shell tool "${toolName}" is disabled (pass --allow-cmd to whitelist read-only commands)`
      }
      const cmd =
        args && typeof args === 'object'
          ? String(args.command ?? args.cmd ?? args.script ?? '').trim()
          : typeof args === 'string'
            ? args.trim()
            : ''
      if (!cmd) return `Blocked by --mode readonly: empty shell command on "${toolName}"`
      if (hasShellChaining(cmd)) {
        return `Blocked by --mode readonly: shell chaining/redirection is forbidden in "${preview(cmd, 80)}"`
      }
      const forbiddenReason = validateReadonlyAllowCommands([cmd])
      if (forbiddenReason) {
        return `Blocked by --mode readonly: ${forbiddenReason}`
      }
      const allowed = allow.some((prefix) => cmd === prefix || cmd.startsWith(prefix + ' '))
      if (!allowed) {
        return `Blocked by --mode readonly: command "${preview(cmd, 80)}" is not in allowlist [${allow.join(', ')}]`
      }
    }
  }

  if (mode === 'workspace' && policy.cwd && WRITE_TOOL_RE.test(toolName) && args && typeof args === 'object') {
    const file = args.path ?? args.file_path ?? args.filePath ?? args.target ?? args.file
    if (typeof file === 'string' && file.trim()) {
      const resolved = isAbsolute(file) ? resolve(file) : resolve(policy.cwd, file)
      const rel = relative(resolve(policy.cwd), resolved)
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return `Blocked by --mode workspace: write outside workspace root "${policy.cwd}" attempted on "${resolved}"`
      }
    }
  }

  return null
}

/**
 * Format a question captured from an `ask_user_question` tool call.
 */
export function formatInteractiveQuestion(toolName, rawArgs) {
  const args = parseToolArgs(rawArgs)
  if (args && typeof args === 'object') {
    const direct = args.question ?? args.prompt ?? args.message ?? args.text
    if (typeof direct === 'string' && direct.trim()) {
      const options = Array.isArray(args.options)
        ? '\nOptions: ' + args.options.map((o) => (typeof o === 'string' ? o : o?.label ?? JSON.stringify(o))).join(' | ')
        : ''
      return { tool: toolName, text: direct.trim() + options, args }
    }
    if (Array.isArray(args.questions) && args.questions.length > 0) {
      const lines = args.questions.map((q, i) => {
        const qText = typeof q === 'string' ? q : q?.question ?? q?.prompt ?? JSON.stringify(q)
        const opts = Array.isArray(q?.options)
          ? ' [' + q.options.map((o) => (typeof o === 'string' ? o : o?.label ?? JSON.stringify(o))).join(' / ') + ']'
          : ''
        return `${i + 1}. ${qText}${opts}`
      })
      return { tool: toolName, text: lines.join('\n'), args }
    }
  }
  return { tool: toolName, text: preview(args, 600) || `Agent invoked ${toolName}`, args }
}

/**
 * Determine whether a DSH `tool/result` event represents a tool failure.
 */
export function inspectToolResult(event) {
  const data = event?.data ?? {}
  const meta = data.meta ?? {}
  const msg = data.message ?? {}
  const text = extractText(msg.content)
  const exitCode = typeof meta.exitCode === 'number' ? meta.exitCode : typeof data.exitCode === 'number' ? data.exitCode : null
  const flagged =
    data.isError === true ||
    meta.isError === true ||
    meta.ok === false ||
    meta.status === 'error' ||
    msg.isError === true ||
    (exitCode !== null && exitCode !== 0)
  if (flagged) {
    return { isError: true, summary: preview(text || meta.error || `exit ${exitCode}`, 180) }
  }
  return { isError: false, summary: preview(text, 120) }
}

/**
 * Inspect final assistant text for explicit `[NEEDS_INPUT]` or `[BLOCKED]` markers.
 */
export function classifyAssistantOutput(text) {
  const raw = typeof text === 'string' ? text : ''
  const match = NEEDS_INPUT_MARKER_RE.exec(raw)
  if (!match) return { needsInput: false, marker: null, body: raw }
  return {
    needsInput: true,
    marker: match[1].toUpperCase(),
    body: raw.slice(match[0].length).trim() || raw.trim(),
  }
}

const IGNORED_TOUCHED_PATH_RE = /(?:^|[\\/])(?:\.pytest_cache|__pycache__|\.mypy_cache|\.ruff_cache|\.tox|\.nox|node_modules|\.git)(?:[\\/]|$)/i

function cleanShellToken(tok) {
  return String(tok ?? '').trim().replace(/^['"]|['"]$/g, '')
}

function isUsableShellPath(p) {
  if (!p || p.startsWith('-') || p.startsWith('$') || p.startsWith('&') || p.startsWith('/dev/')) return false
  if (p === '.' || p === '..' || p === '/' || p === '1' || p === '2') return false
  if (IGNORED_TOUCHED_PATH_RE.test(p)) return false
  return true
}

/**
 * Extract explicit file paths demonstrably written, created, moved, or deleted
 * by a shell command (`> file`, `>> file`, `tee file`, `touch`, `cp`, `mv`, `rm`).
 */
export function extractShellWritePaths(command) {
  const cmd = String(command ?? '').trim()
  if (!cmd) return []
  const out = new Set()

  // 1. Output redirections (> file, >> file, 1> file)
  for (const m of cmd.matchAll(/(?:^|[\s;|&])(?:1)?>>?\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g)) {
    const p = cleanShellToken(m[1])
    if (isUsableShellPath(p)) out.add(p)
  }

  // 2. tee [-a] <file>
  for (const m of cmd.matchAll(/\btee\s+(?:-[a-zA-Z]+\s+)*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g)) {
    const p = cleanShellToken(m[1])
    if (isUsableShellPath(p)) out.add(p)
  }

  // 3. Per-segment file-mutating commands (touch, rm, mv, cp)
  const segments = cmd.split(/[;&|\r\n]+/)
  for (const seg of segments) {
    const tokens = (seg.trim().match(/"[^"]+"|'[^']+'|\S+/g) ?? []).map(cleanShellToken)
    if (tokens.length < 2) continue
    const bin = tokens[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()
    const nonFlags = tokens.slice(1).filter((t) => t && !t.startsWith('-'))
    if (bin === 'touch' || bin === 'rm') {
      for (const p of nonFlags) if (isUsableShellPath(p)) out.add(p)
    } else if (bin === 'mv' && nonFlags.length >= 2) {
      for (const p of nonFlags) if (isUsableShellPath(p)) out.add(p)
    } else if (bin === 'cp' && nonFlags.length >= 2) {
      const dst = nonFlags[nonFlags.length - 1]
      if (isUsableShellPath(dst)) out.add(dst)
    }
  }
  return [...out]
}

function extractTouchedPaths(toolName, rawArgs) {
  const args = parseToolArgs(rawArgs)
  if (SHELL_TOOL_RE.test(toolName)) {
    const cmd =
      args && typeof args === 'object'
        ? String(args.command ?? args.cmd ?? args.script ?? '')
        : typeof args === 'string'
          ? args
          : ''
    return extractShellWritePaths(cmd)
  }
  if (!WRITE_TOOL_RE.test(toolName)) return []
  if (!args || typeof args !== 'object') return []
  const out = []
  const direct = args.path ?? args.file_path ?? args.filePath ?? args.target ?? args.file
  if (typeof direct === 'string' && direct.trim() && !IGNORED_TOUCHED_PATH_RE.test(direct.trim())) {
    out.push(direct.trim())
  }
  const patchText = args.patch ?? args.input ?? args.diff
  if (typeof patchText === 'string' && patchText.includes('*** ')) {
    for (const m of patchText.matchAll(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/gm)) {
      const p = String(m[1] ?? '').trim()
      if (p && !IGNORED_TOUCHED_PATH_RE.test(p)) out.push(p)
    }
  }
  return out
}

/**
 * Normalize a non-write tool call into exact + fuzzy signatures so repeated
 * identical or near-identical calls (e.g. re-running the same timing test with
 * changing numbers) can be detected reliably. Returns null for write/todo tools.
 */
export function normalizeToolCallSignature(toolName, rawArgs) {
  const lower = String(toolName ?? '').toLowerCase()
  if (!lower || WRITE_TOOL_RE.test(lower) || /^todo[_-]?write$/i.test(lower)) return null
  const args = parseToolArgs(rawArgs)
  if (SHELL_TOOL_RE.test(lower)) {
    const rawCmd =
      args && typeof args === 'object'
        ? String(args.command ?? args.cmd ?? args.script ?? '')
        : typeof args === 'string'
          ? args
          : ''
    const exact = rawCmd.replace(/\s+/g, ' ').trim()
    if (!exact) return null
    const fuzzy = exact
      .replace(/\b\d+(?:\.\d+)?\b/g, '#')
      .replace(/(['"])[^'"]{0,12}#[^'"]{0,12}\1/g, '$1#$1')
      .slice(0, 240)
    return { exact: `shell:${exact.slice(0, 240)}`, fuzzy: `shell:${fuzzy}` }
  }
  const serialized = preview(args, 200)
  const fuzzy = serialized.replace(/\b\d+(?:\.\d+)?\b/g, '#')
  return { exact: `${lower}:${serialized}`, fuzzy: `${lower}:${fuzzy}` }
}

/**
 * Fingerprint of a tool outcome for loop detection. Only volatile noise is
 * removed (timestamps, clock times, durations, decimals), so a re-run that only
 * differs in timing matches, but a changed result (e.g. "2 failed" -> "1 failed",
 * other file content) does not.
 */
export function outcomeFingerprint(summary) {
  return preview(summary, 160)
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?/g, '#ts')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, '#tijd')
    .replace(/\d+(?:[.,]\d+)?\s*(?:ms|s|sec|secs|seconds?|seconden|min|minuten)\b/gi, '#duur')
    .replace(/\d+[.,]\d+/g, '#dec')
}

/**
 * Build a short, human-readable status summary for timeout / stuck / loop reports
 * so partial work is never invisible to the caller.
 */
export function buildStandSummary({ todos = [], touchedFiles = [], lastTool = null, currentActivity = '', steps = 0, toolCalls = 0 } = {}) {
  const parts = []
  if (Array.isArray(todos) && todos.length > 0) {
    const done = todos.filter((t) => t.status === 'completed')
    const active = todos.find((t) => t.status === 'in_progress')
    const doneNames = done.slice(0, 3).map((t) => t.content).join(', ')
    let todoPart = `${done.length}/${todos.length} taken klaar`
    if (doneNames) todoPart += ` (klaar: ${doneNames}${done.length > 3 ? ', …' : ''})`
    if (active) todoPart += `; bezig: ${active.content}`
    parts.push(todoPart)
  } else {
    parts.push(`${steps} stappen, ${toolCalls} tool-calls`)
  }
  if (Array.isArray(touchedFiles) && touchedFiles.length > 0) {
    const shortFiles = touchedFiles
      .slice(0, 8)
      .map((f) => String(f).split(/[\\/]/).slice(-2).join('/'))
      .join(', ')
    parts.push(`gewijzigd: ${shortFiles}${touchedFiles.length > 8 ? ` (+${touchedFiles.length - 8})` : ''}`)
  }
  if (currentActivity && currentActivity !== 'Thinking...') {
    parts.push(`laatst: ${currentActivity}`)
  } else if (lastTool) {
    parts.push(`laatste tool: ${lastTool}`)
  }
  return parts.join(' | ')
}

/**
 * Watch a live in-process DSH agent from `firstSeq` until it settles, asks for
 * interactive input, trips a safety policy/loop/watchdog/error-loop breaker, or is cancelled.
 */
export async function watchAgentTurn(options) {
  const {
    agent,
    ctx,
    firstSeq,
    toSeq = (n) => n,
    mode = 'full',
    allowCommands = [],
    cwd,
    preExecutionGuardActive = false,
    onLoopSteer,
    loopSteerThreshold = 4,
    loopAbortAfterSteer = 3,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_SEC * 1000,
    toolIdleTimeoutMs = DEFAULT_TOOL_IDLE_TIMEOUT_SEC * 1000,
    maxTurnMs = DEFAULT_MAX_TURN_SEC * 1000,
    maxConsecutiveToolErrors = DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS,
    pollIntervalMs = 250,
    askTrapGraceMs = 450,
    signal,
    onProgress,
  } = options

  const subagents = ctx?.get?.('subagents')
  const policy = { mode, allowCommands, cwd }
  const startedAt = nowMs()
  let lastActivityAt = startedAt
  let cursor = firstSeq
  let sawTurnStart = false
  let steps = 0
  let toolCalls = 0
  let succeededToolCalls = 0
  let hadShellCalls = false
  let lastTool = null
  let currentActivity = 'Thinking...'
  let lastAssistantText = ''
  let turnEndReason = null
  let turnError = null
  let cancelledByCaller = false
  let policyViolation = null
  let consecutiveBlockedCalls = 0

  /** @type {Array<{fuzzy: string, exact: string, resultFp: string, toolName: string, preview: string}>} */
  const repeatWindow = []
  let loopSteerSent = false
  let loopSteerKey = null
  let repeatsAfterSteer = 0
  /** @type {{tool: string, count: number, detail: string}|null} */
  let loopTripped = null

  /** @type {Array<{tool: string, reason: string}>} */
  const blockedCalls = []
  /** @type {Set<string>} */
  const touchedFiles = new Set()

  /** @type {Array<{content: string, status: string}>} */
  let todos = []
  /** @type {Map<string, {name: string, startedAt: number, argsPreview: string, rawArgs: any, blockedByPolicy?: boolean}>} */
  const inFlightTools = new Map()
  /** @type {Array<{at: string, seq: number, type: string, detail: string}>} */
  const recentEvents = []
  /** @type {{inputTokens: number, outputTokens: number, cacheReadTokens: number}} */
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }

  /** @type {{callId: string, tool: string, detectedAt: number, question: {tool: string, text: string, args: any}}|null} */
  let pendingInteractive = null
  /** @type {{tool: string, count: number, lastError: string}} */
  let errorStreak = { tool: '', count: 0, lastError: '' }

  function pushTimeline(seq, type, detail) {
    recentEvents.push({ at: nowIso(), seq, type, detail })
    if (recentEvents.length > 30) recentEvents.shift()
  }

  function currentStandSummary() {
    return buildStandSummary({
      todos,
      touchedFiles: [...touchedFiles],
      lastTool,
      currentActivity,
      steps,
      toolCalls,
    })
  }

  function snapshot() {
    const now = nowMs()
    const activeTools = [...inFlightTools.values()].map((t) => ({
      name: t.name,
      elapsedSec: Math.round((now - t.startedAt) / 1000),
      args: t.argsPreview,
    }))
    return {
      elapsedMs: now - startedAt,
      idleMs: now - lastActivityAt,
      seq: cursor,
      steps,
      toolCalls,
      lastTool,
      currentActivity,
      standSummary: currentStandSummary(),
      todos: todos.map((t) => ({ ...t })),
      activeTools,
      blockedCalls: blockedCalls.slice(0, 12),
      usage: { ...usage },
      recentEvents: recentEvents.slice(-15),
    }
  }

  function drainEvents() {
    const session = agent?.session
    if (!session || typeof session.seq !== 'number' || typeof session.eventAt !== 'function') return false
    const total = session.seq
    if (total <= cursor) return false
    let progressed = false
    for (let seq = cursor; seq < total; seq += 1) {
      const event = session.eventAt(toSeq(seq))
      if (!event) continue
      progressed = true
      const type = String(event.type ?? 'unknown')
      const data = event.data ?? {}

      if (type === 'turn/start') {
        sawTurnStart = true
        currentActivity = 'Thinking...'
        pushTimeline(seq, type, `turn ${data.turn ?? '?'}`)
        continue
      }
      if (!sawTurnStart) {
        if (!/error|approv|todo/i.test(type)) continue
      }

      if (type === 'todo/write') {
        todos = normalizeTodos(data.todos)
        const inProg = todos.find((t) => t.status === 'in_progress')
        if (inProg) currentActivity = inProg.content
        pushTimeline(seq, type, `${todos.filter((t) => t.status === 'completed').length}/${todos.length} todos`)
      } else if (type === 'step/start') {
        steps += 1
        currentActivity = `Step ${data.step ?? steps}: thinking...`
        pushTimeline(seq, type, `step ${data.step ?? steps}`)
      } else if (type === 'tool/call') {
        toolCalls += 1
        const toolName = String(data.name ?? 'unknown')
        const callId = String(data.callId ?? `call_${seq}`)
        const argsPreview = preview(data.arguments, 140)
        lastTool = toolName
        currentActivity = formatActivity(toolName, data.arguments)

        // Also capture todo_write tool calls directly in case DSH emits tool/call before todo/write
        if (/^todo[_-]?write$/i.test(toolName)) {
          const parsed = parseToolArgs(data.arguments)
          if (parsed && Array.isArray(parsed.todos)) {
            todos = normalizeTodos(parsed.todos)
          }
        }

        // Active safety policy check (readonly / workspace)
        const violation = checkToolPolicy(policy, toolName, data.arguments)
        if (violation) {
          blockedCalls.push({ tool: toolName, reason: violation })
          consecutiveBlockedCalls += 1
          pushTimeline(seq, 'policy/blocked', violation)
          if (preExecutionGuardActive) {
            // DSH's synchronous tools.guard() already rejected dispatch and returned
            // the error to the model, so let it adapt and finish safe read-only work
            // unless it loops on repeated blocked attempts.
            inFlightTools.set(callId, {
              name: toolName,
              startedAt: nowMs(),
              argsPreview,
              rawArgs: data.arguments,
              blockedByPolicy: true,
            })
            if (consecutiveBlockedCalls >= 4 && !policyViolation) {
              policyViolation = `${violation} (aborted after ${consecutiveBlockedCalls} consecutive blocked attempts)`
            }
          } else if (!policyViolation) {
            policyViolation = violation
          }
          continue
        }

        consecutiveBlockedCalls = 0
        inFlightTools.set(callId, {
          name: toolName,
          startedAt: nowMs(),
          argsPreview,
          rawArgs: data.arguments,
          blockedByPolicy: false,
        })
        pushTimeline(seq, type, `${toolName}(${argsPreview})`)
        if (INTERACTIVE_TOOL_RE.test(toolName) && !pendingInteractive) {
          pendingInteractive = {
            callId,
            tool: toolName,
            detectedAt: nowMs(),
            question: formatInteractiveQuestion(toolName, data.arguments),
          }
        }
      } else if (type === 'tool/result') {
        const callId = String(
          data.message?.toolCallId ?? data.message?.source?.callId ?? data.callId ?? '',
        )
        const started = inFlightTools.get(callId)
        const toolName = started?.name ?? lastTool ?? 'tool'
        if (callId) inFlightTools.delete(callId)
        if (pendingInteractive && pendingInteractive.callId === callId) {
          pendingInteractive = null
        }
        const inspected = inspectToolResult(event)
        if (inspected.isError) {
          if (!started?.blockedByPolicy) {
            if (errorStreak.tool === toolName) {
              errorStreak.count += 1
              errorStreak.lastError = inspected.summary
            } else {
              errorStreak = { tool: toolName, count: 1, lastError: inspected.summary }
            }
          }
          pushTimeline(seq, 'tool/error', `${toolName}: ${inspected.summary}`)
        } else {
          errorStreak = { tool: '', count: 0, lastError: '' }
          if (!started?.blockedByPolicy) {
            succeededToolCalls += 1
            if (SHELL_TOOL_RE.test(toolName)) hadShellCalls = true
            const newlyTouched = extractTouchedPaths(toolName, started?.rawArgs)
            for (const p of newlyTouched) touchedFiles.add(p)

            // Real file writes reset repetition loop tracking
            if (WRITE_TOOL_RE.test(toolName) || newlyTouched.length > 0) {
              repeatWindow.length = 0
              loopSteerSent = false
              loopSteerKey = null
              repeatsAfterSteer = 0
            } else if (loopSteerThreshold > 0) {
              const sig = normalizeToolCallSignature(toolName, started?.rawArgs)
              if (sig) {
                const resultFp = outcomeFingerprint(inspected.summary)
                repeatWindow.push({
                  exact: sig.exact,
                  fuzzy: sig.fuzzy,
                  resultFp,
                  toolName,
                  preview: started?.argsPreview ?? '',
                })
                if (repeatWindow.length > 12) repeatWindow.shift()

                // A repeat is the same (fuzzy) call AND the same (fuzzy) outcome.
                // Reading other lines of a file, or running a command whose output
                // changed (e.g. fewer failing tests), is progress, not a loop.
                const loopKey = `${sig.fuzzy}\u0000${resultFp}`
                const repeatCount = repeatWindow.filter((r) => `${r.fuzzy}\u0000${r.resultFp}` === loopKey).length

                if (loopSteerSent && loopSteerKey !== loopKey) {
                  // After the steer the agent did something different: progress.
                  // Only the call that triggered the steer counts towards LOOP.
                  if (repeatCount < loopSteerThreshold) {
                    loopSteerSent = false
                    loopSteerKey = null
                    repeatsAfterSteer = 0
                  }
                }

                if (loopSteerSent && loopSteerKey === loopKey) {
                  repeatsAfterSteer += 1
                  if (repeatsAfterSteer >= loopAbortAfterSteer && !loopTripped) {
                    loopTripped = {
                      tool: toolName,
                      count: repeatCount,
                      detail: `Herhaallus gedetecteerd: "${toolName}" bleef herhalen (${repeatCount}× zonder nieuwe wijzigingen) ondanks automatische steer`,
                    }
                    pushTimeline(seq, 'watchdog/loop_abort', loopTripped.detail)
                  }
                } else if (!loopSteerSent && repeatCount >= loopSteerThreshold) {
                  loopSteerSent = true
                  loopSteerKey = loopKey
                  repeatsAfterSteer = 0
                  pushTimeline(
                    seq,
                    'watchdog/loop_steer',
                    `Auto-steer after ${repeatCount}× repeated ${toolName}(${preview(started?.argsPreview ?? '', 80)})`,
                  )
                  const steerText =
                    `Je hebt hetzelfde commando/actie (${toolName}) al ${repeatCount}× herhaald zonder nieuwe bestandswijzigingen of nieuwe uitkomst. ` +
                    'Je bent klaar met controleren — stop direct met nieuwe tool-calls en geef nu je eindantwoord met de gewijzigde bestanden en resultaten.'
                  try {
                    if (typeof onLoopSteer === 'function') {
                      onLoopSteer(steerText)
                    } else if (typeof agent.steer === 'function') {
                      agent.steer({ role: 'user', content: [{ type: 'text', text: `[LOOP GUARD] ${steerText}` }] })
                    }
                  } catch {
                    /* best-effort auto-steer */
                  }
                }
              }
            }
          }
          pushTimeline(seq, type, `${toolName}: ok`)
        }
      } else if (type === 'assistant/message') {
        const joined = extractText(data.message?.content)
        if (joined !== '') lastAssistantText = joined
        const u = data.usage
        if (u && typeof u === 'object') {
          if (typeof u.input === 'number') usage.inputTokens += u.input
          else if (typeof u.inputTokens === 'number') usage.inputTokens += u.inputTokens
          else if (typeof u.prompt_tokens === 'number') usage.inputTokens += u.prompt_tokens
          if (typeof u.output === 'number') usage.outputTokens += u.output
          else if (typeof u.outputTokens === 'number') usage.outputTokens += u.outputTokens
          else if (typeof u.completion_tokens === 'number') usage.outputTokens += u.completion_tokens
          if (typeof u.cacheRead === 'number') usage.cacheReadTokens += u.cacheRead
          else if (typeof u.cache_read_input_tokens === 'number') usage.cacheReadTokens += u.cache_read_input_tokens
        }
        pushTimeline(seq, type, preview(joined, 120) || '(assistant message)')
      } else if (type === 'assistant/attempt') {
        const stream = Array.isArray(data.stream) ? data.stream : []
        const errChunk = stream.find((c) => c?.chunk?.reason?.kind === 'error')
        if (errChunk) {
          const msg = errChunk.chunk?.reason?.failure?.message ?? 'attempt error'
          pushTimeline(seq, 'assistant/error', preview(msg, 160))
        }
      } else if (/approval.*request|permission.*request/i.test(type)) {
        const q = formatInteractiveQuestion(type, data)
        pendingInteractive = {
          callId: `evt_${seq}`,
          tool: type,
          detectedAt: nowMs(),
          question: q,
        }
        pushTimeline(seq, type, preview(q.text, 160))
      } else if (type === 'turn/end') {
        const terminal = data.reason
        const kind = terminal?.kind
        if (typeof kind === 'string') turnEndReason = kind
        if (kind === 'error' && terminal?.error) {
          turnError = {
            code: typeof terminal.error.code === 'string' ? terminal.error.code : 'ERROR',
            message: typeof terminal.error.message === 'string' ? terminal.error.message : preview(terminal.error),
          }
        }
        pushTimeline(seq, type, `reason=${kind ?? 'unknown'}`)
      }
    }
    cursor = total
    if (progressed) {
      lastActivityAt = nowMs()
      try {
        onProgress?.(snapshot())
      } catch {
        /* ignore progress listener errors */
      }
    }
    return progressed
  }

  async function safeCancel() {
    try {
      await agent.cancel?.({ kind: 'user' })
    } catch {
      /* cancellation is best-effort */
    }
    await Promise.race([
      Promise.resolve(agent.whenIdle?.()).catch(() => {}),
      new Promise((r) => setTimeout(r, 1500)),
    ])
    drainEvents()
  }

  const onAbort = () => {
    cancelledByCaller = true
    void agent.cancel?.({ kind: 'user' })
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    for (;;) {
      drainEvents()

      // 0. Active safety policy violation tripwire
      if (policyViolation) {
        const msg = policyViolation
        await safeCancel()
        return {
          status: 'blocked_policy',
          reason: 'policy_violation',
          text: lastAssistantText,
          question: null,
          error: { code: 'policy_blocked', message: msg },
          stats: snapshot(),
        }
      }

      // 0b. Repetition loop breaker (after auto-steer did not stop the loop)
      if (loopTripped) {
        const tripped = loopTripped
        await safeCancel()
        const stand = currentStandSummary()
        return {
          status: 'loop',
          reason: 'repeated_tool_loop',
          text: lastAssistantText || `Automatisch gestopt wegens herhaallus. ${stand}`,
          question: null,
          error: { code: 'repeated_tool_loop', message: tripped.detail },
          stats: snapshot(),
          touchedFiles: [...touchedFiles],
          hadShellCalls,
        }
      }

      if (cancelledByCaller || signal?.aborted) {
        await safeCancel()
        return {
          status: 'cancelled',
          reason: 'cancelled',
          text: lastAssistantText || currentStandSummary(),
          question: null,
          error: null,
          stats: snapshot(),
          touchedFiles: [...touchedFiles],
          hadShellCalls,
        }
      }

      // 1. Interactive tool / approval trap
      if (pendingInteractive && nowMs() - pendingInteractive.detectedAt >= askTrapGraceMs) {
        const trapped = pendingInteractive
        await safeCancel()
        return {
          status: 'needs_input',
          reason: trapped.tool,
          text: trapped.question.text,
          question: trapped.question,
          error: null,
          stats: snapshot(),
          touchedFiles: [...touchedFiles],
          hadShellCalls,
        }
      }

      // 2. Repeated consecutive tool error loop breaker
      if (maxConsecutiveToolErrors > 0 && errorStreak.count >= maxConsecutiveToolErrors) {
        const detail = `Tool "${errorStreak.tool}" failed ${errorStreak.count} times in a row. Last error: ${errorStreak.lastError}`
        await safeCancel()
        const stand = currentStandSummary()
        return {
          status: 'stuck',
          reason: 'repeated_tool_error',
          text: lastAssistantText || stand,
          question: null,
          error: { code: 'repeated_tool_error', message: detail },
          stats: snapshot(),
          touchedFiles: [...touchedFiles],
          hadShellCalls,
        }
      }

      // 3. Check if the agent has settled
      const isIdle = agent.status === 'idle'
      if (isIdle && (sawTurnStart || turnEndReason !== null || nowMs() - startedAt >= pollIntervalMs)) {
        const idleSeq = agent.session?.seq ?? cursor
        let waitingChildren = false
        if (subagents && typeof subagents.waitForChildren === 'function') {
          waitingChildren = await Promise.race([
            Promise.resolve(subagents.waitForChildren(agent)).catch(() => false),
            new Promise((r) => setTimeout(() => r(true), pollIntervalMs)),
          ])
        }
        drainEvents()
        if (!waitingChildren && agent.status === 'idle' && (agent.session?.seq ?? cursor) === idleSeq) {
          if (turnEndReason === 'error') {
            return {
              status: 'error',
              reason: 'turn_error',
              text: lastAssistantText,
              question: null,
              error: turnError ?? { code: 'TURN_ERROR', message: 'DSH turn ended with error' },
              stats: snapshot(),
            }
          }
          if (turnEndReason === 'cancelled' || turnEndReason === 'aborted') {
            return {
              status: 'cancelled',
              reason: turnEndReason,
              text: lastAssistantText,
              question: null,
              error: null,
              stats: snapshot(),
            }
          }
          const classified = classifyAssistantOutput(lastAssistantText)
          if (classified.needsInput) {
            return {
              status: 'needs_input',
              reason: classified.marker === 'BLOCKED' ? 'agent_blocked' : 'agent_needs_input',
              text: classified.body,
              question: { tool: classified.marker, text: classified.body, args: null },
              error: null,
              stats: snapshot(),
            }
          }
          if (blockedCalls.length > 0 && succeededToolCalls === 0) {
            return {
              status: 'blocked_policy',
              reason: 'policy_violation',
              text: lastAssistantText,
              question: null,
              error: { code: 'policy_blocked', message: blockedCalls[0].reason },
              stats: snapshot(),
              touchedFiles: [...touchedFiles],
              hadShellCalls,
            }
          }
          return {
            status: 'done',
            reason: turnEndReason ?? 'completed',
            text: lastAssistantText,
            question: null,
            error: null,
            stats: snapshot(),
            touchedFiles: [...touchedFiles],
            hadShellCalls,
          }
        }
      }

      // 4. Activity-based idle watchdog + hard max-turn watchdog
      const now = nowMs()
      const elapsed = now - startedAt
      const idle = now - lastActivityAt
      const activeIdleLimit = inFlightTools.size > 0 ? Math.max(idleTimeoutMs, toolIdleTimeoutMs) : idleTimeoutMs

      if (maxTurnMs > 0 && elapsed >= maxTurnMs) {
        const detail = `Turn exceeded max duration of ${Math.round(maxTurnMs / 1000)}s (steps=${steps}, tools=${toolCalls}, lastTool=${lastTool ?? 'none'})`
        await safeCancel()
        const stand = currentStandSummary()
        return {
          status: 'stuck',
          reason: 'max_turn_timeout',
          text: lastAssistantText || stand,
          question: null,
          error: { code: 'max_turn_timeout', message: detail },
          stats: snapshot(),
          touchedFiles: [...touchedFiles],
          hadShellCalls,
        }
      }

      if (activeIdleLimit > 0 && idle >= activeIdleLimit) {
        const activeList = [...inFlightTools.values()].map((t) => t.name).join(', ')
        const detail =
          `No session activity for ${Math.round(idle / 1000)}s` +
          (activeList ? ` while tool(s) running: ${activeList}` : ` (last tool: ${lastTool ?? 'none'})`)
        await safeCancel()
        const stand = currentStandSummary()
        return {
          status: 'stuck',
          reason: 'idle_timeout',
          text: lastAssistantText || stand,
          question: null,
          error: { code: 'idle_timeout', message: detail },
          stats: snapshot(),
          touchedFiles: [...touchedFiles],
          hadShellCalls,
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
