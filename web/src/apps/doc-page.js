// Page setup: paper size, orientation, margins, and the header and footer.
// It is a map in the shared document beside the text, so it syncs to
// everyone, is part of every version, and travels into Word and OpenDocument
// files (server/docexport.go reads it from exportCopy's <meta>).

export const papers = {
  a4: { label: 'A4', w: 210, h: 297 },
  letter: { label: 'Letter', w: 215.9, h: 279.4 },
  legal: { label: 'Legal', w: 215.9, h: 355.6 },
  a5: { label: 'A5', w: 148, h: 210 },
  a3: { label: 'A3', w: 297, h: 420 },
}

export const pageDefaults = {
  size: 'a4', orientation: 'portrait',
  top: 25.4, right: 25.4, bottom: 25.4, left: 25.4, // millimetres
  header: '', headerAlign: 'center', footer: '', footerAlign: 'center',
}

const ALIGNS = ['left', 'center', 'right']
const MAX_TEXT = 300

// cleanPage checks a page setup from outside (a person, the API, a file);
// what it cannot use it leaves out.
export function cleanPage(input) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  if (papers[input.size]) out.size = input.size
  if (input.orientation === 'portrait' || input.orientation === 'landscape') out.orientation = input.orientation
  for (const k of ['top', 'right', 'bottom', 'left']) {
    const v = Number(input[k])
    if (input[k] !== undefined && input[k] !== null && input[k] !== '' && Number.isFinite(v) && v >= 0 && v <= 100) out[k] = Math.round(v * 10) / 10
  }
  for (const k of ['header', 'footer']) if (typeof input[k] === 'string') out[k] = input[k].replace(/[\r\n]+/g, ' ').slice(0, MAX_TEXT)
  for (const k of ['headerAlign', 'footerAlign']) if (ALIGNS.includes(input[k])) out[k] = input[k]
  return out
}

export const pageMap = (ydoc) => ydoc.getMap('page')

export function readPage(ydoc) {
  return { ...pageDefaults, ...cleanPage(pageMap(ydoc).toJSON()) }
}

// setPage changes some settings; a setting given as its default is removed,
// so a document never set up stays empty.
export function setPage(ydoc, changes) {
  const m = pageMap(ydoc)
  const clean = cleanPage(changes)
  ydoc.transact(() => {
    for (const [k, v] of Object.entries(clean)) {
      if (v === pageDefaults[k]) m.delete(k)
      else if (m.get(k) !== v) m.set(k, v)
    }
  })
  return readPage(ydoc)
}

// adoptPage makes a document's page setup the one a past version had.
export function adoptPage(ydoc, from) {
  const was = pageMap(from)
  const m = pageMap(ydoc)
  ydoc.transact(() => {
    for (const k of [...m.keys()]) if (!was.has(k)) m.delete(k)
    for (const [k, v] of was.entries()) if (m.get(k) !== v) m.set(k, v)
  })
}

export function pageSize(p) {
  const paper = papers[p.size] || papers.a4
  return p.orientation === 'landscape' ? { w: paper.h, h: paper.w } : { w: paper.w, h: paper.h }
}

export const MM = 96 / 25.4 // screen pixels per millimetre

// fillTokens writes a header or footer for one page.
export function fillTokens(text, { page, pages, title }) {
  return text.replace(/\{(page|pages|title)\}/g, (_, k) => ({ page, pages, title }[k] ?? ''))
}

const cssString = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'

// marginContent turns header or footer text into CSS generated content, with
// the page number and count filled in by the printer.
function marginContent(text, title) {
  const parts = []
  let last = 0
  text.replace(/\{(page|pages|title)\}/g, (m, k, at) => {
    if (at > last) parts.push(cssString(text.slice(last, at)))
    parts.push(k === 'page' ? 'counter(page)' : k === 'pages' ? 'counter(pages)' : cssString(title))
    last = at + m.length
    return m
  })
  if (last < text.length) parts.push(cssString(text.slice(last)))
  return parts.join(' ') || '""'
}

const box = { left: 'left', center: 'center', right: 'right' }

// printCSS is the @page rule for printing and saving as PDF: the paper, its
// margins, and the header and footer in the margin boxes.
export function printCSS(p, title = '') {
  const { w, h } = pageSize(p)
  const font = 'font: 9pt system-ui, sans-serif; color: #555;'
  let rules = `size: ${w}mm ${h}mm; margin: ${p.top}mm ${p.right}mm ${p.bottom}mm ${p.left}mm;`
  if (p.header) rules += ` @top-${box[p.headerAlign] || 'center'} { content: ${marginContent(p.header, title)}; ${font} }`
  if (p.footer) rules += ` @bottom-${box[p.footerAlign] || 'center'} { content: ${marginContent(p.footer, title)}; ${font} }`
  return `@page { ${rules} }`
}

// pageMeta and pageFromHTML carry a page setup inside HTML, which is how it
// reaches the converter on export and comes back from it on import.
export function pageMeta(p) {
  const changed = {}
  for (const [k, v] of Object.entries(p)) if (v !== pageDefaults[k]) changed[k] = v
  return `<meta name="os-page" content="${JSON.stringify(changed).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}">`
}

export function pageFromHTML(html) {
  const m = /<meta name="os-page" content="([^"]*)"/.exec(html || '')
  if (!m) return null
  const named = { quot: '"', lt: '<', gt: '>', apos: "'", amp: '&' }
  const text = m[1].replace(/&(#x[0-9a-f]+|#\d+|quot|lt|gt|apos|amp);/gi, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : named[e.toLowerCase()])
  try {
    return cleanPage(JSON.parse(text))
  } catch {
    return null
  }
}
