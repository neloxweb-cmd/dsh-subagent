/**
 * Calm, zero-clutter Claude Code Mod for @local/dsh-subagent.
 *
 * Strictly follows Claude Code's static mod validator rules:
 * - Zero Node.js imports
 * - `$` is always spelled `$.noun.method(...)` at the call site
 * - `on` is always `on("<event>", hook)`
 *
 * Reads `~/.dsh-subagent/live.json` (written only while DeepSeek is running)
 * and renders a compact live checklist right above the prompt (`AbovePrompt`).
 * Hides completely when idle.
 */

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

interface ActiveSubagent {
  name: string
  mode?: string
  elapsedMs: number
  toolCalls: number
  currentActivity: string
  todos: TodoItem[]
  tokens: number
}

let activeRuns: ActiveSubagent[] = []
let lastPollAt = 0
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

function parseLiveSnapshot(raw: unknown): ActiveSubagent[] {
  try {
    const text = typeof raw === 'string' ? raw : typeof (raw as any)?.content === 'string' ? (raw as any).content : ''
    if (!text.trim()) return []
    const parsed = JSON.parse(text)
    const updatedMs = Date.parse(String(parsed?.updatedAt ?? ''))
    if (!Number.isFinite(updatedMs) || Date.now() - updatedMs > 90_000) return []
    const list = Array.isArray(parsed?.activeRuns) ? parsed.activeRuns : []
    return list.map((r: any) => {
      const p = r?.progress ?? {}
      const u = p?.usage ?? {}
      const startedMs = Date.parse(String(r?.startedAt ?? ''))
      const elapsedMs = Number.isFinite(startedMs)
        ? Math.max(Number(p.elapsedMs || 0), Date.now() - startedMs)
        : Number(p.elapsedMs || 0)
      return {
        name: String(r?.name ?? 'deepseek'),
        mode: typeof r?.mode === 'string' ? r.mode : undefined,
        elapsedMs,
        toolCalls: Number(p.toolCalls || 0),
        currentActivity: String(p.currentActivity || p.lastTool || 'Bezig...'),
        todos: Array.isArray(p.todos) ? p.todos.slice(0, 6) : [],
        tokens: Number(u.inputTokens || 0) + Number(u.outputTokens || 0),
      }
    })
  } catch {
    return []
  }
}

function buildLivePath(explicitHome: unknown, userProfile: unknown, unixHome: unknown): string | null {
  if (typeof explicitHome === 'string' && explicitHome.trim()) {
    return `${explicitHome.replace(/[\\/]+$/, '')}/live.json`
  }
  const base = typeof userProfile === 'string' && userProfile.trim() ? userProfile : typeof unixHome === 'string' ? unixHome : ''
  if (!base.trim()) return null
  return `${base.replace(/[\\/]+$/, '')}/.dsh-subagent/live.json`
}

export function register(on: any) {
  on('ui.render', async ($: any, e: any, next: any) => {
    const existing = await next(e)
    if (e?.component !== 'AbovePrompt') return existing

    const now = Date.now()
    if (now - lastPollAt >= 1200) {
      lastPollAt = now
      try {
        const livePath = buildLivePath(
          await $.env.get('DSH_SUBAGENT_HOME'),
          await $.env.get('USERPROFILE'),
          await $.env.get('HOME'),
        )
        if (livePath) {
          const raw = await $.fs.read(livePath)
          activeRuns = parseLiveSnapshot(raw)
        }
      } catch {
        activeRuns = []
      }
    }

    if (activeRuns.length > 0 && !tickScheduled) {
      tickScheduled = true
      setTimeout(() => {
        tickScheduled = false
        try {
          $.ui.invalidate('ui.render')
        } catch {
          /* ignore */
        }
      }, 1500)
    }

    if (activeRuns.length === 0) return existing

    try {
      const ui = $.ui.resolve(e)
      if (!ui || typeof ui.Box !== 'function' || typeof ui.Text !== 'function') return existing
      const { Box, Text } = ui

      const cards = activeRuns.slice(0, 3).map((run) => {
        const doneCount = run.todos.filter((t) => t.status === 'completed').length
        const progressLabel = run.todos.length > 0 ? ` (${doneCount}/${run.todos.length})` : ''
        const tokLabel = fmtTokens(run.tokens)
        const modeTag = run.mode && run.mode !== 'full' ? ` [${run.mode}]` : ''
        const meta = [fmtDuration(run.elapsedMs), `${run.toolCalls} tools`, tokLabel].filter(Boolean).join(' · ')

        const rows = [
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ color: 'warning', bold: true, children: [`● DeepSeek ${run.name}${modeTag}${progressLabel}`] }),
              Text({ dimColor: true, children: [`${meta} — ${run.currentActivity}`] }),
            ],
          }),
          ...run.todos.map((t, idx) =>
            Text({
              color: t.status === 'completed' ? 'success' : t.status === 'in_progress' ? 'warning' : undefined,
              dimColor: t.status === 'pending' || t.status === 'cancelled',
              children: [`  ${todoMarker(t.status)} ${idx + 1}. ${t.content}`],
            }),
          ),
        ]

        return Box({ flexDirection: 'column', children: rows })
      })

      const band = Box({ flexDirection: 'column', rowGap: 1, children: cards })
      return existing ? Box({ flexDirection: 'column', rowGap: 1, children: [existing, band] }) : band
    } catch {
      return existing
    }
  })
}

export default { name: 'deepseek-subagent', version: '2.0.0', register }
