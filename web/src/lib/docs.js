import { user, docs, upsertDoc, removeDoc, toast, patchBoot, meetings } from './store.js'
import { api, post, patch, del } from './api.js'
import { navigate } from './router.js'
import { newId, newMeetCode } from './util.js'

export const docPath = (d) => (d.kind === 'sheet' ? '/s/' : '/d/') + d.id

// createDoc opens a new document at once: the id is minted here, the view
// starts on local state, and the server learns about it in the background.
export function createDoc(kind, { title = '', snapshot } = {}) {
  const t = Math.floor(Date.now() / 1000)
  const doc = { id: newId(14), kind, title, access: 'private', owner: user.value.id, role: 'owner', created: t, updated: t, shares: [] }
  upsertDoc(doc)
  const saved = post('/api/docs', { id: doc.id, kind, title, snapshot }).catch((e) => {
    removeDoc(doc.id)
    toast(e.message, 'error')
    throw e
  })
  creating.set(doc.id, saved.then(() => {}, () => {}).finally(() => creating.delete(doc.id)))
  return { doc, saved }
}

// whenCreated resolves once the server knows a document made a moment ago, so
// its live connection is not attempted too early.
const creating = new Map()
export const whenCreated = (id) => creating.get(id) || Promise.resolve()

export function openNew(kind) {
  const { doc } = createDoc(kind)
  navigate(docPath(doc))
}

export async function renameDoc(doc, title) {
  upsertDoc({ ...doc, title })
  await patch('/api/docs/' + doc.id, { title }).catch((e) => toast(e.message, 'error'))
}

export async function shareDoc(doc, change) {
  upsertDoc({ ...doc, ...change })
  await patch('/api/docs/' + doc.id, change).catch((e) => toast(e.message, 'error'))
}

export async function trashDoc(doc, trashed = true) {
  upsertDoc({ ...doc, trashed: trashed ? Math.floor(Date.now() / 1000) : 0 })
  await patch('/api/docs/' + doc.id, { trashed }).catch((e) => toast(e.message, 'error'))
}

export async function deleteDoc(doc) {
  removeDoc(doc.id)
  await del('/api/docs/' + doc.id).catch((e) => toast(e.message, 'error'))
  try {
    indexedDB.deleteDatabase('os-doc-' + doc.id)
  } catch {}
}

export const findDoc = (id) => docs.value.find((d) => d.id === id)

// convert sends a file through the server's document converter.
export async function convert(from, to, body) {
  const res = await api('POST', `/api/convert?from=${from}&to=${to}`, body, { raw: true, type: 'application/octet-stream' })
  return res
}

// newMeeting creates a room and returns its code without waiting.
export function newMeeting(title = '') {
  const code = newMeetCode()
  const m = { code, title, owner: user.value.id, created: Math.floor(Date.now() / 1000), used: 0 }
  patchBoot({ meetings: [m, ...meetings.value] })
  const saved = post('/api/meet', { code, title }).catch((e) => toast(e.message, 'error'))
  return { code, saved }
}

export const meetLink = (code) => `${location.origin}/meet/${code}`
