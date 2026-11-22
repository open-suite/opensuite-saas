// The review rail beside a document: comment threads and suggestions, in the
// order they appear in the text.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Check, X, MoreHorizontal, Pencil, Trash2, RotateCcw, MessageSquare, CheckCheck } from 'lucide-preact'
import './side-panel.css'
import './doc-review.css'
import { people, peopleById } from '../lib/store.js'
import { cx, when, whenFull, colorFor } from '../lib/util.js'
import { Avatar, Button, IconButton, Menu } from '../ui.jsx'
import { suggestKey, suggestions, settle, commentRanges } from './doc-marks.js'
import { readThreads, addThread, addReply, editEntry, removeReply, removeThread, setResolved } from './doc-comments.js'

const safe = (id) => /^[a-z0-9]{4,32}$/.test(id || '')
const clip = (s, n = 90) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

// reviewItems is everything the rail lists, for the count on its button too.
export function reviewItems(editor, ydoc) {
  const ranges = commentRanges(editor.state.doc)
  const threads = readThreads(ydoc).map((t) => ({ kind: 'comment', ...t, range: ranges.get(t.id) || null }))
  const open = threads.filter((t) => !t.resolved)
  const sugg = suggestions(editor.state.doc).map((s) => ({ kind: 'suggestion', ...s }))
  const pos = (x) => (x.kind === 'comment' ? x.range?.from ?? Infinity : x.from)
  return {
    open: [...open, ...sugg].sort((a, b) => pos(a) - pos(b) || a.at - b.at),
    resolved: threads.filter((t) => t.resolved).sort((a, b) => b.resolved.at - a.resolved.at),
    suggestions: sugg.length,
  }
}

// What the caret is resting in, so the matching card can light up.
export function reviewAtCaret(editor, ydoc) {
  const { $from } = editor.state.selection
  const marks = [...$from.marks(), ...($from.nodeAfter?.marks || [])]
  for (const m of marks) {
    if (m.type.name === 'ins' || m.type.name === 'del' || m.type.name === 'fmt') return { kind: 'suggestion', id: m.attrs.id }
  }
  for (const m of marks) {
    if (m.type.name === 'comment' && ydoc.getMap('comments').has(m.attrs.id) && !ydoc.getMap('comments').get(m.attrs.id).get('resolved')) return { kind: 'comment', id: m.attrs.id }
  }
  return null
}

// startThread marks the selected text and returns the new thread's id; the
// thread itself is created when its first comment is posted.
export function startThread(editor, id) {
  const { from, to, empty } = editor.state.selection
  if (empty) return null
  const quote = editor.state.doc.textBetween(from, to, ' ')
  editor.view.dispatch(editor.state.tr.addMark(from, to, editor.schema.marks.comment.create({ id })).setMeta(suggestKey, { skip: true }))
  return { id, quote }
}

export function unmarkThread(editor, id) {
  const tr = editor.state.tr
  editor.state.doc.descendants((node, pos) => {
    const m = node.marks.find((x) => x.type.name === 'comment' && x.attrs.id === id)
    if (m) tr.removeMark(pos, pos + node.nodeSize, m)
  })
  if (tr.steps.length) editor.view.dispatch(tr.setMeta(suggestKey, { skip: true }))
}

// The highlight for open threads is plain CSS keyed on thread ids, so that a
// thread that is resolved or deleted simply stops being painted.
export function ReviewStyle({ items, active, pending }) {
  const ids = items.open.filter((x) => x.kind === 'comment' && safe(x.id)).map((x) => x.id)
  if (pending && safe(pending)) ids.push(pending)
  let css = ids.length ? ids.map((id) => `.paper .cmt[data-c="${id}"]`).join(',') + '{background:var(--cmt);border-bottom:2px solid var(--cmt-line)}' : ''
  const on = pending ? { kind: 'comment', id: pending } : active
  if (on && safe(on.id)) {
    if (on.kind !== 'comment') css += `.paper [data-s="${on.id}"]{background:color-mix(in srgb,var(--who) 22%,transparent)}`
    else if (ids.includes(on.id)) css += `.paper .cmt[data-c="${on.id}"]{background:var(--cmt-on)}`
  }
  return <style>{css}</style>
}

function Text({ text, mentions }) {
  const names = (mentions || []).map((id) => peopleById.value[id]?.name).filter(Boolean).sort((a, b) => b.length - a.length)
  if (!names.length) return <p class="rv-text">{text}</p>
  const parts = []
  let rest = text
  while (rest) {
    let at = -1
    let hit = ''
    for (const n of names) {
      const i = rest.indexOf('@' + n)
      if (i >= 0 && (at < 0 || i < at)) { at = i; hit = '@' + n }
    }
    if (at < 0) { parts.push(rest); break }
    if (at) parts.push(rest.slice(0, at))
    parts.push(<span class="mention">{hit}</span>)
    rest = rest.slice(at + hit.length)
  }
  return <p class="rv-text">{parts}</p>
}

// A text box that offers colleagues after "@".
function Composer({ initial = '', initialMentions = [], placeholder, action, onSubmit, onCancel, focus = true }) {
  const [text, setText] = useState(initial)
  const [mentions, setMentions] = useState(initialMentions)
  const [pick, setPick] = useState(null) // { q, start, i }
  const box = useRef()
  useLayoutEffect(() => {
    if (!focus) return
    box.current.focus({ preventScroll: true })
    box.current.setSelectionRange(box.current.value.length, box.current.value.length)
  }, [])
  useLayoutEffect(() => {
    const el = box.current
    el.style.height = 'auto'
    el.style.height = Math.min(180, el.scrollHeight + 2) + 'px'
  }, [text])
  const found = pick ? people.value.filter((p) => p.status === 'active' && p.name.toLowerCase().includes(pick.q)).slice(0, 6) : []
  const look = (el) => {
    const m = /(^|\s)@([^\s@][^@\n]{0,30})?$/.exec(el.value.slice(0, el.selectionStart))
    setPick(m ? { q: (m[2] || '').toLowerCase(), start: el.selectionStart - (m[2] || '').length - 1, i: 0 } : null)
  }
  const choose = (p) => {
    const el = box.current
    const next = text.slice(0, pick.start) + '@' + p.name + ' ' + text.slice(el.selectionStart)
    const caret = pick.start + p.name.length + 2
    // Written to the box at once, with the caret after the name, so that
    // whatever is typed next lands there even before the next frame.
    el.value = next
    el.setSelectionRange(caret, caret)
    setText(next)
    setMentions([...new Set([...mentions, p.id])])
    setPick(null)
  }
  const submit = () => {
    const body = text.trim()
    if (body) onSubmit(body, mentions.filter((id) => peopleById.value[id] && body.includes('@' + peopleById.value[id].name)))
  }
  const keys = (e) => {
    if (pick && found.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setPick({ ...pick, i: (pick.i + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length }); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(found[pick.i]); return }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPick(null); return }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel?.() }
  }
  return (
    <div class="rv-compose">
      <textarea ref={box} class="textarea" rows={1} placeholder={placeholder} value={text}
        onInput={(e) => { setText(e.target.value); look(e.target) }} onKeyDown={keys} onBlur={() => setTimeout(() => setPick(null), 150)} />
      {pick && found.length > 0 && (
        <div class="menu rv-people" role="listbox">
          {found.map((p, i) => (
            <button type="button" key={p.id} role="option" aria-selected={i === pick.i} class={cx('menu-item', i === pick.i && 'hover')} onMouseDown={(e) => { e.preventDefault(); choose(p) }}>
              <Avatar name={p.name} id={p.id} size={22} /><span>{p.name}</span>
            </button>
          ))}
        </div>
      )}
      {(text.trim() || onCancel) && (
        <div class="rv-actions">
          {onCancel && <Button kind="ghost" onClick={onCancel}>Cancel</Button>}
          <Button kind="primary" disabled={!text.trim()} onClick={submit}>{action}</Button>
        </div>
      )}
    </div>
  )
}

function Entry({ e, me, canManage, onEdit, onDelete, deleteLabel = 'Delete', extra }) {
  const [editing, setEditing] = useState(false)
  const own = e.by === me.id
  return (
    <div class="rv-entry">
      <Avatar name={e.name} id={e.by} size={26} />
      <div class="grow">
        <div class="rv-head">
          <span class="rv-name ellipsis">{e.name}</span>
          <span class="rv-when" title={whenFull(e.at)}>{when(e.at)}{e.edited ? ' · edited' : ''}</span>
          <span class="grow" />
          {extra}
          {(own || canManage) && !editing && (
            <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label="More" size={16} class="side-icon" />} items={[
              own && { label: 'Edit', icon: Pencil, onSelect: () => setEditing(true) },
              { label: deleteLabel, icon: Trash2, danger: true, onSelect: onDelete },
            ]} />
          )}
        </div>
        {editing
          ? <Composer initial={e.text} initialMentions={e.mentions} action="Save" onSubmit={(t, m) => { onEdit(t, m); setEditing(false) }} onCancel={() => setEditing(false)} />
          : <Text text={e.text} mentions={e.mentions} />}
      </div>
    </div>
  )
}

function Thread({ t, me, on, canComment, canManage, ydoc, editor, onPick }) {
  const drop = () => {
    removeThread(ydoc, t.id)
    unmarkThread(editor, t.id)
  }
  return (
    <div class={cx('rv-card', on && 'on', t.resolved && 'done')} data-rv={t.id} onClick={onPick}>
      {t.range ? <div class="rv-quote ellipsis">{clip(t.range.quote)}</div> : <div class="rv-quote gone">The text this was about has been removed</div>}
      <Entry e={t} me={me} canManage={canManage} onEdit={(text, m) => editEntry(ydoc, t.id, null, text, m)} onDelete={drop} deleteLabel={t.replies.length ? 'Delete thread' : 'Delete'} extra={canComment && (
        t.resolved
          ? <IconButton icon={RotateCcw} label="Reopen" size={16} class="side-icon" onClick={(e) => { e.stopPropagation(); setResolved(ydoc, t.id, me, false) }} />
          : <IconButton icon={Check} label="Resolve" size={16} class="side-icon" onClick={(e) => { e.stopPropagation(); setResolved(ydoc, t.id, me, true) }} />
      )} />
      {t.replies.map((r) => (
        <Entry key={r.id} e={r} me={me} canManage={canManage} onEdit={(text, m) => editEntry(ydoc, t.id, r.id, text, m)} onDelete={() => removeReply(ydoc, t.id, r.id)} />
      ))}
      {t.resolved && <div class="rv-note">Resolved by {t.resolved.name} · {when(t.resolved.at)}</div>}
      {canComment && on && !t.resolved && (
        <Composer key={t.id + t.replies.length} placeholder="Reply, or @ a colleague" action="Reply" focus={false} onSubmit={(text, m) => addReply(ydoc, t.id, me, text, m)} />
      )}
    </div>
  )
}

function Suggestion({ s, me, on, canEdit, editor, onPick }) {
  const quote = (text) => <q>{clip(text.trim() || '(space)', 70)}</q>
  let what
  if (s.added && s.removed) what = <>Replace {quote(s.removed)} with {quote(s.added)}</>
  else if (s.added) what = <>Add {quote(s.added)}</>
  else if (s.removed) what = <>Remove {quote(s.removed)}</>
  else what = <>{s.format.join(', ')}: {quote(s.quote || '')}</>
  return (
    <div class={cx('rv-card', 'rv-sug', on && 'on')} data-rv={s.id} style={{ '--who': colorFor(s.by || '') }} onClick={onPick}>
      <div class="rv-entry">
        <Avatar name={s.name || '?'} id={s.by} size={26} />
        <div class="grow">
          <div class="rv-head">
            <span class="rv-name ellipsis">{s.name}</span>
            <span class="rv-when" title={whenFull(s.at)}>{when(s.at)}</span>
            <span class="grow" />
            {canEdit && <IconButton icon={Check} label="Accept" size={16} class="side-icon ok" onClick={(e) => { e.stopPropagation(); settle(editor, s.id, true) }} />}
            {(canEdit || s.by === me.id) && <IconButton icon={X} label="Reject" size={16} class="side-icon" onClick={(e) => { e.stopPropagation(); settle(editor, s.id, false) }} />}
          </div>
          <p class="rv-text rv-what">{what}</p>
        </div>
      </div>
    </div>
  )
}

export function Review({ editor, ydoc, me, role, items, active, onActive, pending, onPending, onClose, tick }) {
  const [showDone, setShowDone] = useState(false)
  const list = useRef()
  const canEdit = role === 'owner' || role === 'edit'
  const canComment = canEdit || role === 'comment'

  // Bring the lit card into view when the caret moves into its text.
  useEffect(() => {
    const id = pending?.id || active?.id
    if (!id || !safe(id)) return
    list.current?.querySelector(`[data-rv="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active?.id, pending?.id])

  const pick = (kind, id) => () => {
    onActive({ kind, id })
    if (!safe(id)) return
    document.querySelector(kind === 'comment' ? `.paper .cmt[data-c="${id}"]` : `.paper [data-s="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  const total = items.open.length
  return (
    <aside class="review" aria-label="Comments and suggestions">
      <header class="side-top">
        <h2>Comments{total > 0 && <span class="badge">{total}</span>}</h2>
        <span class="grow" />
        {canEdit && items.suggestions > 0 && (
          <Menu align="right" trigger={<IconButton icon={CheckCheck} label="All suggestions" />} items={[
            { label: `Accept all ${items.suggestions} suggestions`, icon: Check, onSelect: () => settle(editor, null, true) },
            { label: 'Reject all suggestions', icon: X, danger: true, onSelect: () => settle(editor, null, false) },
          ]} />
        )}
        <IconButton icon={X} label="Close comments" onClick={onClose} />
      </header>
      <div class="rv-list" ref={list}>
        {pending && (
          <div class="rv-card on" data-rv={pending.id}>
            <div class="rv-quote ellipsis">{clip(pending.quote)}</div>
            <Composer placeholder="Comment, or @ a colleague" action="Comment"
              onSubmit={(text, m) => { addThread(ydoc, pending.id, me, text, m); onActive({ kind: 'comment', id: pending.id }); onPending(null, true) }}
              onCancel={() => onPending(null, false)} />
          </div>
        )}
        {items.open.map((x) => x.kind === 'comment'
          ? <Thread key={x.id} t={x} me={me} on={active?.id === x.id} canComment={canComment} canManage={canEdit} ydoc={ydoc} editor={editor} onPick={pick('comment', x.id)} />
          : <Suggestion key={x.id} s={x} me={me} on={active?.id === x.id} canEdit={canEdit} editor={editor} onPick={pick('suggestion', x.id)} />)}
        {!pending && total === 0 && (
          <div class="side-empty">
            <MessageSquare size={22} />
            <p>{canComment ? 'Select some text and choose Comment to start a conversation.' : 'No comments on this document.'}</p>
          </div>
        )}
        {items.resolved.length > 0 && (
          <button type="button" class="rv-more" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} {items.resolved.length} resolved</button>
        )}
        {showDone && items.resolved.map((x) => (
          <Thread key={x.id} t={x} me={me} on={active?.id === x.id} canComment={canComment} canManage={canEdit} ydoc={ydoc} editor={editor} onPick={() => onActive({ kind: 'comment', id: x.id })} />
        ))}
      </div>
    </aside>
  )
}
