// Open Suite service worker: keeps the app shell and every build asset on the
// device, so a return visit starts from local disk with no network on the
// critical path. Data is never cached here; the app keeps its own local copy.
const VERSION = '__VERSION__'
const CACHE = 'opensuite-' + VERSION
const ASSETS = "__ASSETS__"
const SHELL = '/?shell'

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll([SHELL, ...ASSETS]))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('opensuite-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

const passthrough = /^\/(api|_matrix|lk|\.well-known)\//

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin || passthrough.test(url.pathname)) return
  if (req.mode === 'navigate') {
    e.respondWith(caches.match(SHELL, { cacheName: CACHE }).then((hit) => hit || fetch(req)))
    return
  }
  if (url.pathname.startsWith('/assets/') || url.pathname === '/icon.svg') {
    e.respondWith(caches.match(req, { cacheName: CACHE }).then((hit) => hit || fetch(req)))
  }
})
