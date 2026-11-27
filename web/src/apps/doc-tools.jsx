// The document's dialogs and floating bars: page setup, word count, find
// and replace, a footnote's words, and a selected picture's layout.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { ChevronUp, ChevronDown, X, CaseSensitive, WholeWord, Trash2 } from 'lucide-preact'
import { Button, IconButton, Modal, Field } from '../ui.jsx'
import { keys } from '../menubar.jsx'
import { cx } from '../lib/util.js'
import { toast } from '../lib/store.js'
import { papers, pageDefaults, readPage, setPage } from './doc-page.js'
import { findKey, counts } from './doc-find.js'
import { imageSizes, shortcutList } from './doc-menus.jsx'

export function PageSetup({ ydoc, title, onClose, readOnly }) {
  const [p, setP] = useState(() => readPage(ydoc))
  const header = useRef()
  const footer = useRef()
  const set = (k, v) => setP({ ...p, [k]: v })
  const token = (ref, key, t) => {
    const el = ref.current
    const at = el ? el.selectionStart : p[key].length
    const v = p[key].slice(0, at) + t + p[key].slice(el ? el.selectionEnd : at)
    set(key, v)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(at + t.length, at + t.length)
    })
  }
  const apply = () => {
    setPage(ydoc, p)
    onClose()
  }
  const margin = (k, label) => (
    <label class="ps-margin">
      <span>{label}</span>
      <input class="input" type="number" min="0" max="100" step="1" aria-label={`${label} margin (mm)`} value={p[k]} disabled={readOnly}
        onInput={(e) => set(k, e.target.value === '' ? '' : +e.target.value)} />
    </label>
  )
  const hf = (key, ref, label) => (
    <Field label={label}>
      <div class="ps-hf">
        <input class="input" ref={ref} aria-label={label} placeholder={key === 'footer' ? 'e.g. Page {page} of {pages}' : 'e.g. {title}'} value={p[key]} disabled={readOnly}
          onInput={(e) => set(key, e.target.value)} />
        <select class="select" aria-label={`${label} alignment`} value={p[key + 'Align']} disabled={readOnly} onChange={(e) => set(key + 'Align', e.target.value)}>
          <option value="left">Left</option>
          <option value="center">Centre</option>
          <option value="right">Right</option>
        </select>
      </div>
      {!readOnly && (
        <div class="ps-tokens">
          <button type="button" class="chip" onClick={() => token(ref, key, '{page}')}>+ Page number</button>
          <button type="button" class="chip" onClick={() => token(ref, key, '{pages}')}>+ Page count</button>
          <button type="button" class="chip" onClick={() => token(ref, key, '{title}')}>+ Title</button>
        </div>
      )}
    </Field>
  )
  return (
    <Modal title="Page setup" width={520} onClose={onClose} footer={readOnly ? <Button onClick={onClose}>Close</Button> : <>
      <Button onClick={() => setP({ ...pageDefaults })}>Reset to defaults</Button>
      <span class="grow" />
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" onClick={apply}>Apply</Button>
    </>}>
      <div class="ps-row">
        <Field label="Paper size">
          <select class="select" aria-label="Paper size" value={p.size} disabled={readOnly} onChange={(e) => set('size', e.target.value)}>
            {Object.entries(papers).map(([k, v]) => <option key={k} value={k}>{v.label} ({v.w} × {v.h} mm)</option>)}
          </select>
        </Field>
        <Field label="Orientation">
          <div class="seg" role="radiogroup" aria-label="Orientation">
            {['portrait', 'landscape'].map((o) => (
              <button key={o} type="button" role="radio" aria-checked={p.orientation === o} class={cx('seg-btn', p.orientation === o && 'on')} disabled={readOnly} onClick={() => set('orientation', o)}>
                {o === 'portrait' ? 'Portrait' : 'Landscape'}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <Field label="Margins (millimetres)">
        <div class="ps-margins">{margin('top', 'Top')}{margin('bottom', 'Bottom')}{margin('left', 'Left')}{margin('right', 'Right')}</div>
      </Field>
      {hf('header', header, 'Header')}
      {hf('footer', footer, 'Footer')}
      <div class="field-hint">Headers and footers appear on every printed page and in Word and OpenDocument files. {'{page}'} is the page number, {'{pages}'} the number of pages{title ? ', {title} the title' : ''}.</div>
    </Modal>
  )
}

export function WordCount({ editor, onClose, show, onShow }) {
  const doc = editor.state.doc
  const { from, to, empty } = editor.state.selection
  const all = counts(doc.textBetween(0, doc.content.size, '\n', ' '))
  const sel = empty ? null : counts(doc.textBetween(from, to, '\n', ' '))
  const row = (label, k) => (
    <tr key={k}><th>{label}</th>{sel && <td>{sel[k].toLocaleString()}</td>}<td>{all[k].toLocaleString()}</td></tr>
  )
  return (
    <Modal title="Word count" width={420} onClose={onClose} footer={<Button kind="primary" onClick={onClose}>OK</Button>}>
      <table class="wc-table">
        <thead><tr><th />{sel && <th>Selection</th>}<th>Document</th></tr></thead>
        <tbody>
          {row('Words', 'words')}
          {row('Characters', 'characters')}
          {row('Characters excluding spaces', 'charactersNoSpaces')}
        </tbody>
      </table>
      <label class="check"><input type="checkbox" checked={show} onChange={(e) => onShow(e.target.checked)} /> Show word count while typing</label>
    </Modal>
  )
}

export function Shortcuts({ onClose }) {
  return (
    <Modal title="Keyboard shortcuts" width={480} onClose={onClose} footer={<Button kind="primary" onClick={onClose}>OK</Button>}>
      <table class="wc-table shortcuts">
        <tbody>{shortcutList.map(([what, combo]) => <tr key={what}><th>{what}</th><td><kbd>{combo.split(' · ').map((k) => /\+/.test(k) ? keys(k) : k).join(' · ')}</kbd></td></tr>)}</tbody>
      </table>
    </Modal>
  )
}

// The find bar sits over the top right of the page, as in most editors.
export function FindBar({ editor, replace: withReplace, canReplace, onClose, tick }) {
  const f = findKey.getState(editor.state)
  const [q, setQ] = useState(f.query || '')
  const [r, setR] = useState('')
  const [showReplace, setShowReplace] = useState(withReplace)
  const [opts, setOpts] = useState({ matchCase: f.matchCase, wholeWord: f.wholeWord })
  const input = useRef()
  useEffect(() => setShowReplace(withReplace || showReplace), [withReplace])
  useLayoutEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [withReplace])
  useEffect(() => {
    editor.commands.setFind({ query: q, ...opts })
  }, [q, opts.matchCase, opts.wholeWord])
  useEffect(() => () => editor.commands.closeFind(), [])
  const n = f.matches.length
  const close = () => {
    onClose()
    editor.view.focus()
  }
  const key = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      editor.commands.findNext(e.shiftKey ? -1 : 1)
    }
  }
  return (
    <div class="find-bar" role="search" aria-label="Find and replace" onKeyDown={key}>
      <div class="find-row">
        <input class="input" ref={input} aria-label="Find" placeholder="Find in document" value={q} onInput={(e) => setQ(e.target.value)} />
        <span class="find-count" aria-live="polite">{q ? (n ? `${f.current >= 0 ? f.current + 1 : 0} of ${n}` : 'No results') : ''}</span>
        <IconButton icon={CaseSensitive} label="Match case" active={opts.matchCase} onClick={() => setOpts({ ...opts, matchCase: !opts.matchCase })} />
        <IconButton icon={WholeWord} label="Whole words only" active={opts.wholeWord} onClick={() => setOpts({ ...opts, wholeWord: !opts.wholeWord })} />
        <IconButton icon={ChevronUp} label="Previous" disabled={!n} onClick={() => editor.commands.findNext(-1)} />
        <IconButton icon={ChevronDown} label="Next" disabled={!n} onClick={() => editor.commands.findNext(1)} />
        <IconButton icon={X} label="Close" onClick={close} />
      </div>
      {canReplace && (showReplace ? (
        <div class="find-row">
          <input class="input" aria-label="Replace with" placeholder="Replace with" value={r} onInput={(e) => setR(e.target.value)} />
          <Button disabled={!n} onClick={() => editor.commands.replaceCurrent(r)}>Replace</Button>
          <Button disabled={!n} onClick={() => {
            editor.commands.replaceAll(r)
            toast(n === 1 ? 'Replaced 1 match' : `Replaced ${n} matches`)
          }}>Replace all</Button>
        </div>
      ) : <button type="button" class="link-btn find-more" onClick={() => setShowReplace(true)}>Replace…</button>)}
    </div>
  )
}

// Where on the screen a document position is, relative to an element.
function placeAt(editor, pos, box) {
  try {
    const at = editor.view.coordsAtPos(pos)
    const r = box.getBoundingClientRect()
    return { top: at.bottom - r.top + 6, left: Math.max(8, Math.min(at.left - r.left - 20, r.width - 340)) }
  } catch {
    return null
  }
}

// A footnote's words, edited in a small box under its number.
export function FootnoteBox({ editor, pos, box, canEdit, onDone }) {
  const node = editor.state.doc.nodeAt(pos)
  const [text, setText] = useState(node?.attrs.text || '')
  const area = useRef()
  const place = box && placeAt(editor, pos, box)
  useLayoutEffect(() => {
    if (canEdit && !node?.attrs.text) area.current?.focus()
  }, [pos])
  if (!node || !place) return null
  const number = editor.state.doc.content.size && footIndex(editor.state.doc, pos)
  const save = () => {
    if (text !== node.attrs.text) editor.commands.setFootnote(pos, text)
  }
  return (
    <div class="fn-box" style={place} onMouseDown={(e) => e.stopPropagation()}>
      <div class="fn-box-head">Footnote {number}</div>
      <textarea class="textarea" ref={area} rows={3} aria-label={`Footnote ${number}`} value={text} readOnly={!canEdit} placeholder="Write the footnote"
        onInput={(e) => setText(e.target.value)} onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
            e.preventDefault()
            save()
            onDone(true)
          }
        }} />
      {canEdit && (
        <div class="fn-box-foot">
          <IconButton icon={Trash2} label="Delete footnote" onClick={() => { editor.chain().focus().deleteRange({ from: pos, to: pos + 1 }).run(); onDone(false) }} />
          <span class="grow" />
          <Button kind="primary" onClick={() => { save(); onDone(true) }}>Done</Button>
        </div>
      )}
    </div>
  )
}

function footIndex(doc, pos) {
  let n = 0
  let found = 0
  doc.descendants((node, p) => {
    if (found) return false
    if (node.type.name === 'footnote' && !node.marks.some((m) => m.type.name === 'del')) {
      n++
      if (p === pos) found = n
    }
  })
  return found
}

// The bar over a selected picture: its layout and size.
export function PictureBar({ editor, picture, box, onLayout }) {
  const place = box && placeAt(editor, picture.pos, box)
  if (!place) return null
  const layout = picture.inline ? 'inline' : picture.wrap
  const opt = (value, label) => <option value={value}>{label}</option>
  return (
    <div class="pic-bar" style={{ top: Math.max(4, place.top - 54), left: place.left }} onMouseDown={(e) => e.target.closest('select') || e.preventDefault()}>
      <select class="select" aria-label="Picture layout" value={layout} onChange={(e) => onLayout({ layout: e.target.value })}>
        {opt('inline', 'In line with text')}{opt('break', 'Break text')}{opt('left', 'Wrap text, on the left')}{opt('right', 'Wrap text, on the right')}
      </select>
      <select class="select" aria-label="Picture size" value={picture.width || ''} onChange={(e) => onLayout({ width: e.target.value || null })}>
        {imageSizes.map(([label, w]) => <option key={label} value={w || ''}>{label}</option>)}
        {picture.width && !imageSizes.some(([, w]) => w === picture.width) && <option value={picture.width}>{picture.width}</option>}
      </select>
      {layout === 'break' && (
        <select class="select" aria-label="Picture position" value={picture.align || 'left'} onChange={(e) => onLayout({ align: e.target.value })}>
          {opt('left', 'Left')}{opt('center', 'Centre')}{opt('right', 'Right')}
        </select>
      )}
    </div>
  )
}
