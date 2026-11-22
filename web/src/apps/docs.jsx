// What documents of every kind share: their icon, turning an uploaded file
// into one, and the dialogs for sharing and renaming. The list they live in
// is the drive (apps/files.jsx).
import { useState } from 'preact/hooks'
import { FileText, Table2, Presentation, Lock, Building2, Globe, Copy } from 'lucide-preact'
import { org, people, peopleById, toast } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { createDoc, docPath, renameDoc, shareDoc, convert } from '../lib/docs.js'
import { cx, pickFile, copyText } from '../lib/util.js'
import { Avatar, Button, Modal, Field } from '../ui.jsx'

// One icon per kind of document; a new editor adds its line here.
export const kindIcons = { doc: FileText, sheet: Table2, slides: Presentation }

export function KindIcon({ kind }) {
  const Icon = kindIcons[kind] || FileText
  return <span class={cx('kind-icon', 'kind-' + kind)}><Icon size={17} /></span>
}

// importFile asks for a Word, OpenDocument, Markdown, Excel, CSV or PowerPoint
// file and turns it into a new document, spreadsheet or presentation.
export async function importFile(folder = '') {
  const file = await pickFile('.docx,.odt,.md,.xlsx,.csv,.pptx')
  if (file) await importBlob(file, folder)
}

// importBlob does the same for a file already in hand (one in the drive).
export async function importBlob(file, folder = '') {
  const ext = file.name.split('.').pop().toLowerCase()
  const title = file.name.replace(/\.[^.]+$/, '')
  try {
    if (ext === 'pptx') {
      const { importDeck } = await import('./slides-pptx.js')
      navigate(docPath(await importDeck(file, title, (kind, opts) => createDoc(kind, { ...opts, folder }))))
    } else if (ext === 'xlsx' || ext === 'csv') {
      // The spreadsheet engine reads these itself, on this device.
      const snap = ext === 'csv'
        ? await (await import('../lib/csv.js')).csvToSnapshot(await file.text(), title)
        : await (await import('./sheet.jsx')).xlsxToSnapshot(new Uint8Array(await file.arrayBuffer()), title)
      const { doc } = createDoc('sheet', { title, folder, snapshot: await toBase64(new Blob([snap])) })
      navigate(docPath(doc))
    } else {
      const res = await convert(ext === 'markdown' ? 'md' : ext, 'html', file)
      const html = await res.text()
      const { doc } = createDoc('doc', { title, folder })
      sessionStorage.setItem('os:import:' + doc.id, html)
      navigate(docPath(doc))
    }
  } catch (e) {
    toast(e.message, 'error')
  }
}

function toBase64(file) {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result.split(',')[1])
    r.readAsDataURL(file)
  })
}

// ShareDialog works for anything with an owner, a general access setting and
// a list of people: a document (the default) or, given save, a file or
// folder. link adds "anyone with the link": { url, toggle(on) }.
export function ShareDialog({ doc, onClose, save = (change) => shareDoc(doc, change), link, note }) {
  const mine = doc.role === 'owner'
  const [add, setAdd] = useState('')
  const others = people.value.filter((p) => p.id !== doc.owner && p.status === 'active')
  const shared = doc.shares || []
  const setShares = (shares) => save({ shares })
  const owner = peopleById.value[doc.owner]
  const copy = async () => toast((await copyText(link.url)) ? 'Link copied' : "The link couldn't be copied.")
  return (
    <Modal title={`Share "${doc.title || 'Untitled'}"`} onClose={onClose} footer={<Button kind="primary" onClick={onClose}>Done</Button>}>
      <Field label="General access">
        <div class="row" style={{ flexWrap: 'wrap' }}>
          <button class={cx('btn', doc.access === 'private' && 'btn-primary')} disabled={!mine} onClick={() => save({ access: 'private' })}><Lock size={15} /> Only people added</button>
          <button class={cx('btn', doc.access === 'org' && 'btn-primary')} disabled={!mine} onClick={() => save({ access: 'org' })}><Building2 size={15} /> Everyone at {org.value.name}</button>
        </div>
      </Field>
      {note && <p class="muted" style={{ fontSize: 13 }}>{note}</p>}
      <Field label="People">
        <div class="card">
          {owner && (
            <div class="list-row">
              <Avatar name={owner.name} id={owner.id} size={28} />
              <span class="grow ellipsis">{owner.name}</span>
              <span class="muted">Owner</span>
            </div>
          )}
          {shared.map((s) => {
            const p = peopleById.value[s.user]
            if (!p) return null
            return (
              <div class="list-row" key={s.user}>
                <Avatar name={p.name} id={p.id} size={28} />
                <span class="grow ellipsis">{p.name}</span>
                <select class="select" style={{ width: 110 }} disabled={!mine} value={s.role} onChange={(e) => {
                  if (e.target.value === 'remove') setShares(shared.filter((x) => x.user !== s.user))
                  else setShares(shared.map((x) => (x.user === s.user ? { ...x, role: e.target.value } : x)))
                }}>
                  <option value="edit">Can edit</option>
                  {doc.kind === 'doc' && <option value="comment">Can comment</option>}
                  <option value="view">Can view</option>
                  <option value="remove">Remove</option>
                </select>
              </div>
            )
          })}
        </div>
      </Field>
      {mine && others.some((p) => !shared.find((s) => s.user === p.id)) && (
        <div class="row">
          <select class="select" value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Add a person…</option>
            {others.filter((p) => !shared.find((s) => s.user === p.id)).map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}
          </select>
          <Button disabled={!add} onClick={() => { setShares([...shared, { user: add, role: 'edit' }]); setAdd('') }}>Add</Button>
        </div>
      )}
      {link && mine && (
        <Field label="Anyone with the link" hint={link.url ? 'Anyone who has this link can view and download, without an account.' : 'Off. Only the people above can open this.'}>
          <div class="row" style={{ flexWrap: 'wrap' }}>
            {link.url && <input class="input grow" readOnly value={link.url} onFocus={(e) => e.target.select()} aria-label="Public link" />}
            {link.url && <Button icon={Copy} onClick={copy}>Copy</Button>}
            <Button icon={link.url ? Lock : Globe} onClick={() => link.toggle(!link.url)}>{link.url ? 'Switch off' : 'Create a public link'}</Button>
          </div>
        </Field>
      )}
    </Modal>
  )
}

export function RenameDialog({ doc, onClose, save = (title) => renameDoc(doc, title) }) {
  const [title, setTitle] = useState(doc.title)
  const submit = (e) => { e.preventDefault(); if (title.trim()) save(title.trim()); onClose() }
  return (
    <Modal title="Rename" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={submit}>Rename</Button></>}>
      <form onSubmit={submit}><input class="input" autofocus value={title} onInput={(e) => setTitle(e.target.value)} onFocus={(e) => e.target.select()} /></form>
    </Modal>
  )
}
