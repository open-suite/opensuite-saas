// Comment threads live in the document's own shared state, beside its text,
// so they sync live, work offline and are in every version. A thread is
// anchored by a `comment` mark on the text it is about (doc-marks.js).
import * as Y from 'yjs'
import { newId } from '../lib/util.js'

const map = (ydoc) => ydoc.getMap('comments')

const entry = (me, text, mentions) => ({ id: newId(10), by: me.id, name: me.name, at: Date.now(), text, mentions })

export function readThreads(ydoc) {
  const out = []
  map(ydoc).forEach((t, id) => {
    if (!(t instanceof Y.Map)) return
    out.push({
      id, by: t.get('by'), name: t.get('name'), at: t.get('at'), text: t.get('text') || '', mentions: t.get('mentions') || [],
      edited: !!t.get('edited'), resolved: t.get('resolved') || null, replies: t.get('replies')?.toArray() || [],
    })
  })
  return out
}

export function addThread(ydoc, id, me, text, mentions) {
  const t = new Y.Map()
  ydoc.transact(() => {
    const e = entry(me, text, mentions)
    for (const k of ['by', 'name', 'at', 'text', 'mentions']) t.set(k, e[k])
    t.set('replies', new Y.Array())
    map(ydoc).set(id, t)
  })
}

export function addReply(ydoc, id, me, text, mentions) {
  const t = map(ydoc).get(id)
  if (!t) return
  ydoc.transact(() => {
    t.get('replies').push([entry(me, text, mentions)])
    // An answer reopens a settled thread, as a new message would.
    if (t.get('resolved')) t.set('resolved', null)
  })
}

// editEntry changes the opening comment (reply = null) or one reply.
export function editEntry(ydoc, id, reply, text, mentions) {
  const t = map(ydoc).get(id)
  if (!t) return
  ydoc.transact(() => {
    if (!reply) {
      t.set('text', text)
      t.set('mentions', mentions)
      t.set('edited', true)
      return
    }
    const list = t.get('replies')
    const i = list.toArray().findIndex((r) => r.id === reply)
    if (i < 0) return
    const next = { ...list.get(i), text, mentions, edited: true }
    list.delete(i, 1)
    list.insert(i, [next])
  })
}

export function removeReply(ydoc, id, reply) {
  const list = map(ydoc).get(id)?.get('replies')
  const i = list ? list.toArray().findIndex((r) => r.id === reply) : -1
  if (i >= 0) list.delete(i, 1)
}

export const removeThread = (ydoc, id) => map(ydoc).delete(id)

export function setResolved(ydoc, id, me, resolved) {
  map(ydoc).get(id)?.set('resolved', resolved ? { by: me.id, name: me.name, at: Date.now() } : null)
}

// adoptThreads copies threads from another copy of the document (a past
// version) that this one no longer has, so restored text keeps its comments.
export function adoptThreads(ydoc, from) {
  const mine = map(ydoc)
  ydoc.transact(() => {
    map(from).forEach((t, id) => {
      if (mine.has(id) || !(t instanceof Y.Map)) return
      const copy = new Y.Map()
      for (const [k, v] of t.entries()) {
        if (k === 'replies') {
          const list = new Y.Array()
          list.push(v.toArray())
          copy.set(k, list)
        } else copy.set(k, v)
      }
      mine.set(id, copy)
    })
  })
}
