/**
 * Remote host registry & automatic SSH tunnel helper for @local/dsh-subagent.
 *
 * Allows running the DSH subagent daemon persistently on a Linux server (via
 * systemd) while orchestrating it seamlessly from Windows/macOS via Tailscale
 * or an automatic SSH loopback tunnel.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/**
 * Collect local package files into a portable `{ files: { relPath: utf8 } }` bundle
 * so we can ship @local/dsh-subagent over SSH stdin with zero scp/tar quirks.
 */
export function buildPackageBundle(pkgRoot) {
  const root = pkgRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const files = {}
  const include = ['package.json', 'cordis.patch.yml', 'install.mjs', 'README.md', 'bin', 'lib', 'skills']

  function collect(relPath) {
    const abs = join(root, relPath)
    if (!existsSync(abs)) return
    const st = statSync(abs)
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs)) collect(join(relPath, entry))
    } else if (st.isFile()) {
      files[relPath.replaceAll('\\', '/')] = readFileSync(abs, 'utf8')
    }
  }
  for (const item of include) collect(item)
  return files
}

/**
 * Install DeepSeek Harness + @local/dsh-subagent as a persistent systemd user
 * service (with linger enabled, loopback-only bridge, mode-600 env secret file)
 * on a remote Linux server, then register the host locally.
 */
export async function installRemoteHost({
  alias,
  sshTarget,
  provider = 'mistral',
  model = 'deepseek-v4-1-flash-1017',
  apiKey = '',
  remotePort = DEFAULT_BRIDGE_PORT,
  remoteWebPort = 45721,
  home,
  packageRoot,
  stdout = process.stdout,
}) {
  const cleanAlias = validateAlias(alias)
  const cleanProvider = String(provider || 'mistral').trim()
  const cleanModel = String(model || 'deepseek-v4-1-flash-1017').trim()
  const envVarName = cleanProvider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'MISTRAL_API_KEY'

  stdout.write(`[1/6] Checking SSH & Node.js >= 20 on ${sshTarget}...\n`)
  const probe = runSafeSshScript(
    sshTarget,
    'set -euo pipefail\ncommand -v node >/dev/null || { echo "MISSING_NODE"; exit 2; }\nnode -e "const m=Number(process.versions.node.split(\'.\')[0]); if(m<20){console.log(\'OLD_NODE:\'+process.version); process.exit(3);} console.log(\'NODE_OK:\'+process.version);"\n',
  )
  if (probe.status !== 0) {
    throw new Error(
      `Remote preflight failed on ${sshTarget}: ${(probe.stdout || probe.stderr || '').trim()}\n` +
        'Ensure SSH key auth works and Node.js 20+ is installed on the Linux server.',
    )
  }
  stdout.write(`      -> ${(probe.stdout || '').trim()}\n`)

  stdout.write('[2/6] Uploading @local/dsh-subagent package over SSH stdin...\n')
  const bundle = buildPackageBundle(packageRoot)
  const unpackRes = spawnSync(
    'ssh',
    [
      '-T',
      '-o',
      'BatchMode=yes',
      sshTarget,
      'node -e "const fs=require(\'fs\'),p=require(\'path\'),os=require(\'os\');const d=JSON.parse(fs.readFileSync(0,\'utf8\'));const root=p.join(os.homedir(),\'.dsh-subagent\',\'app\');fs.rmSync(root,{recursive:true,force:true});for(const [k,v] of Object.entries(d)){const t=p.join(root,k);fs.mkdirSync(p.dirname(t),{recursive:true});fs.writeFileSync(t,v,\'utf8\');}console.log(\'UPLOADED:\'+Object.keys(d).length);"',
    ],
    {
      input: JSON.stringify(bundle),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  if (unpackRes.status !== 0) {
    throw new Error('Failed uploading package to remote server: ' + (unpackRes.stderr || unpackRes.stdout))
  }
  stdout.write(`      -> ${(unpackRes.stdout || '').trim()} files\n`)

  if (apiKey && apiKey.trim()) {
    stdout.write(`[3/6] Writing ${envVarName} securely via stdin (mode 600, never in argv/logs)...\n`)
    const envPayload = `${envVarName}=${apiKey.trim()}\nDSH_SUBAGENT_PROFILE=subagent\nDSH_PERMISSION_MODE=danger-full-access\n`
    const envRes = spawnSync(
      'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        sshTarget,
        'umask 077 && mkdir -p "$HOME/.dsh-subagent" && cat > "$HOME/.dsh-subagent/env" && chmod 600 "$HOME/.dsh-subagent/env"',
      ],
      {
        input: envPayload,
        encoding: 'utf8',
        windowsHide: true,
      },
    )
    if (envRes.status !== 0) {
      throw new Error('Failed writing remote env file: ' + (envRes.stderr || envRes.stdout))
    }
  } else {
    stdout.write('[3/6] No API key piped; ensuring ~/.dsh-subagent/env exists (mode 600)...\n')
    runSafeSshScript(
      sshTarget,
      'umask 077; mkdir -p "$HOME/.dsh-subagent"; touch "$HOME/.dsh-subagent/env"; chmod 600 "$HOME/.dsh-subagent/env"\n',
    )
  }

  stdout.write('[4/6] Ensuring DeepSeek Harness (dsh) + configuring subagent profile on server...\n')
  const providerYaml =
    cleanProvider === 'mistral'
      ? [
          '- id: llm-pi-ai',
          '  name: "@deepseek-ai/dsh-llm-pi-ai"',
          '  config:',
          '    providers:',
          '      mistral:',
          '        apiKeyEnv: MISTRAL_API_KEY',
          '        models:',
          `          - id: ${cleanModel}`,
          '            name: D-4.1flash',
          '            contextWindow: 1000000',
          '            maxTokens: 128000',
          '            input: [text, image]',
          '- id: agent-default-model',
          '  name: "@deepseek-ai/dsh-agent-default-model"',
          '  config:',
          '    provider: mistral',
          `    model: ${cleanModel}`,
        ].join('\n')
      : ''

  const setupScript = `set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"
if ! command -v dsh >/dev/null 2>&1; then
  echo "Installing @deepseek-ai/dsh..."
  if command -v npm >/dev/null 2>&1; then
    npm install -g @deepseek-ai/dsh
  else
    echo "ERROR: neither dsh nor npm found on server" >&2
    exit 4
  fi
fi
DSH_BIN="$(command -v dsh)"
echo "DSH_BIN=$DSH_BIN"

PROF="$HOME/.dsh/profiles/subagent"
APP="$HOME/.dsh-subagent/app"
mkdir -p "$PROF" "$HOME/.config/systemd/user"
printf '[]\n' > "$PROF/cordis.yml"
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$PROF/pnpm-workspace.yaml"
cat > "$PROF/package.json" <<EOF
{
  "name": "dsh-profile-subagent",
  "private": true,
  "dependencies": {
    "@local/dsh-subagent": "link:$APP"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-subagent"
      ]
    }
  }
}
EOF
cat > "$PROF/cordis.patch.yml" <<'EOF'
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: standard
${providerYaml}
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: danger-full-access
- id: tool-fs
  disabled: false
- id: tool-fs-search
  disabled: false
- id: tool-bash
  disabled: false
- id: tool-todo
  disabled: false
- id: dsh-subagent
  name: "@local/dsh-subagent"
  config:
    enabled: true
    host: 127.0.0.1
    port: ${remotePort}
    profile: subagent
    agentPreset: standard
EOF

"$DSH_BIN" plugin --profile subagent add "link:$APP"

cat > "$HOME/.config/systemd/user/dsh-subagent.service" <<EOF
[Unit]
Description=DeepSeek Harness Subagent Daemon (loopback only)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=-%h/.dsh-subagent/env
Environment=DSH_SUBAGENT_PROFILE=subagent
Environment=DSH_PERMISSION_MODE=danger-full-access
Environment=DSH_WEB_URL=http://127.0.0.1:${remoteWebPort}
ExecStart=$DSH_BIN --profile subagent --no-open --host 127.0.0.1 --port ${remoteWebPort}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

loginctl enable-linger "$USER" 2>/dev/null || echo "NOTE: loginctl enable-linger requires sudo on this host (run: sudo loginctl enable-linger $USER)"
systemctl --user daemon-reload
systemctl --user enable --now dsh-subagent.service
systemctl --user restart dsh-subagent.service

for i in $(seq 1 30); do
  if [ -f "$HOME/.dsh-subagent/bridge.json" ]; then
    TOKEN=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.dsh-subagent/bridge.json','utf8')).token||'')}catch{}")
    if [ -n "$TOKEN" ] && curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:${remotePort}/v1/health" >/dev/null 2>&1; then
      echo "REMOTE_BRIDGE_READY"
      exit 0
    fi
  fi
  sleep 1
done
echo "REMOTE_BRIDGE_TIMEOUT" >&2
systemctl --user status dsh-subagent.service --no-pager >&2 || true
exit 5
`

  const setupRes = runSafeSshScript(sshTarget, setupScript)
  if (setupRes.stdout) stdout.write(setupRes.stdout)
  if (setupRes.status !== 0) {
    throw new Error('Remote server setup failed:\n' + (setupRes.stderr || setupRes.stdout))
  }

  stdout.write(`[5/6] Fetching remote loopback bridge token securely over SSH...\n`)
  const token = fetchRemoteTokenViaSsh(sshTarget)
  if (!token) {
    throw new Error(`Remote bridge started, but could not read token from ${sshTarget}:~/.dsh-subagent/bridge.json`)
  }

  stdout.write(`[6/6] Registering local host alias "${cleanAlias}"...\n`)
  const hosts = loadHosts(home)
  hosts[cleanAlias] = { type: 'ssh', ssh: sshTarget, remotePort, token }
  saveHosts(home, hosts)

  return { ok: true, alias: cleanAlias, ssh: sshTarget, remotePort, hasToken: true }
}

