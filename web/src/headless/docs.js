// Text documents, read and written as the editor does: the same schema
// (apps/doc-format.js), the same review marks and comment threads, and every
// write an edit to the shared document that merges with whoever is typing in
// it at the same moment.
import { getSchema, createDocument, getHTMLFromFragment } from '@tiptap/core'
import { Fragment } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap'
import { formatExtensions, docText, readingCopy, exportCopy, importCopy } from '../apps/doc-format.js'
import { commentRanges } from '../apps/doc-marks.js'
import { readThreads, addThread, addReply, setResolved, adoptThreads } from '../apps/doc-comments.js'
import { readPage, setPage, adoptPage, pageFromHTML } from '../apps/doc-page.js'
import { findMatches, replaceMatches, counts } from '../apps/doc-find.js'
import { newId } from '../lib/util.js'
import { arg, oneOf, person, frames, openY, change } from './wire.js'
import { reuse } from './reuse.js'

const schema = getSchema(formatExtensions(null))
const REVIEW = new Set(['comment', 'ins', 'del', 'fmt'])

// open runs `fn` on a document's shared state and its ProseMirror form.
function open(state, fn) {
  const ydoc = openY(state)
  try {
    const frag = ydoc.getXmlFragment('default')
    const { doc, meta } = initProseMirrorDoc(frag, schema)
    return fn({ ydoc, frag, doc, meta })
  } finally {
    ydoc.destroy()
  }
}

// settled is a node as it reads with every suggestion accepted: text
// proposed for removal gone, and no review marks except, when asked for,
// comments.
function settled(node, comments = false) {
  if (node.marks.some((m) => m.type.name === 'del')) return null
  const marks = node.marks.filter((m) => !REVIEW.has(m.type.name) || (comments && m.type.name === 'comment'))
  if (node.isText) return node.mark(marks)
  const kids = []
  node.forEach((c) => {
    const s = settled(c, comments)
    if (s) kids.push(s)
  })
  return node.type.create(node.attrs, Fragment.fromArray(kids), marks)
}

// unmarked drops review marks from content that comes from outside:
// comments and suggestions are made through their own operations.
function unmarked(node) {
  const marks = node.marks.filter((m) => !REVIEW.has(m.type.name))
  if (node.isText) return node.mark(marks)
  const kids = []
  node.forEach((c) => kids.push(unmarked(c)))
  return node.type.create(node.attrs, Fragment.fromArray(kids), marks)
}

const readingKey = (n) => JSON.stringify(settled(n)?.toJSON() ?? null)
const exactKey = (n) => JSON.stringify(n.toJSON())

const blank = (doc) => doc.childCount === 0 || (doc.childCount === 1 && doc.firstChild.isTextblock && doc.firstChild.content.size === 0)

// keepComments lets an edited block keep its comments on the text before
// and after the part that changed.
function keepComments(old, block) {
  const was = []
  settled(old, true).descendants((n) => {
    if (!n.isText) return
    const marks = n.marks.filter((m) => m.type.name === 'comment')
    for (let i = 0; i < n.text.length; i++) was.push({ ch: n.text[i], marks })
  })
  if (!was.some((c) => c.marks.length)) return block
  const doc = schema.topNodeType.create(null, block)
  const now = []
  doc.descendants((n, pos) => {
    if (n.isText) for (let i = 0; i < n.text.length; i++) now.push({ ch: n.text[i], pos: pos + i })
  })
  let p = 0
  while (p < was.length && p < now.length && was[p].ch === now[p].ch) p++
  let s = 0
  while (s < was.length - p && s < now.length - p && was[was.length - 1 - s].ch === now[now.length - 1 - s].ch) s++
  const tr = new Transform(doc)
  const carry = (a, b) => {
    for (const m of was[a].marks) tr.addMark(now[b].pos, now[b].pos + 1, m)
  }
  for (let i = 0; i < p; i++) carry(i, i)
  for (let k = 1; k <= s; k++) carry(was.length - k, now.length - k)
  return tr.doc.firstChild
}

// find locates the nth time `quote` appears in the document as it reads
// (text proposed for removal skipped; blocks end in a line break).
function find(doc, quote, nth) {
  let text = ''
  let blocks = 0
  const at = [] // the document position of each character of text
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (blocks++) {
        text += '\n'
        at.push(-1)
      }
      return true
    }
    if (!node.isInline) return true
    if (node.marks.some((m) => m.type.name === 'del')) return false
    const s = node.isText ? node.text : ' '
    text += s
    for (let i = 0; i < s.length; i++) at.push(pos + i)
    return false
  })
  let i = -1
  for (let k = 0; k < nth; k++) if ((i = text.indexOf(quote, i + 1)) < 0) return null
  return { from: at[i], to: at[i + quote.length - 1] + 1 }
}

function threadJSON(t, ranges) {
  return {
    id: t.id, quote: ranges.get(t.id)?.quote || '', author: { id: t.by, name: t.name }, at: t.at, text: t.text,
    resolved: t.resolved ? { id: t.resolved.by, name: t.resolved.name, at: t.resolved.at } : null,
    replies: t.replies.map((r) => ({ id: r.id, author: { id: r.by, name: r.name }, at: r.at, text: r.text })),
  }
}

function threadOf(ydoc, args) {
  const id = arg(args, 'thread', 'string')
  if (!readThreads(ydoc).some((t) => t.id === id)) throw new Error(`No comment thread "${id}" in this document`)
  return id
}

export const docOps = {
  // With export, the HTML a file is made from (doc-format.js exportCopy).
  'doc.read': (args) => {
    const ex = arg(args, 'export', 'object', true)
    return open(frames(args), ({ ydoc, doc }) => {
      const raw = getHTMLFromFragment(doc.content, schema)
      const text = docText(settled(doc))
      return {
        html: ex
          ? exportCopy(raw, { page: readPage(ydoc), title: typeof ex.title === 'string' ? ex.title : 'Untitled', target: ['word', 'html', 'markdown'].includes(ex.target) ? ex.target : 'word' })
          : readingCopy(raw).body.innerHTML,
        text: docText(doc),
        page: readPage(ydoc),
        ...counts(text),
      }
    })
  },

  // A page setup in the HTML (a converted file's <meta>) comes with it.
  'doc.write': (args) => {
    const html = arg(args, 'html', 'string')
    const mode = oneOf(args, 'mode', ['replace', 'append', 'prepend'])
    return open(frames(args), ({ ydoc, frag, doc, meta }) => {
      const input = unmarked(createDocument(importCopy(html), schema))
      const page = mode === 'replace' ? pageFromHTML(html) : null
      if (mode !== 'replace' && blank(input)) return { update: '', text: docText(doc) }
      const content = mode === 'replace' ? reuse(doc, input, readingKey, keepComments)
        : blank(doc) ? input.content
          : mode === 'append' ? doc.content.append(input.content) : input.content.append(doc.content)
      const next = schema.topNodeType.create(null, content)
      return {
        update: change(ydoc, () => {
          updateYFragment(ydoc, frag, next, meta)
          if (page) setPage(ydoc, page)
        }),
        text: docText(next),
      }
    })
  },

  'doc.page': (args) => open(frames(args), ({ ydoc }) => ({ page: readPage(ydoc) })),

  'doc.setPage': (args) => {
    const page = arg(args, 'page', 'object')
    return open(frames(args), ({ ydoc }) => {
      let after
      const update = change(ydoc, () => {
        after = setPage(ydoc, page)
      })
      return { update, page: after }
    })
  },

  // Find and replace, as Edit > Find and replace does it.
  'doc.replace': (args) => {
    const find = arg(args, 'find', 'string')
    const replace = arg(args, 'replace', 'string')
    const matchCase = arg(args, 'matchCase', 'boolean', true) ?? false
    const wholeWord = arg(args, 'wholeWord', 'boolean', true) ?? false
    if (!find) throw new Error('find must not be empty')
    return open(frames(args), ({ ydoc, frag, doc, meta }) => {
      const matches = findMatches(doc, find, { matchCase, wholeWord })
      if (!matches.length) return { update: '', text: docText(doc), replaced: 0 }
      const tr = replaceMatches(new Transform(doc), matches, replace)
      return { update: change(ydoc, () => updateYFragment(ydoc, frag, tr.doc, meta)), text: docText(tr.doc), replaced: matches.length }
    })
  },

  'doc.comments': (args) => open(frames(args), ({ ydoc, doc }) => {
    const ranges = commentRanges(doc)
    const where = (t) => ranges.get(t.id)?.from ?? Infinity
    return { threads: readThreads(ydoc).sort((a, b) => where(a) - where(b) || a.at - b.at).map((t) => threadJSON(t, ranges)) }
  }),

  // A comment anchors where the editor anchors one: a comment mark over the
  // quoted text (doc-review.jsx startThread), then the thread itself.
  'doc.comment': (args) => {
    const quote = arg(args, 'quote', 'string').trim()
    const nth = arg(args, 'occurrence', 'integer', true) ?? 1
    const text = arg(args, 'text', 'string').trim()
    const author = person(args, 'author')
    if (!quote) throw new Error('quote must not be empty')
    if (!text) throw new Error('text must not be empty')
    if (nth < 1) throw new Error('occurrence must be 1 or more')
    return open(frames(args), ({ ydoc, frag, doc, meta }) => {
      const range = find(doc, quote, nth)
      if (!range) throw new Error(nth === 1 ? `The document does not contain "${quote}"` : `The document does not contain "${quote}" ${nth} times`)
      const id = newId(10)
      const tr = new Transform(doc).addMark(range.from, range.to, schema.marks.comment.create({ id }))
      const update = change(ydoc, () => {
        updateYFragment(ydoc, frag, tr.doc, meta)
        addThread(ydoc, id, author, text, [])
      })
      return { update, thread: threadJSON(readThreads(ydoc).find((t) => t.id === id), commentRanges(tr.doc)) }
    })
  },

  'doc.reply': (args) => {
    const text = arg(args, 'text', 'string').trim()
    const author = person(args, 'author')
    if (!text) throw new Error('text must not be empty')
    return open(frames(args), ({ ydoc }) => {
      const id = threadOf(ydoc, args)
      return { update: change(ydoc, () => addReply(ydoc, id, author, text, [])) }
    })
  },

  'doc.resolve': (args) => {
    const resolved = arg(args, 'resolved', 'boolean')
    const author = person(args, 'author')
    return open(frames(args), ({ ydoc }) => {
      const id = threadOf(ydoc, args)
      return { update: change(ydoc, () => setResolved(ydoc, id, author, resolved)) }
    })
  },

  // Restoring is an edit, as in the editor (editor.jsx restore): the text
  // becomes the version's, and threads the version had come back with it.
  'doc.restore': (args) => {
    const version = openY(frames(args, 'version'))
    try {
      const past = initProseMirrorDoc(version.getXmlFragment('default'), schema).doc
      return open(frames(args), ({ ydoc, frag, doc, meta }) => {
        const next = schema.topNodeType.create(null, reuse(doc, past, exactKey))
        const update = change(ydoc, () => {
          adoptThreads(ydoc, version)
          adoptPage(ydoc, version)
          updateYFragment(ydoc, frag, next, meta)
        })
        return { update, text: docText(next) }
      })
    } finally {
      version.destroy()
    }
  },
}
