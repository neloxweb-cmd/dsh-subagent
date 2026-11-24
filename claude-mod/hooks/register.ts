/**
 * Sleek, calm Claude Code Mod for @local/dsh-subagent (v2.0.1).
 *
 * Strictly follows Claude Code's static mod validator rules:
 * - Zero Node.js imports
 * - `$` is always spelled `$.noun.method(...)` at the call site
 * - `on` is always `on("<event>", hook)`
 *
 * Reads atomic `~/.dsh-subagent/live.json`, tolerates transient read glitches,
 * shows a clean compact rounded card with progress bar + humanized status +
 * live checklist while DeepSeek is running, plus a brief green "Klaar" badge
 * before hiding cleanly.
 */

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

interface SubagentCard {
  name: string
  mode?: string
  status: string
  elapsedMs: number
  toolCalls: number
  activity: string
  todos: TodoItem[]
  tokens: number
}

let cardsState: SubagentCard[] = []
let lastPollAt = 0
let consecutiveErrors = 0
let tickScheduled = false

function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round((ms || 0) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${String(s).padStart(2, '0')}s`
}

function fmtTokens(n: number): string {
  if (!n || n <= 0) return ''
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`
}

function clip(text: string, max = 56): string {
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
    const target = clip(m[2], 38)
    if (tool === 'read' || tool === 'read_file') return `Lezen: ${target}`
    if (tool === 'edit' || tool === 'edit_file' || tool === 'write' || tool === 'write_file' || tool === 'patch') {
      return `Aanpassen: ${target}`
    }
    if (tool === 'pwsh' || tool === 'bash' || tool === 'shell' || tool === 'exec') return `Uitvoeren: ${target}`
    if (tool === 'grep' || tool === 'glob' || tool === 'search' || tool === 'find') return `Zoeken: ${target}`
    if (tool === 'todo_write') return 'Takenlijst bijwerken'
    return clip(`${tool}: ${target}`, 48)
  }
  return clip(s, 48)
}

function progressBar(done: number, total: number, width = 8): string {
  if (total <= 0) return ''
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function todoMarker(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '✓'
    case 'in_progress':
      return '▶'
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
  return {
    name: String(r?.name ?? 'deepseek'),
    mode: typeof r?.mode === 'string' ? r.mode : undefined,
    status: String(r?.status ?? 'running'),
    elapsedMs,
    toolCalls: Number(p.toolCalls || 0),
    activity: humanizeActivity(String(p.currentActivity || p.lastTool || '')),
    todos: Array.isArray(p.todos) ? p.todos : [],
    tokens: Number(u.inputTokens || 0) + Number(u.outputTokens || 0),
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
    const recent = Array.isArray(parsed?.recentRuns) ? parsed.recentRuns.map((r: any) => toCard(r, true)) : []
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
  on('ui.render', async ($: any, e: any, next: any) => {
    const existing = await next(e)
    if (e?.component !== 'AbovePrompt') return existing

    const now = Date.now()
    const pollInterval = cardsState.length > 0 ? 1000 : 2500
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
            cardsState = parsed
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

    if (!tickScheduled) {
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
      const { Box, Text } = ui

      const rendered = cardsState.map((card) => {
        const isRunning = card.status === 'running'
        const isDone = card.status === 'done'
        const isWarn = card.status === 'needs_input' || card.status === 'stuck' || card.status === 'blocked_policy'
        const dot = isRunning ? '●' : isDone ? '✓' : isWarn ? '!' : '×'
        const color = isRunning ? 'cyan' : isDone ? 'success' : isWarn ? 'warning' : 'error'
        const stateText = isRunning
          ? ''
          : isDone
            ? ' · Klaar'
            : card.status === 'needs_input'
              ? ' · Vraag nodig'
              : card.status === 'stuck'
                ? ' · Vastgelopen'
                : card.status === 'blocked_policy'
                  ? ' · Geblokkeerd'
                  : ' · Gestopt'
        const modeTag = card.mode && card.mode !== 'full' ? ` [${card.mode}]` : ''
        const meta = [fmtDuration(card.elapsedMs), `${card.toolCalls} tools`, fmtTokens(card.tokens)]
          .filter(Boolean)
          .join(' · ')

        const rows: any[] = [
          Box({
            flexDirection: 'row',
            justifyContent: 'space-between',
            columnGap: 2,
            children: [
              Text({ color, bold: true, children: [`${dot} DeepSeek · ${card.name}${modeTag}${stateText}`] }),
              Text({ dimColor: true, children: [meta] }),
            ],
          }),
        ]

        if (isRunning) {
          const doneCount = card.todos.filter((t) => t.status === 'completed').length
          const bar = card.todos.length > 0 ? `${progressBar(doneCount, card.todos.length)} ${doneCount}/${card.todos.length}  ·  ` : ''
          rows.push(Text({ dimColor: true, children: [`  ${bar}${card.activity}`] }))
        }

        if (card.todos.length > 0) {
          const { items, hiddenCount } = visibleTodos(card.todos, 5)
          for (const item of items) {
            rows.push(
              Text({
                color: item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'cyan' : undefined,
                dimColor: item.status === 'pending' || item.status === 'cancelled',
                children: [`  ${todoMarker(item.status)} ${clip(item.content, 58)}`],
              }),
            )
          }
          if (hiddenCount > 0) {
            rows.push(Text({ dimColor: true, children: [`    +${hiddenCount} meer…`] }))
          }
        }

        return Box({
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: isDone ? 'green' : isWarn ? 'yellow' : 'gray',
          paddingX: 1,
          children: rows,
        })
      })

      const band = Box({ flexDirection: 'column', children: rendered })
      return existing ? Box({ flexDirection: 'column', children: [existing, band] }) : band
    } catch {
      return existing
    }
  })
}

export default { name: 'deepseek-subagent', version: '2.0.1', register }
