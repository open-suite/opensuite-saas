// The presentation controller. A deck is a shared document held on the
// device: it opens from local storage, every edit applies at once, and the
// server relays and backs up. The view (slides.jsx) draws whatever this holds
// and calls its methods; nothing here renders.
//
// Shape of the shared document:
//   meta   : { theme, transition }
//   slides : id -> { pos, layout, bg, notes (text), els: id -> element }
//   element: { type: box|image|line, geometry, style, z, text (rich text) }
// Slides and elements are keyed by id and ordered by a number (pos, z), so a
// reorder is one small write that never disturbs what a colleague is typing.
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import { docs, upsertDoc, toast } from '../lib/store.js'
import { api } from '../lib/api.js'
import { DocSocket, fetchState } from '../lib/sync.js'
import { findDoc, whenCreated, isFresh } from '../lib/docs.js'
import { colorFor, newId } from '../lib/util.js'
import { W, H, themeOf, slideColors, slideVars, layouts, bounds, outer, union, shifted, between, round, isLine, isShape, frameCss, textCss, textPad } from './slides-model.js'
import { textJSON, textPlain, fillText, isBlank, forget, createTextEditor, formatAll, describeAll, rehearse as rehearseText, ySyncPluginKey, paragraphs } from './slides-text.js'

const REMOTE = 'remote'
const SEED = 'seed'
export const LOCAL = 'local'

// --- plain data <-> shared document ------------------------------------------

export function readEl(m) {
  const o = {}
  m.forEach((v, k) => (o[k] = v))
  return o
}

export function elJSON(m) {
  const o = readEl(m)
  if (o.type === 'box') o.text = textJSON(o.text)
  return o
}

export function slideJSON(m) {
  return {
    layout: m.get('layout') || 'blank', bg: m.get('bg') || null, notes: m.get('notes')?.toString() || '',
    els: [...m.get('els').values()].map(elJSON).sort((a, b) => (a.z || 0) - (b.z || 0)),
  }
}

export function writeEl(els, data) {
  const m = new Y.Map()
  for (const [k, v] of Object.entries(data)) if (k !== 'text' && v !== undefined && v !== null) m.set(k, v)
  if (data.type === 'box') m.set('text', new Y.XmlFragment())
  els.set(data.id, m)
  if (data.type === 'box') fillText(m.get('text'), data.text)
  return m
}

export function writeSlide(slides, id, pos, data) {
  const m = new Y.Map()
  m.set('pos', pos)
  m.set('layout', data.layout || 'blank')
  if (data.bg) m.set('bg', data.bg)
  m.set('notes', new Y.Text(data.notes || ''))
  m.set('els', new Y.Map())
  slides.set(id, m)
  const els = m.get('els')
  let z = 1
  for (const e of data.els || []) writeEl(els, { ...e, id: e.id || newId(8), z: z++ })
  return m
}

// The boxes a layout starts with.
export function layoutEls(layout) {
  return (layouts[layout] || layouts.blank).els.map((p) =>
    p.type === 'image' ? { type: 'image', role: p.role, src: '', x: p.x, y: p.y, w: p.w, h: p.h, rot: 0 }
      : { type: 'box', shape: 'none', role: p.role, slot: p.slot, x: p.x, y: p.y, w: p.w, h: p.h, rot: 0, valign: p.valign })
}

// buildDeck fills an empty document from plain data (a new deck, an import).
export function buildDeck(ydoc, data) {
  const slides = ydoc.getMap('slides'), meta = ydoc.getMap('meta')
  ydoc.transact(() => {
    meta.set('theme', data.theme || 'paper')
    if (data.transition) meta.set('transition', data.transition)
    data.slides.forEach((s, i) => writeSlide(slides, s.id || newId(10), i + 1, s))
  }, SEED)
}

// --- decks kept in memory ---------------------------------------------------

const warm = new Map() // deck id -> state
export function keepWarm(id, state) {
  warm.delete(id)
  warm.set(id, state)
  if (warm.size > 16) warm.delete(warm.keys().next().value)
}

let rehearsed = false
function rehearse() {
  if (rehearsed) return
  rehearsed = true
  rehearseText()
  const tmp = new Y.Doc()
  try {
    createTextEditor({ element: document.createElement('div'), fragment: tmp.getXmlFragment('t') }).destroy()
  } catch {}
  tmp.destroy()
}

// prewarm runs while the browser is idle: recent decks are read from the
// device into memory, and ones this device has never held are fetched, so the
// first open here is as fast as any other.
export async function prewarm() {
  rehearse()
  let stored
  try {
    stored = new Set((await indexedDB.databases()).map((d) => d.name))
  } catch {
    return
  }
  for (const d of docs.value.filter((x) => x.kind === 'slides' && !x.trashed).slice(0, 6)) {
    if (warm.has(d.id)) continue
    const name = 'os-doc-' + d.id
    const tmp = new Y.Doc()
    const store = new IndexeddbPersistence(name, tmp)
    try {
      await store.whenSynced
      if (!stored.has(name)) {
        const state = await fetchState(d.id)
        if (state.base.length) Y.applyUpdate(tmp, state.base)
        for (const u of state.updates) Y.applyUpdate(tmp, u)
      }
      if (!warm.has(d.id)) keepWarm(d.id, Y.encodeStateAsUpdate(tmp))
    } catch {}
    await store.destroy()
    tmp.destroy()
  }
}

function clientIds(update) {
  const dec = decoding.createDecoder(update)
  const n = decoding.readVarUint(dec)
  const ids = []
  for (let i = 0; i < n; i++) {
    ids.push(decoding.readVarUint(dec))
    decoding.readVarUint(dec)
    decoding.readVarString(dec)
  }
  return ids
}

export async function uploadImage(file) {
  const res = await api('POST', '/api/blobs?name=' + encodeURIComponent(file.name || 'image'), file, { type: file.type })
  return res.url
}

function imageSize(src) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth || 640, h: img.naturalHeight || 360 })
    img.onerror = () => resolve({ w: 640, h: 360 })
    img.src = src
  })
}

// --- the controller ---------------------------------------------------------

export class Deck {
  constructor(id, me, onChange) {
    const t0 = performance.now()
    this.id = id
    this.me = me
    this.onChange = onChange
    this.ydoc = new Y.Doc()
    this.local = new IndexeddbPersistence('os-doc-' + id, this.ydoc)
    // Applied before the store has opened, so it is on screen in this frame.
    if (warm.has(id)) Y.applyUpdate(this.ydoc, warm.get(id), REMOTE)
    this.slides = this.ydoc.getMap('slides')
    this.meta = this.ydoc.getMap('meta')
    this.awareness = new Awareness(this.ydoc)
    this.color = colorFor(me.id)
    this.awareness.setLocalStateField('user', { name: me.name, color: this.color, id: me.id })

    this.state = { online: false, canEdit: true }
    this.cur = null // slide on the stage
    this.picked = new Set() // slides selected in the strip
    this.sel = new Set() // elements selected on the stage
    this.zone = 'stage' // where keys and the clipboard act: stage | strip
    this.editing = null // id of the box being typed in
    this.editor = null
    this.host = null // where the view lets the text editor live
    this.live = null // geometry of elements while they are dragged
    this.guides = null
    this.marquee = null
    this.scale = 1
    this.versions = new Map() // slide id -> counter, so thumbnails redraw only when needed
    this.cache = null
    this.pastes = 0

    this.undoer = new Y.UndoManager([this.slides, this.meta], { trackedOrigins: new Set([LOCAL, ySyncPluginKey]), captureTimeout: 400 })
    const remember = ({ stackItem }) => stackItem.meta.set('view', { cur: this.cur, sel: [...this.sel] })
    this.undoer.on('stack-item-added', remember)
    this.undoer.on('stack-item-updated', remember)
    this.undoer.on('stack-item-popped', ({ stackItem }) => {
      const v = stackItem.meta.get('view')
      if (!v || !this.slides.has(v.cur)) return
      if (this.editing && this.cur !== v.cur) this.stopEdit()
      this.cur = v.cur
      this.picked = new Set([v.cur])
      if (!this.editing) this.sel = new Set(v.sel)
      this.settle()
    })

    this.slides.observeDeep((events) => {
      this.cache = null
      for (const ev of events) {
        const p = ev.path
        if (!p.length) ev.keysChanged?.forEach((k) => this.touch(k))
        else this.touch(p[0])
        if (p[1] === 'els' && p[3] === 'text') {
          const frag = this.slides.get(p[0])?.get('els')?.get(p[2])?.get('text')
          if (frag) forget(frag)
        }
      }
      this.settle()
      this.changed()
    })
    this.meta.observe(() => this.changed())

    if (isFresh(id) && this.slides.size === 0) this.seed()
    this.settle()
    this.connect()
    this.onUnload = () => removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'unload')
    addEventListener('pagehide', this.onUnload)
    // Where opening a deck spends its time, for tests/perf-slides.cjs.
    window.__slidesTiming = { t0, state: performance.now() - t0 }
  }

  touch(id) {
    this.versions.set(id, (this.versions.get(id) || 0) + 1)
  }

  changed() {
    this.onChange?.()
  }

  // seed gives an empty deck its first slide. The ids are fixed, so two
  // devices doing this at the same moment end up with one slide, not two.
  seed() {
    this.ydoc.transact(() => {
      if (!this.meta.get('theme')) this.meta.set('theme', 'paper')
      if (!this.slides.has('first')) writeSlide(this.slides, 'first', 1, { layout: 'title', els: layoutEls('title').map((e, i) => ({ ...e, id: 'first' + i })) })
    }, SEED)
  }

  // --- sync -----------------------------------------------------------------

  connect() {
    const { ydoc, awareness, id } = this
    let history = []
    let first = true
    const peers = new Map()
    this.queue = []
    this.timer = null
    this.flush = () => {
      this.timer = null
      if (!this.queue.length) return
      this.sock.sendUpdate(this.queue.length === 1 ? this.queue[0] : Y.mergeUpdates(this.queue))
      this.queue = []
      this.changed()
    }
    ydoc.on('update', (update, origin) => {
      if (origin === REMOTE || origin === this.local) return
      this.queue.push(update)
      this.timer ??= setTimeout(this.flush, 50)
    })
    const announce = () => this.sock.sendAwareness(encodeAwarenessUpdate(awareness, [ydoc.clientID]))
    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (origin !== REMOTE) this.sock.sendAwareness(encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]))
      this.changed()
    })
    this.sock = new DocSocket(id, {
      hello: (peer, canEdit) => {
        this.state.canEdit = canEdit
        if (!canEdit) this.stopEdit()
        this.changed()
      },
      base: (seq, bytes) => {
        if (!bytes.length) return
        Y.applyUpdate(ydoc, bytes, REMOTE)
        if (first) history.push(bytes)
      },
      update: (seq, bytes) => {
        Y.applyUpdate(ydoc, bytes, REMOTE)
        if (first) history.push(bytes)
      },
      ack: () => this.changed(),
      synced: async (seq) => {
        announce()
        if (!first) return
        first = false
        const got = history
        history = []
        // Send whatever this device has that the server lacks: edits made
        // offline in an earlier session.
        await this.local.whenSynced
        if (this.closed) return
        const server = new Y.Doc()
        for (const u of got) Y.applyUpdate(server, u)
        const missing = Y.encodeStateAsUpdate(ydoc, Y.encodeStateVector(server))
        server.destroy()
        if (missing.length > 2) this.sock.sendUpdate(missing)
        // A long log is folded into one snapshot so the next open is quick.
        else if (got.length > 60) this.sock.sendSnapshot(seq, Y.encodeStateAsUpdate(ydoc))
        if (this.slides.size === 0 && this.state.canEdit) this.seed()
      },
      awareness: (peer, bytes) => {
        const known = peers.has(peer)
        try {
          peers.set(peer, clientIds(bytes))
          applyAwarenessUpdate(awareness, bytes, REMOTE)
        } catch {}
        if (!known) announce()
      },
      leave: (peer) => {
        removeAwarenessStates(awareness, peers.get(peer) || [], REMOTE)
        peers.delete(peer)
      },
      title: (title) => {
        const d = findDoc(id)
        if (d && d.title !== title) upsertDoc({ ...d, title })
      },
      status: (online) => {
        this.state.online = online
        this.changed()
      },
    }, 0, whenCreated(id))
    // Search indexes what the deck says; the server cannot read it itself.
    this.sock.text = () => this.plainText()
  }

  saved() {
    return this.sock.pending.size === 0 && this.queue.length === 0
  }

  close() {
    this.stopEdit()
    this.closed = true
    clearTimeout(this.timer)
    this.flush()
    keepWarm(this.id, Y.encodeStateAsUpdate(this.ydoc))
    removeEventListener('pagehide', this.onUnload)
    removeAwarenessStates(this.awareness, [this.ydoc.clientID], 'close')
    this.undoer.destroy()
    this.sock.close()
    this.local.destroy()
    this.ydoc.destroy()
  }

  // --- reading --------------------------------------------------------------

  order() {
    if (!this.cache) {
      this.cache = [...this.slides.entries()].map(([id, m]) => ({ id, pos: m.get('pos') || 0 }))
        .sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1)).map((s) => s.id)
    }
    return this.cache
  }

  slide(id = this.cur) {
    return this.slides.get(id)
  }

  elMap(id, sid = this.cur) {
    return this.slides.get(sid)?.get('els')?.get(id)
  }

  el(id, sid = this.cur) {
    const m = this.elMap(id, sid)
    if (!m) return null
    const e = readEl(m)
    return this.live?.has(id) && sid === this.cur ? { ...e, ...this.live.get(id) } : e
  }

  els(sid = this.cur) {
    const m = this.slides.get(sid)?.get('els')
    if (!m) return []
    return [...m.values()].map(readEl).sort((a, b) => (a.z || 0) - (b.z || 0) || (a.id < b.id ? -1 : 1))
  }

  selected() {
    return this.els().filter((e) => this.sel.has(e.id)).map((e) => (this.live?.has(e.id) ? { ...e, ...this.live.get(e.id) } : e))
  }

  themeId() {
    return this.meta.get('theme') || 'paper'
  }

  colors(sid = this.cur) {
    const m = this.slides.get(sid)
    return slideColors(themeOf(this.themeId()), m?.get('layout'), m?.get('bg'))
  }

  notes(sid = this.cur) {
    return this.slides.get(sid)?.get('notes')?.toString() || ''
  }

  // Everyone else looking at this deck.
  peers() {
    const out = []
    this.awareness.getStates().forEach((st, cid) => {
      if (cid !== this.awareness.clientID && st.user) out.push({ cid, user: st.user, at: st.sl || {} })
    })
    return out
  }

  // settle keeps the view state pointing at things that still exist.
  settle() {
    const order = this.order()
    if (!this.slides.has(this.cur)) {
      this.cur = order[Math.min(this.at || 0, order.length - 1)] || null
      this.sel = new Set()
    }
    this.at = Math.max(0, order.indexOf(this.cur))
    this.picked = new Set([...this.picked].filter((id) => this.slides.has(id)))
    if (this.cur) this.picked.add(this.cur)
    const els = this.slides.get(this.cur)?.get('els')
    for (const id of this.sel) if (!els?.has(id)) this.sel.delete(id)
    if (this.editing && !els?.has(this.editing)) this.stopEdit()
    this.publish()
  }

  publish() {
    const at = { slide: this.cur, sel: [...this.sel], edit: this.editing }
    const key = JSON.stringify(at)
    if (key === this.said) return
    this.said = key
    this.awareness.setLocalStateField('sl', at)
  }

  // --- moving around --------------------------------------------------------

  goto(id, mode) {
    if (!this.slides.has(id)) return
    this.stopEdit()
    const order = this.order()
    if (mode === 'range' && this.cur) {
      const [a, b] = [order.indexOf(this.cur), order.indexOf(id)].sort((x, y) => x - y)
      this.picked = new Set(order.slice(a, b + 1))
    } else if (mode === 'toggle') {
      if (this.picked.has(id) && this.picked.size > 1) {
        this.picked.delete(id)
        if (id === this.cur) id = [...this.picked][0]
      } else this.picked.add(id)
    } else if (mode !== 'keep' || !this.picked.has(id)) this.picked = new Set([id])
    if (id !== this.cur) this.sel = new Set()
    this.cur = id
    this.settle()
    this.changed()
  }

  step(n) {
    const order = this.order()
    const i = Math.max(0, Math.min(order.length - 1, order.indexOf(this.cur) + n))
    this.goto(order[i])
  }

  select(ids) {
    const next = new Set(ids)
    if (this.editing && !next.has(this.editing)) this.stopEdit()
    this.sel = next
    this.zone = 'stage'
    this.publish()
    this.changed()
  }

  pickedInOrder() {
    return this.order().filter((id) => this.picked.has(id))
  }

  // --- changing the deck ----------------------------------------------------

  // mutate makes one change to the deck. Each call is its own step for undo,
  // unless `merge` says it continues the step before (typing, nudging), or
  // is 'open': a new step that what follows at once may still join.
  mutate(fn, merge) {
    if (!this.state.canEdit) return
    if (merge !== true) this.undoer.stopCapturing()
    this.ydoc.transact(fn, LOCAL)
    if (!merge) this.undoer.stopCapturing()
  }

  // refit grows text boxes whose text no longer fits them, once the page has
  // drawn the change that made it so (a paste, a larger size, a list).
  refit(ids) {
    requestAnimationFrame(() => setTimeout(() => {
      if (this.closed || !this.host) return
      const changes = {}
      for (const id of ids) {
        const e = this.el(id)
        const dom = this.host.parentElement?.querySelector(`.sl-slide [data-el="${id}"]`)
        if (!e || !dom || e.type !== 'box' || isShape(e) || id === this.editing) continue
        const d = Math.ceil(dom.offsetHeight) - e.h
        if (d > 0.5) changes[id] = { h: e.h + d, y: e.valign === 'bottom' ? e.y - d : e.valign === 'middle' ? e.y - d / 2 : e.y }
      }
      if (Object.keys(changes).length) this.patch(changes, true)
    }, 0))
  }

  undo() {
    this.undoer.undo()
    this.changed()
  }

  redo() {
    this.undoer.redo()
    this.changed()
  }

  setTheme(id) {
    this.mutate(() => this.meta.set('theme', id))
  }

  setTransition(t) {
    this.mutate(() => this.meta.set('transition', t))
  }

  addSlide(layout = 'titleBody', after = this.cur, data) {
    const order = this.order()
    const i = order.indexOf(after)
    const a = this.slides.get(order[i])?.get('pos'), b = this.slides.get(order[i + 1])?.get('pos')
    const id = newId(10)
    this.stopEdit()
    this.mutate(() => writeSlide(this.slides, id, between(a ?? null, b ?? null), data || { layout, els: layoutEls(layout) }))
    if (this.slides.has(id)) this.goto(id)
    return id
  }

  duplicateSlides(ids = this.pickedInOrder()) {
    let last = null
    this.stopEdit()
    this.mutate(() => {
      for (const id of ids) {
        const order = this.order()
        const i = order.indexOf(id)
        const a = this.slides.get(id).get('pos'), b = this.slides.get(order[i + 1])?.get('pos')
        last = newId(10)
        writeSlide(this.slides, last, between(a, b ?? null), slideJSON(this.slides.get(id)))
        this.cache = null
      }
    })
    if (last) this.goto(last)
  }

  deleteSlides(ids = this.pickedInOrder()) {
    this.stopEdit()
    this.mutate(() => {
      for (const id of ids) this.slides.delete(id)
      if (this.slides.size === 0) writeSlide(this.slides, newId(10), 1, { layout: 'titleBody', els: layoutEls('titleBody') })
    })
  }

  // moveSlides puts the given slides, in order, before position `index`.
  moveSlides(ids, index) {
    const order = this.order()
    const rest = order.filter((id) => !ids.includes(id))
    const before = order.slice(0, index).filter((id) => !ids.includes(id)).length
    let a = this.slides.get(rest[before - 1])?.get('pos') ?? null
    const b = this.slides.get(rest[before])?.get('pos') ?? null
    this.mutate(() => {
      for (const id of ids) {
        a = between(a, b)
        this.slides.get(id).set('pos', a)
      }
    })
  }

  // setLayout rearranges a slide: boxes that play a part move to their new
  // places, missing ones appear, and empty ones that no longer fit go.
  setLayout(layout, sid = this.cur) {
    const slide = this.slides.get(sid)
    if (!slide) return
    this.stopEdit()
    this.mutate(() => {
      const els = slide.get('els')
      const have = [...els.values()].map(readEl).filter((e) => e.role).sort((a, b) => (a.slot || 0) - (b.slot || 0) || a.x - b.x)
      let z = Math.max(0, ...[...els.values()].map((m) => m.get('z') || 0))
      for (const want of layoutEls(layout)) {
        const i = have.findIndex((e) => e.role === want.role)
        if (i < 0) {
          writeEl(els, { ...want, id: newId(8), z: ++z })
          continue
        }
        const m = els.get(have.splice(i, 1)[0].id)
        for (const k of ['x', 'y', 'w', 'h', 'valign', 'slot']) if (want[k] !== undefined) m.set(k, want[k])
        m.set('rot', 0)
      }
      for (const e of have) if (e.type === 'image' ? !e.src : isBlank(e.text)) els.delete(e.id)
      slide.set('layout', layout)
    })
  }

  setBackground(color, sid = this.cur) {
    this.mutate(() => (color ? this.slides.get(sid).set('bg', color) : this.slides.get(sid).delete('bg')))
  }

  setNotes(text, sid = this.cur) {
    const y = this.slides.get(sid)?.get('notes')
    if (!y) return
    const old = y.toString()
    if (old === text) return
    let a = 0
    while (a < old.length && a < text.length && old[a] === text[a]) a++
    let b = 0
    while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++
    this.mutate(() => {
      if (old.length - a - b > 0) y.delete(a, old.length - a - b)
      if (text.length - a - b > 0) y.insert(a, text.slice(a, text.length - b))
    }, true)
  }

  topZ() {
    return Math.max(0, ...this.els().map((e) => e.z || 0))
  }

  // free finds a spot for a new element that is not exactly on top of one
  // already there.
  free(x, y) {
    const taken = this.els().map((e) => bounds(e))
    while (taken.some((b) => Math.abs(b.x - x) < 4 && Math.abs(b.y - y) < 4) && x < W - 120 && y < H - 120) {
      x += 24
      y += 24
    }
    return [x, y]
  }

  add(data, merge) {
    const id = newId(8)
    this.stopEdit()
    this.mutate(() => writeEl(this.slide().get('els'), { ...data, id, z: this.topZ() + 1 }), merge)
    if (this.elMap(id)) this.select([id])
    return id
  }

  addText(text) {
    const [x, y] = this.free(W / 2 - 260, H / 2 - 40)
    const id = this.add({ type: 'box', shape: 'none', x, y, w: 520, h: 50, rot: 0, valign: 'top', text: text ? paragraphs(...text.split(/\r?\n/)) : undefined }, text ? 'open' : undefined)
    if (text) this.refit([id])
    else this.startEdit(id)
    return id
  }

  addShape(shape) {
    if (shape === 'line' || shape === 'arrow') {
      const [x, y] = this.free(W / 2 - 200, H / 2)
      return this.add({ type: 'line', x1: x, y1: y, x2: x + 400, y2: y, stroke: 'ink', sw: 4, head: shape === 'arrow' ? 'end' : 'none' })
    }
    const size = shape === 'ellipse' ? [240, 240] : [320, 200]
    const [x, y] = this.free(W / 2 - size[0] / 2, H / 2 - size[1] / 2)
    return this.add({ type: 'box', shape, x, y, w: size[0], h: size[1], rot: 0, valign: 'middle', fill: 'accent' })
  }

  // addImage uploads a picture. It fills the selected empty picture frame if
  // there is one, and otherwise lands in the middle of the slide.
  async addImage(file, into) {
    if (!this.state.canEdit) return
    try {
      const sid = this.cur
      const local = URL.createObjectURL(file)
      const [src, size] = await Promise.all([uploadImage(file), imageSize(local)])
      URL.revokeObjectURL(local)
      if (!this.slides.has(sid)) return
      if (sid !== this.cur) this.goto(sid)
      const target = into || this.selected().find((e) => e.type === 'image' && !e.src)?.id
      if (target && this.elMap(target)) {
        this.mutate(() => this.elMap(target).set('src', src))
        return this.select([target])
      }
      const k = Math.min(1, 720 / size.w, 480 / size.h)
      const w = Math.round(size.w * k), h = Math.round(size.h * k)
      const [x, y] = this.free(Math.round((W - w) / 2), Math.round((H - h) / 2))
      this.add({ type: 'image', src, alt: file.name || '', x, y, w, h, rot: 0 })
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  // patch applies { id: changes } to elements of the current slide.
  patch(changes, merge) {
    const entries = changes instanceof Map ? [...changes] : Object.entries(changes)
    this.mutate(() => {
      for (const [id, p] of entries) {
        const m = this.elMap(id)
        if (!m) continue
        for (const [k, v] of Object.entries(p)) {
          if (v === undefined || v === null) m.delete(k)
          else m.set(k, typeof v === 'number' ? round(v) : v)
        }
      }
    }, merge)
  }

  patchSelected(p) {
    this.patch(Object.fromEntries([...this.sel].map((id) => [id, p])))
  }

  remove(ids = [...this.sel]) {
    this.stopEdit()
    this.mutate(() => {
      const els = this.slide()?.get('els')
      for (const id of ids) els?.delete(id)
    })
  }

  duplicate(ids = [...this.sel], shift = 24) {
    const made = []
    this.stopEdit()
    this.mutate(() => {
      const els = this.slide().get('els')
      let z = this.topZ()
      for (const e of this.els().filter((x) => ids.includes(x.id))) {
        const id = newId(8)
        writeEl(els, { ...elJSON(els.get(e.id)), ...shifted(e, shift, shift), id, z: ++z })
        made.push(id)
      }
    })
    if (made.length) this.select(made)
    return made
  }

  // arrange changes what is in front of what: front | back | forward | backward.
  arrange(how) {
    const all = this.els()
    const chosen = all.filter((e) => this.sel.has(e.id))
    if (!chosen.length) return
    const changes = {}
    if (how === 'front') {
      let z = this.topZ()
      for (const e of chosen) changes[e.id] = { z: ++z }
    } else if (how === 'back') {
      let z = Math.min(...all.map((e) => e.z || 0)) - chosen.length
      for (const e of chosen) changes[e.id] = { z: z++ }
    } else {
      const list = how === 'forward' ? [...all].reverse() : all
      for (let i = 1; i < list.length; i++) {
        if (this.sel.has(list[i].id) && !this.sel.has(list[i - 1].id)) {
          const mine = changes[list[i].id]?.z ?? list[i].z, theirs = changes[list[i - 1].id]?.z ?? list[i - 1].z
          changes[list[i].id] = { z: theirs }
          changes[list[i - 1].id] = { z: mine }
          ;[list[i], list[i - 1]] = [list[i - 1], list[i]]
        }
      }
    }
    this.patch(changes)
  }

  // align lines elements up: with the slide when one is selected, with each
  // other when several are.
  align(how) {
    const chosen = this.selected()
    if (!chosen.length) return
    const frame = chosen.length > 1 ? union(chosen.map(outer)) : { x: 0, y: 0, w: W, h: H }
    const changes = {}
    for (const e of chosen) {
      const b = outer(e)
      const dx = how === 'left' ? frame.x - b.x : how === 'center' ? frame.x + frame.w / 2 - (b.x + b.w / 2) : how === 'right' ? frame.x + frame.w - (b.x + b.w) : 0
      const dy = how === 'top' ? frame.y - b.y : how === 'middle' ? frame.y + frame.h / 2 - (b.y + b.h / 2) : how === 'bottom' ? frame.y + frame.h - (b.y + b.h) : 0
      changes[e.id] = shifted(e, dx, dy)
    }
    this.patch(changes)
  }

  // distribute spaces three or more elements evenly along an axis.
  distribute(axis) {
    const chosen = this.selected().map((e) => ({ e, b: outer(e) }))
    if (chosen.length < 3) return
    const [at, size] = axis === 'x' ? ['x', 'w'] : ['y', 'h']
    chosen.sort((p, q) => p.b[at] - q.b[at])
    const first = chosen[0].b, last = chosen[chosen.length - 1].b
    const gap = (last[at] + last[size] - first[at] - chosen.reduce((s, c) => s + c.b[size], 0)) / (chosen.length - 1)
    let pos = first[at]
    const changes = {}
    for (const c of chosen) {
      const d = pos - c.b[at]
      changes[c.e.id] = axis === 'x' ? shifted(c.e, d, 0) : shifted(c.e, 0, d)
      pos += c.b[size] + gap
    }
    this.patch(changes)
  }

  nudge(dx, dy) {
    this.patch(Object.fromEntries(this.selected().map((e) => [e.id, shifted(e, dx, dy)])), true)
  }

  // --- clipboard ------------------------------------------------------------

  copy() {
    if (this.zone === 'strip') {
      const slides = this.pickedInOrder().map((id) => slideJSON(this.slides.get(id)))
      return { t: 'slides', slides, plain: slides.map((s) => s.els.map((e) => plainOf(e)).filter(Boolean).join('\n')).join('\n\n') }
    }
    if (!this.sel.size) return null
    const els = this.els().filter((e) => this.sel.has(e.id)).map((e) => elJSON(this.elMap(e.id)))
    this.pastes = 0
    return { t: 'els', from: this.id + '/' + this.cur, els, plain: els.map(plainOf).filter(Boolean).join('\n') }
  }

  paste(data) {
    if (!data || !this.state.canEdit) return
    if (data.t === 'slides') {
      let after = this.pickedInOrder().pop() || this.cur
      for (const s of data.slides) after = this.addSlide(s.layout, after, s)
      return
    }
    if (data.t !== 'els') return
    const shift = data.from === this.id + '/' + this.cur ? 24 * ++this.pastes : 0
    const made = []
    this.stopEdit()
    this.mutate(() => {
      const els = this.slide().get('els')
      let z = this.topZ()
      for (const e of data.els) {
        const id = newId(8)
        writeEl(els, { ...e, ...shifted(e, shift, shift), id, z: ++z })
        made.push(id)
      }
    }, 'open')
    if (made.length) this.select(made)
    this.refit(made)
  }

  // --- typing in a box ------------------------------------------------------

  // placeHost keeps the live editor exactly over the box it edits.
  placeHost() {
    if (!this.host || !this.inner) return
    const e = this.el(this.editing)
    if (!e) return
    const colors = this.colors()
    this.host.style.cssText = frameCss(e) + slideVars(themeOf(this.themeId()), colors)
    this.inner.style.cssText = textCss(e, this.slide().get('layout'), colors)
  }

  // startEdit puts the caret into a box, in the same task as the click or key
  // that asked for it. opts: { all, point: {left, top}, insert }
  startEdit(id, opts = {}) {
    if (this.editing === id) return this.editor
    this.stopEdit()
    const m = this.elMap(id)
    if (!m || m.get('type') !== 'box' || !this.state.canEdit || !this.host) return null
    this.sel = new Set([id])
    this.zone = 'stage'
    this.editing = id
    this.inner = document.createElement('div')
    this.inner.className = 'sl-box-text'
    this.host.append(this.inner)
    this.host.hidden = false
    this.placeHost()
    this.editor = createTextEditor({
      element: this.inner, fragment: m.get('text'), awareness: this.awareness,
      keys: { undo: () => this.undo(), redo: () => this.redo(), exit: () => this.stopEdit(true) },
      onChange: () => {
        this.fit()
        this.changed()
      },
    })
    const view = this.editor.view
    view.focus()
    const at = opts.point && view.posAtCoords(opts.point)
    if (opts.all) this.editor.commands.selectAll()
    else if (at) this.editor.commands.setTextSelection(at.pos)
    else this.editor.commands.focus('end')
    if (opts.insert) this.editor.commands.insertContent(opts.insert)
    this.publish()
    this.changed()
    return this.editor
  }

  // fit lets a text box grow with what is typed into it.
  fit() {
    if (!this.editor || !this.inner) return
    const e = this.el(this.editing)
    if (!e || isShape(e)) return
    const need = Math.ceil(this.editor.view.dom.offsetHeight + textPad(e)[0] * 2)
    if (need <= e.h + 0.5) return
    const d = need - e.h
    const y = e.valign === 'bottom' ? e.y - d : e.valign === 'middle' ? e.y - d / 2 : e.y
    this.patch({ [e.id]: { h: need, y } }, true)
    this.placeHost()
  }

  stopEdit(refocus) {
    if (!this.editor) return
    const id = this.editing
    const m = this.elMap(id)
    this.editor.destroy()
    this.inner.remove()
    this.editor = this.inner = this.editing = null
    if (this.host) this.host.hidden = true
    if (m) {
      const frag = m.get('text')
      forget(frag)
      // A loose text box that was left empty is not worth keeping.
      if (!m.get('role') && !isShape(readEl(m)) && !m.get('fill') && isBlank(frag)) {
        this.mutate(() => this.slide()?.get('els').delete(id))
        this.sel.delete(id)
      }
    }
    if (refocus) this.host?.closest('.sl-area')?.focus()
    this.publish()
    this.changed()
  }

  boxes() {
    return this.selected().filter((e) => e.type === 'box')
  }

  // format runs a text command on the caret's selection, or on the whole
  // text of every selected box when nobody is typing.
  format(run) {
    if (!this.state.canEdit) return
    if (this.editor) run(this.editor.chain().focus()).run()
    else {
      this.undoer.stopCapturing()
      for (const e of this.boxes()) formatAll(e.text, run)
      this.refit(this.boxes().map((e) => e.id))
    }
    this.changed()
  }

  // formatting reports what the toolbar should show as active.
  formatting() {
    const ed = this.editor
    if (ed) {
      const style = ed.getAttributes('textStyle')
      return {
        bold: ed.isActive('bold'), italic: ed.isActive('italic'), underline: ed.isActive('underline'), link: ed.isActive('link'),
        size: parseFloat(style.fontSize) || null, color: style.color || null, font: style.fontFamily || null,
        align: ed.getAttributes('paragraph').textAlign || null, bullet: ed.isActive('bulletList'), ordered: ed.isActive('orderedList'),
      }
    }
    const box = this.boxes()[0]
    return box ? describeAll(box.text) : null
  }

  // --- whole deck as data (export, presenting) ------------------------------

  // plainText is the deck as words only, slide by slide with its notes: what
  // a search index wants.
  plainText() {
    return this.order().map((id) => [...this.els(id).filter((e) => e.type === 'box').map((e) => textPlain(e.text)), this.notes(id)].filter(Boolean).join('\n')).filter(Boolean).join('\n\n')
  }

  toJSON() {
    return { theme: this.themeId(), transition: this.meta.get('transition') || 'fade', slides: this.order().map((id) => ({ id, ...slideJSON(this.slides.get(id)) })) }
  }
}

const plainOf = (e) => (e.type === 'box' ? (e.text || []).map(nodeText).join('\n') : '')
function nodeText(n) {
  if (n.type === 'text') return n.text || ''
  return (n.content || []).map(nodeText).join(n.type === 'paragraph' ? '' : '\n')
}
