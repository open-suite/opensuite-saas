// Layout in the document format: line spacing and indents on paragraphs and
// headings, page breaks, a table of contents, footnotes, and pictures that
// can be sized and wrapped. All of it lives in the shared document, so it
// syncs, versions and exports like the text does. Nothing here needs a
// browser to load (src/headless/ builds the schema from it); the node views
// only run where there is an editor on screen.
import { Extension, Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, NodeSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import Image from '@tiptap/extension-image'

export const lineHeights = [1, 1.15, 1.5, 2]
export const INDENT_PX = 36 // one indent step, half an inch at 96 dpi
const MAX_INDENT = 8

const lineHeightOf = (el) => {
  const v = parseFloat(el.style?.lineHeight || el.getAttribute('data-line-height') || '')
  return v > 0 && v <= 4 && !/px|em|%/.test(el.style?.lineHeight || '') ? v : null
}
const indentOf = (el) => {
  const n = parseInt(el.getAttribute('data-indent') || '', 10)
  if (n > 0) return Math.min(n, MAX_INDENT)
  const px = parseFloat(el.style?.marginLeft || '')
  return px > 0 && /px$/.test(el.style.marginLeft) ? Math.min(Math.round(px / INDENT_PX), MAX_INDENT) || null : null
}

// Paragraph and heading attributes: line spacing and indent.
export const Spacing = Extension.create({
  name: 'spacing',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: lineHeightOf,
          renderHTML: (a) => (a.lineHeight ? { style: `line-height: ${a.lineHeight}` } : {}),
        },
        indent: {
          default: null,
          parseHTML: indentOf,
          renderHTML: (a) => (a.indent ? { 'data-indent': a.indent, style: `margin-left: ${a.indent * INDENT_PX}px` } : {}),
        },
      },
    }]
  },
  addCommands() {
    const blocks = (state, fn) => {
      const seen = []
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (node.type.name === 'paragraph' || node.type.name === 'heading') {
          seen.push([node, pos])
          return false
        }
      })
      return seen
    }
    const each = (fn) => ({ state, tr, dispatch }) => {
      const found = blocks(state)
      if (!found.length) return false
      if (dispatch) for (const [node, pos] of found) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...fn(node.attrs) })
      return true
    }
    return {
      setLineHeight: (v) => each(() => ({ lineHeight: v === 1.15 || !v ? null : v })),
      // In a list, indenting nests the item; elsewhere the paragraph moves in.
      indent: () => ({ editor, commands }) => {
        if (editor.isActive('listItem')) return commands.sinkListItem('listItem')
        if (editor.isActive('taskItem')) return commands.sinkListItem('taskItem')
        return commands.command(each((a) => ({ indent: Math.min((a.indent || 0) + 1, MAX_INDENT) })))
      },
      outdent: () => ({ editor, commands }) => {
        if (editor.isActive('listItem')) return commands.liftListItem('listItem')
        if (editor.isActive('taskItem')) return commands.liftListItem('taskItem')
        return commands.command(each((a) => ({ indent: (a.indent || 0) > 1 ? a.indent - 1 : null })))
      },
    }
  },
  addKeyboardShortcuts() {
    return {
      'Mod-]': () => this.editor.commands.indent(),
      'Mod-[': () => this.editor.commands.outdent(),
    }
  },
})

// A page break: on screen a marked line, on paper and in Word a new page.
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [
      { tag: 'div[data-page-break]' },
      // How a page break comes back from Word (see exportCopy).
      { tag: 'div[data-custom-style="OS_PageBreak"]' },
    ]
  },
  renderHTML() {
    return ['div', { 'data-page-break': '', class: 'page-break' }]
  },
  addCommands() {
    return {
      setPageBreak: () => ({ chain, state }) => {
        const atEnd = state.selection.$to.after(1) >= state.doc.content.size
        return chain().insertContent(atEnd ? [{ type: 'pageBreak' }, { type: 'paragraph' }] : { type: 'pageBreak' }).run()
      },
    }
  },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() }
  },
})

// headings lists the document's headings in order, for the table of contents.
export function headings(doc) {
  const out = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      let text = ''
      node.descendants((n) => {
        if (n.isText && !n.marks.some((m) => m.type.name === 'del')) text += n.text
      })
      if (text.trim()) out.push({ level: node.attrs.level, text: text.trim(), pos })
      return false
    }
    return node.isBlock
  })
  return out
}

const tocKey = new PluginKey('toc')

// A table of contents that keeps itself up to date: it holds no text of its
// own, and is drawn from the headings whenever the document changes.
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'nav[data-toc]' }]
  },
  renderHTML() {
    return ['nav', { 'data-toc': '', class: 'toc' }]
  },
  addStorage() {
    return { views: new Set() }
  },
  addCommands() {
    return {
      insertTableOfContents: () => ({ commands }) => commands.insertContent({ type: 'tableOfContents' }),
    }
  },
  addNodeView() {
    const storage = this.storage
    return ({ editor, getPos }) => {
      const dom = document.createElement('nav')
      dom.className = 'toc'
      dom.contentEditable = 'false'
      dom.setAttribute('data-toc', '')
      const draw = () => {
        const list = headings(editor.state.doc)
        const key = JSON.stringify(list.map((h) => [h.level, h.text]))
        if (key === dom.dataset.key) return
        dom.dataset.key = key
        dom.replaceChildren()
        const title = document.createElement('div')
        title.className = 'toc-title'
        title.textContent = 'Contents'
        dom.append(title)
        if (!list.length) {
          const hint = document.createElement('div')
          hint.className = 'toc-empty'
          hint.textContent = 'Headings you add appear here.'
          dom.append(hint)
        }
        for (const h of list) {
          const a = document.createElement('a')
          a.className = 'toc-item'
          a.style.paddingLeft = (h.level - 1) * 18 + 'px'
          a.textContent = h.text
          a.href = '#'
          a.addEventListener('mousedown', (e) => {
            e.preventDefault()
            const at = headings(editor.state.doc).find((x) => x.text === h.text && x.level === h.level)
            if (!at) return
            editor.chain().setTextSelection(at.pos + 1).scrollIntoView().run()
            editor.view.nodeDOM(at.pos)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
          })
          dom.append(a)
        }
      }
      const view = { draw }
      storage.views.add(view)
      draw()
      return {
        dom,
        stopEvent: (e) => e.type === 'mousedown' && e.target.closest('.toc-item'),
        ignoreMutation: () => true,
        destroy: () => storage.views.delete(view),
      }
    }
  },
  addProseMirrorPlugins() {
    const storage = this.storage
    return [new Plugin({
      key: tocKey,
      view: () => ({
        update: (view, prev) => {
          if (prev.doc !== view.state.doc) for (const v of storage.views) v.draw()
        },
      }),
    })]
  },
})

// footnoteText reads a footnote from pandoc's form of one: a numbered link
// to an entry in a list at the end of the document.
function pandocNote(el) {
  const id = (el.getAttribute('href') || '').replace(/^#/, '')
  const li = id && el.ownerDocument?.getElementById(id)
  if (!li) return false
  const copy = li.cloneNode(true)
  for (const back of copy.querySelectorAll('.footnote-back, [role="doc-backlink"]')) back.remove()
  return { text: copy.textContent.replace(/\s+/g, ' ').trim() }
}

const footnoteKey = new PluginKey('footnotes')

export function footnotes(doc) {
  const out = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'footnote' && !node.marks.some((m) => m.type.name === 'del')) out.push({ text: node.attrs.text, pos })
  })
  return out
}

// A footnote: a number in the text, its words in a list at the end of the
// document. The words are an attribute of the number, so the two can never
// drift apart.
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      text: { default: '', parseHTML: (el) => el.getAttribute('data-footnote') ?? (pandocNote(el) || {}).text ?? '', renderHTML: (a) => ({ 'data-footnote': a.text || '' }) },
    }
  },
  parseHTML() {
    // Ahead of the link mark, which would otherwise take pandoc's numbers.
    return [
      { tag: 'sup[data-footnote]', priority: 1100 },
      { tag: 'a.footnote-ref', getAttrs: pandocNote, priority: 1100 },
      { tag: 'a[role="doc-noteref"]', getAttrs: pandocNote, priority: 1100 },
      // The list of notes itself is read through the numbers above.
      { tag: 'section.footnotes', ignore: true },
      { tag: 'section[role="doc-endnotes"]', ignore: true },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { class: 'fn-ref' })]
  },
  renderText: () => '',
  addCommands() {
    return {
      insertFootnote: (text = '') => ({ chain }) => chain().insertContent({ type: 'footnote', attrs: { text } }).run(),
      setFootnote: (pos, text) => ({ tr, state, dispatch }) => {
        const node = state.doc.nodeAt(pos)
        if (node?.type.name !== 'footnote') return false
        if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, text })
        return true
      },
    }
  },
  // The list at the end of the document, drawn as part of the page so it
  // prints where it is seen.
  addProseMirrorPlugins() {
    const editor = this.editor
    return [new Plugin({
      key: footnoteKey,
      props: {
        decorations: (state) => {
          const notes = footnotes(state.doc)
          if (!notes.length) return null
          const key = 'fn:' + JSON.stringify(notes.map((n) => n.text))
          return DecorationSet.create(state.doc, [Decoration.widget(state.doc.content.size, () => {
            const box = document.createElement('div')
            box.className = 'fn-list'
            box.contentEditable = 'false'
            const ol = document.createElement('ol')
            notes.forEach((n, i) => {
              const li = document.createElement('li')
              li.textContent = n.text || ' '
              li.addEventListener('mousedown', (e) => {
                e.preventDefault()
                const at = footnotes(editor.state.doc)[i]
                if (at) editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at.pos)).scrollIntoView())
              })
              ol.append(li)
            })
            box.append(ol)
            return box
          }, { key, side: 1, ignoreSelection: true })])
        },
      },
    })]
  },
})

const LENGTH = /^\d+(\.\d+)?(%|px)$/
const widthOf = (el) => {
  const w = el.style?.width || el.getAttribute('width') || ''
  if (LENGTH.test(w)) return w
  if (/^\d+$/.test(w)) return w + 'px'
  const m = /^(\d+(?:\.\d+)?)(in|cm|mm)$/.exec(w)
  if (m) return Math.round(+m[1] * { in: 96, cm: 37.8, mm: 3.78 }[m[2]]) + 'px'
  return null
}
const wraps = ['break', 'left', 'right']
const aligns = ['left', 'center', 'right']

const imageStyle = (a, inline) => {
  const s = []
  if (a.width) s.push(`width: ${a.width}`)
  if (!inline) {
    if (a.wrap === 'left') s.push('float: left', 'margin: 4px 18px 10px 0')
    else if (a.wrap === 'right') s.push('float: right', 'margin: 4px 0 10px 18px')
    else if (a.align === 'center') s.push('margin-left: auto', 'margin-right: auto')
    else if (a.align === 'right') s.push('margin-left: auto')
  }
  return s.join('; ')
}

// Dragging a picture's corner sizes it as a share of the text width, so it
// keeps its place on any paper size.
function imageView(inline) {
  return ({ node, editor, getPos }) => {
    const dom = document.createElement(inline ? 'span' : 'div')
    dom.className = inline ? 'img-wrap inline' : 'img-wrap'
    const img = document.createElement('img')
    const handle = document.createElement('span')
    handle.className = 'img-handle'
    handle.contentEditable = 'false'
    dom.append(img, handle)
    const paint = (n) => {
      img.src = n.attrs.src
      img.alt = n.attrs.alt || ''
      if (n.attrs.title) img.title = n.attrs.title
      dom.dataset.wrap = inline ? 'inline' : n.attrs.wrap || 'break'
      dom.dataset.align = n.attrs.align || 'left'
      dom.style.cssText = imageStyle(n.attrs, inline) + (inline ? '' : '; display: block')
      img.style.width = '100%'
      if (!n.attrs.width) {
        dom.style.width = ''
        img.style.width = ''
      }
    }
    paint(node)
    handle.addEventListener('mousedown', (e) => {
      if (!editor.isEditable) return
      e.preventDefault()
      e.stopPropagation()
      const paper = dom.closest('.paper')
      const cs = paper && getComputedStyle(paper)
      const column = paper ? paper.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : 600
      const startX = e.clientX
      const startW = img.getBoundingClientRect().width
      let pct = null
      const move = (ev) => {
        const w = Math.max(24, Math.min(column, startW + (ev.clientX - startX) * (node.attrs.wrap === 'right' ? -1 : 1)))
        pct = Math.max(5, Math.min(100, Math.round((w / column) * 100)))
        dom.style.width = pct + '%'
        img.style.width = '100%'
      }
      const up = () => {
        removeEventListener('mousemove', move)
        removeEventListener('mouseup', up)
        const pos = getPos()
        if (pct == null || typeof pos !== 'number') return
        const cur = editor.state.doc.nodeAt(pos)
        if (cur) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, width: pct + '%' }))
      }
      addEventListener('mousemove', move)
      addEventListener('mouseup', up)
    })
    return {
      dom,
      update: (n) => {
        if (n.type !== node.type) return false
        node = n
        paint(n)
        return true
      },
      selectNode: () => dom.classList.add('ProseMirror-selectednode'),
      deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
      stopEvent: (e) => e.target === handle,
      ignoreMutation: () => true,
    }
  }
}

// Pictures on a line of their own ("break text") or with text flowing round
// them ("wrap text").
export const Picture = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null, parseHTML: widthOf, renderHTML: () => ({}) },
      // A height would fight the width; pictures keep their proportions.
      height: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      wrap: { default: 'break', parseHTML: (el) => (wraps.includes(el.getAttribute('data-wrap')) ? el.getAttribute('data-wrap') : el.style?.float === 'left' ? 'left' : el.style?.float === 'right' ? 'right' : 'break'), renderHTML: () => ({}) },
      align: { default: 'left', parseHTML: (el) => (aligns.includes(el.getAttribute('data-align')) ? el.getAttribute('data-align') : 'left'), renderHTML: () => ({}) },
    }
  },
  parseHTML() {
    return [{ tag: 'img[src]:not([data-inline])' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs
    const extra = { 'data-wrap': a.wrap, 'data-align': a.align }
    if (a.width) extra.width = a.width.replace(/px$/, '')
    const style = imageStyle(a, false)
    return ['img', mergeAttributes(HTMLAttributes, extra, style ? { style: style + '; display: block' } : {})]
  },
  addNodeView() {
    return imageView(false)
  },
}).configure({ allowBase64: true })

// A picture that sits in a line of text, like a large character.
export const InlinePicture = Node.create({
  name: 'inlineImage',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
      width: { default: null, parseHTML: widthOf, renderHTML: () => ({}) },
    }
  },
  parseHTML() {
    return [{ tag: 'img[src][data-inline]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const extra = { 'data-inline': '' }
    if (node.attrs.width) extra.width = node.attrs.width.replace(/px$/, '')
    return ['img', mergeAttributes(HTMLAttributes, extra, node.attrs.width ? { style: `width: ${node.attrs.width}` } : {})]
  },
  addNodeView() {
    return imageView(true)
  },
})

// setImageLayout moves a selected picture between the three layouts, and
// sets its size and alignment. layout: 'inline' | 'break' | 'left' | 'right'.
export function setImageLayout(editor, { layout, width, align }) {
  const { state } = editor
  const sel = state.selection
  if (!(sel instanceof NodeSelection)) return false
  const node = sel.node
  const pos = sel.from
  const { image, inlineImage, paragraph } = state.schema.nodes
  const base = { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title, width: width !== undefined ? width : node.attrs.width }
  const tr = state.tr
  let at = pos
  if (node.type === image && layout === 'inline') {
    tr.replaceWith(pos, pos + node.nodeSize, paragraph.create(null, inlineImage.create(base)))
    at = pos + 1
  } else if (node.type === inlineImage && layout && layout !== 'inline') {
    // Out of the line: the picture goes on its own after the paragraph.
    const $pos = state.doc.resolve(pos)
    const after = $pos.after($pos.depth)
    tr.insert(after, image.create({ ...base, wrap: layout, align: align || 'left' }))
    tr.delete(pos, pos + node.nodeSize)
    at = tr.mapping.slice(1).map(after)
  } else if (node.type === image) {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...base, wrap: layout || node.attrs.wrap, align: align || node.attrs.align })
  } else {
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...base })
  }
  try {
    tr.setSelection(NodeSelection.create(tr.doc, at))
  } catch {}
  editor.view.dispatch(tr)
  return true
}

export const layoutExtensions = () => [Spacing, PageBreak, TableOfContents, Footnote, Picture, InlinePicture]
