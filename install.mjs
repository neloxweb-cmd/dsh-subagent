#!/usr/bin/env node
/**
 * One-command installer & uninstaller for @local/dsh-subagent.
 *
 * Works on Windows (via INSTALL.cmd or `node install.mjs`), macOS, and Linux.
 * Zero external dependencies — Node.js >= 20 built-ins only.
 *
 * Usage:
 *   node install.mjs              # install or update
 *   node install.mjs --dry-run    # preview changes without writing
 *   node install.mjs --uninstall  # remove launchers, skills, and subagent profile
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findDshBinary } from './lib/cli.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DRY_RUN = process.argv.includes('--dry-run')
const UNINSTALL = process.argv.includes('--uninstall')
const NO_AUTOSTART = process.argv.includes('--no-autostart')

const HOME = homedir()
const SUBAGENT_HOME = process.env.DSH_SUBAGENT_HOME || join(HOME, '.dsh-subagent')
const APP_DIR = join(SUBAGENT_HOME, 'app')
const BIN_DIR = join(HOME, 'bin')
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'subagent')
const DESKTOP_PATCH = join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml')

const SKILL_ONLY_TARGETS = [
  join(HOME, '.gemini', 'config', 'skills', 'deepseek-subagent'),
  join(HOME, '.agents', 'skills', 'deepseek-subagent'),
]
const CLAUDE_PLUGIN_TARGET = join(HOME, '.claude', 'skills', 'deepseek-subagent')

function log(msg) {
  console.log(msg)
}

function fail(msg) {
  console.error('\n[FOUT] ' + msg)
  process.exit(1)
}

/**
 * Extract only the `llm-pi-ai` and `agent-default-model` YAML entries from an
 * existing DSH desktop patch so the friend's own provider/model works automatically.
 */
export function extractDesktopModelBlocks(yamlText) {
  if (typeof yamlText !== 'string' || !yamlText.trim()) return ''
  const lines = yamlText.split(/\r?\n/)
  const blocks = []
  let current = null
  const flush = () => {
    if (!current) return
    const first = current[0] ?? ''
    if (/^-\s+id:\s*(llm-pi-ai|agent-default-model)\s*$/.test(first)) {
      // Trim trailing blank/comment lines belonging to the next block
      while (current.length > 0 && (/^\s*$/.test(current.at(-1)) || /^#/.test(current.at(-1)))) {
        current.pop()
      }
      blocks.push(current.join('\n'))
    }
    current = null
  }
  for (const line of lines) {
    if (/^-\s+/.test(line)) {
      flush()
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  flush()
  return blocks.join('\n\n')
}

function runDsh(dshBin, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(dshBin)) {
    const electronExe = resolve(dshBin, '..', '..', '..', '..', '..', 'DeepSeek Harness.exe')
    const cliEntry = resolve(
      dshBin,
      '..',
      '..',
      '..',
      '..',
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-desktop-host',
      'lib',
      'cli.js',
    )
    if (existsSync(electronExe)) {
      return spawnSync(electronExe, ['--expose-internals', cliEntry, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    }
  }
  return spawnSync(dshBin, args, { encoding: 'utf8', windowsHide: true })
}

function ensureWindowsUserPath(dir) {
  if (process.platform !== 'win32') return false
  const psScript = `
$dir = '${dir.replaceAll("'", "''")}'
$cur = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $cur) { $cur = '' }
$parts = @($cur -split ';' | Where-Object { $_ -ne '' })
$norm = $dir.TrimEnd('\\','/').ToUpperInvariant()
$has = $parts | Where-Object { $_.Trim().Trim('"').TrimEnd('\\','/').ToUpperInvariant() -eq $norm }
if (-not $has) {
  $next = (@($dir) + $parts) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  Write-Output 'ADDED'
} else {
  Write-Output 'PRESENT'
}
`
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return (res.stdout || '').includes('ADDED')
}

function stopRunningDaemon() {
  const pids = new Set()
  for (const file of [join(SUBAGENT_HOME, 'bridge.json'), join(SUBAGENT_HOME, 'daemon.pid')]) {
    if (!existsSync(file)) continue
    try {
      const raw = readFileSync(file, 'utf8').trim()
      if (file.endsWith('.json')) {
        const parsed = JSON.parse(raw)
        if (Number.isInteger(parsed?.pid) && parsed.pid > 0) pids.add(parsed.pid)
      } else {
        const n = Number(raw)
        if (Number.isInteger(n) && n > 0) pids.add(n)
      }
    } catch {
      /* ignore */
    }
  }
  let stopped = 0
  for (const pid of pids) {
    try {
      process.kill(pid, 0)
    } catch (err) {
      if (err?.code !== 'EPERM') continue
    }
    if (!DRY_RUN) {
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          stopped += 1
        } catch {
          /* already exited */
        }
      } else {
        try {
          process.kill(pid, 'SIGTERM')
          stopped += 1
        } catch {
          /* already exited */
        }
      }
    } else {
      stopped += 1
    }
  }
  return stopped
}

function doUninstall() {
  log('=== dsh-subagent verwijderen ===')
  const stopped = stopRunningDaemon()
  if (stopped > 0) log(`${DRY_RUN ? '[dry-run] zou stoppen' : 'Gestopt'}: lopende DSH-subagent daemon`)
  const targets = [
    join(BIN_DIR, 'ds-subagent.cmd'),
    join(BIN_DIR, 'ds-subagent'),
    CLAUDE_PLUGIN_TARGET,
    ...SKILL_ONLY_TARGETS,
    APP_DIR,
    PROFILE_DIR,
  ]
  for (const t of targets) {
    if (existsSync(t)) {
      log(`${DRY_RUN ? '[dry-run] zou verwijderen' : 'Verwijderd'}: ${t}`)
      if (!DRY_RUN) rmSync(t, { recursive: true, force: true })
    }
  }
  log('\nKlaar! (Je sessie-logs in ~/.dsh-subagent/sessions zijn bewaard; verwijder die map zelf als je alles wilt wissen.)')
}

function doInstall() {
  log('=== DeepSeek Subagent (ds-subagent) Installer ===\n')

  // 1. Check Node version
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(major) || major < 20) {
    fail(`Node.js 20 of hoger is nodig (nu geïnstalleerd: v${process.versions.node}). Download via https://nodejs.org/`)
  }
  log(`[1/6] Node.js v${process.versions.node} gevonden.`)

  // 2. Find DeepSeek Harness
  const dshBin = findDshBinary(process.env)
  if (!dshBin) {
    fail(
      'DeepSeek Harness (dsh) is niet gevonden op deze pc.\n' +
        'Download & installeer eerst DeepSeek Harness via: https://github.com/deepseek-ai/deepseek-harness\n' +
        'Log daar 1x in met je model/API-key, en draai deze installer daarna opnieuw.',
    )
  }
  log(`[2/6] DeepSeek Harness gevonden: ${dshBin}`)

  const stopped = stopRunningDaemon()
  if (stopped > 0) {
    log(`      -> Oude lopende subagent-daemon gestopt zodat de nieuwe versie direct actief wordt.`)
  }

  // 3. Copy package to permanent location (~/.dsh-subagent/app)
  log(`[3/6] Installeren naar ${APP_DIR} ...`)
  if (!DRY_RUN) {
    mkdirSync(APP_DIR, { recursive: true })
    for (const item of ['package.json', 'cordis.patch.yml', 'install.mjs', 'README.md', 'lib', 'bin', 'skills', 'claude-mod']) {
      const src = join(HERE, item)
      const dst = join(APP_DIR, item)
      if (existsSync(src)) {
        rmSync(dst, { recursive: true, force: true })
        cpSync(src, dst, { recursive: true })
      }
    }
  }

  // 4. Create/update dedicated `subagent` DSH profile
  log(`[4/6] DSH-profiel "subagent" inrichten in ${PROFILE_DIR} ...`)
  let inheritedBlocks = ''
  if (existsSync(DESKTOP_PATCH)) {
    try {
      inheritedBlocks = extractDesktopModelBlocks(readFileSync(DESKTOP_PATCH, 'utf8'))
    } catch {
      inheritedBlocks = ''
    }
  }
  if (inheritedBlocks) {
    log('      -> Bestaande model/provider-instellingen uit je Desktop-profiel automatisch overgenomen.')
  } else {
    log('      -> Gebruikt DeepSeek Harness standaard model/account.')
  }

  const patchLines = [
    '# DeepSeek Harness dedicated subagent profile (Antigravity + Claude Code)',
    '# Automatically configured by dsh-subagent installer.',
    '',
    '- id: agent-preset-registry',
    '  name: "@deepseek-ai/dsh-agent-preset-registry"',
    '  config:',
    '    default: standard',
    '',
  ]
  if (inheritedBlocks) {
    patchLines.push(inheritedBlocks, '')
  }
  patchLines.push(
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '      workspace-write:',
    '        sandbox: workspace-write',
    '        approval: ask',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    '    defaultPreset: danger-full-access',
    '',
    '- id: tool-fs',
    '  disabled: false',
    '- id: tool-fs-search',
    '  disabled: false',
    process.platform === 'win32' ? '- id: tool-pwsh' : '- id: tool-bash',
    '  disabled: false',
    '- id: tool-todo',
    '  disabled: false',
    '',
    '- id: dsh-subagent',
    '  name: "@local/dsh-subagent"',
    '  config:',
    '    enabled: true',
    '    host: 127.0.0.1',
    '    port: 45720',
    '    profile: subagent',
    '    agentPreset: standard',
    '',
  )

  const linkSpec = 'link:' + APP_DIR.replaceAll('\\', '/')

  if (!DRY_RUN) {
    mkdirSync(PROFILE_DIR, { recursive: true })
    writeFileSync(join(PROFILE_DIR, 'cordis.yml'), '[]\n', 'utf8')
    writeFileSync(
      join(PROFILE_DIR, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
      'utf8',
    )
    writeFileSync(
      join(PROFILE_DIR, 'package.json'),
      JSON.stringify(
        {
          name: 'dsh-profile-subagent',
          private: true,
          dependencies: {
            '@local/dsh-subagent': linkSpec,
          },
          dsh: {
            profile: {
              bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-subagent'],
            },
          },
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
    writeFileSync(join(PROFILE_DIR, 'cordis.patch.yml'), patchLines.join('\n'), 'utf8')

    const addRes = runDsh(dshBin, ['plugin', '--profile', 'subagent', 'add', linkSpec])
    if (addRes.status !== 0) {
      fail('Kon plugin niet koppelen aan DSH-profiel:\n' + (addRes.stderr || addRes.stdout || 'onbekende fout'))
    }
    // Ensure @local/dsh-subagent stays in dsh.profile.bundles
    const pkgPath = join(PROFILE_DIR, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    if (!pkg.dsh.profile.bundles.includes('@local/dsh-subagent')) {
      pkg.dsh.profile.bundles.push('@local/dsh-subagent')
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    }
  }

  // 5. Install PATH launchers (Windows .cmd + Unix/Git Bash)
  log(`[5/6] Commando "ds-subagent" installeren in ${BIN_DIR} ...`)
  const binScriptWin = join(APP_DIR, 'bin', 'ds-subagent.mjs')
  const binScriptPosix = binScriptWin.replaceAll('\\', '/')
  if (!DRY_RUN) {
    mkdirSync(BIN_DIR, { recursive: true })
    writeFileSync(
      join(BIN_DIR, 'ds-subagent.cmd'),
      `@echo off\r\nsetlocal\r\nnode "${binScriptWin}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
      'utf8',
    )
    const shPath = join(BIN_DIR, 'ds-subagent')
    writeFileSync(shPath, `#!/usr/bin/env bash\nexec node "${binScriptPosix}" "$@"\n`, 'utf8')
    try {
      chmodSync(shPath, 0o755)
    } catch {
      /* ignore on Windows */
    }
    const added = ensureWindowsUserPath(BIN_DIR)
    if (added) log(`      -> ${BIN_DIR} automatisch toegevoegd aan je Windows PATH.`)
  }

  // 6. Install shared skill + Claude Code Mod (live AbovePrompt tasklist)
  log('[6/6] Skill + Claude Code Mod (live takenlijst) installeren ...')
  const skillSrc = join(HERE, 'skills', 'deepseek-subagent', 'SKILL.md')
  const modSrc = join(HERE, 'claude-mod')
  if (!DRY_RUN) {
    // Claude Code plugin/mod bundle (auto-loaded from ~/.claude/skills/deepseek-subagent/)
    mkdirSync(CLAUDE_PLUGIN_TARGET, { recursive: true })
    if (existsSync(modSrc)) {
      cpSync(modSrc, CLAUDE_PLUGIN_TARGET, { recursive: true, force: true })
    }
    const claudeSkillDir = join(CLAUDE_PLUGIN_TARGET, 'skills', 'deepseek-subagent')
    mkdirSync(claudeSkillDir, { recursive: true })
    cpSync(skillSrc, join(claudeSkillDir, 'SKILL.md'))
    cpSync(skillSrc, join(CLAUDE_PLUGIN_TARGET, 'SKILL.md'))

    // Antigravity & shared agents skills
    for (const dir of SKILL_ONLY_TARGETS) {
      mkdirSync(dir, { recursive: true })
      cpSync(skillSrc, join(dir, 'SKILL.md'))
    }

    // Enable daemon autostart by default so the bridge stays available across reboots
    if (!NO_AUTOSTART) {
      const autoRes = spawnSync(process.execPath, [join(APP_DIR, 'bin', 'ds-subagent.mjs'), 'daemon', 'autostart', 'on'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      if (autoRes.status === 0 && autoRes.stdout) {
        log('      -> ' + autoRes.stdout.trim().split('\n')[0])
      }
    }
  }

  log('\n=======================================================')
  log(DRY_RUN ? 'DRY-RUN VOLTOOID (niets gewijzigd)' : 'INSTALLATIE GESLAAGD!')
  log('=======================================================')
  log('')
  log('Volgende stappen:')
  log('  1. Herstart Claude Code en/of Antigravity (zodat de nieuwe skill en PATH geladen zijn).')
  log('  2. Plak deze testzin in Claude Code of Antigravity:')
  log('     "Gebruik ds-subagent op de achtergrond om aan DeepSeek te vragen Hallo te zeggen."')
  log('')
  log('Tip: open eventueel http://127.0.0.1:45721 in je browser terwijl DeepSeek werkt om live mee te kijken.')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (UNINSTALL) doUninstall()
  else doInstall()
}
