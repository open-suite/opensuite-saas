// The document editor. The document is a CRDT held on the device: it opens
// from local storage, edits apply locally at once, and the server is a relay
// and backup. Losing the connection changes nothing except the status label.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Placeholder, CharacterCount } from '@tiptap/extensions'
import { yXmlFragmentToProseMirrorRootNode, yUndoPluginKey } from '@tiptap/y-tiptap'
import { NodeSelection } from '@tiptap/pm/state'
import {
  ArrowLeft, Undo2, Redo2, Bold, Italic, Underline, Strikethrough, Highlighter, Baseline, Link2, List, ListOrdered, ListChecks,
  AlignLeft, AlignCenter, AlignRight, AlignJustify, Table, ImagePlus, RemoveFormatting, Users, FileX2, MessageSquarePlus, MessageSquare,
  IndentIncrease, IndentDecrease, Rows3, Superscript,
} from 'lucide-preact'
import './editor.css'
import { user, docs, upsertDoc, toast, confirmed } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { api, post, refreshBoot } from '../lib/api.js'
import { DocSocket, fetchState } from '../lib/sync.js'
import { findDoc, renameDoc, trashDoc, convert, whenCreated } from '../lib/docs.js'
import { colorFor, cx, debounce, download as saveFile, pickFile, newId } from '../lib/util.js'
import { Avatar, Button, Empty, IconButton, Menu, Modal, Popover, Swatches, inkColors, markColors, keepFocus } from '../ui.jsx'
import { MenuBar } from '../menubar.jsx'
import { ShareDialog } from './docs.jsx'
import { suggestKey, isSuggesting, setSuggesting } from './doc-marks.js'
import { formatExtensions, docText, exportCopy, importCopy, fonts, fontSizes } from './doc-format.js'
import { setImageLayout, lineHeights } from './doc-layout.js'
import { FindReplace } from './doc-find.js'
import { readPage, setPage, adoptPage, pageFromHTML, pageMap, pageSize, printCSS, fillTokens, pageDefaults, MM } from './doc-page.js'
import { docMenus, tableSizes, lineLabel } from './doc-menus.jsx'
import { PageSetup, WordCount, Shortcuts, FindBar, FootnoteBox, PictureBar } from './doc-tools.jsx'
import { adoptThreads } from './doc-comments.js'
import { Review, ReviewStyle, reviewItems, reviewAtCaret, startThread, unmarkThread } from './doc-review.jsx'

const REMOTE = 'remote'

function clientIds(update) {
  const dec = decoding.createDecoder(update)
  const n = decoding.readVarUint(dec)
  const ids = []
  for (let i = 0; i < n; i++) {
    ids.push(decoding.readVarUint(dec))
    decoding.readVarUint(dec)
    decoding.readVarString(dec)
  }
  return ids
}

async function uploadImage(file) {
  const res = await api('POST', '/api/blobs?name=' + encodeURIComponent(file.name), file, { type: file.type })
  return res.url
}

// Documents recently used on this device, held in memory so that opening one
// paints its content in the same frame as the click.
const warm = new Map() // doc id -> Yjs state

function keepWarm(id, state) {
  warm.delete(id)
  warm.set(id, state)
  if (warm.size > 24) warm.delete(warm.keys().next().value)
}

function extensionsFor(ydoc, awareness, who) {
  return [
    ...formatExtensions(who),
    Collaboration.configure({ document: ydoc }),
    CollaborationCaret.configure({
      provider: { awareness },
      user: who,
      render: (u) => {
        const caret = document.createElement('span')
        caret.className = 'caret'
        caret.style.borderColor = u.color
        const tag = document.createElement('span')
        tag.style.background = u.color
        tag.textContent = u.name
        caret.append(tag)
        return caret
      },
    }),
    Placeholder.configure({ placeholder: 'Start writing…' }),
    CharacterCount,
    FindReplace,
  ]
}

let rehearsed = false
// rehearse builds and discards one editor so that the first real one runs on
// code the browser has already compiled.
function rehearse() {
  if (rehearsed) return
  rehearsed = true
  const tmp = new Y.Doc()
  const aw = new Awareness(tmp)
  try {
    new Editor({ element: document.createElement('div'), extensions: extensionsFor(tmp, aw, { name: '', color: '#000' }) }).destroy()
  } catch {}
  aw.destroy()
  tmp.destroy()
}

// prewarm runs while the browser is idle: the most recent documents are read
// from the device into memory, and any that this device has never held are
// fetched and stored, so a first open here is as fast as any other.
export async function prewarm() {
  rehearse()
  let stored
  try {
    stored = new Set((await indexedDB.databases()).map((d) => d.name))
  } catch {
    return
  }
  for (const d of docs.value.filter((x) => x.kind === 'doc' && !x.trashed).slice(0, 8)) {
    if (warm.has(d.id)) continue
    const name = 'os-doc-' + d.id
    const tmp = new Y.Doc()
    const store = new IndexeddbPersistence(name, tmp)
    try {
      await store.whenSynced
      if (!stored.has(name)) {
        const state = await fetchState(d.id)
        if (state.base.length) Y.applyUpdate(tmp, state.base)
        for (const u of state.updates) Y.applyUpdate(tmp, u)
      }
      if (!warm.has(d.id)) keepWarm(d.id, Y.encodeStateAsUpdate(tmp))
    } catch {}
    await store.destroy()
    tmp.destroy()
  }
}

// Open a document: local copy first, then the live connection.
function openDocument(id, element, me, role, onChange) {
  const t0 = performance.now()
  const ydoc = new Y.Doc()
  const local = new IndexeddbPersistence('os-doc-' + id, ydoc)
  // Applied before the store has opened, so it is shown now and not written
  // back as a duplicate.
  if (warm.has(id)) Y.applyUpdate(ydoc, warm.get(id), REMOTE)
  const awareness = new Awareness(ydoc)
  const color = colorFor(me.id)
  awareness.setLocalStateField('user', { name: me.name, color, id: me.id })

  const t1 = performance.now()
  const editor = new Editor({
    element,
    extensions: extensionsFor(ydoc, awareness, { name: me.name, color, id: me.id }),
    editorProps: {
      attributes: { class: 'paper', spellcheck: 'true' },
      handlePaste: (view, e) => insertFiles([...(e.clipboardData?.files || [])]),
      handleDrop: (view, e) => insertFiles([...(e.dataTransfer?.files || [])]),
    },
    onTransaction: () => onChange(),
  })
  // Where opening a document spends its time, for tests/perf.cjs.
  window.__docTiming = { state: t1 - t0, editor: performance.now() - t1 }

  function insertFiles(files) {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return false
    images.forEach(async (f) => {
      try {
        editor.chain().focus().setImage({ src: await uploadImage(f), alt: f.name }).run()
      } catch (e) {
        toast(e.message, 'error')
      }
    })
    return true
  }

  // --- sync ---------------------------------------------------------------
  let history = [] // everything the server sent during the first replay
  let first = true
  const peers = new Map() // server peer id -> awareness client ids
  let queue = []
  let timer = null
  // mode: 'edit' changes the text, 'suggest' proposes changes, 'view' reads
  // the document as it would be with every suggestion accepted. Someone who
  // may only comment can suggest but never edit directly.
  const state = { online: false, canEdit: true, mode: role === 'comment' ? 'suggest' : 'edit' }
  const applyMode = () => {
    const editable = state.canEdit && role !== 'view' && state.mode !== 'view'
    if (editor.isEditable !== editable) editor.setEditable(editable)
    if (isSuggesting(editor) !== (state.mode === 'suggest')) setSuggesting(editor, state.mode === 'suggest')
  }
  applyMode()

  const flush = () => {
    timer = null
    if (!queue.length) return
    sock.sendUpdate(queue.length === 1 ? queue[0] : Y.mergeUpdates(queue))
    queue = []
    onChange()
  }
  ydoc.on('update', (update, origin) => {
    if (origin === REMOTE || origin === local) return
    queue.push(update)
    timer ??= setTimeout(flush, 50)
  })

  const announce = () => sock.sendAwareness(encodeAwarenessUpdate(awareness, [ydoc.clientID]))
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin !== REMOTE) sock.sendAwareness(encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]))
    onChange()
  })

  const sock = new DocSocket(id, {
    hello: (peer, canEdit) => {
      state.canEdit = canEdit
      applyMode()
    },
    base: (seq, bytes) => {
      if (!bytes.length) return
      Y.applyUpdate(ydoc, bytes, REMOTE)
      if (first) history.push(bytes)
    },
    update: (seq, bytes) => {
      Y.applyUpdate(ydoc, bytes, REMOTE)
      if (first) history.push(bytes)
    },
    ack: () => onChange(),
    synced: async (seq) => {
      announce()
      if (!first) return
      first = false
      const got = history
      history = []
      // Send whatever this device has that the server lacks: edits made
      // offline in an earlier session.
      await local.whenSynced
      const server = new Y.Doc()
      for (const u of got) Y.applyUpdate(server, u)
      const missing = Y.encodeStateAsUpdate(ydoc, Y.encodeStateVector(server))
      server.destroy()
      if (missing.length > 2) sock.sendUpdate(missing)
      // A long log is folded into one snapshot so the next open is quick.
      else if (got.length > 60) sock.sendSnapshot(seq, Y.encodeStateAsUpdate(ydoc))
    },
    awareness: (peer, bytes) => {
      const known = peers.has(peer)
      try {
        peers.set(peer, clientIds(bytes))
        applyAwarenessUpdate(awareness, bytes, REMOTE)
      } catch {}
      if (!known) announce()
    },
    leave: (peer) => {
      removeAwarenessStates(awareness, peers.get(peer) || [], REMOTE)
      peers.delete(peer)
    },
    title: (title) => {
      const d = findDoc(id)
      if (d && d.title !== title) upsertDoc({ ...d, title })
    },
    status: (online) => {
      state.online = online
      onChange()
    },
  }, 0, whenCreated(id))
  // Search: the socket sends these words to the server's index (lib/sync.js).
  // Read from the document node, which outlives the editor: the last send
  // happens while this view is closing.
  sock.text = () => docText(editor.state.doc)

  // A file chosen in "Import" becomes this document's first content, with
  // the page setup it came with.
  local.whenSynced.then(() => {
    const key = 'os:import:' + id
    const html = sessionStorage.getItem(key)
    if (html && editor.isEmpty) {
      editor.commands.setContent(importCopy(html))
      const page = pageFromHTML(html)
      if (page) setPage(ydoc, page)
    }
    sessionStorage.removeItem(key)
  })

  // Comments and the page setup are shared state outside the text, so they
  // need their own nudge.
  state.rev = 0
  ydoc.getMap('comments').observeDeep(() => {
    state.rev++
    onChange()
  })
  pageMap(ydoc).observe(() => {
    state.rev++
    onChange()
  })

  const onUnload = () => removeAwarenessStates(awareness, [ydoc.clientID], 'unload')
  addEventListener('pagehide', onUnload)

  return {
    editor, awareness, state, ydoc,
    setMode(mode) {
      state.mode = mode
      applyMode()
      onChange()
    },
    saved: () => sock.pending.size === 0 && queue.length === 0,
    close() {
      flush()
      keepWarm(id, Y.encodeStateAsUpdate(ydoc))
      removeEventListener('pagehide', onUnload)
      removeAwarenessStates(awareness, [ydoc.clientID], 'close')
      editor.destroy()
      sock.close()
      local.destroy()
      ydoc.destroy()
    },
  }
}


// A downloaded copy carries its pictures inside.
async function inlinePictures(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const img of doc.querySelectorAll('img[src^="/api/blobs/"]')) {
    try {
      const blob = await (await fetch(img.getAttribute('src'))).blob()
      img.setAttribute('src', await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob) }))
    } catch {}
  }
  return '<!doctype html>' + doc.documentElement.outerHTML
}

const modes = [['edit', 'Editing'], ['suggest', 'Suggesting'], ['view', 'Viewing']]

function ModeSelect({ mode, role, onMode }) {
  return (
    <span class="mode-select">
      <select class="select" aria-label="Mode" value={mode} onChange={(e) => onMode(e.target.value)}>
        {modes.filter(([m]) => m !== 'edit' || role !== 'comment').map(([m, label]) => <option key={m} value={m}>{label}</option>)}
      </select>
    </span>
  )
}

const aligns = [['left', 'Align left', AlignLeft], ['center', 'Centre', AlignCenter], ['right', 'Align right', AlignRight], ['justify', 'Justify', AlignJustify]]

function Toolbar({ editor, mode, role, onMode, a }) {
  const c = () => editor.chain().focus()
  const on = (name, attrs) => editor.isActive(name, attrs)
  const block = on('heading', { level: 1 }) ? 'h1' : on('heading', { level: 2 }) ? 'h2' : on('heading', { level: 3 }) ? 'h3' : 'p'
  const style = editor.getAttributes('textStyle')
  const para = { ...editor.getAttributes('paragraph'), ...editor.getAttributes('heading') }
  // Straight back to the text after a list is used, so the next keystroke
  // lands there.
  const back = () => editor.view.focus()
  const setBlock = (v) => {
    if (v === 'p') editor.chain().setParagraph().run()
    else editor.chain().setHeading({ level: +v[1] }).run()
    back()
  }
  const font = style.fontFamily || ''
  const size = style.fontSize ? parseFloat(style.fontSize) : ''
  const align = aligns.find(([k]) => editor.isActive({ textAlign: k })) || aligns[0]
  const inTable = on('table')
  if (mode === 'view') {
    return (
      <div class="toolbar" role="toolbar" aria-label="Formatting" style={{ minHeight: 43 }} onMouseDown={keepFocus}>
        <span class="muted" style={{ padding: '0 6px', fontSize: 13 }}>Reading the document as it would be with every suggestion accepted.</span>
        <ModeSelect mode={mode} role={role} onMode={onMode} />
      </div>
    )
  }
  return (
    <div class="toolbar" role="toolbar" aria-label="Formatting" onMouseDown={keepFocus}>
      <IconButton icon={Undo2} label="Undo" disabled={!editor.can().undo()} onClick={() => c().undo().run()} />
      <IconButton icon={Redo2} label="Redo" disabled={!editor.can().redo()} onClick={() => c().redo().run()} />
      <span class="sep" />
      <select class="select" aria-label="Text style" value={block} onChange={(e) => setBlock(e.target.value)}>
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>
      <span class="sep" />
      <select class="select tb-font" aria-label="Font" value={font} style={font ? { fontFamily: font } : undefined}
        onChange={(e) => { e.target.value ? editor.chain().setFontFamily(e.target.value).run() : editor.chain().unsetFontFamily().run(); back() }}>
        {fonts.map(([css, name]) => <option key={name} value={css} style={css ? { fontFamily: css } : undefined}>{name}</option>)}
        {font && !fonts.some(([css]) => css === font) && <option value={font}>{font.split(',')[0].replace(/"/g, '')}</option>}
      </select>
      <select class="select tb-size" aria-label="Font size" value={size}
        onChange={(e) => { e.target.value ? editor.chain().setFontSize(e.target.value + 'pt').run() : editor.chain().unsetFontSize().run(); back() }}>
        <option value="">11.5</option>
        {fontSizes.map((n) => <option key={n} value={n}>{n}</option>)}
        {size && !fontSizes.includes(size) && <option value={size}>{size}</option>}
      </select>
      <span class="sep" />
      <IconButton icon={Bold} label="Bold" active={on('bold')} onClick={() => c().toggleBold().run()} />
      <IconButton icon={Italic} label="Italic" active={on('italic')} onClick={() => c().toggleItalic().run()} />
      <IconButton icon={Underline} label="Underline" active={on('underline')} onClick={() => c().toggleUnderline().run()} />
      <IconButton icon={Strikethrough} label="Strikethrough" active={on('strike')} onClick={() => c().toggleStrike().run()} />
      <Popover icon={Baseline} label="Text colour">
        <Swatches colors={inkColors} clear="Default colour" onPick={(col) => (col ? c().setColor(col).run() : c().unsetColor().run())} />
      </Popover>
      <Popover icon={Highlighter} label="Highlight">
        <Swatches colors={markColors} clear="No highlight" onPick={(col) => (col ? c().setHighlight({ color: col }).run() : c().unsetHighlight().run())} />
      </Popover>
      <span class="sep" />
      <IconButton icon={Link2} label="Link" active={on('link')} onClick={a.link} />
      <IconButton icon={ImagePlus} label="Image" onClick={a.image} />
      <Menu trigger={<IconButton icon={Table} label="Table" active={inTable} />} items={inTable ? [
        { label: 'Insert row below', icon: Rows3, onSelect: () => c().addRowAfter().run() },
        { label: 'Insert column right', icon: Rows3, onSelect: () => c().addColumnAfter().run() },
        { divider: true },
        { label: 'Delete row', onSelect: () => c().deleteRow().run() },
        { label: 'Delete column', onSelect: () => c().deleteColumn().run() },
        { label: 'Delete table', danger: true, onSelect: () => c().deleteTable().run() },
      ] : tableSizes.map(([cols, rows]) => ({ label: `Insert ${cols} × ${rows} table`, icon: Table, onSelect: () => c().insertTable({ rows, cols, withHeaderRow: true }).run() }))} />
      <IconButton icon={Superscript} label="Footnote" onClick={a.footnote} />
      <IconButton icon={MessageSquarePlus} label="Comment" disabled={editor.state.selection.empty} onClick={a.comment} />
      <span class="sep" />
      <Menu trigger={<IconButton icon={align[2]} label="Align" />} items={aligns.map(([k, label, Icon]) => ({ label, icon: Icon, onSelect: () => c().setTextAlign(k).run() }))} />
      <Menu trigger={<IconButton icon={Rows3} label="Line spacing" />} items={lineHeights.map((v) => ({ label: lineLabel(v) + ((para.lineHeight || 1.15) === v ? '  ✓' : ''), onSelect: () => c().setLineHeight(v).run() }))} />
      <IconButton icon={List} label="Bulleted list" active={on('bulletList')} onClick={() => c().toggleBulletList().run()} />
      <IconButton icon={ListOrdered} label="Numbered list" active={on('orderedList')} onClick={() => c().toggleOrderedList().run()} />
      <IconButton icon={ListChecks} label="Checklist" active={on('taskList')} onClick={() => c().toggleTaskList().run()} />
      <IconButton icon={IndentDecrease} label="Decrease indent" onClick={() => c().outdent().run()} />
      <IconButton icon={IndentIncrease} label="Increase indent" onClick={() => c().indent().run()} />
      <IconButton icon={RemoveFormatting} label="Clear formatting" onClick={a.clearFormatting} />
      <ModeSelect mode={mode} role={role} onMode={onMode} />
    </div>
  )
}

// The picture the selection is on, if it is on one.
function selectedPicture(editor) {
  const sel = editor?.state.selection
  if (!(sel instanceof NodeSelection)) return null
  const n = sel.node
  if (n.type.name !== 'image' && n.type.name !== 'inlineImage') return null
  return { pos: sel.from, inline: n.type.name === 'inlineImage', wrap: n.attrs.wrap || 'break', align: n.attrs.align || 'left', width: n.attrs.width || null }
}

function selectedFootnote(editor) {
  const sel = editor?.state.selection
  return sel instanceof NodeSelection && sel.node.type.name === 'footnote' ? sel.from : null
}

const pagePx = (mm) => Math.round(mm * MM)

// The page as it is set up: its paper, margins, header and footer. The text
// runs on as one long page on screen; on paper it breaks into pages.
function Page({ page, title, children }) {
  const { w, h } = pageSize(page)
  const style = {
    width: pagePx(w) + 'px', minHeight: pagePx(h) + 'px',
    padding: `${pagePx(page.top)}px ${pagePx(page.right)}px ${pagePx(page.bottom)}px ${pagePx(page.left)}px`,
  }
  // Header and footer sit in the middle of their margin, as on paper.
  const band = (text, al, edge, margin) => text && (
    <div class={'page-band ' + edge} aria-hidden="true"
      style={{ [edge]: Math.max(6, pagePx(Math.min(12.5, margin / 2)) - 9) + 'px', left: pagePx(page.left) + 'px', right: pagePx(page.right) + 'px', textAlign: al }}>
      {fillTokens(text, { page: '#', pages: '#', title: title || 'Untitled' })}
    </div>
  )
  return (
    <div class="doc-page" style={style}>
      {band(page.header, page.headerAlign, 'top', page.top)}
      {children}
      {band(page.footer, page.footerAlign, 'bottom', page.bottom)}
    </div>
  )
}

const COUNT_KEY = 'os:doc-wordcount'

export default function EditorView({ id }) {
  const doc = docs.value.find((d) => d.id === id)
  const host = useRef()
  const session = useRef(null)
  // `tick` changes whenever the editor does. It is handed to the toolbar as a
  // prop because components here re-render on changed props, state or
  // signals only, and the editor object itself never changes identity.
  const [tick, bump] = useState(0)
  const [share, setShare] = useState(false)
  const [rail, setRail] = useState(null) // null: open when there is something in it
  const [active, setActive] = useState(null) // { kind, id }: the card that is lit
  const [pending, setPending] = useState(null) // { id, quote }: a comment being written
  const [history, setHistory] = useState(null) // the version panel, once asked for
  const [past, setPast] = useState(null) // { version, json, ydoc }: a past version on screen
  const [dialog, setDialog] = useState(null) // 'page' | 'count' | 'keys'
  const [find, setFind] = useState(null) // { replace }: the find bar, when open
  const [link, setLink] = useState(null) // the link being edited
  const [showCount, setShowCount] = useState(() => localStorage.getItem(COUNT_KEY) !== 'off')
  const pastHost = useRef()
  const main = useRef()
  const titleInput = useRef()
  const caret = useRef('')
  const me = user.value

  useEffect(() => {
    if (!doc) refreshBoot()
  }, [id])

  // A layout effect: the editor and its content are in place before the
  // browser paints the frame that follows the click.
  useLayoutEffect(() => {
    if (!doc || !host.current) return
    let raf = 0
    const s = openDocument(id, host.current, me, doc.role, () => {
      raf ||= requestAnimationFrame(() => {
        raf = 0
        bump((n) => n + 1)
      })
    })
    session.current = s
    bump((n) => n + 1)
    return () => {
      cancelAnimationFrame(raf)
      session.current = null
      s.close()
    }
  }, [id, !!doc])

  const rename = useRef(debounce((d, title) => renameDoc(d, title), 500)).current

  // The card for whatever the caret rests in lights up; moving out of it
  // lets go. A card picked by hand stays lit until the caret moves.
  useEffect(() => {
    const s = session.current
    if (!s) return
    const at = reviewAtCaret(s.editor, s.ydoc)
    const key = at ? at.kind + at.id : ''
    if (key === caret.current) return
    caret.current = key
    setActive(at)
  }, [tick])

  // A past version is shown by a second, read-only editor in place of the
  // live one, which carries on underneath.
  useEffect(() => {
    if (!past) return
    const view = new Editor({ element: pastHost.current, editable: false, extensions: formatExtensions(me), content: past.json, editorProps: { attributes: { class: 'paper' } } })
    return () => {
      view.destroy()
      past.ydoc.destroy()
    }
  }, [past])

  const s = session.current
  const editor = s?.editor
  const items = useMemo(() => (editor ? reviewItems(editor, s.ydoc) : null), [editor?.state.doc, s?.state.rev])

  if (!doc) {
    return (
      <div class="page">
        {confirmed.value && <Empty icon={FileX2} title="This document isn't available" text="It may have been deleted, or it hasn't been shared with you."><Button onClick={() => navigate('/docs')}>Back to Docs</Button></Empty>}
      </div>
    )
  }

  const role = doc.role
  const canEdit = role === 'owner' || role === 'edit'
  const canWrite = !!s && s.state.canEdit && role !== 'view'
  const mode = s?.state.mode
  const railOpen = !!editor && !history && (!!pending || (rail ?? (items.open.length > 0 && matchMedia('(min-width: 1101px)').matches)))
  const editable = canWrite && mode !== 'view' && !past

  const comment = () => {
    if (!canWrite || mode === 'view') return
    const p = startThread(editor, newId(10))
    if (!p) return toast('Select the text you want to comment on.')
    setPending(p)
  }
  const endPending = (_, posted) => {
    if (!posted && pending) unmarkThread(editor, pending.id)
    setPending(null)
    editor.view.focus() // at once, so typing can carry straight on
  }

  const pastDoc = (state) => {
    const ydoc = new Y.Doc()
    if (state.base.length) Y.applyUpdate(ydoc, state.base)
    for (const u of state.updates) Y.applyUpdate(ydoc, u)
    return { ydoc, json: yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment('default'), editor.schema).toJSON() }
  }
  const openHistory = async () => {
    const m = await import('./versions.jsx')
    setHistory(() => m)
  }
  const viewPast = (version, state) => setPast(version ? { version, state, ...pastDoc(state) } : null)
  const HistoryPanel = history?.default
  const VersionBar = history?.VersionBar
  // Restoring is an ordinary edit: it syncs to everyone and Undo reverses it.
  // What is there now is filed as a version first.
  const restore = async (version, state) => {
    await post(`/api/docs/${id}/versions`, {})
    const old = pastDoc(state)
    // Its own step in the undo history: joined to typing from a moment before,
    // one Undo would take both and leave the page empty.
    const history = yUndoPluginKey.getState(editor.state)?.undoManager
    history?.stopCapturing()
    adoptThreads(s.ydoc, old.ydoc)
    adoptPage(s.ydoc, old.ydoc)
    editor.chain().setMeta(suggestKey, { skip: true }).setContent(old.json).run()
    history?.stopCapturing()
    old.ydoc.destroy()
    setPast(null)
  }
  const others = s ? [...s.awareness.getStates().entries()].filter(([cid, st]) => cid !== s.awareness.clientID && st.user).map(([, st]) => st.user) : []
  const unique = [...new Map(others.map((u) => [u.id, u])).values()]
  const status = !s ? '' : !s.state.online ? 'Offline · saved on this device' : s.saved() ? 'Saved' : 'Saving…'
  const title = doc.title
  const page = s ? readPage(s.ydoc) : pageDefaults
  const shownPage = past ? readPage(past.ydoc) : page

  const download = async (fmt) => {
    try {
      const target = fmt === 'md' ? 'markdown' : fmt === 'html' ? 'html' : 'word'
      const html = await inlinePictures(exportCopy(editor.getHTML(), { page, title: title || 'Untitled', target }))
      const name = `${title || 'Untitled'}.${fmt}`
      if (fmt === 'html') return saveFile(new Blob([html], { type: 'text/html' }), name)
      const res = await convert('html', fmt, new Blob([html]))
      saveFile(await res.blob(), name)
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  const addImage = async () => {
    const f = await pickFile('image/*')
    if (!f) return
    try {
      editor.chain().focus().setImage({ src: await uploadImage(f), alt: f.name }).run()
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  const clearFormatting = () => {
    // Formatting only: comments and suggestions on the text stay.
    const chain = editor.chain().focus()
    for (const name of Object.keys(editor.schema.marks)) if (!['comment', 'ins', 'del', 'fmt'].includes(name)) chain.unsetMark(name)
    chain.clearNodes().command(({ tr, state }) => {
      state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
        if (node.attrs.lineHeight || node.attrs.indent) tr.setNodeMarkup(pos, undefined, { ...node.attrs, lineHeight: null, indent: null })
      })
      return true
    }).run()
  }
  const footnote = () => {
    if (!editable) return
    const at = editor.state.selection.to
    editor.chain().focus().setTextSelection(at).insertFootnote('').setNodeSelection(at).run()
  }
  const clipboard = async (kind) => {
    editor.view.focus()
    if (kind !== 'paste') {
      document.execCommand(kind)
      return
    }
    try {
      const [item] = await navigator.clipboard.read()
      if (item.types.includes('text/html')) editor.view.pasteHTML(await (await item.getType('text/html')).text())
      else editor.view.pasteText(await (await item.getType('text/plain')).text())
    } catch {
      toast(`Your browser keeps the clipboard to itself here. Press ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}V to paste.`)
    }
  }
  const setCount = (on) => {
    setShowCount(on)
    localStorage.setItem(COUNT_KEY, on ? 'on' : 'off')
  }
  const picture = editable ? selectedPicture(editor) : null
  const fnPos = editor && !past ? selectedFootnote(editor) : null
  const imageLayout = (change) => setImageLayout(editor, change)

  const actions = {
    doc, editor, canEdit, canWrite, role, mode, railOpen, showCount, picture,
    share: () => setShare(true),
    history: openHistory,
    download,
    print: () => window.print(),
    pageSetup: () => setDialog('page'),
    rename: () => titleInput.current?.select(),
    trash: () => { trashDoc(doc); navigate('/docs') },
    clipboard,
    find: (replace) => setFind({ replace }),
    setMode: (m) => s.setMode(m),
    toggleRail: () => { setHistory(null); setPast(null); setRail(!railOpen) },
    toggleCount: () => setCount(!showCount),
    image: addImage,
    link: () => setLink(editor.getAttributes('link').href || ''),
    footnote,
    comment,
    clearFormatting,
    imageLayout,
    wordCount: () => setDialog('count'),
    shortcuts: () => setDialog('keys'),
  }

  const keys = (e) => {
    const mod = e.metaKey || e.ctrlKey
    if (!mod || !editor) return
    const take = (fn) => {
      e.preventDefault()
      fn()
    }
    if (e.code === 'KeyM' && e.altKey) take(comment)
    else if (e.code === 'KeyF' && e.altKey) take(footnote)
    else if (e.code === 'KeyF' && !e.shiftKey) take(() => setFind({ replace: false }))
    else if (e.code === 'KeyH' && e.shiftKey && e.altKey) canEdit && take(openHistory)
    else if (e.code === 'KeyH' && (e.shiftKey || !navigator.platform.includes('Mac'))) take(() => setFind({ replace: true }))
    else if (e.code === 'KeyC' && e.shiftKey) take(() => setDialog('count'))
    else if (e.code === 'KeyK' && editable) take(actions.link)
    else if (e.code === 'Backslash' && editable) take(clearFormatting)
  }

  const pageCSS = `@media print { ${printCSS(shownPage, title || 'Untitled')} }`

  return (
    <div class="doc-view" style={{ position: 'relative' }} onKeyDown={keys}>
      <style>{pageCSS}</style>
      <div class="doc-bar with-menus">
        <IconButton icon={ArrowLeft} label="All docs" onClick={() => navigate('/docs')} />
        <div class="doc-head">
          <div class="doc-head-top">
            <input class="doc-title" aria-label="Title" placeholder="Untitled" value={title} disabled={!canEdit} ref={titleInput}
              onInput={(e) => { upsertDoc({ ...doc, title: e.target.value }); rename(doc, e.target.value) }}
              onKeyDown={(e) => e.key === 'Enter' && editor?.commands.focus('start')} />
            <span class="save-state">{status}</span>
          </div>
          <MenuBar menus={docMenus(actions)} />
        </div>
        <span class="grow" />
        <span class="presence">{unique.slice(0, 5).map((u) => <span key={u.id} title={u.name}><Avatar name={u.name} id={u.id} size={28} /></span>)}</span>
        {editor && (
          <span class="rv-count">
            <IconButton icon={MessageSquare} label="Comments" active={railOpen} onClick={actions.toggleRail} />
            {items.open.length > 0 && <span class="count">{items.open.length}</span>}
          </span>
        )}
        <Button icon={Users} kind={doc.access === 'org' || doc.shares?.length ? 'default' : 'primary'} onClick={() => setShare(true)}>Share</Button>
      </div>
      {past && VersionBar && <VersionBar version={past.version} onBack={() => setPast(null)} onRestore={() => restore(past.version, past.state).then(() => toast('Version restored'), (e) => toast(e.message, 'error'))} />}
      {editor && canWrite && !past && <Toolbar editor={editor} tick={tick} mode={mode} role={role} onMode={s.setMode} a={actions} />}
      <div class="doc-body">
        <div class="doc-main" ref={main}>
          <div class={cx('doc-scroll', mode === 'view' && 'clean')} onMouseDown={(e) => e.target === e.currentTarget && !past && editor?.commands.focus('end')}>
            <Page page={shownPage} title={title}>
              <div ref={host} style={past ? { display: 'none' } : undefined} />
              <div ref={pastHost} />
            </Page>
          </div>
          {editor && !past && showCount && <button type="button" class="doc-foot" onClick={() => setDialog('count')}>{editor.storage.characterCount.words()} words</button>}
          {editor && find && <FindBar editor={editor} tick={tick} replace={find.replace} canReplace={editable} onClose={() => setFind(null)} />}
          {editor && fnPos !== null && <FootnoteBox key={fnPos} editor={editor} pos={fnPos} box={main.current} canEdit={editable}
            onDone={(keep) => { if (keep) editor.chain().focus().setTextSelection(fnPos + 1).run() }} />}
          {editor && picture && <PictureBar editor={editor} picture={picture} box={main.current} onLayout={imageLayout} />}
        </div>
        {HistoryPanel
          ? <HistoryPanel doc={doc} viewing={past?.version.id || null} onView={viewPast} onRestore={restore} onClose={() => { setHistory(null); setPast(null) }} />
          : railOpen && <Review editor={editor} ydoc={s.ydoc} me={me} role={canWrite ? role : 'view'} items={items} active={active} onActive={setActive} pending={pending} onPending={endPending} onClose={() => { if (pending) endPending(null, false); setRail(false) }} tick={tick} />}
      </div>
      {editor && <ReviewStyle items={items} active={active} pending={pending?.id} />}
      {share && <ShareDialog doc={doc} onClose={() => setShare(false)} />}
      {dialog === 'page' && s && <PageSetup ydoc={s.ydoc} title={title} readOnly={!editable} onClose={() => setDialog(null)} />}
      {dialog === 'count' && editor && <WordCount editor={editor} show={showCount} onShow={setCount} onClose={() => setDialog(null)} />}
      {dialog === 'keys' && <Shortcuts onClose={() => setDialog(null)} />}
      {link !== null && editor && (
        <Modal title="Link" onClose={() => setLink(null)} footer={<>
          {editor.isActive('link') && <Button kind="danger" onClick={() => { editor.chain().focus().unsetLink().run(); setLink(null) }}>Remove</Button>}
          <Button kind="primary" onClick={() => { const v = link.trim(); v ? editor.chain().focus().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(v) ? v : 'https://' + v }).run() : editor.chain().focus().unsetLink().run(); setLink(null) }}>Apply</Button>
        </>}>
          <input class="input" autofocus placeholder="https://" value={link} onInput={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.closest('.modal')?.querySelector('footer .btn:last-child')?.click()} />
        </Modal>
      )}
    </div>
  )
}
