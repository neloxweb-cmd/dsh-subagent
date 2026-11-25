/**
 * Ultra-clean, native-looking Claude Code / Claude Desktop Mod for @local/dsh-subagent (v2.1.0).
 *
 * Design principles:
 * - ZERO double borders (uses Claude Desktop's own soft container natively)
 * - Calm single-line bar by default: `● DeepSeek · auth   Tests draaien (2/4)   1m24s [▾]`
 * - Clickable expand/collapse Button for the checklist + token count
 * - Brief 5s green "Klaar" confirmation (or dismissable with `×`), completely hidden when idle
 *
 * Strictly obeys Claude Code's static mod validator:
 * - Zero Node.js imports
 * - `$` is always spelled `$.noun.method(...)` at the call site
 * - `on` is always `on("<event>", hook)`
 */

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

interface SubagentCard {
  name: string
  runId: string
  mode?: string
  status: string
  elapsedMs: number
  toolCalls: number
  activity: string
  todos: TodoItem[]
  tokens: number
  costEur: number
}

let cardsState: SubagentCard[] = []
let expanded = false
const dismissedRunIds = new Set<string>()
/** Sessions started/sent/steered from THIS Claude chat (name -> expiry ms). */
const ownedSessions = new Map<string, number>()
let lastPollAt = 0
let consecutiveErrors = 0
let tickScheduled = false

function extractCommandText(e: any): string {
  const candidates = [
    e?.input?.command,
    e?.tool_input?.command,
    e?.args?.command,
    e?.command,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c
  }
  try {
    const obj = e?.input ?? e?.tool_input ?? e?.args
    if (obj && typeof obj === 'object') return JSON.stringify(obj)
  } catch {
    /* ignore */
  }
  return ''
}

function trackSubagentCommands(cmd: string): boolean {
  if (!cmd || !/ds-subagent/i.test(cmd)) return false
  let touched = false
  const re = /\bds-subagent(?:\.cmd|\.mjs)?\s+(start|send|steer|close)\s+["']?([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})["']?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(cmd)) !== null) {
    const verb = m[1].toLowerCase()
    const name = m[2]
    if (!name || name.startsWith('-')) continue
    if (verb === 'close') {
      if (ownedSessions.has(name)) {
        ownedSessions.set(name, Date.now() + 8000)
        touched = true
      }
    } else {
      ownedSessions.set(name, Date.now() + 2 * 60 * 60 * 1000)
      touched = true
    }
  }
  return touched
}

function pruneOwnedSessions(now: number): void {
  for (const [name, exp] of ownedSessions) {
    if (exp <= now) ownedSessions.delete(name)
  }
}

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round((ms || 0) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}

function fmtTokens(n: number, costEur = 0): string {
  if (!n || n <= 0) return ''
  const tok = n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`
  if (!costEur || costEur <= 0) return tok
  const eur = costEur < 0.01 ? `~€${costEur.toFixed(4).replace('.', ',')}` : `~€${costEur.toFixed(2).replace('.', ',')}`
  return `${tok} (${eur})`
}

function fmtTools(n: number): string {
  if (!n || n <= 0) return ''
  return n === 1 ? '1 stap' : `${n} stappen`
}

function clip(text: string, max = 46): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

function humanizeActivity(raw: string): string {
  const s = String(raw || '').trim()
  if (!s || /^starting/i.test(s)) return 'Starten…'
  if (/^step \d+:?\s*thinking/i.test(s) || /^thinking/i.test(s)) return 'Nadenken…'
  const m = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(s)
  if (m) {
    const tool = m[1].toLowerCase()
    const target = clip(m[2], 32)
    if (tool === 'read' || tool === 'read_file') return `Lezen: ${target}`
    if (tool === 'edit' || tool === 'edit_file' || tool === 'write' || tool === 'write_file' || tool === 'patch') {
      return `Aanpassen: ${target}`
    }
    if (tool === 'pwsh' || tool === 'bash' || tool === 'shell' || tool === 'exec') return `Uitvoeren: ${target}`
    if (tool === 'grep' || tool === 'glob' || tool === 'search' || tool === 'find') return `Zoeken: ${target}`
    if (tool === 'todo_write') return 'Takenlijst bijwerken'
    return clip(`${tool}: ${target}`, 40)
  }
  return clip(s, 40)
}

function todoMarker(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'in_progress':
      return '●'
    case 'cancelled':
      return '×'
    default:
      return '○'
  }
}

function visibleTodos(todos: TodoItem[], maxRows = 5): { items: TodoItem[]; hiddenCount: number } {
  if (todos.length <= maxRows) return { items: todos, hiddenCount: 0 }
  const activeIdx = todos.findIndex((t) => t.status === 'in_progress')
  const start = activeIdx >= 0 ? Math.max(0, Math.min(activeIdx - 1, todos.length - maxRows)) : todos.length - maxRows
  const items = todos.slice(start, start + maxRows)
  return { items, hiddenCount: todos.length - items.length }
}

function toCard(r: any, isRecent: boolean): SubagentCard {
  const p = r?.progress ?? {}
  const u = p?.usage ?? {}
  const startedMs = Date.parse(String(r?.startedAt ?? ''))
  const elapsedMs = isRecent
    ? Number(p.elapsedMs || 0)
    : Number.isFinite(startedMs)
      ? Math.max(Number(p.elapsedMs || 0), Date.now() - startedMs)
      : Number(p.elapsedMs || 0)
  const inp = Number(u.inputTokens || 0)
  const out = Number(u.outputTokens || 0)
  const cache = Math.min(inp, Number(u.cacheReadTokens || 0))
  const costEur = ((inp - cache) * 0.25 + cache * 0.03 + out * 0.70) / 1_000_000
  return {
    name: String(r?.name ?? 'deepseek'),
    runId: String(r?.runId ?? r?.name ?? ''),
    mode: typeof r?.mode === 'string' ? r.mode : undefined,
    status: String(r?.status ?? 'running'),
    elapsedMs,
    toolCalls: Number(p.toolCalls || 0),
    activity: humanizeActivity(String(p.currentActivity || p.lastTool || '')),
    todos: Array.isArray(p.todos) ? p.todos : [],
    tokens: inp + out,
    costEur,
  }
}

function parseLiveSnapshot(raw: unknown): SubagentCard[] | null {
  try {
    const text = typeof raw === 'string' ? raw : typeof (raw as any)?.content === 'string' ? (raw as any).content : ''
    if (!text.trim()) return null
    const parsed = JSON.parse(text)
    const updatedMs = Date.parse(String(parsed?.updatedAt ?? ''))
    if (!Number.isFinite(updatedMs) || Date.now() - updatedMs > 180_000) return []
    const active = Array.isArray(parsed?.activeRuns) ? parsed.activeRuns.map((r: any) => toCard(r, false)) : []
    const recent = Array.isArray(parsed?.recentRuns)
      ? parsed.recentRuns
          .map((r: any) => toCard(r, true))
          .filter((c: SubagentCard) => !dismissedRunIds.has(c.runId))
      : []
    return [...active, ...recent].slice(0, 3)
  } catch {
    return null
  }
}

function buildLivePath(explicitHome: unknown, userProfile: unknown, unixHome: unknown): string | null {
  if (typeof explicitHome === 'string' && explicitHome.trim()) {
    return `${explicitHome.replace(/[\\/]+$/, '')}/live.json`
  }
  const base =
    typeof userProfile === 'string' && userProfile.trim()
      ? userProfile
      : typeof unixHome === 'string'
        ? unixHome
        : ''
  if (!base.trim()) return null
  return `${base.replace(/[\\/]+$/, '')}/.dsh-subagent/live.json`
}

export function register(on: any) {
  on('tool.call', async ($: any, e: any, next: any) => {
    try {
      const cmd = extractCommandText(e)
      if (trackSubagentCommands(cmd)) {
        lastPollAt = 0
        try {
          $.ui.invalidate('ui.render')
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* never block tool calls */
    }
    return next(e)
  })

  on('ui.render', async ($: any, e: any, next: any) => {
    const existing = await next(e)
    if (e?.component !== 'AbovePrompt') return existing

    const now = Date.now()
    pruneOwnedSessions(now)
    // Chat-scoped: never show or poll anything in chats that did not launch a DeepSeek subagent.
    if (ownedSessions.size === 0) {
      cardsState = []
      return existing
    }

    const pollInterval = cardsState.length > 0 ? 1000 : 2000
    if (now - lastPollAt >= pollInterval) {
      lastPollAt = now
      try {
        const livePath = buildLivePath(
          await $.env.get('DSH_SUBAGENT_HOME'),
          await $.env.get('USERPROFILE'),
          await $.env.get('HOME'),
        )
        if (livePath) {
          const raw = await $.fs.read(livePath)
          const parsed = parseLiveSnapshot(raw)
          if (parsed !== null) {
            cardsState = parsed.filter((card) => ownedSessions.has(card.name))
            consecutiveErrors = 0
          } else {
            consecutiveErrors += 1
            if (consecutiveErrors >= 3) cardsState = []
          }
        }
      } catch {
        consecutiveErrors += 1
        if (consecutiveErrors >= 3) cardsState = []
      }
    }

    if (!tickScheduled && ownedSessions.size > 0) {
      tickScheduled = true
      const nextDelay = cardsState.length > 0 ? 1200 : 3000
      setTimeout(() => {
        tickScheduled = false
        try {
          $.ui.invalidate('ui.render')
        } catch {
          /* ignore */
        }
      }, nextDelay)
    }

    if (cardsState.length === 0) return existing

    try {
      const ui = $.ui.resolve(e)
      if (!ui || typeof ui.Box !== 'function' || typeof ui.Text !== 'function') return existing
      const { Box, Text, Button } = ui

      const rows = cardsState.map((card) => {
        const isRunning = card.status === 'running'
        const isDone = card.status === 'done'
        const isWarn =
          card.status === 'needs_input' ||
          card.status === 'stuck' ||
          card.status === 'loop' ||
          card.status === 'blocked_policy'
        const dotColor = isRunning ? 'accent' : isDone ? 'success' : isWarn ? 'warning' : 'error'
        const dot = isDone ? '✓' : '●'

        const doneCount = card.todos.filter((t) => t.status === 'completed').length
        const countLabel = card.todos.length > 0 ? ` (${doneCount}/${card.todos.length})` : ''
        const statusSummary = isRunning
          ? `${card.activity}${countLabel}`
          : isDone
            ? 'Klaar'
            : card.status === 'needs_input'
              ? 'Vraag nodig'
              : card.status === 'loop'
                ? 'Herhaallus gestopt'
                : card.status === 'stuck'
                  ? 'Vastgelopen'
                  : card.status === 'blocked_policy'
                    ? 'Alleen-lezen geblokkeerd'
                    : 'Gestopt'

        const rightControls: any[] = [
          Text({ dimColor: true, children: [fmtDuration(card.elapsedMs)] }),
        ]

        const hasDetails = card.todos.length > 0 || card.tokens > 0 || card.toolCalls > 0
        if (typeof Button === 'function' && hasDetails) {
          rightControls.push(
            Button({
              key: `toggle-${card.runId || card.name}`,
              label: expanded ? '▴' : '▾',
              onPress: () => {
                expanded = !expanded
                try {
                  $.ui.invalidate('ui.render')
                } catch {
                  /* ignore */
                }
              },
            }),
          )
        }
        if (typeof Button === 'function' && !isRunning) {
          rightControls.push(
            Button({
              key: `dismiss-${card.runId || card.name}`,
              label: '×',
              onPress: () => {
                dismissedRunIds.add(card.runId)
                cardsState = cardsState.filter((c) => c.runId !== card.runId)
                try {
                  $.ui.invalidate('ui.render')
                } catch {
                  /* ignore */
                }
              },
            }),
          )
        }

        const cardChildren: any[] = [
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: 2,
            children: [
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: [
                  Text({ color: dotColor, bold: true, children: [dot] }),
                  Text({ bold: true, children: [`DeepSeek · ${card.name}`] }),
                  Text({ dimColor: true, children: [statusSummary] }),
                ],
              }),
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: rightControls,
              }),
            ],
          }),
        ]

        if (expanded) {
          if (card.todos.length > 0) {
            const { items, hiddenCount } = visibleTodos(card.todos, 5)
            for (const item of items) {
              cardChildren.push(
                Text({
                  color: item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'accent' : undefined,
                  dimColor: item.status === 'pending' || item.status === 'cancelled',
                  children: [`  ${todoMarker(item.status)} ${clip(item.content, 56)}`],
                }),
              )
            }
            if (hiddenCount > 0) {
              cardChildren.push(Text({ dimColor: true, children: [`    +${hiddenCount} meer`] }))
            }
          }
          const detailParts = [
            card.mode === 'readonly' ? 'alleen-lezen' : card.mode === 'workspace' ? 'workspace' : '',
            fmtTools(card.toolCalls),
            fmtTokens(card.tokens, card.costEur),
          ].filter(Boolean)
          if (detailParts.length > 0) {
            cardChildren.push(Text({ dimColor: true, children: [`  ${detailParts.join(' · ')}`] }))
          }
        }

        return Box({ flexDirection: 'column', children: cardChildren })
      })

      const band = Box({ flexDirection: 'column', children: rows })
      return existing ? Box({ flexDirection: 'column', children: [existing, band] }) : band
    } catch {
      return existing
    }
  })
}

export default { name: 'deepseek-subagent', version: '2.1.0', register }
