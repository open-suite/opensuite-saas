// Presentations, read and changed through the same functions as the slides
// screen (apps/slides-data.js) and exported and imported by the same code
// (apps/slides-pptx.js).
import * as Y from 'yjs'
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap'
import { layouts, layoutIds, themeIds, between } from '../apps/slides-model.js'
import { textSchema, textPlain, textHTML, paragraphs } from '../apps/slides-text.js'
import {
  writeSlide, layoutEls, buildDeck, seedDeck, slideOrder, elsOf, deckText, deckJSON, placeSlides, removeSlides, relayout, retype,
} from '../apps/slides-doc.js'
import { deckToPptx, pptxToDeck } from '../apps/slides-pptx.js'
import { newId } from '../lib/util.js'
import { arg, oneOf, frames, openY, change, fromB64, toB64 } from './wire.js'
import { reuse, plainKey } from './reuse.js'

function open(args, fn) {
  const ydoc = openY(frames(args))
  try {
    return fn(ydoc, ydoc.getMap('slides'), ydoc.getMap('meta'))
  } finally {
    ydoc.destroy()
  }
}

// boxText is what plain text becomes in a box: a line per paragraph, and
// lines starting with "- " or "* " as a bulleted list.
function boxText(text) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    if (!bullet) {
      out.push(...paragraphs(line))
      continue
    }
    const item = { type: 'listItem', content: paragraphs(bullet[1]) }
    if (out[out.length - 1]?.type === 'bulletList') out[out.length - 1].content.push(item)
    else out.push({ type: 'bulletList', content: [item] })
  }
  return out
}

const layoutList = () => layoutIds.map((id) => `${id} (${layouts[id].name})`).join(', ')

function slideOf(slides, id) {
  const s = typeof id === 'string' && slides.get(id)
  if (!(s instanceof Y.Map)) throw new Error(`No slide ${JSON.stringify(id)} in this presentation`)
  return s
}

function positionOf(op, count) {
  const p = arg(op, 'position', 'integer', true) ?? count
  if (p < 1 || p > count) throw new Error(`position must be from 1 to ${count}`)
  return p
}

// A new slide is the layout's own boxes, with the title and body written
// into the parts the layout gives them (the body into its first text box
// that is not the title).
function newSlide(slides, op) {
  const layout = arg(op, 'layout', 'string', true) ?? 'titleBody'
  if (!layouts[layout]) throw new Error(`Unknown layout ${JSON.stringify(layout)}. The layouts are ${layoutList()}`)
  const id = arg(op, 'id', 'string', true) ?? newId(10)
  if (!id || slides.has(id)) throw new Error(`There is already a slide ${JSON.stringify(id)}`)
  const els = layoutEls(layout)
  const fill = (key, box, content) => {
    const text = arg(op, key, 'string', true)
    if (!text) return
    if (!box) throw new Error(`The ${layouts[layout].name} layout has no place for a ${key}`)
    box.text = content(text)
  }
  fill('title', els.find((e) => e.role === 'title'), (t) => paragraphs(...t.split(/\r?\n/)))
  fill('body', els.find((e) => e.type === 'box' && e.role !== 'title'), boxText)
  const order = slideOrder(slides)
  const at = positionOf(op, order.length + 1)
  const a = slides.get(order[at - 2])?.get('pos') ?? null
  const b = slides.get(order[at - 1])?.get('pos') ?? null
  writeSlide(slides, id, between(a, b), { layout, notes: arg(op, 'notes', 'string', true), els })
  return id
}

// setText makes a box say `text`, keeping every paragraph that stays the
// same as it is (formatting and a colleague's typing included).
function setText(ydoc, slide, op) {
  const id = arg(op, 'element', 'string')
  const el = slide.get('els').get(id)
  if (!(el instanceof Y.Map) || el.get('type') !== 'box') throw new Error(`No text box ${JSON.stringify(id)} on this slide`)
  const frag = el.get('text')
  const schema = textSchema()
  const { doc, meta } = initProseMirrorDoc(frag, schema)
  const next = schema.nodeFromJSON({ type: 'doc', content: boxText(arg(op, 'text', 'string')) })
  updateYFragment(ydoc, frag, schema.topNodeType.create(null, reuse(doc, next, plainKey)), meta)
}

function apply(ydoc, slides, meta, op, added) {
  switch (op.op) {
    case 'addSlide':
      added.push(newSlide(slides, op))
      return
    case 'setText':
      return setText(ydoc, slideOf(slides, op.slide), op)
    case 'setNotes':
      return retype(slideOf(slides, op.slide).get('notes'), arg(op, 'notes', 'string'))
    case 'setLayout': {
      const slide = slideOf(slides, op.slide)
      const layout = arg(op, 'layout', 'string')
      if (!layouts[layout]) throw new Error(`Unknown layout ${JSON.stringify(layout)}. The layouts are ${layoutList()}`)
      return relayout(slide, layout)
    }
    case 'moveSlide':
      slideOf(slides, op.slide)
      return placeSlides(slides, [op.slide], positionOf(op, slides.size) - 1)
    case 'deleteSlide':
      slideOf(slides, op.slide)
      return removeSlides(slides, [op.slide])
    case 'setTheme':
      return meta.set('theme', oneOf(op, 'theme', themeIds))
    default:
      throw new Error(`Unknown op ${JSON.stringify(op.op)}. The ops are addSlide, setText, setNotes, setLayout, moveSlide, deleteSlide, setTheme`)
  }
}

function elementJSON(e) {
  if (e.type !== 'box') return e
  return { ...e, text: textPlain(e.text), html: textHTML(e.text) }
}

export const slideOps = {
  'slides.read': (args) => open(args, (ydoc, slides, meta) => {
    const theme = meta.get('theme') || 'paper'
    if (!slides.size) return { theme, empty: true, slides: [] }
    return {
      theme,
      slides: slideOrder(slides).map((id, i) => {
        const s = slides.get(id)
        return {
          id, position: i + 1, layout: s.get('layout') || 'blank', ...(s.get('bg') ? { bg: s.get('bg') } : {}),
          notes: s.get('notes')?.toString() || '', elements: elsOf(s).map(elementJSON),
        }
      }),
    }
  }),

  // All ops apply in one change. A deck nobody has opened yet first gets
  // the first slide the editor gives it (fixed ids, so it is never doubled).
  'slides.write': (args) => {
    const ops = arg(args, 'ops', 'array')
    if (ops.some((op) => op === null || typeof op !== 'object')) throw new Error('ops must be an array of objects')
    return open(args, (ydoc, slides, meta) => {
      const added = []
      const update = change(ydoc, () => {
        if (!slides.size) seedDeck(ydoc)
        ops.forEach((op, i) => {
          try {
            apply(ydoc, slides, meta, op, added)
          } catch (e) {
            throw new Error(`ops[${i}] (${op.op}): ${e.message}`)
          }
        })
      })
      return { update, text: deckText(slides), added }
    })
  },

  'slides.pptx': (args, call) => {
    const title = arg(args, 'title', 'string', true)
    const deck = open(args, (ydoc, slides, meta) => deckJSON(slides, meta))
    // Pictures come from the server, which checks that each belongs to the
    // caller's organisation. One it does not supply is left out.
    const image = async (src) => {
      if (src.startsWith('data:')) return { data: src, size: null }
      const got = await call('blob', { src })
      if (!got?.data) throw new Error('No picture at ' + src)
      return { data: `data:${got.mime};base64,${got.data}`, size: got.w && got.h ? { w: got.w, h: got.h } : null }
    }
    return deckToPptx(deck, title, image).then(async (blob) => ({ pptx: toB64(new Uint8Array(await blob.arrayBuffer())) }))
  },

  'slides.fromPptx': async (args, call) => {
    const file = new File([fromB64(arg(args, 'pptx', 'string'))], 'presentation.pptx')
    const store = async (pic) => {
      const got = await call('store', { name: pic.name, mime: pic.type, data: toB64(new Uint8Array(await pic.arrayBuffer())) })
      if (!got?.url) throw new Error('The picture was not stored')
      return got.url
    }
    const data = await pptxToDeck(file, store)
    const ydoc = new Y.Doc()
    try {
      buildDeck(ydoc, data)
      return { snapshot: toB64(Y.encodeStateAsUpdate(ydoc)), text: deckText(ydoc.getMap('slides')), skipped: data.skipped }
    } finally {
      ydoc.destroy()
    }
  },
}
