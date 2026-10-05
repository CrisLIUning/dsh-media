#!/usr/bin/env node
/**
 * Write THIRD-PARTY-NOTICES.txt for what lib/ bundles, then remove the source
 * maps it was read from.
 *
 * The packages are the ones the bundle's source maps name (everything under a
 * node_modules folder), so the list is exactly what ships: pi-ai, the
 * Anthropic and OpenAI SDKs and their dependencies. Each entry carries the
 * package's licence text and, where the package has one, its NOTICE. The
 * DeepSeek Harness files copied into src/llm come first. The build stops when
 * a bundled package has no licence file.
 *
 *   node scripts/third-party-notices.mjs
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const lib = join(root, 'lib')
const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const LICENSE_FILE = /^(licen[cs]e|copying)([-.](md|txt|mit))?$/i
const NOTICE_FILE = /^notice(\.(md|txt))?$/i

/**
 * Bundled packages whose npm tarball ships no licence file: the licence text
 * comes from their repository (kept in scripts/licenses/), for the exact
 * version checked; another version stops the build until someone checks again.
 */
const LICENSE_OVERRIDES = {
  '@earendil-works/pi-ai': {
    version: '0.87.1',
    file: 'scripts/licenses/earendil-works__pi-ai.txt',
    note: 'The npm package ships no licence file; this is the LICENSE of its repository, github.com/earendil-works/pi.',
  },
  standardwebhooks: {
    version: '1.1.1',
    file: 'scripts/licenses/standardwebhooks.txt',
    note: 'The npm package declares MIT (author: Standard Webhooks) and ships no licence file; its repository, '
      + 'github.com/standard-webhooks/standard-webhooks, carries the Apache-2.0 licence reproduced here.',
  },
}

/** Package roots (absolute) named by every source map in lib/. */
function bundledPackages() {
  const roots = new Map()
  for (const file of readdirSync(lib).filter(name => name.endsWith('.js.map'))) {
    const map = JSON.parse(readFileSync(join(lib, file), 'utf8'))
    for (const source of map.sources ?? []) {
      const absolute = resolve(lib, map.sourceRoot ?? '', source)
      const parts = absolute.split(sep)
      const at = parts.lastIndexOf('node_modules')
      if (at < 0) continue
      const scoped = parts[at + 1]?.startsWith('@') === true
      const packageRoot = parts.slice(0, at + (scoped ? 3 : 2)).join(sep)
      if (!roots.has(packageRoot)) roots.set(packageRoot, JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')))
    }
  }
  return [...roots.entries()].sort(([, left], [, right]) => left.name.localeCompare(right.name))
}

function firstFile(dir, pattern) {
  const name = readdirSync(dir).find(entry => pattern.test(entry))
  return name === undefined ? undefined : readFileSync(join(dir, name), 'utf8').trim()
}

function licenseOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license
  if (typeof manifest.license?.type === 'string') return manifest.license.type
  return 'UNKNOWN'
}

function repositoryOf(manifest) {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  return typeof repository === 'string' ? repository.replace(/^git\+/, '').replace(/\.git$/, '') : (manifest.homepage ?? '')
}

const rule = '='.repeat(78)
const sections = []

const harness = join(root, 'node_modules', '@deepseek-ai', 'dsh-llm')
const harnessLicense = firstFile(harness, LICENSE_FILE)
if (harnessLicense === undefined) throw new Error('third-party notices: no licence file in @deepseek-ai/dsh-llm')
sections.push([
  rule,
  'DeepSeek Harness — @deepseek-ai/dsh-llm-pi-ai (MIT)',
  'https://github.com/deepseek-ai/deepseek-harness',
  'src/llm/context.ts, src/llm/replay.ts and src/llm/stream.ts (bundled into lib/) are copied from',
  '@deepseek-ai/dsh-llm-pi-ai (dsh-v0.2.0-rc.2), and the bundled pi-ai carries the Harness\'s',
  'patch to its streaming tool-argument parsing.',
  rule,
  harnessLicense,
].join('\n'))

const missing = []
for (const [dir, manifest] of bundledPackages()) {
  const override = LICENSE_OVERRIDES[manifest.name]
  let license = firstFile(dir, LICENSE_FILE)
  let note
  if (license === undefined && override !== undefined) {
    if (override.version !== manifest.version) {
      throw new Error(`third-party notices: ${manifest.name} is ${manifest.version}; its licence was checked for ${override.version} — check it again and update LICENSE_OVERRIDES`)
    }
    license = readFileSync(join(root, override.file), 'utf8').trim()
    note = override.note
  }
  if (license === undefined) {
    missing.push(`${manifest.name}@${manifest.version}`)
    continue
  }
  const notice = firstFile(dir, NOTICE_FILE)
  sections.push([
    rule,
    `${manifest.name} ${manifest.version} (${licenseOf(manifest)})`,
    repositoryOf(manifest),
    ...note === undefined ? [] : [note],
    rule,
    license,
    ...notice === undefined ? [] : ['', '--- NOTICE ---', notice],
  ].join('\n'))
}
if (missing.length > 0) throw new Error(`third-party notices: no licence file in ${missing.join(', ')}`)

writeFileSync(join(root, 'THIRD-PARTY-NOTICES.txt'), [
  `THIRD-PARTY NOTICES · ${own.name} ${own.version}`,
  '',
  'This package bundles code from the projects below. Each is used under the licence that',
  'follows its name; the licence texts are reproduced as the projects ship them.',
  '',
  ...sections.map(section => `${section}\n`),
].join('\n'))

for (const file of readdirSync(lib).filter(name => name.endsWith('.map'))) rmSync(join(lib, file))
console.log(`third-party notices: ${sections.length - 1} bundled package(s) + DeepSeek Harness → THIRD-PARTY-NOTICES.txt`)
if (!existsSync(join(root, 'THIRD-PARTY-NOTICES.txt'))) throw new Error('third-party notices: nothing written')
