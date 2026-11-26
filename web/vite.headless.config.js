// Builds the headless content engine (src/headless/engine.js) into one file
// for Node, dist-headless/engine.mjs, with every dependency inside it and the
// spreadsheet engine's WebAssembly beside it. The server runs it with no
// network and no node_modules.
import { defineConfig } from 'vite'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'

const out = join(import.meta.dirname, 'dist-headless')

export default defineConfig({
  plugins: [{
    name: 'opensuite-engine-wasm',
    apply: 'build',
    closeBundle() {
      copyFileSync(join(import.meta.dirname, 'node_modules/@ironcalc/wasm-xlsx/wasm_bg.wasm'), join(out, 'ironcalc.wasm'))
    },
  }],
  publicDir: false,
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'src/headless/engine.js',
    outDir: out,
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: { output: { entryFileNames: 'engine.mjs', codeSplitting: false } },
  },
})
