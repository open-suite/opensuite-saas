// Text inside slides. Every text box keeps its content as a shared rich-text
// fragment. Boxes are drawn from that fragment as plain HTML; an editor exists
// only for the one box being typed in, so a deck of fifty slides costs no
// more to open than its first slide.
import { Editor, Extension, getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyle, Color, FontSize, FontFamily } from '@tiptap/extension-text-style'
import { DOMSerializer } from '@tiptap/pm/model'
import {
  ySyncPlugin, ySyncPluginKey, yCursorPlugin, yXmlFragmentToProseMirrorRootNode, yXmlFragmentToProsemirrorJSON, prosemirrorJSONToYXmlFragment,
} from '@tiptap/y-tiptap'

export { ySyncPluginKey }

const extensions = () => [
  StarterKit.configure({
    undoRedo: false, heading: false, blockquote: false, codeBlock: false, code: false, horizontalRule: false,
    dropcursor: false, gapcursor: false, trailingNode: false, link: { openOnClick: false, autolink: true },
  }),
  TextStyle, Color, FontSize, FontFamily,
  TextAlign.configure({ types: ['paragraph'] }),
]

let made = null
function kit() {
  if (!made) {
    const schema = getSchema(extensions())
    made = { schema, serializer: DOMSerializer.fromSchema(schema) }
  }
  return made
}

// --- reading ----------------------------------------------------------------

const cache = new WeakMap() // fragment -> { html, plain }

function read(frag) {
  let c = cache.get(frag)
  if (c) return c
  const { schema, serializer } = kit()
  c = { html: '', plain: '' }
  if (frag.length) {
    const t0 = performance.now()
    try {
      const node = yXmlFragmentToProseMirrorRootNode(frag, schema)
      const div = document.createElement('div')
      div.append(serializer.serializeFragment(node.content))
      c = { html: div.innerHTML, plain: node.textBetween(0, node.content.size, '\n', ' ').trim() }
    } catch {}
    // Where opening a deck spends its time, for tests/perf-slides.cjs.
    if (window.__slidesTiming) window.__slidesTiming.text = (window.__slidesTiming.text || 0) + performance.now() - t0
  }
  cache.set(frag, c)
  return c
}

export const textHTML = (frag) => (frag ? read(frag).html : '')
export const textPlain = (frag) => (frag ? read(frag).plain : '')
export const isBlank = (frag) => !frag || read(frag).plain === ''
export const forget = (frag) => cache.delete(frag)

// The content as plain data, for copying, duplicating and exporting.
export const textJSON = (frag) => (frag && frag.length ? yXmlFragmentToProsemirrorJSON(frag).content || [] : [])

// fillText writes content into a fragment that is already part of a document.
export function fillText(frag, content) {
  if (!content?.length) return
  prosemirrorJSONToYXmlFragment(kit().schema, { type: 'doc', content }, frag)
  forget(frag)
}

export const paragraphs = (...lines) => lines.map((t) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] }))

// --- editing ----------------------------------------------------------------

function caret(u) {
  const el = document.createElement('span')
  el.className = 'sl-caret'
  el.style.borderColor = u.color
  const tag = document.createElement('span')
  tag.style.background = u.color
  tag.textContent = u.name
  el.append(tag)
  return el
}

// createTextEditor binds an editor to one box's fragment. `keys` lets the
// deck own undo, redo and leaving the box.
export function createTextEditor({ element, fragment, awareness, editable = true, keys = {}, onChange }) {
  const Bind = Extension.create({
    name: 'deckText',
    addProseMirrorPlugins: () => [ySyncPlugin(fragment), ...(awareness ? [yCursorPlugin(awareness, { cursorBuilder: caret })] : [])],
    addKeyboardShortcuts: () => ({
      'Mod-z': () => (keys.undo?.(), true),
      'Shift-Mod-z': () => (keys.redo?.(), true),
      'Mod-y': () => (keys.redo?.(), true),
      Escape: () => (keys.exit?.(), true),
    }),
  })
  return new Editor({
    element,
    editable,
    extensions: [...extensions(), Bind],
    editorProps: { attributes: { class: 'sl-text', spellcheck: 'true' } },
    onTransaction: () => onChange?.(),
  })
}

// formatAll applies one formatting command to the whole text of a box that is
// not being edited.
export function formatAll(fragment, run) {
  if (!fragment.length) return
  const editor = createTextEditor({ element: document.createElement('div'), fragment })
  try {
    run(editor.chain().selectAll()).run()
  } finally {
    editor.destroy()
    forget(fragment)
  }
}

// describe reports the formatting of a box's whole text, for the toolbar.
export function describeAll(fragment) {
  const out = { bold: false, italic: false, underline: false, size: null, align: null, color: null, font: null, bullet: false, ordered: false }
  if (!fragment?.length) return out
  try {
    const node = yXmlFragmentToProseMirrorRootNode(fragment, kit().schema)
    let chars = 0
    const count = { bold: 0, italic: 0, underline: 0 }
    const sizes = new Set(), colors = new Set(), aligns = new Set(), families = new Set()
    node.descendants((n) => {
      if (n.type.name === 'paragraph') aligns.add(n.attrs.textAlign || '')
      if (n.type.name === 'bulletList') out.bullet = true
      if (n.type.name === 'orderedList') out.ordered = true
      if (!n.isText) return
      chars += n.text.length
      const style = n.marks.find((m) => m.type.name === 'textStyle')?.attrs || {}
      sizes.add(style.fontSize || '')
      colors.add(style.color || '')
      families.add(style.fontFamily || '')
      for (const k of Object.keys(count)) if (n.marks.some((m) => m.type.name === k)) count[k] += n.text.length
    })
    for (const k of Object.keys(count)) out[k] = chars > 0 && count[k] === chars
    if (sizes.size === 1) out.size = parseFloat([...sizes][0]) || null
    if (colors.size === 1) out.color = [...colors][0] || null
    if (families.size === 1) out.font = [...families][0] || null
    if (aligns.size === 1) out.align = [...aligns][0] || null
  } catch {}
  return out
}

let rehearsed = false
// rehearse compiles the editor code path once, before the first real edit.
export function rehearse() {
  if (rehearsed) return
  rehearsed = true
  kit()
}
