/**
 * Browser half of dsh-media, built the way DeepSeek Harness loads an external
 * package's client: one closure-factory file that calls
 * `window.__ModuleLoader__.load({ id, factory })` and gets React and the client
 * primitives through the injected `require` (the Host's module table).
 * Everything else is bundled in. scripts/normalize-client.mjs then puts the
 * loader call on the first line, which the Host reads the module id from.
 */
import { defineConfig } from 'tsdown'

const id = 'dsh-media'

/** Modules the Host's module table provides; a `require` it cannot answer throws at load. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  tsconfig: 'tsconfig.client.json',
  dts: false,
  sourcemap: false,
  clean: true,
  external: [...CLIENT_EXTERNALS],
  noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
