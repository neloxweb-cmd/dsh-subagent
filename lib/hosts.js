/**
 * Remote host registry & automatic SSH tunnel helper for @local/dsh-subagent.
 *
 * Allows running the DSH subagent daemon persistently on a Linux server (via
 * systemd) while orchestrating it seamlessly from Windows/macOS via Tailscale
 * or an automatic SSH loopback tunnel.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'

import { DEFAULT_BRIDGE_PORT, LOOPBACK_HOST, optionalString } from './protocol.js'

const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/

export function hostsFilePath(home) {
  return join(home, 'hosts.json')
}

export function loadHosts(home) {
  const file = hostsFilePath(home)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed.hosts === 'object' && !Array.isArray(parsed.hosts) ? parsed.hosts : {}
  } catch {
    return {}
  }
}

export function saveHosts(home, hosts) {
  mkdirSync(home, { recursive: true })
  writeFileSync(hostsFilePath(home), JSON.stringify({ version: 1, hosts }, null, 2) + '\n', { mode: 0o600 })
}

export function validateAlias(alias) {
  const s = optionalString(alias)
  if (!s || !ALIAS_RE.test(s)) {
    throw new Error(`host alias must match [a-zA-Z0-9._-] (max 32 chars), got "${String(alias ?? '')}"`)
  }
  return s
}

export function fetchRemoteTokenViaSsh(sshTarget) {
  const res = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshTarget, 'cat ~/.dsh-subagent/bridge.json'],
    { encoding: 'utf8', windowsHide: true, timeout: 12_000 },
  )
  if (res.status !== 0) return null
  try {
    const parsed = JSON.parse(res.stdout)
    return optionalString(parsed?.token) ?? null
  } catch {
    return null
  }
}

function getFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, LOOPBACK_HOST, () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

function waitForPort(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.createConnection({ host: LOOPBACK_HOST, port })
      sock.once('connect', () => {
        sock.destroy()
        resolve()
      })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`SSH tunnel on 127.0.0.1:${port} did not become ready within ${timeoutMs}ms`))
        } else {
          setTimeout(attempt, 150)
        }
      })
    }
    attempt()
  })
}

/**
 * Open a temporary local SSH tunnel to a remote host's loopback bridge.
 * Returns `{ url, token, close }`.
 */
export async function openRemoteConnection(hostEntry) {
  if (hostEntry.type === 'http') {
    return {
      url: String(hostEntry.url).replace(/\/+$/, ''),
      token: hostEntry.token ?? '',
      close: async () => {},
    }
  }
  if (hostEntry.type !== 'ssh' || !hostEntry.ssh) {
    throw new Error('invalid remote host configuration')
  }
  const remotePort = Number.isInteger(hostEntry.remotePort) ? hostEntry.remotePort : DEFAULT_BRIDGE_PORT
  const localPort = await getFreeLoopbackPort()
  const child = spawn(
    'ssh',
    [
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'BatchMode=yes',
      '-L',
      `${LOOPBACK_HOST}:${localPort}:${LOOPBACK_HOST}:${remotePort}`,
      hostEntry.ssh,
    ],
    { stdio: 'ignore', windowsHide: true },
  )

  let exited = false
  child.once('exit', () => {
    exited = true
  })

  try {
    await waitForPort(localPort, 8000)
  } catch (err) {
    try {
      if (!exited) child.kill()
    } catch {
      /* ignore */
    }
    throw new Error(`Could not open SSH tunnel to ${hostEntry.ssh}: ${err.message}`)
  }

  return {
    url: `http://${LOOPBACK_HOST}:${localPort}`,
    token: hostEntry.token ?? '',
    close: async () => {
      try {
        if (!exited) child.kill()
      } catch {
        /* ignore */
      }
    },
  }
}

/**
 * Run a script safely over SSH using stdin (`ssh -T <target> bash -s`),
 * completely avoiding Windows PowerShell -> SSH quote-stripping bugs.
 */
export function runSafeSshScript(sshTarget, scriptText) {
  return spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', sshTarget, 'bash', '-s'], {
    input: scriptText,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
}
