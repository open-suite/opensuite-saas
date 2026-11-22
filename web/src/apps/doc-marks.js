// What review adds to the document format: a mark that anchors a comment to
// text, and three marks that record a suggestion (text someone proposes to
// add, to remove, or to restyle). All four are ordinary marks, so they travel
// with the text through sync, copy and paste, and version history.
//
// Suggesting works by letting an edit happen and then, in the same state
// update, correcting it: removed text is put back and marked as a proposed
// removal, added text is marked as a proposed addition, and a change of
// formatting is noted beside the text it touched. Only this person's own
// edits are corrected; changes arriving from colleagues and undo are left
// alone, which is what keeps two people suggesting at once from tangling.
import { Mark, Extension, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { ReplaceStep, AddMarkStep, RemoveMarkStep, Mapping } from '@tiptap/pm/transform'
import { Fragment, Slice } from '@tiptap/pm/model'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { colorFor, newId } from '../lib/util.js'

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '', // threads may overlap
  addAttributes() {
    return { id: { default: null, parseHTML: (el) => el.getAttribute('data-c'), renderHTML: (a) => ({ 'data-c': a.id }) } }
  },
  parseHTML() {
    return [{ tag: 'span[data-c]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'cmt' }), 0]
  },
})

const data = (name) => ({ default: null, parseHTML: (el) => el.getAttribute('data-' + name), renderHTML: (a) => (a[name] == null ? {} : { ['data-' + name]: a[name] }) })
const who = () => ({
  id: { default: null, parseHTML: (el) => el.getAttribute('data-s'), renderHTML: (a) => ({ 'data-s': a.id }) },
  by: data('by'),
  name: data('name'),
  at: { default: 0, parseHTML: (el) => +el.getAttribute('data-at') || 0, renderHTML: (a) => ({ 'data-at': a.at }) },
})
const tint = (attrs) => ({ style: `--who: ${colorFor(attrs['data-by'] || '')}` })

function suggestionMark(name, tag, cls, extra = {}) {
  return Mark.create({
    name,
    inclusive: false,
    // Ahead of the strike-through and underline marks, which would otherwise
    // claim <del> and <ins> when a document is pasted or imported.
    priority: 1100,
    addAttributes() {
      return { ...who(), ...extra }
    },
    parseHTML() {
      return [{ tag: `${tag}[data-s]` }]
    },
    renderHTML({ HTMLAttributes }) {
      return [tag, mergeAttributes(HTMLAttributes, { class: cls }, tint(HTMLAttributes)), 0]
    },
  })
}

export const Insertion = suggestionMark('ins', 'ins', 'sug-ins')
export const Deletion = suggestionMark('del', 'del', 'sug-del')
// ch: JSON list of { type, from, to }, the mark of that type before and after.
export const FormatChange = suggestionMark('fmt', 'span', 'sug-fmt', { ch: data('ch') })

const REVIEW = new Set(['comment', 'ins', 'del', 'fmt'])
export const suggestKey = new PluginKey('suggest')

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// One formatting change folded into the list already noted on some text.
function mergeChange(list, type, from, to) {
  const out = list.filter((c) => c.type !== type)
  const prior = list.find((c) => c.type === type)
  const origin = prior ? prior.from : from
  if (!same(origin, to)) out.push({ type, from: origin, to })
  return out
}

// The inline content of a removed slice that is worth showing as a proposed
// removal: everything except what this person had only proposed to add.
function struck(fragment, schema, mine, mark) {
  const kept = []
  let any = false
  fragment.forEach((node) => {
    if (node.isText || (node.isInline && node.isLeaf)) {
      const ins = schema.marks.ins.isInSet(node.marks)
      if (ins && mine(ins)) return
      any = true
      kept.push(schema.marks.del.isInSet(node.marks) ? node : node.mark(mark.addToSet(node.marks)))
    } else {
      const inner = struck(node.content, schema, mine, mark)
      any ||= inner.any
      kept.push(node.copy(inner.fragment))
    }
  })
  return { fragment: Fragment.fromArray(kept), any }
}

function suggestPlugin(user) {
  return new Plugin({
    key: suggestKey,
    state: {
      init: () => ({ on: false }),
      apply: (tr, value) => {
        const meta = tr.getMeta(suggestKey)
        return meta && 'on' in meta ? { on: meta.on } : value
      },
    },
    appendTransaction(trs, oldState, newState) {
      const { on } = suggestKey.getState(newState)
      const schema = newState.schema
      const { ins, del, fmt } = schema.marks
      const local = (t) => t.docChanged && !t.getMeta(ySyncPluginKey) && !t.getMeta(suggestKey)?.skip
      if (!trs.some(local)) return null
      const me = user()
      const mine = (m) => m.attrs.by === me.id
      const stamp = Date.now()
      const fresh = newId(10)
      const attrsFor = (near) => (near && mine(near) ? near.attrs : { id: fresh, by: me.id, name: me.name, at: stamp })
      const tr = newState.tr
      let caret = null

      trs.forEach((t, ti) => {
        if (!local(t)) return
        t.steps.forEach((step, si) => {
          // From the document as it stood after this step to the one being built.
          const later = new Mapping()
          t.mapping.maps.slice(si + 1).forEach((m) => later.appendMap(m))
          trs.slice(ti + 1).forEach((t2) => t2.mapping.maps.forEach((m) => later.appendMap(m)))
          const here = (pos, side) => tr.mapping.map(later.map(pos, side), side)
          const before = t.docs[si]

          if (step instanceof ReplaceStep) {
            const a = here(step.from, 1)
            const b = here(step.from + step.slice.size, -1)
            const added = step.slice.size > 0 && b > a
            if (added) {
              // Typing inside text that is proposed for removal is not itself
              // a removal.
              tr.removeMark(a, b, del)
              if (on) {
                // New text continues this person's suggestion next to it, so
                // typing after striking something reads as one replacement.
                const beside = [tr.doc.resolve(a).nodeBefore, tr.doc.resolve(b).nodeAfter].map((n) => n?.marks || [])
                const own = (type) => beside.map((marks) => type.isInSet(marks)).find((m) => m && mine(m))
                const near = own(ins) || own(del)
                tr.removeMark(a, b, fmt)
                tr.addMark(a, b, ins.create(attrsFor(near)))
              }
            }
            if (!on || step.to <= step.from) return
            const at = here(step.from, 1)
            const $at = tr.doc.resolve(at)
            const near = del.isInSet($at.nodeBefore?.marks || []) || (!added && del.isInSet($at.nodeAfter?.marks || []))
            const gone = before.slice(step.from, step.to)
            const back = struck(gone.content, schema, mine, del.create(attrsFor(near)))
            // Joining two paragraphs, or deleting one's own proposed text,
            // removes nothing that needs to be shown.
            if (!back.any) return
            const mark = tr.steps.length
            tr.replace(at, at, new Slice(back.fragment, gone.openStart, gone.openEnd))
            const placed = tr.mapping.slice(mark)
            // Backspace leaves the caret in front of what it struck, so the
            // next press strikes the character before; anything else carries on
            // after it.
            const sel = oldState.selection
            const backspace = !added && trs.length === 1 && t.steps.length === 1 && sel.empty && sel.head === step.to
            caret = backspace ? placed.map(at, -1) : added ? null : placed.map(at, 1)
          } else if (on && (step instanceof AddMarkStep || step instanceof RemoveMarkStep) && !REVIEW.has(step.mark.type.name)) {
            const type = step.mark.type
            const adding = step instanceof AddMarkStep
            before.nodesBetween(step.from, step.to, (node, pos) => {
              if (!node.isInline) return
              const had = type.isInSet(node.marks) || null
              if (adding ? had && had.eq(step.mark) : !step.mark.isInSet(node.marks)) return
              const own = ins.isInSet(node.marks)
              if (own && mine(own)) return // restyling one's own proposed text
              const a = here(Math.max(pos, step.from), 1)
              const b = here(Math.min(pos + node.nodeSize, step.to), -1)
              if (b <= a) return
              const old = fmt.isInSet(node.marks)
              const list = mergeChange(old ? JSON.parse(old.attrs.ch || '[]') : [], type.name, adding ? had?.toJSON() || null : step.mark.toJSON(), adding ? step.mark.toJSON() : null)
              if (!list.length) tr.removeMark(a, b, fmt)
              else tr.addMark(a, b, fmt.create({ ...(old ? old.attrs : attrsFor(null)), ch: JSON.stringify(list) }))
            })
          }
        })
      })

      if (!tr.steps.length) return null
      if (caret !== null) {
        try {
          tr.setSelection(TextSelection.near(tr.doc.resolve(caret), -1))
        } catch {}
      }
      return tr.setMeta(suggestKey, { skip: true })
    },
  })
}

export const Review = Extension.create({
  name: 'review',
  addOptions() {
    return { user: () => ({ id: '', name: '' }) }
  },
  addExtensions() {
    return [CommentMark, Insertion, Deletion, FormatChange]
  },
  addProseMirrorPlugins() {
    return [suggestPlugin(this.options.user)]
  },
})

export const isSuggesting = (editor) => !!suggestKey.getState(editor.state)?.on
export const setSuggesting = (editor, on) => editor.view.dispatch(editor.state.tr.setMeta(suggestKey, { on }))

const fmtNames = {
  bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikethrough', code: 'code', link: 'link',
  highlight: 'highlight', textStyle: 'text colour', subscript: 'subscript', superscript: 'superscript',
}

// suggestions lists every open suggestion in document order. Text added and
// removed in one edit share an id and read as one replacement.
export function suggestions(doc) {
  const byId = new Map()
  const note = (attrs, pos) => {
    let s = byId.get(attrs.id)
    if (!s) byId.set(attrs.id, (s = { id: attrs.id, by: attrs.by, name: attrs.name, at: attrs.at, from: pos, to: pos, added: '', removed: '', format: [] }))
    return s
  }
  doc.descendants((node, pos) => {
    if (!node.isInline) return
    const text = node.isText ? node.text : ' '
    for (const m of node.marks) {
      if (m.type.name !== 'ins' && m.type.name !== 'del' && m.type.name !== 'fmt') continue
      const s = note(m.attrs, pos)
      s.to = pos + node.nodeSize
      if (m.type.name === 'ins') s.added += text
      else if (m.type.name === 'del') s.removed += text
      else {
        for (const c of JSON.parse(m.attrs.ch || '[]')) {
          const label = (c.to && c.from ? 'Change ' : c.to ? 'Add ' : 'Remove ') + (fmtNames[c.type] || c.type)
          if (!s.format.includes(label)) s.format.push(label)
        }
        if (!s.quote) s.quote = ''
        s.quote += text
      }
    }
  })
  return [...byId.values()].sort((a, b) => a.from - b.from)
}

// settle accepts or rejects suggestions: one by id, or every one when id is
// null. It works backwards through the document so positions stay true.
export function settle(editor, id, accept) {
  const { state } = editor
  const { ins, del, fmt } = state.schema.marks
  const spans = []
  state.doc.descendants((node, pos) => {
    if (!node.isInline) return
    for (const m of node.marks) {
      if ((m.type === ins || m.type === del || m.type === fmt) && (id === null || m.attrs.id === id)) spans.push({ from: pos, to: pos + node.nodeSize, mark: m })
    }
  })
  if (!spans.length) return false
  const tr = state.tr
  // Marks first (they never move text), then removals from the end.
  const cuts = []
  for (const s of spans) {
    const type = s.mark.type
    if (type === fmt) {
      if (!accept) {
        for (const c of JSON.parse(s.mark.attrs.ch || '[]')) {
          const mt = state.schema.marks[c.type]
          if (!mt) continue
          if (c.to) tr.removeMark(s.from, s.to, mt)
          if (c.from) tr.addMark(s.from, s.to, mt.create(c.from.attrs))
        }
      }
      tr.removeMark(s.from, s.to, s.mark)
    } else if ((type === ins) === accept) {
      tr.removeMark(s.from, s.to, s.mark)
    } else {
      cuts.push(s)
    }
  }
  cuts.sort((a, b) => b.from - a.from)
  let last = Infinity
  for (const s of cuts) {
    // Text that is both a proposed addition and a proposed removal can be
    // listed twice; cut it once.
    if (s.to > last) continue
    tr.delete(s.from, s.to)
    last = s.from
  }
  editor.view.dispatch(tr.setMeta(suggestKey, { skip: true }).scrollIntoView())
  return true
}

// Where a comment thread or suggestion sits, for scrolling to it.
export function anchorOf(doc, kind, id) {
  let found = null
  doc.descendants((node, pos) => {
    if (found || !node.isInline) return
    for (const m of node.marks) {
      if (m.attrs.id === id && (kind === 'comment' ? m.type.name === 'comment' : m.type.name !== 'comment')) found = pos
    }
  })
  return found
}

// commentRanges maps each thread id to the text it is anchored to.
export function commentRanges(doc) {
  const out = new Map()
  doc.descendants((node, pos) => {
    if (!node.isInline) return
    for (const m of node.marks) {
      if (m.type.name !== 'comment') continue
      const r = out.get(m.attrs.id)
      const text = node.isText ? node.text : ' '
      if (r) {
        r.to = pos + node.nodeSize
        r.quote += text
      } else out.set(m.attrs.id, { from: pos, to: pos + node.nodeSize, quote: text })
    }
  })
  return out
}
