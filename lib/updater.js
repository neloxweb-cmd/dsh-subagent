/**
 * Self-updater for @local/dsh-subagent.
 *
 * Downloads the latest version from GitHub (ZIP archive via built-in fetch,
 * with automatic fallback to `git clone --depth 1` for private repos), then
 * runs the bundled `install.mjs` which stops any old daemon, updates code +
 * skills + launchers, and preserves all sessions and DSH settings.
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { optionalString } from './protocol.js'

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,80}$/

export function normalizeRepoSpec(raw) {
  const s = optionalString(raw)
  if (!s) return null
  const ghMatch = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s#?]+?)(?:\.git)?\/?$/i.exec(s)
  const candidate = ghMatch ? ghMatch[1] : s.replace(/^git\+/, '').replace(/\.git$/, '')
  return REPO_RE.test(candidate) ? candidate : null
}

export function normalizeBranch(raw) {
  const s = optionalString(raw) ?? 'main'
  return BRANCH_RE.test(s) ? s : 'main'
}

export function resolveUpdateSource({ options = {}, env = process.env, home, packageJsonPath } = {}) {
  const fromFlag = normalizeRepoSpec(options.repo)
  const fromEnv = normalizeRepoSpec(env.DSH_SUBAGENT_REPO)

  let fromFile = null
  let fileBranch = null
  const updateFile = home ? join(home, 'update.json') : null
  if (updateFile && existsSync(updateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(updateFile, 'utf8'))
      fromFile = normalizeRepoSpec(parsed?.repo)
      fileBranch = optionalString(parsed?.branch)
    } catch {
      /* ignore corrupt update.json */
    }
  }

  let fromPkg = null
  const pkgPath = packageJsonPath ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const rawRepo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
      fromPkg = normalizeRepoSpec(rawRepo)
    } catch {
      /* ignore */
    }
  }

  const repo = fromFlag ?? fromEnv ?? fromFile ?? fromPkg ?? null
  const branch = normalizeBranch(options.branch ?? env.DSH_SUBAGENT_BRANCH ?? fileBranch ?? 'main')
  return { repo, branch, updateFile }
}

function findExtractedRoot(dir) {
  if (existsSync(join(dir, 'install.mjs')) && existsSync(join(dir, 'package.json'))) return dir
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sub = join(dir, entry.name)
    if (existsSync(join(sub, 'install.mjs')) && existsSync(join(sub, 'package.json'))) return sub
  }
  return null
}

export async function performUpdate({
  repo,
  branch = 'main',
  home,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
  stderr = process.stderr,
}) {
  const cleanRepo = normalizeRepoSpec(repo)
  if (!cleanRepo) {
    throw new Error(
      'Geen GitHub-repo geconfigureerd. Geef hem eenmalig op met: ds-subagent update --repo <gebruiker>/<repo>',
    )
  }
  const cleanBranch = normalizeBranch(branch)
  const stage = mkdtempSync(join(tmpdir(), 'dsh-subagent-update-'))

  try {
    const zipUrl = `https://codeload.github.com/${cleanRepo}/zip/refs/heads/${encodeURIComponent(cleanBranch)}`
    stdout.write(`Downloaden van https://github.com/${cleanRepo} (${cleanBranch})...\n`)

    let extractedRoot = null
    const res = await fetchImpl(zipUrl, { signal: AbortSignal.timeout(45_000) })

    if (res.ok) {
      const zipPath = join(stage, 'update.zip')
      const outDir = join(stage, 'extracted')
      mkdirSync(outDir, { recursive: true })
      const buf = Buffer.from(await res.arrayBuffer())
      writeFileSync(zipPath, buf)

      if (process.platform === 'win32') {
        const exp = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${outDir.replaceAll("'", "''")}' -Force`,
          ],
          { encoding: 'utf8', windowsHide: true },
        )
        if (exp.status !== 0) {
          throw new Error('Uitpakken van update-zip mislukt: ' + (exp.stderr || exp.stdout))
        }
      } else {
        const exp = spawnSync('unzip', ['-q', zipPath, '-d', outDir], { encoding: 'utf8' })
        if (exp.status !== 0) {
          throw new Error('Uitpakken van update-zip mislukt (unzip): ' + (exp.stderr || exp.stdout))
        }
      }
      extractedRoot = findExtractedRoot(outDir)
    } else if (res.status === 404 || res.status === 401 || res.status === 403) {
      // Fallback for private repos where the user has git credentials configured.
      stderr.write(`Publieke download gaf HTTP ${res.status}; proberen via git clone...\n`)
      const cloneDir = join(stage, 'repo')
      const cloned = spawnSync(
        'git',
        ['clone', '--depth', '1', '--branch', cleanBranch, `https://github.com/${cleanRepo}.git`, cloneDir],
        { encoding: 'utf8', windowsHide: true },
      )
      if (cloned.status !== 0) {
        throw new Error(
          `Kon https://github.com/${cleanRepo} niet ophalen (HTTP ${res.status} en git clone faalde): ` +
            (cloned.stderr || cloned.stdout).trim(),
        )
      }
      extractedRoot = findExtractedRoot(cloneDir)
    } else {
      throw new Error(`GitHub download mislukt met HTTP ${res.status}`)
    }

    if (!extractedRoot) {
      throw new Error('Download bevat geen geldig dsh-subagent pakket (install.mjs ontbreekt).')
    }

    // Remember the repo/branch for future one-word `ds-subagent update` calls.
    if (home) {
      mkdirSync(home, { recursive: true })
      writeFileSync(
        join(home, 'update.json'),
        JSON.stringify({ repo: cleanRepo, branch: cleanBranch }, null, 2) + '\n',
        'utf8',
      )
    }

    const inst = spawnSync(process.execPath, [join(extractedRoot, 'install.mjs')], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, DSH_SUBAGENT_HOME: home },
    })
    if (inst.stdout) stdout.write(inst.stdout)
    if (inst.stderr) stderr.write(inst.stderr)
    if (inst.status !== 0) {
      throw new Error(`Update-installatie mislukt (exit ${inst.status})`)
    }

    const newPkg = JSON.parse(readFileSync(join(extractedRoot, 'package.json'), 'utf8'))
    return { ok: true, repo: cleanRepo, branch: cleanBranch, version: newPkg.version ?? 'unknown' }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
