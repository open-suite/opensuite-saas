// PowerPoint in and out. This file loads only when someone exports or
// imports, so its weight (a zip reader and a .pptx writer) never touches
// opening or editing a deck.
//
// Out: every slide becomes native PowerPoint text, shapes, lines and pictures
// that stay editable there. In: text, pictures, basic shapes, lines and notes
// are read; charts, tables, SmartArt, animations and master artwork are not.
import PptxGen from 'pptxgenjs'
import JSZip from 'jszip'
import * as Y from 'yjs'
import { W, H, themeOf, fonts, fontKey, slideColors, decor, resolve, roleStyle, textColor, textPad, isShape } from './slides-model.js'
import { buildDeck, keepWarm, uploadImage } from './slides-core.js'

const IN = 96 // slide units per inch
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.slice(1).toUpperCase() : null)

// --- out ----------------------------------------------------------------------

function runOptions(marks = []) {
  const o = {}
  for (const m of marks) {
    if (m.type === 'bold') o.bold = true
    else if (m.type === 'italic') o.italic = true
    else if (m.type === 'underline') o.underline = { style: 'sng' }
    else if (m.type === 'strike') o.strike = 'sngStrike'
    else if (m.type === 'link' && m.attrs?.href) o.hyperlink = { url: m.attrs.href }
    else if (m.type === 'textStyle') {
      if (hex(m.attrs?.color)) o.color = hex(m.attrs.color)
      if (parseFloat(m.attrs?.fontSize)) o.fontSize = Math.round(parseFloat(m.attrs.fontSize) * 0.75 * 10) / 10
      if (fontKey(m.attrs?.fontFamily)) o.fontFace = fonts[fontKey(m.attrs.fontFamily)].office
    }
  }
  return o
}

// textRuns flattens rich text into the runs PowerPoint wants, one paragraph
// after another, lists as bulleted or numbered paragraphs.
function textRuns(content, align) {
  const paras = []
  const walk = (nodes, list, level) => {
    for (const n of nodes || []) {
      if (n.type === 'paragraph') {
        const opts = { align: n.attrs?.textAlign || align }
        if (list) Object.assign(opts, { bullet: list === 'ordered' ? { type: 'number' } : true, indentLevel: level })
        const runs = []
        let soft = false
        for (const c of n.content || []) {
          if (c.type === 'hardBreak') soft = true
          else if (c.type === 'text' && c.text) {
            runs.push({ text: c.text, options: { ...opts, ...runOptions(c.marks), ...(soft ? { softBreakBefore: true } : {}) } })
            soft = false
          }
        }
        if (!runs.length) runs.push({ text: '', options: opts })
        paras.push(runs)
      } else if (n.type === 'bulletList' || n.type === 'orderedList') {
        for (const item of n.content || []) walk(item.content, n.type === 'orderedList' ? 'ordered' : 'bullet', list ? level + 1 : 0)
      }
    }
  }
  walk(content, null, 0)
  paras.forEach((runs, i) => i < paras.length - 1 && (runs[runs.length - 1].options.breakLine = true))
  return paras.flat()
}

async function imageData(src) {
  const blob = await (await fetch(src)).blob()
  const data = await new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.readAsDataURL(blob)
  })
  const size = await new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = data
  })
  return { data, size }
}

// deckToPptx turns Deck.toJSON() into a .pptx file.
export async function deckToPptx(deck, title) {
  const pptx = new PptxGen()
  pptx.layout = 'LAYOUT_WIDE' // 13.33 × 7.5 inches: our 1280 × 720 at 96 per inch
  pptx.title = title || 'Untitled'
  const theme = themeOf(deck.theme)
  const face = fonts[theme.font].office
  pptx.theme = { headFontFace: face, bodyFontFace: face }

  for (const s of deck.slides) {
    const slide = pptx.addSlide()
    const colors = slideColors(theme, s.layout, s.bg)
    slide.background = { color: hex(colors.bg) }
    for (const d of decor(s.layout, colors)) {
      slide.addShape('roundRect', { x: d.x / IN, y: d.y / IN, w: d.w / IN, h: d.h / IN, rectRadius: d.r / IN, fill: { color: hex(d.fill) }, line: { type: 'none' } })
    }
    for (const e of s.els) {
      if (e.type === 'line') {
        let a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 }, swapped = false
        if (a.x > b.x) [a, b, swapped] = [b, a, true]
        const arrow = e.head === 'end' || e.head === 'both'
        slide.addShape('line', {
          x: a.x / IN, y: Math.min(a.y, b.y) / IN, w: (b.x - a.x) / IN, h: Math.abs(b.y - a.y) / IN, flipV: b.y < a.y,
          line: {
            color: hex(resolve(colors, e.stroke) || colors.ink), width: (e.sw || 4) * 0.75,
            endArrowType: (arrow && !swapped) || e.head === 'both' ? 'triangle' : 'none',
            beginArrowType: (arrow && swapped) || e.head === 'both' ? 'triangle' : 'none',
          },
        })
      } else if (e.type === 'image') {
        if (!e.src) continue
        try {
          const { data, size } = await imageData(e.src)
          const frame = { x: e.x / IN, y: e.y / IN, w: e.w / IN, h: e.h / IN }
          const natural = size ? { w: frame.w, h: (frame.w * size.h) / size.w } : frame
          slide.addImage({ data, x: frame.x, y: frame.y, w: natural.w, h: natural.h, rotate: e.rot || 0, altText: e.alt || 'Picture', sizing: { type: 'cover', w: frame.w, h: frame.h } })
        } catch {}
      } else {
        const r = roleStyle(s.layout, e)
        const [py, px] = textPad(e)
        const fill = resolve(colors, e.fill), stroke = e.sw === 0 ? null : resolve(colors, e.stroke)
        const opts = {
          x: e.x / IN, y: e.y / IN, w: e.w / IN, h: e.h / IN, rotate: e.rot || 0,
          fontSize: r.size * 0.75, bold: r.weight >= 600, color: hex(textColor(e, s.layout, colors)), fontFace: face,
          valign: e.valign === 'middle' || (!e.valign && isShape(e)) ? 'middle' : e.valign === 'bottom' ? 'bottom' : 'top',
          margin: [px * 0.75, px * 0.75, py * 0.75, py * 0.75], lineSpacingMultiple: r.lh, fit: 'none', wrap: true,
        }
        if (fill) opts.fill = { color: hex(fill) }
        if (stroke) opts.line = { color: hex(stroke), width: (e.sw || 2) * 0.75 }
        if (isShape(e)) {
          opts.shape = e.shape === 'ellipse' ? 'ellipse' : e.shape === 'round' ? 'roundRect' : 'rect'
          if (e.shape === 'round') opts.rectRadius = 20 / IN
        } else opts.isTextBox = true
        const runs = textRuns(e.text, r.align || 'left')
        if (!runs.length && !isShape(e) && !fill && !stroke) continue
        slide.addText(runs.length ? runs : [{ text: '', options: {} }], opts)
      }
    }
    if (s.notes) slide.addNotes(s.notes)
  }
  return pptx.write({ outputType: 'blob' })
}

// --- in ------------------------------------------------------------------------

const EMU = 9525 // units of a .pptx file per slide unit
const xml = (s) => new DOMParser().parseFromString(s, 'application/xml')
const kids = (n, name) => (n ? [...n.children].filter((c) => c.nodeName === name) : [])
const kid = (n, ...names) => names.reduce((x, name) => (x ? [...x.children].find((c) => c.nodeName === name) || null : null), n)
const attr = (n, a, d = 0) => (n?.hasAttribute(a) ? Number(n.getAttribute(a)) : d)

function mixTo(c, to, t) {
  const a = parseInt(c.slice(1), 16), b = parseInt(to.slice(1), 16)
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t)
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')
}

// colorOf reads the colour inside a fill, with the common lighter and darker
// adjustments.
function colorOf(node, ctx) {
  if (!node) return null
  const tag = [...node.children].find((c) => ['a:srgbClr', 'a:schemeClr', 'a:sysClr', 'a:prstClr'].includes(c.nodeName))
  if (!tag) return null
  let c = null
  if (tag.nodeName === 'a:srgbClr') c = '#' + tag.getAttribute('val').toLowerCase()
  else if (tag.nodeName === 'a:sysClr') c = '#' + (tag.getAttribute('lastClr') || '000000').toLowerCase()
  else if (tag.nodeName === 'a:prstClr') c = { black: '#000000', white: '#ffffff', red: '#ff0000', blue: '#0000ff', green: '#008000', gray: '#808080' }[tag.getAttribute('val')] || null
  else {
    const v = tag.getAttribute('val')
    c = ctx.scheme[ctx.map[v] || v] || null
  }
  if (!c || !/^#[0-9a-f]{6}$/.test(c)) return null
  const mod = kid(tag, 'a:lumMod'), off = kid(tag, 'a:lumOff'), tint = kid(tag, 'a:tint'), shade = kid(tag, 'a:shade')
  if (off) c = mixTo(c, '#ffffff', attr(off, 'val') / 100000)
  else if (mod && attr(mod, 'val') < 100000) c = mixTo(c, '#000000', 1 - attr(mod, 'val') / 100000)
  if (tint) c = mixTo(c, '#ffffff', 1 - attr(tint, 'val') / 100000)
  if (shade) c = mixTo(c, '#000000', 1 - attr(shade, 'val') / 100000)
  return c
}

function join(dir, target) {
  if (target.startsWith('/')) return target.slice(1)
  const parts = dir.split('/')
  for (const p of target.split('/')) {
    if (p === '..') parts.pop()
    else if (p !== '.') parts.push(p)
  }
  return parts.join('/')
}

const mimes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }

// pptxToDeck reads a .pptx file into plain deck data. `upload` stores a
// picture and resolves to its address.
export async function pptxToDeck(file, upload) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer())
  const read = async (path) => {
    const f = zip.file(path)
    return f ? xml(await f.async('string')) : null
  }
  const rels = async (path) => {
    const i = path.lastIndexOf('/')
    const doc = await read(`${path.slice(0, i)}/_rels/${path.slice(i + 1)}.rels`)
    const out = {}
    for (const r of doc ? doc.getElementsByTagName('Relationship') : []) {
      const external = r.getAttribute('TargetMode') === 'External'
      out[r.getAttribute('Id')] = { type: r.getAttribute('Type').split('/').pop(), target: external ? r.getAttribute('Target') : join(path.slice(0, i), r.getAttribute('Target')), external }
    }
    return out
  }

  const pres = await read('ppt/presentation.xml')
  if (!pres) throw new Error('That file is not a PowerPoint presentation.')
  const presRels = await rels('ppt/presentation.xml')
  const size = pres.getElementsByTagName('p:sldSz')[0]
  const cx = attr(size, 'cx', 12192000), cy = attr(size, 'cy', 6858000)
  const k = Math.min(W / cx, H / cy)
  const root = { sx: k, sy: k, dx: (W - cx * k) / 2, dy: (H - cy * k) / 2 }

  const scheme = {}
  const themePath = Object.values(presRels).find((r) => r.type === 'theme')?.target
  const themeDoc = themePath && (await read(themePath))
  for (const c of themeDoc ? kid(themeDoc.documentElement, 'a:themeElements', 'a:clrScheme')?.children || [] : []) {
    const v = c.firstElementChild
    if (v) scheme[c.nodeName.slice(2)] = '#' + (v.getAttribute('val') || v.getAttribute('lastClr') || '000000').toLowerCase()
  }
  const ctx = { scheme, map: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' } }

  const cache = new Map()
  const part = async (path) => {
    if (!cache.has(path)) cache.set(path, { doc: await read(path), rels: await rels(path) })
    return cache.get(path)
  }
  const uploaded = new Map()
  const picture = async (path) => {
    if (!uploaded.has(path)) {
      const ext = path.split('.').pop().toLowerCase()
      const f = zip.file(path)
      uploaded.set(path, f && mimes[ext] ? upload(new File([await f.async('blob')], path.split('/').pop(), { type: mimes[ext] })).catch(() => null) : null)
    }
    return uploaded.get(path)
  }

  const frameOf = (xf, t) => {
    if (!xf) return null
    const off = kid(xf, 'a:off'), ext = kid(xf, 'a:ext')
    return {
      x: attr(off, 'x') * t.sx + t.dx, y: attr(off, 'y') * t.sy + t.dy, w: attr(ext, 'cx') * t.sx, h: attr(ext, 'cy') * t.sy,
      rot: Math.round(attr(xf, 'rot') / 60000), flipH: xf.getAttribute('flipH') === '1', flipV: xf.getAttribute('flipV') === '1',
    }
  }
  const holder = (sp) => kid(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph') || kid(sp, 'p:nvPicPr', 'p:nvPr', 'p:ph')
  const sameHolder = (ph, other) => {
    if (!other) return false
    const t = (x) => ({ ctrTitle: 'title', obj: 'body', subTitle: 'body' })[x.getAttribute('type')] || x.getAttribute('type') || 'body'
    if (ph.hasAttribute('idx') && other.hasAttribute('idx')) return ph.getAttribute('idx') === other.getAttribute('idx')
    return t(ph) === t(other)
  }
  const inherited = (ph, docs) => {
    for (const d of docs) {
      const tree = d && kid(d.documentElement, 'p:cSld', 'p:spTree')
      const match = kids(tree, 'p:sp').find((sp) => sameHolder(ph, holder(sp)))
      if (match) return match
    }
    return null
  }

  const paragraphsOf = (body, rel, opts) => {
    const paras = []
    for (const p of kids(body, 'a:p')) {
      const pPr = kid(p, 'a:pPr')
      const algn = { l: 'left', ctr: 'center', r: 'right', just: 'left' }[pPr?.getAttribute('algn')] || null
      const content = []
      for (const r of p.children) {
        if (r.nodeName === 'a:br') content.push({ type: 'hardBreak' })
        if (r.nodeName !== 'a:r' && r.nodeName !== 'a:fld') continue
        const text = kid(r, 'a:t')?.textContent || ''
        if (!text) continue
        const rPr = kid(r, 'a:rPr')
        const marks = []
        if (rPr?.getAttribute('b') === '1') marks.push({ type: 'bold' })
        if (rPr?.getAttribute('i') === '1') marks.push({ type: 'italic' })
        if (rPr?.hasAttribute('u') && rPr.getAttribute('u') !== 'none') marks.push({ type: 'underline' })
        if (rPr?.hasAttribute('strike') && rPr.getAttribute('strike') !== 'noStrike') marks.push({ type: 'strike' })
        const style = {}
        const col = colorOf(kid(rPr, 'a:solidFill'), ctx)
        if (col) style.color = col
        if (rPr?.hasAttribute('sz')) style.fontSize = Math.round((attr(rPr, 'sz') / 100) * (96 / 72) * k * EMU) + 'px'
        if (Object.keys(style).length) marks.push({ type: 'textStyle', attrs: style })
        const link = rel[kid(rPr, 'a:hlinkClick')?.getAttribute('r:id')]
        if (link?.external && /^https?:|^mailto:/i.test(link.target)) marks.push({ type: 'link', attrs: { href: link.target } })
        content.push({ type: 'text', text, ...(marks.length ? { marks } : {}) })
      }
      while (content.length && content[content.length - 1].type === 'hardBreak') content.pop()
      const auto = kid(pPr, 'a:buAutoNum'), char = kid(pPr, 'a:buChar'), none = kid(pPr, 'a:buNone')
      const list = !content.length || none ? null : auto ? 'ordered' : char || opts.bullets ? 'bullet' : null
      paras.push({ list, level: attr(pPr, 'lvl'), node: { type: 'paragraph', ...(algn ? { attrs: { textAlign: algn } } : {}), ...(content.length ? { content } : {}) } })
    }
    while (paras.length && !paras[paras.length - 1].node.content) paras.pop()
    const out = []
    let i = 0
    const build = (level, kind) => {
      const list = { type: kind === 'ordered' ? 'orderedList' : 'bulletList', content: [] }
      while (i < paras.length && paras[i].list && paras[i].level >= level) {
        if (paras[i].level > level) {
          const sub = build(paras[i].level, paras[i].list)
          const last = list.content[list.content.length - 1]
          if (last) last.content.push(sub)
          else list.content.push({ type: 'listItem', content: [{ type: 'paragraph' }, sub] })
        } else if (paras[i].list !== kind) break
        else list.content.push({ type: 'listItem', content: [paras[i++].node] })
      }
      return list
    }
    while (i < paras.length) out.push(paras[i].list ? build(paras[i].level, paras[i].list) : paras[i++].node)
    return out
  }

  const order = kids(kid(pres.documentElement, 'p:sldIdLst'), 'p:sldId').map((s) => presRels[s.getAttribute('r:id')]?.target).filter(Boolean)
  const slides = []
  let skipped = 0
  for (const path of order) {
    const { doc, rels: rel } = await part(path)
    if (!doc) continue
    const layoutPath = Object.values(rel).find((r) => r.type === 'slideLayout')?.target
    const layout = layoutPath ? await part(layoutPath) : null
    const masterPath = layout && Object.values(layout.rels).find((r) => r.type === 'slideMaster')?.target
    const master = masterPath ? await part(masterPath) : null
    const parents = [layout?.doc, master?.doc]
    const bodyBullets = !!kid(master?.doc?.documentElement, 'p:txStyles', 'p:bodyStyle', 'a:lvl1pPr', 'a:buChar')

    let bg = null
    for (const d of [doc, ...parents]) {
      bg = d && colorOf(kid(d.documentElement, 'p:cSld', 'p:bg', 'p:bgPr', 'a:solidFill'), ctx)
      if (bg) break
    }
    const els = []
    const walk = async (tree, t) => {
      for (const n of tree.children) {
        if (n.nodeName === 'p:grpSp') {
          const xf = kid(n, 'p:grpSpPr', 'a:xfrm')
          const off = kid(xf, 'a:off'), ext = kid(xf, 'a:ext'), cho = kid(xf, 'a:chOff'), che = kid(xf, 'a:chExt')
          const gx = attr(che, 'cx') ? attr(ext, 'cx') / attr(che, 'cx') : 1, gy = attr(che, 'cy') ? attr(ext, 'cy') / attr(che, 'cy') : 1
          await walk(n, { sx: t.sx * gx, sy: t.sy * gy, dx: t.dx + t.sx * (attr(off, 'x') - attr(cho, 'x') * gx), dy: t.dy + t.sy * (attr(off, 'y') - attr(cho, 'y') * gy) })
        } else if (n.nodeName === 'p:pic') {
          const f = frameOf(kid(n, 'p:spPr', 'a:xfrm'), t)
          const target = rel[kid(n, 'p:blipFill', 'a:blip')?.getAttribute('r:embed')]?.target
          const src = f && target ? await picture(target) : null
          if (src) els.push({ type: 'image', src, x: f.x, y: f.y, w: f.w, h: f.h, rot: f.rot })
          else skipped++
        } else if (n.nodeName === 'p:cxnSp' || (n.nodeName === 'p:sp' && ['line', 'straightConnector1'].includes(kid(n, 'p:spPr', 'a:prstGeom')?.getAttribute('prst')))) {
          const f = frameOf(kid(n, 'p:spPr', 'a:xfrm'), t)
          if (!f) continue
          const ln = kid(n, 'p:spPr', 'a:ln')
          let a = { x: f.flipH ? f.x + f.w : f.x, y: f.flipV ? f.y + f.h : f.y }, b = { x: f.flipH ? f.x : f.x + f.w, y: f.flipV ? f.y : f.y + f.h }
          const arrow = (e) => !!e && (e.getAttribute('type') || 'none') !== 'none'
          const start = arrow(kid(ln, 'a:headEnd')), end = arrow(kid(ln, 'a:tailEnd'))
          if (start && !end) [a, b] = [b, a]
          els.push({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: colorOf(kid(ln, 'a:solidFill'), ctx) || 'ink', sw: Math.max(1, Math.round(attr(ln, 'w', 12700) / EMU)), head: start && end ? 'both' : start || end ? 'end' : 'none' })
        } else if (n.nodeName === 'p:sp') {
          const ph = holder(n)
          const kind = ph ? ph.getAttribute('type') || 'body' : null
          if (['dt', 'ftr', 'sldNum', 'hdr'].includes(kind)) continue
          const up = ph ? inherited(ph, parents) : null
          const f = frameOf(kid(n, 'p:spPr', 'a:xfrm'), t) || frameOf(kid(up, 'p:spPr', 'a:xfrm'), root)
          if (!f) continue
          const sp = kid(n, 'p:spPr')
          const geom = kid(sp, 'a:prstGeom')?.getAttribute('prst')
          const box = kid(n, 'p:nvSpPr', 'p:cNvSpPr')?.getAttribute('txBox') === '1'
          let fill = kid(sp, 'a:noFill') ? null : colorOf(kid(sp, 'a:solidFill'), ctx)
          if (!fill && !kid(sp, 'a:noFill') && !box && !ph && kid(n, 'p:style', 'a:fillRef')) fill = colorOf(kid(n, 'p:style', 'a:fillRef'), ctx)
          const ln = kid(sp, 'a:ln')
          const stroke = ln && !kid(ln, 'a:noFill') ? colorOf(kid(ln, 'a:solidFill'), ctx) : null
          const body = kid(n, 'p:txBody')
          const anchor = kid(body, 'a:bodyPr')?.getAttribute('anchor') || kid(up, 'p:txBody', 'a:bodyPr')?.getAttribute('anchor')
          const role = { title: 'title', ctrTitle: 'title', subTitle: 'subtitle', body: 'body', obj: 'body' }[kind]
          const noBullets = !!kid(up, 'p:txBody', 'a:lstStyle', 'a:lvl1pPr', 'a:buNone')
          const text = body ? paragraphsOf(body, rel, { bullets: role === 'body' && bodyBullets && !noBullets }) : []
          // A rectangle with neither fill nor outline is a plain text box.
          const drawn = !!(fill || stroke)
          const shape = box || ph ? 'none' : geom === 'ellipse' ? 'ellipse' : geom === 'roundRect' ? 'round' : drawn ? 'rect' : 'none'
          if (ph && !text.length) continue
          if (!text.length && shape === 'none' && !fill && !stroke) {
            if (geom && geom !== 'rect') skipped++
            continue
          }
          els.push({
            type: 'box', shape, role, x: f.x, y: f.y, w: f.w, h: f.h, rot: f.rot, fill: fill || undefined, stroke: stroke || undefined,
            sw: stroke ? Math.max(1, Math.round(attr(ln, 'w', 12700) / EMU)) : undefined,
            valign: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : shape === 'none' ? 'top' : anchor === 't' ? 'top' : 'middle', text,
          })
        } else if (n.nodeName === 'p:graphicFrame') skipped++
      }
    }
    const tree = kid(doc.documentElement, 'p:cSld', 'p:spTree')
    if (tree) await walk(tree, root)
    for (const e of els) for (const key of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2']) if (e[key] !== undefined) e[key] = Math.round(e[key] * 10) / 10

    let notes = ''
    const notesPath = Object.values(rel).find((r) => r.type === 'notesSlide')?.target
    const notesDoc = notesPath && (await read(notesPath))
    for (const sp of notesDoc ? kids(kid(notesDoc.documentElement, 'p:cSld', 'p:spTree'), 'p:sp') : []) {
      if (holder(sp)?.getAttribute('type') !== 'body') continue
      notes = kids(kid(sp, 'p:txBody'), 'a:p').map((p) => [...p.getElementsByTagName('a:t')].map((x) => x.textContent).join('')).join('\n').trim()
    }
    slides.push({ layout: 'blank', bg: bg && bg !== '#ffffff' ? bg : null, notes, els })
  }
  if (!slides.length) throw new Error('That presentation has no slides.')
  return { theme: 'paper', slides, skipped }
}

function base64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

// importDeck makes a new presentation from a .pptx file and returns it,
// already stored on this device so that it opens at once. The caller hands
// in createDoc (lib/docs.js) so this file stays out of the start-up bundle's
// import graph.
export async function importDeck(file, title, createDoc) {
  const data = await pptxToDeck(file, uploadImage)
  const tmp = new Y.Doc()
  buildDeck(tmp, data)
  const state = Y.encodeStateAsUpdate(tmp)
  tmp.destroy()
  const { doc } = createDoc('slides', { title, snapshot: base64(state) })
  keepWarm(doc.id, state)
  return doc
}
