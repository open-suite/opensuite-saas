import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The person-segmentation runtime behind call backgrounds is served from our
// own origin, never a CDN. Its folder carries the runtime's version because
// /assets/ is cached for good.
const segVersion = JSON.parse(readFileSync(join(import.meta.dirname, 'node_modules/@mediapipe/tasks-vision/package.json'), 'utf8')).version
const SEG = `/assets/seg-${segVersion}`
// Kept on the server until someone turns a background on: 20 MB that most
// visits never need. Everything else in /assets/ is stored on the device.
const onDemand = (f) => f.startsWith(SEG + '/') || f.startsWith('/assets/bg/')

// After the build: write the service worker with the exact list of files to
// keep offline, and a .gz beside every text asset so nginx never compresses
// on the request path.
function offlineShell() {
  return {
    name: 'opensuite-offline-shell',
    apply: 'build',
    closeBundle() {
      const dist = join(import.meta.dirname, 'dist')
      mkdirSync(join(dist, SEG), { recursive: true })
      const wasm = join(import.meta.dirname, 'node_modules/@mediapipe/tasks-vision/wasm')
      for (const name of readdirSync(wasm)) copyFileSync(join(wasm, name), join(dist, SEG, name))
      renameSync(join(dist, 'assets/seg/selfie_segmenter.tflite'), join(dist, SEG, 'selfie_segmenter.tflite'))
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
      const kept = assets.filter((f) => !onDemand(f))
      const version = createHash('sha256').update(kept.join('|')).digest('hex').slice(0, 12)
      const sw = readFileSync(join(import.meta.dirname, 'src/sw.js'), 'utf8')
        .replace('__VERSION__', version)
        .replace('"__ASSETS__"', JSON.stringify([...kept, '/icon.svg']))
      writeFileSync(join(dist, 'sw.js'), sw)
      for (const f of assets) {
        if (/\.(js|css|wasm|svg|tflite)$/.test(f)) writeFileSync(join(dist, f + '.gz'), gzipSync(readFileSync(join(dist, f)), { level: 9 }))
      }
    },
  }
}

export default defineConfig({
  plugins: [preact(), offlineShell()],
  define: { __SEG__: JSON.stringify(SEG) },
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
