/**
 * Real-time DSH session event monitor, activity watchdog, ask_user_question trap,
 * and repeated-tool-error loop detector.
 *
 * Pure JS (zero external imports) so it can be thoroughly unit-tested with fake
 * DSH agents and run inside the DSH Cordis host process.
 */

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

/**
 * Truncate arbitrary preview strings for timeline diagnostics.
 * @param {unknown} value
 * @param {number} [maxLen]
 * @returns {string}
 */
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

/**
 * Parse a tool/call arguments payload (stringified JSON or plain object).
 * @param {unknown} raw
 * @returns {any}
 */
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
 * Format a question captured from an `ask_user_question` tool call.
 * @param {string} toolName
 * @param {unknown} rawArgs
 * @returns {{tool: string, text: string, args: any}}
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
 * @param {any} event
 * @returns {{isError: boolean, summary: string}}
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
 * @param {string} text
 * @returns {{needsInput: boolean, marker: string|null, body: string}}
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

/**
 * Watch a live in-process DSH agent from `firstSeq` until it settles, asks for
 * interactive input, trips a watchdog/error-loop breaker, or is cancelled.
 *
 * @param {{
 *   agent: any,
 *   ctx?: any,
 *   firstSeq: number,
 *   toSeq?: (n: number) => any,
 *   idleTimeoutMs?: number,
 *   toolIdleTimeoutMs?: number,
 *   maxTurnMs?: number,
 *   maxConsecutiveToolErrors?: number,
 *   pollIntervalMs?: number,
 *   askTrapGraceMs?: number,
 *   signal?: AbortSignal,
 *   onProgress?: (snapshot: any) => void,
 * }} options
 */
export async function watchAgentTurn(options) {
  const {
    agent,
    ctx,
    firstSeq,
    toSeq = (n) => n,
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
  const startedAt = nowMs()
  let lastActivityAt = startedAt
  let cursor = firstSeq
  let sawTurnStart = false
  let steps = 0
  let toolCalls = 0
  let lastTool = null
  let lastAssistantText = ''
  let turnEndReason = null
  let turnError = null
  let cancelledByCaller = false

  /** @type {Map<string, {name: string, startedAt: number, argsPreview: string, rawArgs: any}>} */
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
      activeTools,
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
        pushTimeline(seq, type, `turn ${data.turn ?? '?'}`)
        continue
      }
      if (!sawTurnStart) {
        // Ignore pre-turn session setup events until turn/start arrives,
        // except explicit approval/error events.
        if (!/error|approv/i.test(type)) continue
      }

      if (type === 'step/start') {
        steps += 1
        pushTimeline(seq, type, `step ${data.step ?? steps}`)
      } else if (type === 'tool/call') {
        toolCalls += 1
        const toolName = String(data.name ?? 'unknown')
        const callId = String(data.callId ?? `call_${seq}`)
        const argsPreview = preview(data.arguments, 140)
        lastTool = toolName
        inFlightTools.set(callId, {
          name: toolName,
          startedAt: nowMs(),
          argsPreview,
          rawArgs: data.arguments,
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
          if (errorStreak.tool === toolName) {
            errorStreak.count += 1
            errorStreak.lastError = inspected.summary
          } else {
            errorStreak = { tool: toolName, count: 1, lastError: inspected.summary }
          }
          pushTimeline(seq, 'tool/error', `${toolName}: ${inspected.summary}`)
        } else {
          errorStreak = { tool: '', count: 0, lastError: '' }
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
    // Give the agent a brief moment to settle after cancellation without hanging.
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

      if (cancelledByCaller || signal?.aborted) {
        await safeCancel()
        return {
          status: 'cancelled',
          reason: 'cancelled',
          text: lastAssistantText,
          question: null,
          error: null,
          stats: snapshot(),
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
        }
      }

      // 2. Repeated consecutive tool error loop breaker
      if (maxConsecutiveToolErrors > 0 && errorStreak.count >= maxConsecutiveToolErrors) {
        const detail = `Tool "${errorStreak.tool}" failed ${errorStreak.count} times in a row. Last error: ${errorStreak.lastError}`
        await safeCancel()
        return {
          status: 'stuck',
          reason: 'repeated_tool_error',
          text: lastAssistantText,
          question: null,
          error: { code: 'repeated_tool_error', message: detail },
          stats: snapshot(),
        }
      }

      // 3. Check if the agent has settled
      const isIdle = agent.status === 'idle'
      if (isIdle && (sawTurnStart || turnEndReason !== null || nowMs() - startedAt >= pollIntervalMs)) {
        const idleSeq = agent.session?.seq ?? cursor
        let waitingChildren = false
        if (subagents && typeof subagents.waitForChildren === 'function') {
          // Bound child drain wait so a hung child still trips our watchdogs.
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
          return {
            status: 'done',
            reason: turnEndReason ?? 'completed',
            text: lastAssistantText,
            question: null,
            error: null,
            stats: snapshot(),
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
        return {
          status: 'stuck',
          reason: 'max_turn_timeout',
          text: lastAssistantText,
          question: null,
          error: { code: 'max_turn_timeout', message: detail },
          stats: snapshot(),
        }
      }

      if (activeIdleLimit > 0 && idle >= activeIdleLimit) {
        const activeList = [...inFlightTools.values()].map((t) => t.name).join(', ')
        const detail =
          `No session activity for ${Math.round(idle / 1000)}s` +
          (activeList ? ` while tool(s) running: ${activeList}` : ` (last tool: ${lastTool ?? 'none'})`)
        await safeCancel()
        return {
          status: 'stuck',
          reason: 'idle_timeout',
          text: lastAssistantText,
          question: null,
          error: { code: 'idle_timeout', message: detail },
          stats: snapshot(),
        }
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
