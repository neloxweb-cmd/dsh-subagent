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

export const DEFAULT_REMOTE_NODE_VERSION = '24.21.0'
export const DEFAULT_REMOTE_DSH_VERSION = '0.2.2-rc.5'

/**
 * Build the remote Linux setup script for `ds-subagent host install`.
 * Exported for unit testing.
 */
export function buildRemoteSetupScript({
  provider = 'mistral',
  model = 'deepseek-v4-1-flash-1017',
  remotePort = DEFAULT_BRIDGE_PORT,
  remoteWebPort = 45721,
  nodeVersion = DEFAULT_REMOTE_NODE_VERSION,
  dshVersion = DEFAULT_REMOTE_DSH_VERSION,
} = {}) {
  const cleanProvider = String(provider || 'mistral').trim()
  const cleanModel = String(model || 'deepseek-v4-1-flash-1017').trim()
  const cleanNodeVer = String(nodeVersion || DEFAULT_REMOTE_NODE_VERSION).replace(/^v/i, '').trim()
  const cleanDshVer = String(dshVersion || DEFAULT_REMOTE_DSH_VERSION).trim()

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

  return `set -euo pipefail
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
NPM_PREFIX="$HOME/.dsh-subagent/npm-global"
LOCAL_NODE="$HOME/.dsh-subagent/node"
mkdir -p "$NPM_PREFIX/bin" "$HOME/.local/bin" "$HOME/.config/systemd/user"

# 1) Ensure Node >= 24.9.0 (dsh silently exits on older Node versions).
#    Never touches system Node (OpenCode / shop services stay untouched).
find_node24() {
  for cand in "$LOCAL_NODE/bin/node" "$HOME/.local/node24/bin/node" "$HOME/.local/bin/node" "$(command -v node 2>/dev/null || true)"; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    if "$cand" -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit(maj>24||(maj===24&&min>=9)?0:1)" 2>/dev/null; then
      dirname "$cand"
      return 0
    fi
  done
  return 1
}

NODE24_BIN_DIR="$(find_node24 || true)"
if [ -z "$NODE24_BIN_DIR" ]; then
  echo "Installing user-local Node.js v${cleanNodeVer} with SHA256 checksum verification..."
  ARCH_RAW="$(uname -m)"
  case "$ARCH_RAW" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "ERROR: unsupported CPU architecture: $ARCH_RAW" >&2; exit 2 ;;
  esac
  TARBALL="node-v${cleanNodeVer}-linux-\${ARCH}.tar.xz"
  BASE_URL="https://nodejs.org/dist/v${cleanNodeVer}"
  TMP_NODE="$(mktemp -d)"
  trap 'rm -rf "$TMP_NODE"' EXIT
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$BASE_URL/$TARBALL" -o "$TMP_NODE/$TARBALL"
    curl -fsSL "$BASE_URL/SHASUMS256.txt" -o "$TMP_NODE/SHASUMS256.txt"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP_NODE/$TARBALL" "$BASE_URL/$TARBALL"
    wget -qO "$TMP_NODE/SHASUMS256.txt" "$BASE_URL/SHASUMS256.txt"
  else
    echo "ERROR: curl or wget is required to download Node.js v${cleanNodeVer}" >&2
    exit 2
  fi
  (cd "$TMP_NODE" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$LOCAL_NODE"
  mkdir -p "$LOCAL_NODE"
  tar -xJf "$TMP_NODE/$TARBALL" --strip-components=1 -C "$LOCAL_NODE"
  NODE24_BIN_DIR="$LOCAL_NODE/bin"
fi
echo "NODE24_BIN=$NODE24_BIN_DIR/node ($("$NODE24_BIN_DIR/node" -v))"

SERVICE_PATH="$NODE24_BIN_DIR:$NPM_PREFIX/bin:$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$SERVICE_PATH"

# 2) Ensure pnpm is available (required by dsh plugin add)
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Installing pnpm into user-local prefix ($NPM_PREFIX)..."
  npm install --prefix "$NPM_PREFIX" -g pnpm
fi
echo "PNPM_BIN=$(command -v pnpm) ($(pnpm --version))"

# 3) Ensure @deepseek-ai/dsh (pinned pre-release since no stable latest exists yet)
if ! command -v dsh >/dev/null 2>&1; then
  echo "Installing @deepseek-ai/dsh@${cleanDshVer} into user-local prefix ($NPM_PREFIX)..."
  npm install --prefix "$NPM_PREFIX" -g "@deepseek-ai/dsh@${cleanDshVer}"
fi
DSH_BIN="$(command -v dsh)"
echo "DSH_BIN=$DSH_BIN"

PROF="$HOME/.dsh/profiles/subagent"
APP="$HOME/.dsh-subagent/app"
mkdir -p "$PROF"
printf '[]\\n' > "$PROF/cordis.yml"
printf 'packages:\\n  - .\\n\\nnodeLinker: hoisted\\nautoInstallPeers: false\\n' > "$PROF/pnpm-workspace.yaml"
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
Environment=PATH=$SERVICE_PATH
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
journalctl --user -u dsh-subagent.service -n 30 --no-pager >&2 || true
exit 5
`
}

/**
 * Install DeepSeek Harness + @local/dsh-subagent as a persistent systemd user
 * service (with user-local Node 24.9+, pnpm, pinned dsh pre-release, linger
 * enabled, dedicated systemd PATH, loopback-only bridge, mode-600 env secret
 * file) on a remote Linux server, then register the host locally.
 */
export async function installRemoteHost({
  alias,
  sshTarget,
  provider = 'mistral',
  model = 'deepseek-v4-1-flash-1017',
  apiKey = '',
  remotePort = DEFAULT_BRIDGE_PORT,
  remoteWebPort = 45721,
  nodeVersion = DEFAULT_REMOTE_NODE_VERSION,
  dshVersion = DEFAULT_REMOTE_DSH_VERSION,
  home,
  packageRoot,
  stdout = process.stdout,
}) {
  const cleanAlias = validateAlias(alias)
  const cleanProvider = String(provider || 'mistral').trim()
  const envVarName = cleanProvider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'MISTRAL_API_KEY'

  stdout.write(`[1/6] Checking SSH & Linux environment on ${sshTarget}...\n`)
  const probe = runSafeSshScript(
    sshTarget,
    'set -euo pipefail\nuname -sm\ncommand -v tar >/dev/null || { echo "MISSING_TAR"; exit 2; }\ncommand -v sha256sum >/dev/null || { echo "MISSING_SHA256SUM"; exit 2; }\n',
  )
  if (probe.status !== 0) {
    throw new Error(
      `Remote preflight failed on ${sshTarget}: ${(probe.stdout || probe.stderr || '').trim()}\n` +
        'Ensure SSH key auth works on the Linux server.',
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
      'python3 -c "import json,os,shutil,sys; d=json.load(sys.stdin); root=os.path.expanduser(\'~/.dsh-subagent/app\'); shutil.rmtree(root,True); [ (os.makedirs(os.path.dirname(os.path.join(root,k)),exist_ok=True), open(os.path.join(root,k),\'w\',encoding=\'utf-8\').write(v)) for k,v in d.items() ]; print(\'UPLOADED:\'+str(len(d)))" 2>/dev/null || node -e "const fs=require(\'fs\'),p=require(\'path\'),os=require(\'os\');const d=JSON.parse(fs.readFileSync(0,\'utf8\'));const root=p.join(os.homedir(),\'.dsh-subagent\',\'app\');fs.rmSync(root,{recursive:true,force:true});for(const [k,v] of Object.entries(d)){const t=p.join(root,k);fs.mkdirSync(p.dirname(t),{recursive:true});fs.writeFileSync(t,v,\'utf8\');}console.log(\'UPLOADED:\'+Object.keys(d).length);"',
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

  stdout.write('[4/6] Ensuring Node 24.9+, pnpm, DeepSeek Harness (dsh) & systemd service on server...\n')
  const setupScript = buildRemoteSetupScript({
    provider: cleanProvider,
    model,
    remotePort,
    remoteWebPort,
    nodeVersion,
    dshVersion,
  })

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

