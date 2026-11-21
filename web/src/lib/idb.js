// A tiny key-value store on IndexedDB for the device-side copies of mail,
// chat and spreadsheets.
let dbp

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('opensuite', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbp
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction('kv', mode)
        const req = fn(tx.objectStore('kv'))
        tx.oncomplete = () => resolve(req?.result)
        tx.onerror = () => reject(tx.error)
      }),
  )
}

export const kvGet = (key) => run('readonly', (s) => s.get(key)).catch(() => undefined)
export const kvSet = (key, value) => run('readwrite', (s) => s.put(value, key)).catch(() => {})
export const kvDel = (key) => run('readwrite', (s) => s.delete(key)).catch(() => {})

// wipeDevice removes every local copy when someone signs out.
export async function wipeDevice() {
  try {
    await run('readwrite', (s) => s.clear())
    const dbs = (await indexedDB.databases?.()) || []
    for (const d of dbs) if (d.name?.startsWith('os-doc-')) indexedDB.deleteDatabase(d.name)
  } catch {}
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('os:')) localStorage.removeItem(k)
  } catch {}
}
