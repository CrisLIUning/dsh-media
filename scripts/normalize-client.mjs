#!/usr/bin/env node
/**
 * Post-build check of client/client.js: the Host reads the module id from the
 * first line, so the file must start with the exact one-line loader call.
 * Rolldown may spread the banner over several lines; fold it back onto the
 * first line, then fail loudly if the result still does not match.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'client/client.js'
const name = JSON.parse(readFileSync('package.json', 'utf8')).name
const required = `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`

let code = readFileSync(file, 'utf8')
if (!code.startsWith(required)) {
  const end = code.indexOf('factory: (require) => {')
  if (end === -1) throw new Error(`${file}: the loader banner is missing`)
  const head = code.slice(0, end + 'factory: (require) => {'.length).replace(/\s+/g, ' ').trim()
  const folded = head.replace(/^window\.__ModuleLoader__\.load\(\s*\{\s*/, 'window.__ModuleLoader__.load({ ')
  code = `${folded}${code.slice(end + 'factory: (require) => {'.length)}`
  if (!code.startsWith(required)) throw new Error(`${file}: expected it to start with ${required}`)
  writeFileSync(file, code)
}
if (!/return module\.exports;\s*\}\s*\}\);\s*$/.test(code)) throw new Error(`${file}: the loader footer is missing`)
console.log(`${file}: loader banner ok (${code.length} bytes)`)
