// The document format itself: what a past version needs to be shown as well
// as what the live editor needs. Kept free of the DOM so the demo seed
// (web/scripts/demo-seed.mjs) builds documents from the same schema, and the
// server's headless engine (src/headless/) reads and writes them with it.
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Review } from './doc-marks.js'
import { layoutExtensions, INDENT_PX } from './doc-layout.js'
import { pageMeta, printCSS } from './doc-page.js'

export function formatExtensions(who) {
  return [
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true } }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    Highlight.configure({ multicolor: true }),
    TextStyle, Color, FontFamily, FontSize,
    TaskList, TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    ...layoutExtensions(),
    Review.configure({ user: () => who }),
  ]
}

// The fonts on offer: ones every computer has, or an equivalent of.
export const fonts = [
  ['', 'Default'],
  ['Arial, Helvetica, sans-serif', 'Arial'],
  ['Georgia, serif', 'Georgia'],
  ['"Times New Roman", Times, serif', 'Times New Roman'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
  ['"Trebuchet MS", sans-serif', 'Trebuchet MS'],
  ['Garamond, "EB Garamond", serif', 'Garamond'],
  ['"Courier New", Courier, monospace', 'Courier New'],
]
export const fontSizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72]

// docText is the document as plain text, for the search index.
export const docText = (doc) => doc.textBetween(0, doc.content.size, '\n', ' ')

// readingCopy parses the editor's HTML into the form a downloaded copy reads
// as: every suggestion accepted, and none of the app's own markup for
// comments and suggestions. It needs a DOMParser (the browser's, or the
// engine's in src/headless/dom.js).
export function readingCopy(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of doc.querySelectorAll('del.sug-del')) el.remove()
  for (const el of doc.querySelectorAll('ins.sug-ins, span.cmt, span.sug-fmt')) el.replaceWith(...el.childNodes)
  return doc
}

// --- Files -----------------------------------------------------------------
// Word and OpenDocument files are made by pandoc, which keeps no colours,
// fonts or spacing of its own. exportCopy names each combination of them as
// a style ("OS_c-c0392b_f-Georgia_s-14"), which pandoc does carry, and the
// server gives those styles their formatting (server/docexport.go). A file
// that comes back carries the same names, and importCopy turns them back
// into formatting.

const hex = (c) => {
  if (!c) return ''
  const s = c.trim().toLowerCase()
  let m = /^#([0-9a-f]{6})$/.exec(s)
  if (m) return m[1]
  m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) return m[1].split('').map((x) => x + x).join('')
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s)
  if (m) return [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('')
  return ''
}
const firstFont = (f) => (f || '').split(',')[0].replace(/["']/g, '').trim().replace(/[^A-Za-z0-9 ]/g, '')
const points = (s) => {
  const m = /^(\d+(?:\.\d+)?)(pt|px)$/.exec((s || '').trim())
  if (!m) return 0
  const v = m[2] === 'pt' ? +m[1] : +m[1] * 0.75
  return Math.round(v * 2) / 2
}

export function styleName(f) {
  const parts = []
  if (f.c) parts.push('c-' + f.c)
  if (f.h) parts.push('h-' + f.h)
  if (f.f) parts.push('f-' + f.f.replace(/ /g, '.'))
  if (f.s) parts.push('s-' + f.s)
  if (f.lh) parts.push('lh-' + f.lh)
  if (f.in) parts.push('in-' + f.in)
  if (f.al) parts.push('al-' + f.al)
  return parts.length ? 'OS_' + parts.join('_') : ''
}

export function parseStyleName(name) {
  const out = {}
  if (!/^OS_/.test(name || '')) return out
  for (const part of name.slice(3).split('_')) {
    const m = /^(c|h|f|s|lh|in|al)-(.+)$/.exec(part)
    if (!m) continue
    const [, k, v] = m
    if ((k === 'c' || k === 'h') && /^[0-9a-f]{6}$/i.test(v)) out[k] = v.toLowerCase()
    else if (k === 'f') out.f = v.replace(/\./g, ' ').replace(/[^A-Za-z0-9 ]/g, '')
    else if (k === 's' && +v > 0 && +v <= 400) out.s = +v
    else if (k === 'lh' && +v > 0 && +v <= 4) out.lh = +v
    else if (k === 'in' && +v > 0 && +v <= 8) out.in = Math.round(+v)
    else if (k === 'al' && ['left', 'center', 'right', 'justify'].includes(v)) out.al = v
  }
  return out
}

const blockFormat = (el) => {
  const f = {}
  const lh = parseFloat(el.style.lineHeight || '')
  if (lh > 0) f.lh = lh
  const ind = +(el.getAttribute('data-indent') || 0)
  if (ind > 0) f.in = ind
  const al = el.style.textAlign
  if (['center', 'right', 'justify'].includes(al)) f.al = al
  return f
}

function numberFootnotes(doc) {
  const refs = [...doc.querySelectorAll('sup[data-footnote]')]
  if (!refs.length) return
  const section = doc.createElement('section')
  section.className = 'footnotes'
  section.setAttribute('role', 'doc-endnotes')
  const ol = doc.createElement('ol')
  refs.forEach((sup, i) => {
    const n = i + 1
    const a = doc.createElement('a')
    a.href = '#fn' + n
    a.id = 'fnref' + n
    a.className = 'footnote-ref'
    a.setAttribute('role', 'doc-noteref')
    const s = doc.createElement('sup')
    s.textContent = String(n)
    a.append(s)
    const li = doc.createElement('li')
    li.id = 'fn' + n
    const p = doc.createElement('p')
    p.textContent = sup.getAttribute('data-footnote') || ''
    const back = doc.createElement('a')
    back.href = '#fnref' + n
    back.className = 'footnote-back'
    back.setAttribute('role', 'doc-backlink')
    back.textContent = '↩︎'
    p.append(back)
    li.append(p)
    ol.append(li)
    sup.replaceWith(a)
  })
  section.append(ol)
  doc.body.append(section)
}

function fillContents(doc, styles) {
  const navs = [...doc.querySelectorAll('nav[data-toc]')]
  if (!navs.length) return
  const used = new Set()
  const items = []
  for (const h of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const text = h.textContent.trim()
    if (!text) continue
    if (!h.id) {
      const base = 'h-' + (text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x')
      let id = base
      for (let i = 2; used.has(id) || doc.getElementById(id); i++) id = base + '-' + i
      h.id = id
    }
    used.add(h.id)
    items.push({ level: +h.tagName[1], text, id: h.id })
  }
  for (const nav of navs) {
    nav.replaceChildren()
    const title = doc.createElement('p')
    title.innerHTML = '<strong>Contents</strong>'
    nav.append(title)
    for (const it of items) {
      const p = doc.createElement('p')
      if (it.level > 1) p.style.marginLeft = (it.level - 1) * 18 + 'pt'
      const a = doc.createElement('a')
      a.href = '#' + it.id
      a.textContent = it.text
      p.append(a)
      nav.append(p)
    }
    // pandoc reads a <nav> as a plain block of its contents; as a style the
    // contents come back from Word as contents.
    const div = doc.createElement('div')
    div.className = 'toc'
    if (styles) div.setAttribute('data-custom-style', 'OS_Contents')
    div.append(...nav.childNodes)
    nav.replaceWith(div)
  }
}

// exportCopy is the HTML a downloaded file is made from. target is 'word'
// (Word and OpenDocument, through pandoc), 'html' (a web page) or
// 'markdown'.
export function exportCopy(html, { page, title = 'Untitled', target = 'word' } = {}) {
  const doc = readingCopy(html)
  const styles = target === 'word'
  numberFootnotes(doc)
  for (const el of doc.querySelectorAll('div[data-page-break]')) {
    if (target === 'markdown') {
      el.remove()
      continue
    }
    const div = doc.createElement('div')
    if (styles) {
      div.setAttribute('data-custom-style', 'OS_PageBreak')
      div.innerHTML = '<p>​</p>'
    } else div.style.breakAfter = 'page'
    el.replaceWith(div)
  }
  // Ids for headings first: the formatting of a heading travels in its id
  // (see below), and the contents link to the ids.
  if (styles) {
    let n = 0
    for (const h of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const name = styleName(blockFormat(h))
      if (name) h.id = 'h' + ++n + '-' + name
    }
  }
  fillContents(doc, styles)
  if (styles) {
    for (const el of doc.querySelectorAll('span[style], mark')) {
      const f = {}
      const c = hex(el.style.color)
      if (c && el.tagName !== 'MARK') f.c = c
      const h = hex(el.getAttribute('data-color') || el.style.backgroundColor)
      if (h) f.h = h
      if (el.tagName === 'MARK' && !f.h) f.h = 'ffff00'
      const font = firstFont(el.style.fontFamily)
      if (font) f.f = font
      const pt = points(el.style.fontSize)
      if (pt) f.s = pt
      const name = styleName(f)
      if (!name) continue
      const span = doc.createElement('span')
      span.setAttribute('data-custom-style', name)
      span.append(...el.childNodes)
      el.replaceWith(span)
    }
    // pandoc keeps a paragraph style from a <div> around the paragraph, and
    // drops one on a heading; a heading's goes in its id, which becomes a
    // bookmark the server finds.
    for (const p of doc.querySelectorAll('p[style], p[data-indent]')) {
      const name = styleName(blockFormat(p))
      if (!name) continue
      const div = doc.createElement('div')
      div.setAttribute('data-custom-style', name)
      p.replaceWith(div)
      div.append(p)
    }
  }
  for (const img of doc.querySelectorAll('img')) {
    const w = img.style.width
    if (w) img.setAttribute('width', w)
  }
  let head = `<meta charset="utf-8"><title>${title.replace(/[<&]/g, '')}</title>`
  if (page) head += pageMeta(page) + (target === 'html' ? `<style>${printCSS(page, title).replace(/</g, '\\3c ')}</style>` : '')
  return `<!doctype html><html><head>${head}</head><body>${doc.body.innerHTML}</body></html>`
}

// importCopy turns a converted file (Word or OpenDocument through pandoc)
// into HTML the editor reads, with any formatting exportCopy wrote put back.
export function importCopy(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of doc.querySelectorAll('[data-custom-style]')) {
    const name = el.getAttribute('data-custom-style')
    if (name === 'OS_PageBreak' || name === 'OS_Contents') {
      const node = doc.createElement(name === 'OS_Contents' ? 'nav' : 'div')
      node.setAttribute(name === 'OS_Contents' ? 'data-toc' : 'data-page-break', '')
      el.replaceWith(node)
      continue
    }
    const f = parseStyleName(name)
    if (el.tagName === 'SPAN') {
      if (f.h) {
        const mark = doc.createElement('mark')
        mark.setAttribute('data-color', '#' + f.h)
        mark.style.backgroundColor = '#' + f.h
        el.before(mark)
        mark.append(el)
      }
      const style = []
      if (f.c) style.push('color: #' + f.c)
      if (f.f) style.push(`font-family: ${fontFor(f.f)}`)
      if (f.s) style.push(`font-size: ${f.s}pt`)
      if (style.length) {
        const span = doc.createElement('span')
        span.setAttribute('style', style.join('; '))
        span.append(...el.childNodes)
        el.replaceWith(span)
      } else el.replaceWith(...el.childNodes)
      continue
    }
    for (const p of el.querySelectorAll('p')) applyBlock(p, f)
    el.replaceWith(...el.childNodes)
  }
  for (const h of doc.querySelectorAll('h1[id*="-OS_"], h2[id*="-OS_"], h3[id*="-OS_"], h4[id*="-OS_"], h5[id*="-OS_"], h6[id*="-OS_"]')) {
    applyBlock(h, parseStyleName(h.id.slice(h.id.indexOf('-OS_') + 1)))
  }
  return doc.body.innerHTML
}

function applyBlock(el, f) {
  if (f.lh) el.style.lineHeight = String(f.lh)
  if (f.in) {
    el.setAttribute('data-indent', String(f.in))
    el.style.marginLeft = f.in * INDENT_PX + 'px'
  }
  if (f.al) el.style.textAlign = f.al
}

const fontFor = (name) => fonts.find(([, label]) => label === name)?.[0] || `"${name}"`
