import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { extractDesktopModelBlocks } from '../install.mjs'
import { normalizeBranch, normalizeRepoSpec, resolveUpdateSource } from '../lib/updater.js'

test('updater: normalizes owner/repo and GitHub URLs safely', () => {
  assert.equal(normalizeRepoSpec('example/dsh-subagent'), 'example/dsh-subagent')
  assert.equal(normalizeRepoSpec('https://github.com/example/dsh-subagent.git'), 'example/dsh-subagent')
  assert.equal(normalizeRepoSpec('https://github.com/example/dsh-subagent/'), 'example/dsh-subagent')
  assert.equal(normalizeRepoSpec('bad repo; rm -rf /'), null)
  assert.equal(normalizeBranch('main'), 'main')
  assert.equal(normalizeBranch('bad branch'), 'main')
})

test('updater: resolveUpdateSource follows flag > env > update.json > package.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-subagent-upd-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const pkgPath = join(dir, 'package.json')
  await writeFile(pkgPath, JSON.stringify({ repository: 'https://github.com/org/from-pkg.git' }), 'utf8')
  assert.equal(resolveUpdateSource({ home: dir, packageJsonPath: pkgPath, env: {} }).repo, 'org/from-pkg')

  await writeFile(join(dir, 'update.json'), JSON.stringify({ repo: 'org/from-file', branch: 'dev' }), 'utf8')
  const fromFile = resolveUpdateSource({ home: dir, packageJsonPath: pkgPath, env: {} })
  assert.equal(fromFile.repo, 'org/from-file')
  assert.equal(fromFile.branch, 'dev')

  assert.equal(
    resolveUpdateSource({ home: dir, packageJsonPath: pkgPath, env: { DSH_SUBAGENT_REPO: 'org/from-env' } }).repo,
    'org/from-env',
  )
  assert.equal(
    resolveUpdateSource({
      home: dir,
      packageJsonPath: pkgPath,
      env: { DSH_SUBAGENT_REPO: 'org/from-env' },
      options: { repo: 'org/from-flag' },
    }).repo,
    'org/from-flag',
  )
})

test('install: extractDesktopModelBlocks extracts only llm-pi-ai and agent-default-model', () => {
  const sample = `
# Header comment
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: standard

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mistral:
        apiKeyEnv: MISTRAL_API_KEY

- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    fontSize: 18

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mistral
    model: deepseek-v4-1-flash-1017
`
  const extracted = extractDesktopModelBlocks(sample)
  assert.match(extracted, /^- id: llm-pi-ai/m)
  assert.match(extracted, /^- id: agent-default-model/m)
  assert.doesNotMatch(extracted, /ui-theme/)
  assert.doesNotMatch(extracted, /agent-preset-registry/)
})
