// A presentation as plain data and as a shared document, and the way between
// the two. Used by the editor (slides-core.js), PowerPoint import, the demo
// seed (web/scripts/demo-seed.mjs) and the server's headless engine
// (src/headless/), so it touches neither the DOM nor storage.
//
// Shape of the shared document:
//   meta   : { theme, transition }
//   slides : id -> { pos, layout, bg, notes (text), els: id -> element }
//   element: { type: box|image|line, geometry, style, z, text (rich text) }
import * as Y from 'yjs'
import { newId } from '../lib/util.js'
import { layouts, between } from './slides-model.js'
import { textJSON, textPlain, fillText, isBlank } from './slides-text.js'

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

// seedDeck gives an empty deck its first slide. The ids are fixed, so two
// devices doing this at the same moment end up with one slide, not two.
export function seedDeck(ydoc) {
  const slides = ydoc.getMap('slides'), meta = ydoc.getMap('meta')
  ydoc.transact(() => {
    if (!meta.get('theme')) meta.set('theme', 'paper')
    if (!slides.has('first')) writeSlide(slides, 'first', 1, { layout: 'title', els: layoutEls('title').map((e, i) => ({ ...e, id: 'first' + i })) })
  }, SEED)
}

// --- reading the whole deck ------------------------------------------------------

export const slideOrder = (slides) => [...slides.entries()].map(([id, m]) => ({ id, pos: m.get('pos') || 0 }))
  .sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1)).map((s) => s.id)

// elsOf lists a slide's elements from back to front.
export function elsOf(slide) {
  const m = slide?.get('els')
  if (!m) return []
  return [...m.values()].map(readEl).sort((a, b) => (a.z || 0) - (b.z || 0) || (a.id < b.id ? -1 : 1))
}

// deckText is the deck as words only, slide by slide with its notes: what a
// search index wants.
export function deckText(slides) {
  return slideOrder(slides).map((id) => {
    const s = slides.get(id)
    return [...elsOf(s).filter((e) => e.type === 'box').map((e) => textPlain(e.text)), s.get('notes')?.toString() || ''].filter(Boolean).join('\n')
  }).filter(Boolean).join('\n\n')
}

// deckJSON is the whole deck as plain data (export, presenting).
export function deckJSON(slides, meta) {
  return { theme: meta.get('theme') || 'paper', transition: meta.get('transition') || 'fade', slides: slideOrder(slides).map((id) => ({ id, ...slideJSON(slides.get(id)) })) }
}

// --- changes that do not depend on what is on screen -------------------------------

// placeSlides puts the given slides, in order, after the first `before` of
// the slides that stay where they are, by giving them new sort keys.
export function placeSlides(slides, ids, before) {
  const rest = slideOrder(slides).filter((id) => !ids.includes(id))
  let a = slides.get(rest[before - 1])?.get('pos') ?? null
  const b = slides.get(rest[before])?.get('pos') ?? null
  for (const id of ids) {
    a = between(a, b)
    slides.get(id).set('pos', a)
  }
}

// removeSlides deletes slides; a deck is never left without one.
export function removeSlides(slides, ids) {
  for (const id of ids) slides.delete(id)
  if (slides.size === 0) writeSlide(slides, newId(10), 1, { layout: 'titleBody', els: layoutEls('titleBody') })
}

// relayout rearranges a slide: boxes that play a part move to their new
// places, missing ones appear, and empty ones that no longer fit go.
export function relayout(slide, layout) {
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
}

// retype makes a shared text read `text` by changing only the part that
// differs, so a colleague typing elsewhere in it loses nothing.
export function retype(y, text) {
  const old = y.toString()
  let a = 0
  while (a < old.length && a < text.length && old[a] === text[a]) a++
  let b = 0
  while (b < old.length - a && b < text.length - a && old[old.length - 1 - b] === text[text.length - 1 - b]) b++
  if (old.length - a - b > 0) y.delete(a, old.length - a - b)
  if (text.length - a - b > 0) y.insert(a, text.slice(a, text.length - b))
}
