import { boot, setBoot, confirmed } from './store.js'

export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// Writes in flight, and when the last one started or finished. A snapshot of
// server state is only trusted if no write overlapped the request for it.
const writes = { inflight: 0, at: 0 }

export async function api(method, path, body, opts = {}) {
  const init = { method, credentials: 'same-origin', headers: {} }
  if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    init.body = body
    if (opts.type) init.headers['Content-Type'] = opts.type
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers['Content-Type'] = 'application/json'
  }
  const write = method !== 'GET' && !opts.passive
  if (write) {
    writes.inflight++
    writes.at = performance.now()
  }
  let res
  try {
    res = await fetch(path, init)
  } catch {
    throw new ApiError(0, "You're offline. Changes will sync when you reconnect.")
  } finally {
    if (write) {
      writes.inflight--
      writes.at = performance.now()
    }
  }
  if (res.status === 401 && boot.value?.user && !opts.quiet) {
    setBoot({ ...boot.value, user: null })
  }
  if (!res.ok) {
    let msg = 'Something went wrong.'
    try {
      msg = (await res.json()).error || msg
    } catch {}
    throw new ApiError(res.status, msg)
  }
  if (opts.raw) return res
  return res.json()
}

export const get = (path, opts) => api('GET', path, undefined, opts)
export const post = (path, body, opts) => api('POST', path, body ?? {}, opts)
export const patch = (path, body) => api('PATCH', path, body)
export const del = (path) => api('DELETE', path)

let refreshing = null

// refreshBoot reconciles the locally held state with the server. The screen
// already reflects changes made here a moment ago (a new document, a rename);
// a snapshot the server produced before it heard about them would undo them,
// so such a snapshot is discarded and requested again.
export function refreshBoot() {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const started = performance.now()
      let fresh
      try {
        fresh = await get('/api/boot', { quiet: true })
      } catch (e) {
        if (e.status === 0) confirmed.value = true // offline: keep working from the device
        return
      }
      // Being signed out always wins; otherwise only an undisturbed snapshot.
      if (!fresh.user || (writes.inflight === 0 && writes.at < started)) {
        setBoot(fresh)
        return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    confirmed.value = true
  })().finally(() => (refreshing = null))
  return refreshing
}
