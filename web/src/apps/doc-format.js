// The document format itself: what a past version needs to be shown as well
// as what the live editor needs. Kept free of the DOM so the demo seed
// (web/scripts/demo-seed.mjs) builds documents from the same schema.
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
