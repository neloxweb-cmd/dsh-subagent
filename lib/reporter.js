/**
 * Safe diagnostic bug-report builder for @local/dsh-subagent.
 *
 * Collects system info, bridge/daemon health, recent session errors, and the
 * tail of daemon.log while automatically redacting tokens, API keys, passwords,
 * and local usernames so reports can be shared safely.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, homedir, platform, release } from 'node:os'
import { join } from 'node:path'

import { PACKAGE_NAME, PACKAGE_VERSION, nowIso } from './protocol.js'

/**
 * Redact secrets, tokens, API keys, passwords, connection strings, PEM keys,
 * and (optionally) local usernames from arbitrary text.
 * @param {string} input
 * @param {{extraSecrets?: string[], homePath?: string, redactPaths?: boolean}} [options]
 * @returns {string}
 */
export function redactSecrets(input, options = {}) {
  let text = String(input ?? '')
  const extraSecrets = Array.isArray(options.extraSecrets) ? options.extraSecrets : []
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      text = text.split(secret).join('<REDACTED_TOKEN>')
    }
  }

  if (options.redactPaths !== false) {
    const homePath = options.homePath ?? homedir()
    if (homePath && homePath.length > 3) {
      const winHome = homePath.replaceAll('/', '\\')
      const posixHome = homePath.replaceAll('\\', '/')
      text = text.split(winHome).join('<HOME>')
      text = text.split(posixHome).join('<HOME>')
    }
    text = text.replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/g, '$1<USER>')
    text = text.replace(/([A-Za-z]:\/Users\/)[^/\s"']+/g, '$1<USER>')
    text = text.replace(/(\/(?:Users|home)\/)[^/\s"']+/g, '$1<USER>')
  }

  // PEM private key blocks
  text = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '<REDACTED_PRIVATE_KEY>')
  // DB / queue URLs with embedded credentials
  text = text.replace(/\b((?:postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, '$1<REDACTED>$3')
  // Amazon SP-API / LWA tokens, secrets, and client IDs
  text = text.replace(/\bAtzr\|[A-Za-z0-9._~+/=-]{10,}/g, '<REDACTED_AMAZON_TOKEN>')
  text = text.replace(/\bamzn1\.oa2-cs\.v1\.[A-Za-z0-9._-]{10,}/g, '<REDACTED_AMAZON_SECRET>')
  text = text.replace(/\bamzn1\.application-oa2-client\.[A-Za-z0-9._-]{8,}/g, '<REDACTED_AMAZON_CLIENT_ID>')
  // JWT tokens
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '<REDACTED_JWT>')
  // Authorization headers & common API key / token formats
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1<REDACTED>')
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g, '<REDACTED_KEY>')
  // Generic .env lines (KEY=, SECRET=, TOKEN=, PASSWORD=, DSN=, CLIENT_ID=, etc.)
  text = text.replace(/^([ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS|PWD|CREDENTIAL|AUTH|DSN|DATABASE_URL|CONN_STR|CLIENT_ID)[ \t]*=[ \t]*)(.+)$/gim, '$1<REDACTED>')
  text = text.replace(/("(?:token|apiKey|api_key|password|secret|authorization|access_token|refresh_token|private_key|client_secret|client_id)"\s*:\s*")[^"]+(")/gi, '$1<REDACTED>$2')
  text = text.replace(/(\b(?:[A-Z0-9_]*(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|PRIVATE_KEY|PASSWORD|DATABASE_URL)|token|api_key|apikey|password|secret)\s*[=:]\s*)([^\s"',;]+)/gi, '$1<REDACTED>')

  return text
}

function readTailLines(filePath, maxLines = 50) {
  if (!existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf8')
    const lines = raw.split(/\r?\n/)
    while (lines.length > 0 && lines.at(-1) === '') lines.pop()
    return lines.slice(-maxLines)
  } catch (err) {
    return [`(unreadable: ${err.message})`]
  }
}

function readSessionsSummary(home) {
  const indexPath = join(home, 'sessions', 'index.json')
  if (!existsSync(indexPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
    const list = Array.isArray(parsed?.sessions) ? parsed.sessions : []
    return list
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(0, 10)
      .map((s) => ({
        name: s.name,
        status: s.status,
        turns: s.turnCount ?? 0,
        lastOutcome: s.lastOutcome ?? '-',
        lastError: s.lastError ? String(s.lastError).slice(0, 200) : null,
        updatedAt: s.updatedAt ?? null,
      }))
  } catch (err) {
    return [{ name: '(corrupt index.json)', status: 'error', turns: 0, lastOutcome: 'error', lastError: err.message }]
  }
}

function readProfileSummary(dshHome) {
  const profileDir = join(dshHome, 'profiles', 'subagent')
  const pkgPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const exists = existsSync(profileDir)
  let bundles = []
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
    } catch {
      bundles = ['(unreadable package.json)']
    }
  }
  return {
    exists,
    hasPatch: existsSync(patchPath),
    bundles,
  }
}

export function generateBugReport({ home, dshHome, dshBin, probe, extraSecrets = [] }) {
  const resolvedDshHome = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profile = readProfileSummary(resolvedDshHome)
  const sessions = readSessionsSummary(home)
  const daemonTail = readTailLines(join(home, 'daemon.log'), 50)

  const lines = [
    '=== dsh-subagent diagnostic report ===',
    `generated:   ${nowIso()}`,
    `package:     ${PACKAGE_NAME} ${PACKAGE_VERSION}`,
    `node:        ${process.version}`,
    `os:          ${platform()} ${release()} (${arch()})`,
    `dsh binary:  ${dshBin ?? 'NOT FOUND'}`,
    `profile:     exists=${profile.exists} patch=${profile.hasPatch} bundles=[${profile.bundles.join(', ')}]`,
    `bridge:      ${probe.ok ? `OK (${probe.disc.url}, pid ${probe.health?.pid})` : `DOWN (${probe.error})`}`,
  ]

  if (probe.ok && probe.health) {
    const r = probe.health.route ?? {}
    lines.push(`route:       ${r.provider ?? '?'} / ${r.model ?? '?'}`)
    lines.push(`active runs: ${(probe.health.activeRuns ?? []).length}`)
  }

  lines.push('', '--- recent sessions (max 10) ---')
  if (sessions.length === 0) {
    lines.push('(none)')
  } else {
    for (const s of sessions) {
      lines.push(
        `- ${s.name} | ${s.status} | turns=${s.turns} | outcome=${s.lastOutcome}${s.lastError ? ` | error=${s.lastError}` : ''}`,
      )
    }
  }

  lines.push('', '--- daemon.log (last 50 lines) ---')
  if (!daemonTail || daemonTail.length === 0) {
    lines.push('(no daemon.log)')
  } else {
    lines.push(...daemonTail)
  }
  lines.push('=== end report ===')

  const secrets = [...extraSecrets]
  if (probe?.disc?.token) secrets.push(probe.disc.token)
  const redacted = redactSecrets(lines.join('\n') + '\n', { extraSecrets: secrets })

  let reportPath = null
  try {
    mkdirSync(home, { recursive: true })
    reportPath = join(home, 'bug-report.txt')
    writeFileSync(reportPath, redacted, 'utf8')
  } catch {
    reportPath = null
  }

  return { text: redacted, reportPath }
}
