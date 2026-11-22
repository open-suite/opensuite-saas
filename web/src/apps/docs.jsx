import { useState } from 'preact/hooks'
import { FileText, Table2, Plus, Upload, MoreHorizontal, Trash2, Users, Pencil, RotateCcw, Search, Lock, Building2 } from 'lucide-preact'
import { docs, user, org, people, peopleById, toast } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { createDoc, openNew, docPath, renameDoc, shareDoc, trashDoc, deleteDoc, convert } from '../lib/docs.js'
import { cx, when, pickFile } from '../lib/util.js'
import { Avatar, Button, Empty, IconButton, Menu, Modal, Field } from '../ui.jsx'

export function KindIcon({ kind }) {
  return <span class={cx('kind-icon', 'kind-' + kind)}>{kind === 'sheet' ? <Table2 size={17} /> : <FileText size={17} />}</span>
}

// importFile turns a Word, OpenDocument, Markdown or Excel file into a new
// document or spreadsheet.
export async function importFile() {
  const file = await pickFile('.docx,.odt,.md,.xlsx')
  if (!file) return
  const ext = file.name.split('.').pop().toLowerCase()
  const title = file.name.replace(/\.[^.]+$/, '')
  try {
    if (ext === 'xlsx') {
      // The spreadsheet engine reads .xlsx itself, on this device.
      const { xlsxToSnapshot } = await import('./sheet.jsx')
      const snap = await xlsxToSnapshot(new Uint8Array(await file.arrayBuffer()), title)
      const { doc } = createDoc('sheet', { title, snapshot: await toBase64(new Blob([snap])) })
      navigate(docPath(doc))
    } else {
      const res = await convert(ext, 'html', file)
      const html = await res.text()
      const { doc } = createDoc('doc', { title })
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

export function ShareDialog({ doc, onClose }) {
  const mine = doc.role === 'owner'
  const [add, setAdd] = useState('')
  const others = people.value.filter((p) => p.id !== doc.owner && p.status === 'active')
  const shared = doc.shares || []
  const setShares = (shares) => shareDoc(doc, { shares })
  const owner = peopleById.value[doc.owner]
  return (
    <Modal title={`Share "${doc.title || 'Untitled'}"`} onClose={onClose} footer={<Button kind="primary" onClick={onClose}>Done</Button>}>
      <Field label="General access">
        <div class="row">
          <button class={cx('btn', doc.access === 'private' && 'btn-primary')} disabled={!mine} onClick={() => shareDoc(doc, { access: 'private' })}><Lock size={15} /> Only people added</button>
          <button class={cx('btn', doc.access === 'org' && 'btn-primary')} disabled={!mine} onClick={() => shareDoc(doc, { access: 'org' })}><Building2 size={15} /> Everyone at {org.value.name}</button>
        </div>
      </Field>
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
    </Modal>
  )
}

export function RenameDialog({ doc, onClose }) {
  const [title, setTitle] = useState(doc.title)
  const save = (e) => { e.preventDefault(); renameDoc(doc, title.trim()); onClose() }
  return (
    <Modal title="Rename" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save}>Rename</Button></>}>
      <form onSubmit={save}><input class="input" autofocus value={title} onInput={(e) => setTitle(e.target.value)} onFocus={(e) => e.target.select()} /></form>
    </Modal>
  )
}

export function Docs() {
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState(null)
  const me = user.value.id
  const needle = q.trim().toLowerCase()
  const rows = docs.value.filter((d) => {
    if (tab === 'trash') return d.trashed
    if (d.trashed) return false
    if (tab === 'doc' || tab === 'sheet') if (d.kind !== tab) return false
    if (tab === 'shared' && d.owner === me) return false
    return !needle || (d.title || 'untitled').toLowerCase().includes(needle)
  })
  const tabs = [['all', 'All'], ['doc', 'Documents'], ['sheet', 'Spreadsheets'], ['shared', 'Shared with me'], ['trash', 'Trash']]
  return (
    <div class="page">
      <div class="page-inner">
        <div class="page-head">
          <h1>Docs</h1>
          <Button icon={Upload} onClick={importFile}>Import</Button>
          <Button icon={Table2} onClick={() => openNew('sheet')}>New spreadsheet</Button>
          <Button kind="primary" icon={Plus} onClick={() => openNew('doc')}>New document</Button>
        </div>
        <div class="row" style={{ marginBottom: 14 }}>
          <div class="tabs grow" style={{ marginBottom: 0 }}>
            {tabs.map(([k, label]) => <button key={k} class={cx('tab', tab === k && 'on')} onClick={() => setTab(k)}>{label}</button>)}
          </div>
          <div style={{ position: 'relative', width: 240 }}>
            <Search size={15} style={{ position: 'absolute', left: 10, top: 10, color: 'var(--faint)' }} />
            <input class="input" style={{ paddingLeft: 32 }} placeholder="Filter by name" value={q} onInput={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div class="card">
          {rows.length === 0 ? (
            <Empty icon={FileText} title={tab === 'trash' ? 'Trash is empty' : needle ? 'Nothing matches' : 'No documents yet'} text={tab === 'all' && !needle ? 'Create a document or spreadsheet, or import a Word or Excel file.' : ''} />
          ) : (
            rows.map((d) => {
              const owner = peopleById.value[d.owner]
              return (
                <a class="list-row" href={docPath(d)} key={d.id}>
                  <KindIcon kind={d.kind} />
                  <span class="grow ellipsis" style={{ fontWeight: 550 }}>{d.title || 'Untitled'}</span>
                  {(d.access === 'org' || d.shares?.length > 0) && <Users size={15} class="muted" aria-label="Shared" />}
                  <span class="muted ellipsis" style={{ width: 150 }}>{d.owner === me ? 'You' : owner?.name}</span>
                  <span class="muted" style={{ width: 90, textAlign: 'right' }}>{when(d.updated * 1000)}</span>
                  <span onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
                    <Menu
                      align="right"
                      trigger={<IconButton icon={MoreHorizontal} label="More" />}
                      items={d.trashed ? [
                        { label: 'Restore', icon: RotateCcw, onSelect: () => trashDoc(d, false) },
                        { label: 'Delete for ever', icon: Trash2, danger: true, onSelect: () => deleteDoc(d) },
                      ] : [
                        d.role !== 'view' && { label: 'Rename', icon: Pencil, onSelect: () => setDialog({ type: 'rename', doc: d }) },
                        { label: 'Share', icon: Users, onSelect: () => setDialog({ type: 'share', doc: d }) },
                        d.role === 'owner' && { divider: true },
                        d.role === 'owner' && { label: 'Move to trash', icon: Trash2, danger: true, onSelect: () => trashDoc(d) },
                      ]}
                    />
                  </span>
                </a>
              )
            })
          )}
        </div>
      </div>
      {dialog?.type === 'share' && <ShareDialog doc={docs.value.find((d) => d.id === dialog.doc.id) || dialog.doc} onClose={() => setDialog(null)} />}
      {dialog?.type === 'rename' && <RenameDialog doc={dialog.doc} onClose={() => setDialog(null)} />}
    </div>
  )
}
