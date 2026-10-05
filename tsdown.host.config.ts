/**
 * Host half of dsh-vibedev, bundled into lib/. The Harness's own packages
 * (`@deepseek-ai/*`, peer dependencies the Host provides) and node built-ins
 * stay imports; everything else — pi-ai with the Anthropic and OpenAI SDKs —
 * is bundled in, so the published package has no runtime dependencies and
 * installing it runs no dependency install scripts (pnpm 11 refuses those
 * until someone approves them, which leaves a fresh install disabled).
 *
 * The source maps are read by scripts/third-party-notices.mjs to list every
 * bundled package with its licence, then removed. Type declarations come from
 * `tsc --emitDeclarationOnly` (npm run build:types).
 */
import { isBuiltin } from 'node:module'
import { defineConfig } from 'tsdown'
import { piAiStreamingJsonPatch } from './scripts/pi-ai-patch.mjs'

const hostProvided = (id: string): boolean => id.startsWith('@deepseek-ai/') || id.startsWith('node:') || isBuiltin(id)

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  tsconfig: 'tsconfig.build.json',
  dts: false,
  sourcemap: true,
  clean: false,
  // `.js`, as package.json's `main` and `exports` name it (the package is `type: module`).
  fixedExtension: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/],
    alwaysBundle: (id: string) => (hostProvided(id) ? undefined : true),
  },
  plugins: [piAiStreamingJsonPatch()],
})
