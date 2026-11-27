// Find and replace, in the editor and through the API (src/headless/docs.js).
// Matches are found in each paragraph's text as it reads, so a word split
// across bold and plain parts is still one match.
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// findMatches returns { from, to } for every match, in document order. Text
// proposed for removal is skipped: it is not part of the document as it reads.
export function findMatches(doc, query, { matchCase = false, wholeWord = false } = {}) {
  if (!query) return []
  const re = new RegExp((wholeWord ? '(?<![\\p{L}\\p{N}_])' : '') + escape(query) + (wholeWord ? '(?![\\p{L}\\p{N}_])' : ''), 'gu' + (matchCase ? '' : 'i'))
  const out = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    const at = []
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      if (child.marks.some((m) => m.type.name === 'del')) {
        // A gap, so a match cannot run across removed text.
        text += '\u0000'
        at.push(-1)
        return
      }
      const s = child.isText ? child.text : '￼'
      for (let i = 0; i < s.length; i++) at.push(start + i)
      text += s
    })
    for (const m of text.matchAll(re)) {
      if (!m[0].length) continue
      const a = at[m.index]
      const b = at[m.index + m[0].length - 1]
      if (a < 0 || b < 0 || b - a !== m[0].length - 1) continue
      out.push({ from: a, to: b + 1 })
    }
    return false
  })
  return out
}

// replaceMatches replaces matches from the end back, so earlier positions
// stay true. Each replacement takes the formatting of the text it replaces.
export function replaceMatches(tr, matches, text) {
  for (let i = matches.length - 1; i >= 0; i--) {
    const { from, to } = matches[i]
    const marks = tr.doc.resolve(from + 1).marks().filter((m) => !['ins', 'del', 'fmt', 'comment'].includes(m.type.name))
    if (text) tr.replaceWith(from, to, tr.doc.type.schema.text(text, marks))
    else tr.delete(from, to)
  }
  return tr
}

export const findKey = new PluginKey('find')

const empty = { query: '', matchCase: false, wholeWord: false, matches: [], current: -1 }

export const FindReplace = Extension.create({
  name: 'findReplace',
  addCommands() {
    const set = (patch) => ({ tr, dispatch }) => {
      if (dispatch) tr.setMeta(findKey, patch)
      return true
    }
    return {
      setFind: (opts) => set({ ...opts, reset: true }),
      closeFind: () => set({ ...empty, reset: true }),
      findNext: (dir = 1) => ({ state, tr, dispatch, view }) => {
        const f = findKey.getState(state)
        if (!f.matches.length) return false
        const head = state.selection.from
        let i = f.current
        if (i < 0) i = dir > 0 ? f.matches.findIndex((m) => m.from >= head) : f.matches.findLastIndex((m) => m.to <= head)
        else i += dir
        i = ((i % f.matches.length) + f.matches.length) % f.matches.length
        if (i < 0) i = 0
        const m = f.matches[i]
        if (dispatch) tr.setMeta(findKey, { current: i }).setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView()
        return true
      },
      replaceCurrent: (text) => ({ state, tr, dispatch, commands }) => {
        const f = findKey.getState(state)
        const m = f.matches[f.current] || f.matches.find((x) => x.from === state.selection.from && x.to === state.selection.to)
        if (!m) return commands.findNext(1)
        if (dispatch) {
          replaceMatches(tr, [m], text)
          tr.setMeta(findKey, { current: -1, after: tr.mapping.map(m.to) })
        }
        return true
      },
      replaceAll: (text) => ({ state, tr, dispatch }) => {
        const f = findKey.getState(state)
        if (!f.matches.length) return false
        if (dispatch) replaceMatches(tr, f.matches, text).setMeta(findKey, { current: -1 })
        return true
      },
    }
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: findKey,
      state: {
        init: () => empty,
        apply: (tr, value, old, state) => {
          const meta = tr.getMeta(findKey)
          let next = value
          if (meta) next = { ...value, ...meta }
          if (!next.query) return next.matches.length || next.current !== -1 ? { ...next, matches: [], current: -1 } : next
          if (meta?.reset || tr.docChanged) {
            const matches = findMatches(state.doc, next.query, next)
            let current = meta?.reset ? -1 : next.current
            if (meta?.after != null) current = matches.findIndex((m) => m.from >= meta.after)
            if (current >= matches.length) current = matches.length - 1
            next = { ...next, matches, current }
          }
          return next
        },
      },
      props: {
        decorations(state) {
          const f = findKey.getState(state)
          if (!f.matches.length) return null
          return DecorationSet.create(state.doc, f.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === f.current ? 'find-hit current' : 'find-hit' })))
        },
      },
    })]
  },
})

// counts is what Tools > Word count shows, for the whole text or a part.
export function counts(text) {
  const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length
  return { words, characters: [...text].length, charactersNoSpaces: [...text.replace(/\s/g, '')].length }
}
