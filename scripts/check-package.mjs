#!/usr/bin/env node
/**
 * Check the built package before it is packed (run by `prepack`):
 *
 * - no runtime `dependencies`: everything not provided by the Host is bundled,
 *   so installing the plugin runs no dependency install scripts;
 * - lib/ imports only relative chunks, node built-ins and `@deepseek-ai/*`
 *   packages, each of which is a peer dependency;
 * - no source maps left in lib/;
 * - THIRD-PARTY-NOTICES.txt names the bundled pi-ai and the DeepSeek Harness files;
 * - the client module id and the bundle patch's row both name the package;
 * - the pi-ai streaming-JSON patch is in (no per-delta parse after the
 *   Anthropic `partial_json` append).
 *
 *   node scripts/check-package.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []
const fail = message => { problems.push(message) }

if (manifest.dependencies !== undefined && Object.keys(manifest.dependencies).length > 0) {
  fail(`package.json has runtime dependencies (${Object.keys(manifest.dependencies).join(', ')}); bundle them instead`)
}

const lib = join(root, 'lib')
const files = readdirSync(lib)
if (files.some(name => name.endsWith('.map'))) fail('lib/ still holds source maps (npm run build:notices removes them)')
const peers = new Set(Object.keys(manifest.peerDependencies ?? {}))
const imported = new Set()
const SPECIFIER = /(?:^|[;\n])\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\(\s*['"]([^'"]+)['"]\s*\)/g
for (const file of files.filter(name => name.endsWith('.js'))) {
  const code = readFileSync(join(lib, file), 'utf8')
  for (const match of code.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2]
    if (specifier === undefined || specifier.startsWith('.') || specifier.startsWith('node:') || isBuiltin(specifier)) continue
    if (!specifier.startsWith('@deepseek-ai/')) {
      fail(`lib/${file} imports ${specifier}, which the Host does not provide; bundle it`)
      continue
    }
    imported.add(specifier.split('/').slice(0, 2).join('/'))
  }
  if (/block\.partialJson \+= event\.delta\.partial_json;\s*\n\s*block\.arguments = parseStreamingJson/.test(code)) {
    fail(`lib/${file} still re-parses streamed tool arguments on every delta (pi-ai patch missing)`)
  }
}
for (const name of imported) if (!peers.has(name)) fail(`lib/ imports ${name} at run time; list it in peerDependencies`)

const notices = join(root, 'THIRD-PARTY-NOTICES.txt')
if (!existsSync(notices)) fail('THIRD-PARTY-NOTICES.txt is missing (npm run build:notices)')
else {
  const text = readFileSync(notices, 'utf8')
  if (!text.includes('@earendil-works/pi-ai')) fail('THIRD-PARTY-NOTICES.txt does not name the bundled pi-ai')
  if (!text.includes('DeepSeek Harness')) fail('THIRD-PARTY-NOTICES.txt does not credit the DeepSeek Harness files')
}
if (!(manifest.files ?? []).includes('THIRD-PARTY-NOTICES.txt')) fail('package.json files does not ship THIRD-PARTY-NOTICES.txt')

const client = readFileSync(join(root, 'client', 'client.js'), 'utf8')
const loader = `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {`
if (!client.startsWith(loader)) fail(`client/client.js does not start with the loader call for ${manifest.name}`)

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes(`name: '${manifest.name}'`) && !patch.includes(`name: "${manifest.name}"`)) {
  fail(`cordis.patch.yml does not mount ${manifest.name}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-package: ${problem}`)
  process.exit(1)
}
console.log(`check-package: ${manifest.name}@${manifest.version} ok (host imports: ${[...imported].sort().join(', ')})`)
