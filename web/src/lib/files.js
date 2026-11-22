// The drive: folders and uploaded files, kept on this device so the Files
// screen paints from memory and every change shows before the server has
// answered. Documents and spreadsheets come from the boot object (lib/store)
// and are filed in the same folders.
import { signal, computed } from '@preact/signals'
import { user, docs, toast, removeDoc } from './store.js'
import { api, get, post, patch, del, ApiError, refreshBoot } from './api.js'
import { kvGet, kvSet } from './idb.js'
import { newId, debounce, bytes } from './util.js'
import { docPath, renameDoc, shareDoc, trashDoc, deleteDoc, moveDoc } from './docs.js'

export const nodes = signal([]) // every folder and file this person can reach
export const filesLoaded = signal(false) // the device copy or the server's answer is in
export const storage = signal(null) // { usage, quota, maxFile }
export const uploads = signal({}) // id -> { loaded, total } while a file is on its way up

const now = () => Math.floor(Date.now() / 1000)
const save = debounce(() => {
  if (user.value) kvSet('files', { user: user.value.id, nodes: nodes.value.filter((n) => !n.uploading), storage: storage.value })
}, 300)

function setNodes(list) {
  nodes.value = list
  save()
}

export const upsertNode = (n) => setNodes([n, ...nodes.value.filter((x) => x.id !== n.id)])
export const removeNode = (id) => setNodes(nodes.value.filter((x) => x.id !== id))

// Writes in flight. A listing the server produced before it heard about one
// of them would undo it on screen, so such a listing is thrown away.
const writes = { inflight: 0, at: 0 }
function write(promise) {
  writes.inflight++
  writes.at = performance.now()
  return promise.finally(() => {
    writes.inflight--
    writes.at = performance.now()
  })
}

let refreshing = null
// refreshFiles reconciles the drive with the server: folders and files here,
// documents through the boot object they arrive in.
export function refreshFiles({ withDocs = false } = {}) {
  if (withDocs) refreshBoot()
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const started = performance.now()
      let fresh
      try {
        fresh = await get('/api/files', { quiet: true })
      } catch {
        return
      }
      if (writes.inflight === 0 && writes.at < started) {
        const pending = nodes.value.filter((n) => n.uploading)
        storage.value = { usage: fresh.usage, quota: fresh.quota, maxFile: fresh.maxFile }
        setNodes([...pending, ...fresh.nodes.filter((n) => !pending.find((p) => p.id === n.id))])
        filesLoaded.value = true
        return
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  })().finally(() => (refreshing = null))
  return refreshing
}

let started = null
// startFiles restores the device copy, then reconciles it with the server.
export function startFiles() {
  if (started === user.value?.id) return
  started = user.value?.id
  kvGet('files').then((saved) => {
    if (saved?.user === user.value?.id && !filesLoaded.value) {
      nodes.value = saved.nodes || []
      storage.value = saved.storage || null
      filesLoaded.value = true
    }
    refreshFiles()
  })
}

// --- one list for everything in the drive ---------------------------------
//
// An item is a folder, a file or a document, in one shape:
// { key, type: 'folder' | 'file' | 'doc', id, name, parent, owner, role,
//   access, shares, updated, size, mime, trashed, kind, ref }

const fromNode = (n) => ({ key: 'n:' + n.id, type: n.kind, id: n.id, name: n.name, parent: n.parent || '', owner: n.owner, role: n.role, access: n.access, shares: n.shares || [], updated: n.updated, size: n.size, mime: n.mime || '', trashed: n.trashed || 0, link: n.link || '', uploading: n.uploading, ref: n })
const fromDoc = (d) => ({ key: 'd:' + d.id, type: 'doc', kind: d.kind, id: d.id, name: d.title || 'Untitled', parent: d.folder || '', owner: d.owner, role: d.role, access: d.access, shares: d.shares || [], updated: d.updated, size: 0, mime: '', trashed: d.trashed || 0, ref: d })

const nodeById = computed(() => Object.fromEntries(nodes.value.map((n) => [n.id, n])))

// gone: a folder above this is in the trash, so it is out of sight with it.
function gone(parent) {
  for (let p = nodeById.value[parent], guard = 0; p && guard < 40; p = nodeById.value[p.parent], guard++) if (p.trashed) return true
  return false
}

export const items = computed(() => [...nodes.value.map(fromNode), ...docs.value.map(fromDoc)].filter((i) => !gone(i.parent)))
export const folders = computed(() => Object.fromEntries(items.value.filter((i) => i.type === 'folder' && !i.trashed).map((i) => [i.id, i.ref])))
export const itemByKey = computed(() => Object.fromEntries(items.value.map((i) => [i.key, i])))

// An item sits at the top level when it has no folder, or when its folder is
// one this person cannot see (a single file shared out of a private folder).
const top = (i) => !i.parent || !nodeById.value[i.parent]

export function listing(view, folder) {
  const me = user.value.id
  const all = items.value
  switch (view) {
    case 'folder': return all.filter((i) => !i.trashed && i.parent === folder)
    case 'shared': return all.filter((i) => !i.trashed && top(i) && i.owner !== me)
    case 'recent': return all.filter((i) => !i.trashed && i.type !== 'folder').sort((a, b) => b.updated - a.updated).slice(0, 60)
    case 'trash': return all.filter((i) => i.trashed)
    default: return all.filter((i) => !i.trashed && top(i) && i.owner === me)
  }
}

// trail is the chain of folders from the top level down to one folder.
export function trail(id) {
  const out = []
  for (let n = folders.value[id], guard = 0; n && guard < 40; n = folders.value[n.parent], guard++) out.unshift(n)
  return out
}

export const itemHref = (i) => (i.type === 'folder' ? '/files/folder/' + i.id : i.type === 'file' ? '/files/file/' + i.id : docPath(i.ref))
export const contentUrl = (id, dl) => `/api/files/${id}/content${dl ? '?dl=1' : ''}`
export const publicUrl = (token) => `${location.origin}/f/${token}`
// A link that opens a file for colleagues who already have access to it.
export const fileLink = (node) => `${location.origin}/files/file/${node.id}`

// --- what a file is --------------------------------------------------------

const ext = (name = '') => (name.includes('.') ? name.split('.').pop().toLowerCase() : '')
const textExt = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'log', 'ini', 'conf', 'toml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'go', 'py', 'rb', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'sql', 'svg'])
const inlineImage = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml'])
const inlineVideo = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'])
const inlineAudio = new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/flac', 'audio/aac', 'audio/x-m4a'])

// fileType sorts a file into the handful of things the drive can show.
export function fileType({ name, mime = '' }) {
  const e = ext(name)
  if (inlineImage.has(mime)) return 'image'
  if (inlineVideo.has(mime)) return 'video'
  if (inlineAudio.has(mime)) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (e === 'md' || e === 'markdown') return 'markdown'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || (textExt.has(e) && !mime.startsWith('image/'))) return 'text'
  if (['doc', 'docx', 'odt', 'rtf'].includes(e)) return 'document'
  if (['xls', 'xlsx', 'ods'].includes(e)) return 'sheet'
  if (['ppt', 'pptx', 'odp', 'key'].includes(e)) return 'slides'
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz'].includes(e)) return 'archive'
  if (mime.startsWith('image/')) return 'picture'
  if (mime.startsWith('video/')) return 'film'
  if (mime.startsWith('audio/')) return 'sound'
  return 'other'
}

// opensAs says which editor can take a file over (a key of docKinds), or nothing.
export function opensAs({ name }) {
  const e = ext(name)
  if (['docx', 'odt', 'md', 'markdown'].includes(e)) return 'doc'
  if (['xlsx', 'csv'].includes(e)) return 'sheet'
  if (e === 'pptx') return 'slides'
  return null
}

// --- changes ---------------------------------------------------------------

function failed(e, undo) {
  undo?.()
  toast(e.message, 'error')
}

export function createFolder(name, parent = '') {
  const t = now()
  const n = { id: newId(14), kind: 'folder', name: name.trim() || 'Untitled folder', parent, owner: user.value.id, role: 'owner', access: 'private', size: 0, created: t, updated: t, shares: [] }
  upsertNode(n)
  const saved = write(post('/api/files/folders', { id: n.id, name: n.name, parent })).then(
    (made) => { upsertNode({ ...nodes.value.find((x) => x.id === n.id), role: made.role }); return made },
    (e) => { failed(e, () => removeNode(n.id)); throw e },
  )
  return { node: n, saved }
}

function patchNode(node, change, body = change) {
  upsertNode({ ...node, ...change })
  return write(patch('/api/files/' + node.id, body)).then(
    (fresh) => { upsertNode(fresh); return fresh },
    (e) => failed(e, () => upsertNode(node)),
  )
}

const stamp = (on) => (on ? now() : 0)

// The same verbs for folders, files and documents.
export const renameItem = (i, name) => (i.type === 'doc' ? renameDoc(i.ref, name) : patchNode(i.ref, { name, updated: now() }, { name }))
export const moveItem = (i, parent) => (i.type === 'doc' ? moveDoc(i.ref, parent) : patchNode(i.ref, { parent }))
export const trashItem = (i, on = true) => (i.type === 'doc' ? trashDoc(i.ref, on) : patchNode(i.ref, { trashed: stamp(on) }, { trashed: on }))
export const shareItem = (i, change) => (i.type === 'doc' ? shareDoc(i.ref, change) : patchNode(i.ref, change))

export function deleteItem(i) {
  if (i.type === 'doc') return deleteDoc(i.ref)
  // Everything inside a folder goes with it.
  const doomed = new Set([i.id])
  for (let grew = true; grew; ) {
    grew = false
    for (const n of nodes.value) {
      if (doomed.has(n.parent) && !doomed.has(n.id)) {
        doomed.add(n.id)
        grew = true
      }
    }
  }
  setNodes(nodes.value.filter((n) => !doomed.has(n.id)))
  for (const d of docs.value) if (doomed.has(d.folder)) removeDoc(d.id)
  return write(del('/api/files/' + i.id)).then(refreshFiles, (e) => failed(e, refreshFiles))
}

// setPublicLink switches the "anyone with the link" address on or off and
// resolves to that address ('' when off).
export async function setPublicLink(node, on) {
  const fresh = await write(patch('/api/files/' + node.id, { link: on })).catch((e) => failed(e))
  if (!fresh) return ''
  upsertNode(fresh)
  return fresh.link ? publicUrl(fresh.link) : ''
}

// canMoveInto: may these items go into that folder ('' is the top level)?
export function canMoveInto(list, dest) {
  const me = user.value.id
  if (dest) {
    const f = folders.value[dest]
    if (!f || f.role === 'view') return false
    // Not into itself or into anything inside it.
    const chain = new Set(trail(dest).map((n) => n.id))
    if (list.some((i) => i.type === 'folder' && chain.has(i.id))) return false
  }
  // Someone who can only edit an item may move it around inside the shared
  // folder it lives in, not out of it.
  const top = (id) => trail(id)[0]?.id
  return list.every((i) => i.role !== 'view' && i.parent !== dest && (dest || i.owner === me) && (i.role === 'owner' || (!!i.parent && top(i.parent) === top(dest))))
}

// --- uploading -------------------------------------------------------------

const queue = []
let running = 0

function pump() {
  while (running < 3 && queue.length) {
    const job = queue.shift()
    running++
    job().finally(() => {
      running--
      pump()
    })
  }
}

function send(file, node) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    const q = new URLSearchParams({ id: node.id, name: node.name, parent: node.parent })
    xhr.open('POST', '/api/files/upload?' + q)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) uploads.value = { ...uploads.value, [node.id]: { loaded: e.loaded, total: e.total } }
    }
    const done = (error) => {
      const { [node.id]: _, ...rest } = uploads.value
      uploads.value = rest
      if (error) {
        removeNode(node.id)
        toast(`${node.name}: ${error}`, 'error')
      }
      resolve()
    }
    xhr.onload = () => {
      let body = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status !== 200) return done(body.error || 'The upload failed.')
      upsertNode(body)
      if (storage.value) storage.value = { ...storage.value, usage: storage.value.usage + body.size }
      done()
    }
    xhr.onerror = () => done("You're offline. Try again when you reconnect.")
    xhr.onabort = () => done('Cancelled.')
    aborts.set(node.id, () => xhr.abort())
    xhr.send(file)
  }).finally(() => aborts.delete(node.id))
}

const aborts = new Map()
export const cancelUpload = (id) => (aborts.get(id) ? aborts.get(id)() : removeNode(id))

// uploadFiles puts files into a folder. Each shows in the list at once with
// its own progress and becomes a normal file when the server has it.
export function uploadFiles(list, parent = '') {
  const made = []
  for (const file of list) {
    const max = storage.value?.maxFile
    if (max && file.size > max) {
      toast(`${file.name} is larger than ${bytes(max)} and can't be uploaded.`, 'error')
      continue
    }
    const t = now()
    const node = { id: newId(14), kind: 'file', name: file.name, parent, owner: user.value.id, role: 'owner', access: 'private', mime: file.type || '', size: file.size, created: t, updated: t, shares: [], uploading: true }
    upsertNode(node)
    uploads.value = { ...uploads.value, [node.id]: { loaded: 0, total: file.size } }
    made.push(node)
    queue.push(() => write(send(file, node)))
  }
  pump()
  return made
}

// uploadDropped handles a drop from the desktop, folders included.
export async function uploadDropped(dataTransfer, parent = '') {
  const entries = [...(dataTransfer.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean)
  if (!entries.some((e) => e.isDirectory)) return uploadFiles([...dataTransfer.files], parent)
  const walk = async (entry, into) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej))
      uploadFiles([file], into)
      return
    }
    const { node, saved } = createFolder(entry.name, into)
    await saved
    const reader = entry.createReader()
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej))
      if (!batch.length) break
      for (const child of batch) await walk(child, node.id)
    }
  }
  for (const e of entries) await walk(e, parent).catch((err) => toast(err.message || 'That folder could not be read.', 'error'))
}

// --- mail -------------------------------------------------------------------

// saveAttachment copies a mail attachment into the drive, server to server.
export async function saveAttachment(att, parent = '') {
  const node = await write(post('/api/files/from-mail', { id: newId(14), blobId: att.blobId, name: att.name || 'attachment', type: att.type, parent }))
  upsertNode(node)
  if (storage.value) storage.value = { ...storage.value, usage: storage.value.usage + node.size }
  return node
}

// attachFile hands a file from the drive to the mail engine and returns what
// the composer needs to attach it.
export const attachFile = (node) => post('/api/files/' + node.id + '/to-mail', {}, { passive: true })

// --- choosing a file from another part of the suite -------------------------

export const picker = signal(null) // { title, action, resolve } while the chooser is open

// pickFromFiles opens the file chooser and resolves to the chosen file (a
// node: { id, name, size, mime, ... }), or null if it was closed. Use
// fileLink(node) for an address colleagues with access can open, or
// setPublicLink(node, true) for one that works for anyone.
export function pickFromFiles({ title = 'Choose a file', action = 'Choose' } = {}) {
  startFiles()
  return new Promise((resolve) => {
    picker.value = { title, action, resolve: (node) => { picker.value = null; resolve(node || null) } }
  })
}

// fetchText reads the start of a text file for a preview.
export async function fetchText(url, limit = 1 << 20) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { Range: `bytes=0-${limit - 1}` } })
  if (!res.ok) throw new ApiError(res.status, "That file couldn't be opened.")
  return res.text()
}

export async function fetchFile(node) {
  const res = await api('GET', contentUrl(node.id, true), undefined, { raw: true })
  return new File([await res.blob()], node.name, { type: node.mime })
}
