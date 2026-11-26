// A presentation as plain data and as a shared document, and the way between
// the two. Used by the editor (slides-core.js), PowerPoint import and the demo
// seed (web/scripts/demo-seed.mjs), so it touches neither the DOM nor storage.
//
// Shape of the shared document:
//   meta   : { theme, transition }
//   slides : id -> { pos, layout, bg, notes (text), els: id -> element }
//   element: { type: box|image|line, geometry, style, z, text (rich text) }
import * as Y from 'yjs'
import { newId } from '../lib/util.js'
import { layouts } from './slides-model.js'
import { textJSON, fillText } from './slides-text.js'

export const SEED = 'seed'

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
