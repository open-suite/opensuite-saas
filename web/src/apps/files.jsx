// Files: the drive. Folders, uploaded files and documents of every kind in
// one place. Everything on this screen is drawn from what the device already
// holds (lib/files.js), and every change shows before the server answers.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Folder, FolderPlus, FolderUp, FolderInput, File as FileIcon, FileText, FileImage, FileVideo, FileAudio, FileArchive, FileSpreadsheet,
  Presentation, Plus, Upload, MoreHorizontal, Trash2, Users, Pencil, RotateCcw, Search, Download, Share2, Link2, Clock, HardDrive,
  ChevronRight, ChevronLeft, LayoutGrid, List as ListIcon, ArrowUp, ArrowDown, X, Check, FileInput, ExternalLink,
} from 'lucide-preact'
import './files.css'
import { user, peopleById, toast } from '../lib/store.js'
import { parts, navigate } from '../lib/router.js'
import { docKinds, openNew } from '../lib/docs.js'
import {
  nodes, filesLoaded, storage, uploads, items, folders, itemByKey, listing, trail, itemHref, contentUrl, publicUrl, fileLink, fileType, opensAs,
  startFiles, refreshFiles, createFolder, uploadFiles, uploadDropped, cancelUpload, renameItem, moveItem, trashItem, deleteItem, shareItem,
  setPublicLink, canMoveInto, picker, fetchText, fetchFile,
} from '../lib/files.js'
import { markdownToHtml } from '../lib/markdown.js'
import { cx, when, whenFull, bytes, copyText } from '../lib/util.js'
import { Button, Empty, IconButton, Menu, Modal } from '../ui.jsx'
import { KindIcon, kindIcons, ShareDialog, RenameDialog, importFile, importBlob } from './docs.jsx'

const typeIcons = {
  image: FileImage, picture: FileImage, video: FileVideo, film: FileVideo, audio: FileAudio, sound: FileAudio, pdf: FileText,
  markdown: FileText, text: FileText, document: FileText, sheet: FileSpreadsheet, slides: Presentation, archive: FileArchive, other: FileIcon,
}
const typeTint = { image: 'img', picture: 'img', video: 'media', film: 'media', audio: 'media', sound: 'media', pdf: 'pdf', sheet: 'sheet', archive: 'zip' }

export function ItemIcon({ item, size = 17 }) {
  if (item.type === 'doc') return <KindIcon kind={item.kind} />
  if (item.type === 'folder') return <span class="kind-icon kind-folder"><Folder size={size} /></span>
  const t = fileType(item)
  const Icon = typeIcons[t] || FileIcon
  return <span class={cx('kind-icon', 'kind-file', typeTint[t] && 'kind-file-' + typeTint[t])}><Icon size={size} /></span>
}

const viewNames = { mine: 'Files', shared: 'Shared with me', recent: 'Recent', trash: 'Trash' }
const viewHref = { mine: '/files', shared: '/files/shared', recent: '/files/recent', trash: '/files/trash' }
const viewIcons = { mine: HardDrive, shared: Users, recent: Clock, trash: Trash2 }

const PAGE = 120 // rows drawn at first in a long folder
const PREFS = 'os:files:prefs'
function loadPrefs() {
  try {
    return { layout: 'list', sort: 'updated', dir: -1, ...JSON.parse(localStorage.getItem(PREFS)) }
  } catch {
    return { layout: 'list', sort: 'updated', dir: -1 }
  }
}

function sorted(list, { sort, dir }, keepOrder) {
  if (keepOrder) return list
  const val = { name: (i) => i.name.toLowerCase(), updated: (i) => i.updated, size: (i) => i.size }[sort]
  return [...list].sort((a, b) => {
    if ((a.type === 'folder') !== (b.type === 'folder')) return a.type === 'folder' ? -1 : 1
    const x = val(a)
    const y = val(b)
    return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * dir
  })
}

const isShared = (i) => i.access === 'org' || i.shares?.length > 0 || !!i.link

// What is being dragged inside the drive right now (the browser hides drag
// data until the drop, and a drop target must decide before that).
let dragging = null

export function Drive() {
  const p = parts.value
  const me = user.value.id
  useEffect(() => {
    startFiles()
    refreshFiles({ withDocs: true })
    // Colleagues change things too: look again when the window comes back.
    let last = Date.now()
    const again = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < 10000) return
      last = Date.now()
      refreshFiles({ withDocs: true })
    }
    addEventListener('focus', again)
    return () => removeEventListener('focus', again)
  }, [])

  // Where we are.
  const fileId = p[1] === 'file' ? p[2] : null
  const openFile = fileId ? items.value.find((i) => i.type === 'file' && i.id === fileId) : null
  let view = ['shared', 'recent', 'trash'].includes(p[1]) ? p[1] : 'mine'
  let folderId = p[1] === 'folder' ? p[2] : ''
  if (openFile && folders.value[openFile.parent]) folderId = openFile.parent
  else if (openFile && openFile.owner !== me) view = 'shared'
  const folder = folderId ? folders.value[folderId] : null
  if (folderId) view = 'folder'
  const crumbs = folder ? trail(folderId) : []
  const canAdd = view === 'mine' || (view === 'folder' && folder && folder.role !== 'view')
  const dest = view === 'folder' ? folderId : ''

  const [prefs, setPrefsState] = useState(loadPrefs)
  const setPrefs = (change) => {
    const next = { ...prefs, ...change }
    setPrefsState(next)
    try {
      localStorage.setItem(PREFS, JSON.stringify(next))
    } catch {}
  }
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(() => new Set())
  const [dialog, setDialog] = useState(null)
  const [dropping, setDropping] = useState(null) // key of the folder under a drag, or 'here'
  const anchor = useRef(null)
  const dropTimer = useRef()
  const uploadInput = useRef()
  const folderInput = useRef()
  const listEl = useRef()

  const where = view + ':' + folderId
  useEffect(() => {
    setSel(new Set())
    setQ('')
  }, [where])

  const needle = q.trim().toLowerCase()
  const rows = useMemo(() => {
    const base = view === 'folder' && !folder ? [] : listing(view, folderId)
    const found = needle ? base.filter((i) => i.name.toLowerCase().includes(needle)) : base
    return sorted(found, prefs, view === 'recent')
  }, [items.value, where, needle, prefs.sort, prefs.dir, !!folder])
  const chosen = rows.filter((i) => sel.has(i.key))

  // A long folder is drawn a screenful at a time; more rows are added as the
  // end of the list comes near, so opening it costs the same however big it is.
  const windowKey = [where, needle, prefs.layout, prefs.sort, prefs.dir].join('|')
  const [win, setWin] = useState({ key: windowKey, n: PAGE })
  const limit = win.key === windowKey ? win.n : PAGE
  const shown = useMemo(() => (rows.length > limit ? rows.slice(0, limit) : rows), [rows, limit])
  const moreEl = useRef()
  useEffect(() => {
    if (!moreEl.current) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setWin({ key: windowKey, n: limit + PAGE * 2 }), { rootMargin: '900px' })
    io.observe(moreEl.current)
    return () => io.disconnect()
  }, [windowKey, limit, rows.length > limit])

  // --- selection ---
  const toggle = (key) => {
    const next = new Set(sel)
    next.has(key) ? next.delete(key) : next.add(key)
    anchor.current = key
    setSel(next)
  }
  const range = (key) => {
    const a = rows.findIndex((i) => i.key === (anchor.current || key))
    const b = rows.findIndex((i) => i.key === key)
    if (a < 0 || b < 0) return toggle(key)
    setSel(new Set([...sel, ...rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((i) => i.key)]))
  }
  const onRowClick = (e, item) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      toggle(item.key)
    } else if (e.shiftKey) {
      e.preventDefault()
      range(item.key)
    }
  }

  // --- actions ---
  const trash = (list) => {
    const mine = list.filter((i) => i.role === 'owner')
    if (!mine.length) return toast('Only the owner can move this to the trash.', 'error')
    mine.forEach((i) => trashItem(i))
    setSel(new Set())
    toast(mine.length === 1 ? `"${mine[0].name}" moved to the trash` : `${mine.length} items moved to the trash`)
  }
  const move = (list, to) => {
    if (!canMoveInto(list, to)) return
    list.forEach((i) => moveItem(i, to))
    setSel(new Set())
  }
  const download = (list) => {
    for (const i of list.filter((x) => x.type === 'file' && !x.uploading)) {
      const a = document.createElement('a')
      a.href = contentUrl(i.id, true)
      a.download = i.name
      document.body.append(a)
      a.click()
      a.remove()
    }
  }
  const copyLink = async (i) => toast((await copyText(i.type === 'file' ? fileLink(i) : location.origin + itemHref(i))) ? 'Link copied' : "The link couldn't be copied.")
  const openAs = async (i) => {
    try {
      await importBlob(await fetchFile(i.ref), i.parent && folders.value[i.parent]?.role !== 'view' ? i.parent : '')
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const menuFor = (i) => i.trashed ? [
    { label: 'Restore', icon: RotateCcw, onSelect: () => trashItem(i, false) },
    { label: 'Delete for ever', icon: Trash2, danger: true, onSelect: () => setDialog({ type: 'delete', items: [i] }) },
  ] : [
    i.type === 'file' && { label: 'Download', icon: Download, onSelect: () => download([i]) },
    i.type === 'file' && opensAs(i) && { label: 'Open as ' + docKinds[opensAs(i)].name.toLowerCase(), icon: FileInput, onSelect: () => openAs(i) },
    i.role !== 'view' && { label: 'Rename', icon: Pencil, hint: 'F2', onSelect: () => setDialog({ type: 'rename', item: i }) },
    i.role !== 'view' && { label: 'Move to…', icon: FolderInput, onSelect: () => setDialog({ type: 'move', items: [i] }) },
    { label: 'Share', icon: Share2, onSelect: () => setDialog({ type: 'share', key: i.key }) },
    { label: 'Copy link', icon: Link2, onSelect: () => copyLink(i) },
    { label: sel.has(i.key) ? 'Deselect' : 'Select', icon: Check, onSelect: () => toggle(i.key) },
    i.role === 'owner' && { divider: true },
    i.role === 'owner' && { label: 'Move to trash', icon: Trash2, danger: true, onSelect: () => trash([i]) },
  ]

  // --- keyboard ---
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select, .menu')) return
    const focused = itemByKey.value[e.target.closest?.('[data-key]')?.dataset.key]
    const acting = chosen.length ? chosen : focused ? [focused] : []
    const els = [...(listEl.current?.querySelectorAll('[data-key]') || [])]
    const at = els.indexOf(e.target.closest?.('[data-key]'))
    const step = (d) => {
      const el = els[Math.max(0, Math.min(els.length - 1, at + d))]
      if (!el) return
      e.preventDefault()
      el.focus()
      if (e.shiftKey) range(el.dataset.key)
    }
    const perRow = prefs.layout === 'grid' && els.length > 1 ? Math.max(1, els.filter((el) => el.offsetTop === els[0].offsetTop).length) : 1
    if (e.key === 'ArrowDown') step(at < 0 ? 1 : perRow)
    else if (e.key === 'ArrowUp') step(-perRow)
    else if (e.key === 'ArrowRight' && prefs.layout === 'grid') step(1)
    else if (e.key === 'ArrowLeft' && prefs.layout === 'grid') step(-1)
    else if (e.key === ' ' && focused) { e.preventDefault(); toggle(focused.key) }
    else if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); setSel(new Set(rows.map((i) => i.key))) }
    else if (e.key === 'Escape') setSel(new Set())
    else if ((e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) && acting.length && view !== 'trash') { e.preventDefault(); trash(acting) }
    else if (e.key === 'F2' && focused && focused.role !== 'view' && !focused.trashed) { e.preventDefault(); setDialog({ type: 'rename', item: focused }) }
  }

  // --- drag and drop, paste ---
  const external = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
  const hover = (e, key, allowed) => {
    if (!allowed) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = external(e) ? 'copy' : 'move'
    if (dropping !== key) setDropping(key)
    clearTimeout(dropTimer.current)
    dropTimer.current = setTimeout(() => setDropping(null), 250)
  }
  const dropInto = (e, to) => {
    e.preventDefault()
    e.stopPropagation()
    setDropping(null)
    if (external(e)) uploadDropped(e.dataTransfer, to)
    else if (dragging) move(dragging, to)
    dragging = null
  }
  const droppable = (e, to, role) => (external(e) ? role !== 'view' : !!dragging && canMoveInto(dragging, to))
  const dragProps = (item) => ({
    draggable: !item.trashed && !item.uploading && item.role !== 'view',
    onDragStart: (e) => {
      const list = sel.has(item.key) ? chosen : [item]
      if (!sel.has(item.key)) setSel(new Set([item.key]))
      dragging = list
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', list.map((i) => i.name).join('\n'))
    },
    onDragEnd: () => { dragging = null; setDropping(null) },
    ...(item.type === 'folder' && !item.trashed ? {
      onDragOver: (e) => hover(e, item.key, droppable(e, item.id, item.role)),
      onDrop: (e) => dropInto(e, item.id),
    } : {}),
  })
  const targetProps = (key, to, role) => ({
    onDragOver: (e) => hover(e, key, droppable(e, to, role)),
    onDrop: (e) => dropInto(e, to),
  })

  useEffect(() => {
    const onPaste = (e) => {
      if (!canAdd || e.target.closest?.('input, textarea, [contenteditable]')) return
      const files = [...(e.clipboardData?.files || [])]
      if (!files.length) return
      e.preventDefault()
      uploadFiles(files, dest)
      toast(files.length === 1 ? `Uploading ${files[0].name}` : `Uploading ${files.length} files`)
    }
    addEventListener('paste', onPaste)
    return () => removeEventListener('paste', onPaste)
  }, [canAdd, dest])

  const pickUpload = (e) => {
    const list = [...e.target.files]
    e.target.value = ''
    if (!list.length) return
    if (!list[0].webkitRelativePath) return uploadFiles(list, dest)
    // A chosen folder arrives flat, with paths: rebuild its folders first.
    const made = { '': dest }
    const ensure = async (path) => {
      if (path in made) return made[path]
      const cut = path.lastIndexOf('/')
      const parent = await ensure(cut < 0 ? '' : path.slice(0, cut))
      const { node, saved } = createFolder(path.slice(cut + 1), parent)
      await saved
      return (made[path] = node.id)
    }
    ;(async () => {
      for (const f of list) {
        const dir = f.webkitRelativePath.split('/').slice(0, -1).join('/')
        uploadFiles([f], await ensure(dir))
      }
    })().catch((err) => toast(err.message, 'error'))
  }

  const newItems = [
    { label: 'New folder', icon: FolderPlus, onSelect: () => setDialog({ type: 'folder' }) },
    ...Object.entries(docKinds).map(([kind, k]) => ({ label: k.create, icon: kindIcons[kind], onSelect: () => openNew(kind, dest) })),
    { divider: true },
    { label: 'Upload files', icon: Upload, onSelect: () => uploadInput.current.click() },
    { label: 'Upload a folder', icon: FolderUp, onSelect: () => folderInput.current.click() },
    { label: 'Import Word, Excel or Markdown', icon: FileInput, onSelect: () => importFile(dest) },
  ]

  const usage = storage.value
  const pct = usage?.quota ? Math.min(100, (usage.usage / usage.quota) * 100) : 0
  const title = view === 'folder' ? folder?.name || '' : viewNames[view]
  const sortBy = (key) => setPrefs(prefs.sort === key ? { dir: -prefs.dir } : { sort: key, dir: key === 'name' ? 1 : -1 })
  const SortHead = ({ k, label, cls }) => (
    <button class={cx('drive-th', cls, prefs.sort === k && 'on')} onClick={() => sortBy(k)} disabled={view === 'recent'}>
      {label}{prefs.sort === k && view !== 'recent' && (prefs.dir > 0 ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
    </button>
  )
  // The list is rebuilt only when what it shows changes; opening a preview or
  // a dialog over it leaves every row as it is.
  const list = useMemo(() => prefs.layout === 'grid' ? (
    <div class={cx('drive-grid', sel.size > 0 && 'selecting')} ref={listEl}>
      {shown.map((i) => <Tile key={i.key} item={i} picked={sel.has(i.key)} drop={dropping === i.key} onPick={() => toggle(i.key)} onClick={(e) => onRowClick(e, i)} menu={menuFor(i)} drag={dragProps(i)} />)}
    </div>
  ) : (
    <div class={cx('card drive-list', sel.size > 0 && 'selecting')} ref={listEl}>
      <div class="drive-head">
        <SortHead k="name" label="Name" cls="grow" />
        <span class="drive-th c-owner">Owner</span>
        <SortHead k="updated" label="Modified" cls="c-when" />
        <SortHead k="size" label="Size" cls="c-size" />
        <span class="c-menu" />
      </div>
      {shown.map((i) => <Row key={i.key} item={i} me={me} picked={sel.has(i.key)} drop={dropping === i.key} onPick={() => toggle(i.key)} onClick={(e) => onRowClick(e, i)} menu={menuFor(i)} drag={dragProps(i)} />)}
    </div>
  ), [shown, sel, dropping, prefs.layout, prefs.sort, prefs.dir, view])
  const shareTarget = dialog?.type === 'share' ? itemByKey.value[dialog.key] : null
  const empty = !rows.length && (filesLoaded.value || view === 'trash')
  const missing = view === 'folder' && !folder && filesLoaded.value

  return (
    <div class={cx('drive', dropping === 'here' && 'dropping')} onKeyDown={onKey} {...(canAdd ? targetProps('here', dest, folder?.role) : {})}>
      <aside class="drive-side" aria-label="Places">
        {Object.keys(viewNames).map((v) => {
          const Icon = viewIcons[v]
          const on = v === view || (v === 'mine' && view === 'folder' && crumbs[0]?.owner === me) || (v === 'shared' && view === 'folder' && crumbs[0] && crumbs[0].owner !== me)
          return (
            <a key={v} href={viewHref[v]} class={cx('drive-place', on && 'on', dropping === 'place:' + v && 'drop')} {...(v === 'mine' ? targetProps('place:mine', '', 'owner') : {})}>
              <Icon size={17} /><span>{v === 'mine' ? 'My files' : viewNames[v]}</span>
            </a>
          )
        })}
        <div class="drive-usage" title={usage ? `${bytes(usage.usage)} of ${bytes(usage.quota)} used by your organisation` : ''}>
          <div class="meter"><div style={{ width: pct + '%' }} class={cx(pct > 90 && 'full')} /></div>
          <span>{usage ? `${bytes(usage.usage)} of ${bytes(usage.quota)} used` : ' '}</span>
        </div>
      </aside>

      <section class="drive-main page">
        <div class="page-inner">
          <div class="page-head">
            <h1 class="crumbs">
              {view === 'folder' ? (
                <>
                  <a href={crumbs[0] && crumbs[0].owner !== me ? '/files/shared' : '/files'} class={cx(dropping === 'crumb:' && 'drop')} {...targetProps('crumb:', '', 'owner')}>{crumbs[0] && crumbs[0].owner !== me ? 'Shared with me' : 'Files'}</a>
                  {crumbs.map((c, i) => (
                    // Deep inside, the middle of the path folds into one "…".
                    crumbs.length > 3 && i < crumbs.length - 3 ? null : (
                      <>
                        <ChevronRight size={16} class="sep" />
                        {i === crumbs.length - 1 ? <span class="ellipsis">{c.name}</span> : (
                          <a href={'/files/folder/' + c.id} title={c.name} class={cx('ellipsis', dropping === 'crumb:' + c.id && 'drop')} {...targetProps('crumb:' + c.id, c.id, c.role)}>
                            {crumbs.length > 3 && i === crumbs.length - 3 ? '…' : c.name}
                          </a>
                        )}
                      </>
                    )
                  ))}
                </>
              ) : title}
            </h1>
            {view === 'folder' && folder && <IconButton icon={Share2} label="Share this folder" onClick={() => setDialog({ type: 'share', key: 'n:' + folder.id })} />}
            {canAdd && <Button icon={Upload} class="upload-btn" onClick={() => uploadInput.current.click()}>Upload</Button>}
            {canAdd && <Menu align="right" trigger={<Button kind="primary" icon={Plus}>New</Button>} items={newItems} />}
            <input ref={uploadInput} type="file" multiple hidden onChange={pickUpload} />
            <input ref={folderInput} type="file" webkitdirectory="" hidden onChange={pickUpload} />
          </div>

          <div class="drive-places-narrow tabs">
            {Object.keys(viewNames).map((v) => <a key={v} href={viewHref[v]} class={cx('tab', (v === view || (v === 'mine' && view === 'folder')) && 'on')}>{v === 'mine' ? 'My files' : viewNames[v]}</a>)}
          </div>

          {chosen.length > 0 ? (
            <div class="drive-bar selbar" role="toolbar" aria-label="Selection">
              <IconButton icon={X} label="Clear selection" onClick={() => setSel(new Set())} />
              <b>{chosen.length} selected</b>
              <span class="grow" />
              {view === 'trash' ? (
                <>
                  <Button icon={RotateCcw} onClick={() => { chosen.forEach((i) => trashItem(i, false)); setSel(new Set()) }} aria-label="Restore"><span class="wide-only">Restore</span></Button>
                  <Button kind="danger" icon={Trash2} onClick={() => setDialog({ type: 'delete', items: chosen })}>Delete for ever</Button>
                </>
              ) : (
                <>
                  {chosen.some((i) => i.type === 'file') && <Button icon={Download} onClick={() => download(chosen)} aria-label="Download"><span class="wide-only">Download</span></Button>}
                  {chosen.every((i) => i.role !== 'view') && <Button icon={FolderInput} onClick={() => setDialog({ type: 'move', items: chosen })} aria-label="Move"><span class="wide-only">Move</span></Button>}
                  {chosen.length === 1 && <Button icon={Share2} onClick={() => setDialog({ type: 'share', key: chosen[0].key })} aria-label="Share"><span class="wide-only">Share</span></Button>}
                  {chosen.some((i) => i.role === 'owner') && <Button kind="danger" icon={Trash2} onClick={() => trash(chosen)} aria-label="Move to trash"><span class="wide-only">Move to trash</span></Button>}
                </>
              )}
            </div>
          ) : (
            <div class="drive-bar">
              <div class="drive-filter">
                <Search size={15} />
                <input class="input" placeholder="Filter by name" value={q} onInput={(e) => setQ(e.target.value)} aria-label="Filter by name" />
              </div>
              <span class="grow" />
              {view === 'trash' && rows.length > 0 && <Button class="btn-ghost" icon={Trash2} onClick={() => setDialog({ type: 'delete', items: rows })}>Empty trash</Button>}
              <IconButton icon={ListIcon} label="List" active={prefs.layout === 'list'} onClick={() => setPrefs({ layout: 'list' })} />
              <IconButton icon={LayoutGrid} label="Grid" active={prefs.layout === 'grid'} onClick={() => setPrefs({ layout: 'grid' })} />
            </div>
          )}

          {missing ? (
            <div class="card"><Empty icon={Folder} title="This folder isn't available" text="It may have been moved to the trash, or it isn't shared with you."><a class="btn" href="/files">Back to Files</a></Empty></div>
          ) : empty ? (
            <div class="card">
              <Empty
                icon={viewIcons[view] || Folder}
                title={needle ? 'Nothing matches' : view === 'trash' ? 'Trash is empty' : view === 'shared' ? 'Nothing shared with you yet' : view === 'recent' ? 'Nothing recent' : view === 'folder' ? 'This folder is empty' : 'No files yet'}
                text={needle ? '' : view === 'trash' ? 'Items in the trash are deleted for ever after 30 days.' : view === 'shared' ? 'Files, folders and documents that colleagues share with you appear here.' : canAdd ? 'Drop files anywhere on this page to upload them, or create a document.' : ''}
              />
            </div>
          ) : list}
          {rows.length > limit && <div class="drive-more" ref={moreEl} />}
        </div>
        {dropping === 'here' && <div class="drop-hint"><Upload size={16} /> Drop to upload to {view === 'folder' ? `"${folder?.name}"` : 'My files'}</div>}
      </section>

      {dialog?.type === 'folder' && <NameDialog title="New folder" action="Create" initial="" placeholder="Folder name" onClose={() => setDialog(null)} onSave={(name) => createFolder(name, dest)} />}
      {dialog?.type === 'rename' && <RenameDialog doc={{ title: dialog.item.name }} save={(name) => renameItem(dialog.item, name)} onClose={() => setDialog(null)} />}
      {dialog?.type === 'move' && <MoveDialog items={dialog.items} onClose={() => setDialog(null)} onMove={(to) => { move(dialog.items, to); setDialog(null) }} />}
      {dialog?.type === 'delete' && (
        <Modal title="Delete for ever?" onClose={() => setDialog(null)} footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button kind="danger" icon={Trash2} onClick={() => { dialog.items.forEach(deleteItem); setSel(new Set()); setDialog(null) }}>Delete for ever</Button></>}>
          <p>{dialog.items.length === 1 ? `"${dialog.items[0].name}"` : `${dialog.items.length} items`} will be removed for everyone, along with anything inside. This can't be undone.</p>
        </Modal>
      )}
      {shareTarget && <ShareItem item={shareTarget} onClose={() => setDialog(null)} />}
      {fileId && (openFile ? (
        <Preview item={openFile} siblings={rows.filter((i) => i.type === 'file' && !i.uploading)} onShare={() => setDialog({ type: 'share', key: openFile.key })} onOpenAs={() => openAs(openFile)} />
      ) : filesLoaded.value && nodes.value.every((n) => n.id !== fileId) ? (
        <div class="preview"><Empty icon={FileIcon} title="This file isn't available" text="It may have been deleted, or it isn't shared with you."><a class="btn" href="/files">Back to Files</a></Empty></div>
      ) : null)}
    </div>
  )
}

function Progress({ item }) {
  const u = uploads.value[item.id]
  const pct = u?.total ? Math.round((u.loaded / u.total) * 100) : 0
  return (
    <span class="upl" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={'Uploading ' + item.name}>
      <span class="upl-bar"><span style={{ width: pct + '%' }} /></span>
      <span class="upl-pct">{pct}%</span>
    </span>
  )
}

function Pick({ picked, onPick, name }) {
  return (
    <span class={cx('fpick', picked && 'on')} role="checkbox" aria-checked={picked} aria-label={'Select ' + name} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPick() }}>
      {picked && <Check size={13} strokeWidth={3} />}
    </span>
  )
}

function RowMenu({ item, menu }) {
  return (
    <span class="c-menu" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
      {item.uploading
        ? <IconButton icon={X} label="Cancel upload" onClick={() => cancelUpload(item.id)} />
        : <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label="More" />} items={menu} />}
    </span>
  )
}

function Row({ item, me, picked, drop, onPick, onClick, menu, drag }) {
  const owner = peopleById.value[item.owner]
  const Tag = item.trashed || item.uploading ? 'div' : 'a'
  return (
    <Tag class={cx('list-row drive-row hover', picked && 'picked', drop && 'drop')} href={Tag === 'a' ? itemHref(item) : undefined} data-key={item.key} tabIndex={Tag === 'a' ? undefined : 0} onClick={onClick} {...drag}>
      <Pick picked={picked} onPick={onPick} name={item.name} />
      <ItemIcon item={item} />
      <span class="grow ellipsis name">{item.name}</span>
      {isShared(item) && <Users size={15} class="muted" aria-label="Shared" />}
      {!item.uploading && <span class="muted ellipsis c-owner">{item.owner === me ? 'You' : owner?.name}</span>}
      {item.uploading ? <span class="c-when c-up"><Progress item={item} /></span> : <span class="muted c-when" title={whenFull(item.updated * 1000)}>{when(item.updated * 1000)}</span>}
      <span class="muted c-size">{item.type === 'file' ? bytes(item.size) : item.type === 'doc' ? docKinds[item.kind]?.name || '' : ''}</span>
      <RowMenu item={item} menu={menu} />
    </Tag>
  )
}

function Tile({ item, picked, drop, onPick, onClick, menu, drag }) {
  const Tag = item.trashed || item.uploading ? 'div' : 'a'
  const thumb = item.type === 'file' && !item.uploading && fileType(item) === 'image' && item.size < 6 << 20
  return (
    <Tag class={cx('ftile', picked && 'picked', drop && 'drop')} href={Tag === 'a' ? itemHref(item) : undefined} data-key={item.key} tabIndex={Tag === 'a' ? undefined : 0} onClick={onClick} {...drag}>
      <span class="ftile-art">
        {thumb ? <img src={contentUrl(item.id)} alt="" loading="lazy" draggable={false} /> : <ItemIcon item={item} size={30} />}
        <Pick picked={picked} onPick={onPick} name={item.name} />
      </span>
      <span class="ftile-foot">
        <span class="grow" style={{ minWidth: 0 }}>
          <span class="ellipsis name" title={item.name}>{item.name}</span>
          {item.uploading ? <Progress item={item} /> : <span class="sub ellipsis">{item.type === 'file' ? bytes(item.size) + ' · ' : ''}{when(item.updated * 1000)}</span>}
        </span>
        <RowMenu item={item} menu={menu} />
      </span>
    </Tag>
  )
}

function NameDialog({ title, action, initial, placeholder, onSave, onClose }) {
  const [name, setName] = useState(initial)
  const submit = (e) => { e.preventDefault(); if (name.trim()) { onSave(name.trim()); onClose() } }
  return (
    <Modal title={title} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!name.trim()} onClick={submit}>{action}</Button></>}>
      <form onSubmit={submit}><input class="input" autofocus placeholder={placeholder} value={name} onInput={(e) => setName(e.target.value)} /></form>
    </Modal>
  )
}

function ShareItem({ item, onClose }) {
  if (item.type === 'doc') return <ShareDialog doc={item.ref} onClose={onClose} />
  const parent = folders.value[item.parent]
  const inherited = parent && (parent.access === 'org' || parent.shares?.length > 0 || parent.role !== 'owner' || parent.owner !== item.owner)
  return (
    <ShareDialog
      doc={{ ...item.ref, title: item.name }}
      save={(change) => shareItem(item, change)}
      link={{ url: item.link ? publicUrl(item.link) : '', toggle: (on) => setPublicLink(item.ref, on) }}
      note={inherited ? `Everyone who can open the folder "${parent.name}" can open this too.` : item.type === 'folder' ? 'Everything in this folder is shared along with it.' : ''}
      onClose={onClose}
    />
  )
}

// Browser is the small folder view inside the "move to" and "choose a file"
// dialogs.
function Browser({ at, setAt, files, chosen, onChoose, disabled = () => false }) {
  const me = user.value.id
  const view = at === 'shared' ? 'shared' : at ? 'folder' : 'mine'
  const here = at && at !== 'shared' ? folders.value[at] : null
  const list = sorted(listing(view, at).filter((i) => i.type === 'folder' || (files && i.type === 'file' && !i.uploading)), { sort: 'name', dir: 1 })
  const crumbs = here ? trail(at) : []
  const sharedRoot = view === 'shared' || (crumbs[0] && crumbs[0].owner !== me)
  return (
    <div class="browser">
      <div class="tabs" style={{ marginBottom: 8 }}>
        <button class={cx('tab', !sharedRoot && 'on')} onClick={() => setAt('')}>My files</button>
        <button class={cx('tab', sharedRoot && 'on')} onClick={() => setAt('shared')}>Shared with me</button>
      </div>
      {crumbs.length > 0 && (
        <div class="browser-crumbs">
          <IconButton icon={ChevronLeft} label="Up" onClick={() => setAt(crumbs.length > 1 ? crumbs[crumbs.length - 2].id : sharedRoot ? 'shared' : '')} />
          <span class="ellipsis">{crumbs.map((c) => c.name).join(' › ')}</span>
        </div>
      )}
      <div class="card browser-list">
        {list.length === 0 && <Empty icon={Folder} title={files ? 'Nothing here' : 'No folders here'} />}
        {list.map((i) => (
          <button key={i.key} class={cx('list-row hover', chosen === i.key && 'picked')} disabled={disabled(i)} onClick={() => (i.type === 'folder' ? setAt(i.id) : onChoose(i))} onDblClick={() => i.type === 'file' && onChoose(i, true)}>
            <ItemIcon item={i} />
            <span class="grow ellipsis name">{i.name}</span>
            {i.type === 'folder' ? <ChevronRight size={16} class="muted" /> : <span class="muted">{bytes(i.size)}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

function MoveDialog({ items: moving, onMove, onClose }) {
  const [at, setAt] = useState('')
  const dest = at === 'shared' ? null : at
  const ok = dest !== null && canMoveInto(moving, dest)
  const name = dest ? folders.value[dest]?.name : 'My files'
  const inside = new Set(moving.filter((i) => i.type === 'folder').map((i) => i.id))
  return (
    <Modal title={moving.length === 1 ? `Move "${moving[0].name}"` : `Move ${moving.length} items`} onClose={onClose} width={500}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!ok} onClick={() => onMove(dest)}>{dest === null ? 'Choose a folder' : `Move to ${name}`}</Button></>}>
      <Browser at={at} setAt={setAt} disabled={(i) => inside.has(i.id)} />
    </Modal>
  )
}

// FilePicker is mounted once in the shell; lib/files pickFromFiles() opens it.
export function FilePicker() {
  const p = picker.value
  const [at, setAt] = useState('')
  const [chosen, setChosen] = useState(null)
  useEffect(() => {
    setAt('')
    setChosen(null)
  }, [!!p])
  if (!p) return null
  return (
    <Modal title={p.title} onClose={() => p.resolve(null)} width={500}
      footer={<><Button onClick={() => p.resolve(null)}>Cancel</Button><Button kind="primary" disabled={!chosen} onClick={() => p.resolve(chosen.ref)}>{p.action}</Button></>}>
      <Browser at={at} setAt={(to) => { setAt(to); setChosen(null) }} files chosen={chosen?.key} onChoose={(i, now) => (now ? p.resolve(i.ref) : setChosen(i))} />
    </Modal>
  )
}

// --- preview ---------------------------------------------------------------

// The rendered Markdown lives in its own script-less frame, which cannot see
// the app's design tokens, so it is handed their current values.
function frameCss() {
  const css = getComputedStyle(document.documentElement)
  const v = (name) => css.getPropertyValue(name).trim()
  return `html{color-scheme:${v('color-scheme') || 'light'}}body{margin:0 auto;padding:28px 32px;max-width:820px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:${v('--ink')};background:${v('--bg')};overflow-wrap:anywhere}
a{color:${v('--accent')}}pre{background:${v('--canvas')};padding:12px 14px;border-radius:8px;overflow:auto;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}code{font:0.92em ui-monospace,Menlo,Consolas,monospace;background:${v('--sunken')};padding:1px 4px;border-radius:4px}pre code{background:none;padding:0}
blockquote{margin:12px 0;padding-left:14px;border-left:3px solid ${v('--line-strong')};color:${v('--muted')}}hr{border:0;border-top:1px solid ${v('--line')};margin:20px 0}h1,h2,h3{line-height:1.25}`
}

// PreviewBody shows one file. src is where its content comes from, so the
// same view serves the drive and a public link.
export function PreviewBody({ item, src, download }) {
  const type = fileType(item)
  const [text, setText] = useState(null)
  const [failed, setFailed] = useState(false)
  const textual = type === 'text' || type === 'markdown'
  useEffect(() => {
    setText(null)
    setFailed(false)
    if (textual) fetchText(src).then(setText, () => setFailed(true))
  }, [src, textual])
  if (type === 'image') return <div class="preview-stage"><img src={src} alt={item.name} /></div>
  if (type === 'video') return <div class="preview-stage"><video src={src} controls autoplay playsInline /></div>
  if (type === 'audio') return <div class="preview-stage"><div class="preview-audio"><ItemIcon item={item} size={34} /><audio src={src} controls autoplay /></div></div>
  if (type === 'pdf') return <iframe class="preview-frame" title={item.name} src={src} />
  if (textual && !failed) {
    if (text === null) return <div class="preview-stage" />
    const cut = item.size > text.length * 4 && item.size > 1 << 20
    if (type === 'markdown') {
      const page = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${frameCss()}</style></head><body>${markdownToHtml(text)}</body></html>`
      return <iframe class="preview-frame" title={item.name} sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc={page} />
    }
    return <div class="preview-scroll"><pre class="preview-text">{text}{cut ? '\n\n… the rest of this file is not shown. Download it to see everything.' : ''}</pre></div>
  }
  return (
    <div class="preview-stage">
      <Empty icon={typeIcons[type] || FileIcon} title="No preview for this kind of file" text={`${bytes(item.size)}${item.mime ? ' · ' + item.mime : ''}`}>
        <a class="btn btn-primary" href={download} download={item.name}><Download size={16} /> Download</a>
      </Empty>
    </div>
  )
}

function Preview({ item, siblings, onShare, onOpenAs }) {
  const at = siblings.findIndex((i) => i.id === item.id)
  const prev = at > 0 ? siblings[at - 1] : null
  const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : null
  const back = item.parent && folders.value[item.parent] ? '/files/folder/' + item.parent : item.owner === user.value.id ? '/files' : '/files/shared'
  const as = opensAs(item)
  useEffect(() => {
    const key = (e) => {
      if (e.target.closest?.('input, textarea, select, .modal')) return
      if (e.key === 'Escape') navigate(back)
      else if (e.key === 'ArrowLeft' && prev) navigate(itemHref(prev), { replace: true })
      else if (e.key === 'ArrowRight' && next) navigate(itemHref(next), { replace: true })
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [item.id, prev?.id, next?.id, back])
  const owner = peopleById.value[item.owner]
  return (
    <div class="preview" role="dialog" aria-label={item.name}>
      <header class="preview-bar">
        <a class="icon-btn" href={back} aria-label="Close preview" title="Close (Esc)"><X size={18} /></a>
        <ItemIcon item={item} />
        <div class="grow" style={{ minWidth: 0 }}>
          <div class="ellipsis name">{item.name}</div>
          <div class="sub ellipsis">{bytes(item.size)} · {owner ? (item.owner === user.value.id ? 'You' : owner.name) + ' · ' : ''}{whenFull(item.updated * 1000)}</div>
        </div>
        {siblings.length > 1 && <IconButton icon={ChevronLeft} label="Previous" disabled={!prev} onClick={() => navigate(itemHref(prev), { replace: true })} />}
        {siblings.length > 1 && <IconButton icon={ChevronRight} label="Next" disabled={!next} onClick={() => navigate(itemHref(next), { replace: true })} />}
        {as && <Button icon={ExternalLink} onClick={onOpenAs}><span class="wide-only">{'Open as ' + docKinds[as].name.toLowerCase()}</span></Button>}
        <Button icon={Share2} onClick={onShare}><span class="wide-only">Share</span></Button>
        <a class="btn btn-primary" href={contentUrl(item.id, true)} download={item.name}><Download size={16} /><span class="wide-only">Download</span></a>
      </header>
      <PreviewBody key={item.id} item={item} src={contentUrl(item.id)} download={contentUrl(item.id, true)} />
    </div>
  )
}
