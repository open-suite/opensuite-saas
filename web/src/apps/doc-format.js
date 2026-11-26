// The document format itself: what a past version needs to be shown as well
// as what the live editor needs. Kept free of the DOM so the demo seed
// (web/scripts/demo-seed.mjs) builds documents from the same schema, and the
// server's headless engine (src/headless/) reads and writes them with it.
import StarterKit from '@tiptap/starter-kit'
import TextAlign from '@tiptap/extension-text-align'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'
import { TextStyle, Color } from '@tiptap/extension-text-style'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Review } from './doc-marks.js'

export function formatExtensions(who) {
  return [
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true } }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Image.configure({ allowBase64: true }),
    Highlight.configure({ multicolor: true }),
    TextStyle, Color,
    TaskList, TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    Review.configure({ user: () => who }),
  ]
}

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
