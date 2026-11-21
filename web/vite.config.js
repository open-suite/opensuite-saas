import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// After the build: write the service worker with the exact list of files to
// keep offline, and a .gz beside every text asset so nginx never compresses
// on the request path.
function offlineShell() {
  return {
    name: 'opensuite-offline-shell',
    apply: 'build',
    closeBundle() {
      const dist = join(import.meta.dirname, 'dist')
      const files = []
      const walk = (dir, rel) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name)
          if (statSync(p).isDirectory()) walk(p, rel + name + '/')
          else files.push(rel + name)
        }
      }
      walk(dist, '/')
      const assets = files.filter((f) => f.startsWith('/assets/') && !f.endsWith('.gz') && !f.endsWith('.map'))
      const version = createHash('sha256').update(assets.join('|')).digest('hex').slice(0, 12)
      const sw = readFileSync(join(import.meta.dirname, 'src/sw.js'), 'utf8')
        .replace('__VERSION__', version)
        .replace('"__ASSETS__"', JSON.stringify([...assets, '/icon.svg']))
      writeFileSync(join(dist, 'sw.js'), sw)
      for (const f of assets) {
        if (/\.(js|css|wasm|svg)$/.test(f)) writeFileSync(join(dist, f + '.gz'), gzipSync(readFileSync(join(dist, f)), { level: 9 }))
      }
    },
  }
}

export default defineConfig({
  plugins: [preact(), offlineShell()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8600', ws: true },
      '/_matrix': 'http://127.0.0.1:8008',
    },
  },
})
