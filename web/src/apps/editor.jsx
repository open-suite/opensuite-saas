// The document editor. The document is a CRDT held on the device: it opens
// from local storage, edits apply locally at once, and the server is a relay
// and backup. Losing the connection changes nothing except the status label.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import TextAlign from '@tiptap/extension-text-align'
import Image from '@tiptap/extension-image'
import Highlight from '@tiptap/extension-highlight'
import { TextStyle, Color } from '@tiptap/extension-text-style'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder, CharacterCount } from '@tiptap/extensions'
import {
  ArrowLeft, Undo2, Redo2, Bold, Italic, Underline, Strikethrough, Highlighter, Baseline, Link2, List, ListOrdered, ListChecks,
  AlignLeft, AlignCenter, AlignRight, Quote, Code2, Table, ImagePlus, Minus, RemoveFormatting, Users, MoreHorizontal,
  Printer, FileDown, Trash2, FileX2, Rows3, Columns3,
} from 'lucide-preact'
import './editor.css'
import { user, docs, upsertDoc, toast, confirmed } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { api, refreshBoot } from '../lib/api.js'
import { DocSocket, fetchState } from '../lib/sync.js'
import { findDoc, renameDoc, trashDoc, convert, whenCreated } from '../lib/docs.js'
import { colorFor, debounce, download, pickFile } from '../lib/util.js'
import { Avatar, Button, Empty, IconButton, Menu, Modal, Popover, Swatches, inkColors, markColors } from '../ui.jsx'
import { ShareDialog } from './docs.jsx'

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
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true } }),
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
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Image.configure({ allowBase64: true }),
    Highlight.configure({ multicolor: true }),
    TextStyle, Color,
    TaskList, TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    Placeholder.configure({ placeholder: 'Start writing…' }),
    CharacterCount,
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
function openDocument(id, element, me, onChange) {
  const ydoc = new Y.Doc()
  const local = new IndexeddbPersistence('os-doc-' + id, ydoc)
  // Applied before the store has opened, so it is shown now and not written
  // back as a duplicate.
  if (warm.has(id)) Y.applyUpdate(ydoc, warm.get(id), REMOTE)
  const awareness = new Awareness(ydoc)
  const color = colorFor(me.id)
  awareness.setLocalStateField('user', { name: me.name, color, id: me.id })

  const editor = new Editor({
    element,
    extensions: extensionsFor(ydoc, awareness, { name: me.name, color }),
    editorProps: {
      attributes: { class: 'paper', spellcheck: 'true' },
      handlePaste: (view, e) => insertFiles([...(e.clipboardData?.files || [])]),
      handleDrop: (view, e) => insertFiles([...(e.dataTransfer?.files || [])]),
    },
    onTransaction: () => onChange(),
  })

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
  const state = { online: false, canEdit: true }

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
      editor.setEditable(canEdit)
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

  // A file chosen in "Import" becomes this document's first content.
  local.whenSynced.then(() => {
    const key = 'os:import:' + id
    const html = sessionStorage.getItem(key)
    if (html && editor.isEmpty) editor.commands.setContent(html)
    sessionStorage.removeItem(key)
  })

  const onUnload = () => removeAwarenessStates(awareness, [ydoc.clientID], 'unload')
  addEventListener('pagehide', onUnload)

  return {
    editor, awareness, state,
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

async function inlineImages(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const img of doc.querySelectorAll('img[src^="/api/blobs/"]')) {
    try {
      const blob = await (await fetch(img.getAttribute('src'))).blob()
      img.setAttribute('src', await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob) }))
    } catch {}
  }
  return doc.body.innerHTML
}

function Toolbar({ editor }) {
  const [link, setLink] = useState(null)
  const c = () => editor.chain().focus()
  const on = (name, attrs) => editor.isActive(name, attrs)
  const block = on('heading', { level: 1 }) ? 'h1' : on('heading', { level: 2 }) ? 'h2' : on('heading', { level: 3 }) ? 'h3' : 'p'
  const setBlock = (v) => (v === 'p' ? c().setParagraph().run() : c().setHeading({ level: +v[1] }).run())
  const addImage = async () => {
    const f = await pickFile('image/*')
    if (!f) return
    try {
      c().setImage({ src: await uploadImage(f), alt: f.name }).run()
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  const inTable = on('table')
  return (
    <div class="toolbar" role="toolbar" aria-label="Formatting">
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
      <IconButton icon={Link2} label="Link" active={on('link')} onClick={() => setLink(editor.getAttributes('link').href || '')} />
      <span class="sep" />
      <IconButton icon={List} label="Bulleted list" active={on('bulletList')} onClick={() => c().toggleBulletList().run()} />
      <IconButton icon={ListOrdered} label="Numbered list" active={on('orderedList')} onClick={() => c().toggleOrderedList().run()} />
      <IconButton icon={ListChecks} label="Checklist" active={on('taskList')} onClick={() => c().toggleTaskList().run()} />
      <span class="sep" />
      <IconButton icon={AlignLeft} label="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => c().setTextAlign('left').run()} />
      <IconButton icon={AlignCenter} label="Centre" active={editor.isActive({ textAlign: 'center' })} onClick={() => c().setTextAlign('center').run()} />
      <IconButton icon={AlignRight} label="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => c().setTextAlign('right').run()} />
      <span class="sep" />
      <IconButton icon={Quote} label="Quote" active={on('blockquote')} onClick={() => c().toggleBlockquote().run()} />
      <IconButton icon={Code2} label="Code block" active={on('codeBlock')} onClick={() => c().toggleCodeBlock().run()} />
      <IconButton icon={Minus} label="Divider" onClick={() => c().setHorizontalRule().run()} />
      <IconButton icon={ImagePlus} label="Image" onClick={addImage} />
      <Menu trigger={<IconButton icon={Table} label="Table" active={inTable} />} items={inTable ? [
        { label: 'Add row below', icon: Rows3, onSelect: () => c().addRowAfter().run() },
        { label: 'Add column right', icon: Columns3, onSelect: () => c().addColumnAfter().run() },
        { divider: true },
        { label: 'Delete row', onSelect: () => c().deleteRow().run() },
        { label: 'Delete column', onSelect: () => c().deleteColumn().run() },
        { label: 'Delete table', icon: Trash2, danger: true, onSelect: () => c().deleteTable().run() },
      ] : [
        { label: 'Insert 3 × 3 table', icon: Table, onSelect: () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
        { label: 'Insert 5 × 4 table', icon: Table, onSelect: () => c().insertTable({ rows: 5, cols: 4, withHeaderRow: true }).run() },
      ]} />
      <span class="sep" />
      <IconButton icon={RemoveFormatting} label="Clear formatting" onClick={() => c().unsetAllMarks().clearNodes().run()} />
      {link !== null && (
        <Modal title="Link" onClose={() => setLink(null)} footer={<>
          {editor.isActive('link') && <Button kind="danger" onClick={() => { c().unsetLink().run(); setLink(null) }}>Remove</Button>}
          <Button kind="primary" onClick={() => { link.trim() ? c().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(link.trim()) ? link.trim() : 'https://' + link.trim() }).run() : c().unsetLink().run(); setLink(null) }}>Apply</Button>
        </>}>
          <input class="input" autofocus placeholder="https://" value={link} onInput={(e) => setLink(e.target.value)} />
        </Modal>
      )}
    </div>
  )
}

export default function EditorView({ id }) {
  const doc = docs.value.find((d) => d.id === id)
  const host = useRef()
  const session = useRef(null)
  const [, bump] = useState(0)
  const [share, setShare] = useState(false)
  const me = user.value

  useEffect(() => {
    if (!doc) refreshBoot()
  }, [id])

  // A layout effect: the editor and its content are in place before the
  // browser paints the frame that follows the click.
  useLayoutEffect(() => {
    if (!doc || !host.current) return
    let raf = 0
    const s = openDocument(id, host.current, me, () => {
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

  if (!doc) {
    return (
      <div class="page">
        {confirmed.value && <Empty icon={FileX2} title="This document isn't available" text="It may have been deleted, or it hasn't been shared with you."><Button onClick={() => navigate('/docs')}>Back to Docs</Button></Empty>}
      </div>
    )
  }

  const s = session.current
  const editor = s?.editor
  const others = s ? [...s.awareness.getStates().entries()].filter(([cid, st]) => cid !== s.awareness.clientID && st.user).map(([, st]) => st.user) : []
  const unique = [...new Map(others.map((u) => [u.id, u])).values()]
  const status = !s ? '' : !s.state.online ? 'Offline · saved on this device' : s.saved() ? 'Saved' : 'Saving…'
  const title = doc.title

  const exportAs = async (fmt) => {
    try {
      const body = await inlineImages(editor.getHTML())
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${(title || 'Untitled').replace(/</g, '')}</title></head><body>${body}</body></html>`
      const res = await convert('html', fmt, new Blob([html]))
      download(await res.blob(), `${title || 'Untitled'}.${fmt}`)
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  return (
    <div class="doc-view" style={{ position: 'relative' }}>
      <div class="doc-bar">
        <IconButton icon={ArrowLeft} label="All docs" onClick={() => navigate('/docs')} />
        <input class="doc-title" aria-label="Title" placeholder="Untitled" value={title} disabled={doc.role === 'view'}
          onInput={(e) => { upsertDoc({ ...doc, title: e.target.value }); rename(doc, e.target.value) }}
          onKeyDown={(e) => e.key === 'Enter' && editor?.commands.focus('start')} />
        <span class="save-state">{status}</span>
        <span class="grow" />
        <span class="presence">{unique.slice(0, 5).map((u) => <span key={u.id} title={u.name}><Avatar name={u.name} id={u.id} size={28} /></span>)}</span>
        <Button icon={Users} kind={doc.access === 'org' || doc.shares?.length ? 'default' : 'primary'} onClick={() => setShare(true)}>Share</Button>
        <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label="More" />} items={[
          { label: 'Print or save as PDF', icon: Printer, onSelect: () => window.print() },
          { divider: true },
          { label: 'Download as Word (.docx)', icon: FileDown, onSelect: () => exportAs('docx') },
          { label: 'Download as OpenDocument (.odt)', icon: FileDown, onSelect: () => exportAs('odt') },
          { label: 'Download as Markdown (.md)', icon: FileDown, onSelect: () => exportAs('md') },
          doc.role === 'owner' && { divider: true },
          doc.role === 'owner' && { label: 'Move to trash', icon: Trash2, danger: true, onSelect: () => { trashDoc(doc); navigate('/docs') } },
        ]} />
      </div>
      {editor && s.state.canEdit && doc.role !== 'view' && <Toolbar editor={editor} />}
      <div class="doc-scroll" onMouseDown={(e) => e.target === e.currentTarget && editor?.commands.focus('end')}>
        <div ref={host} />
      </div>
      {editor && <div class="doc-foot">{editor.storage.characterCount.words()} words</div>}
      {share && <ShareDialog doc={doc} onClose={() => setShare(false)} />}
    </div>
  )
}
