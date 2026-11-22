// Version history, shared by the document and spreadsheet editors. The panel
// lists versions and fetches the one chosen; each editor decides how to show
// a past version and how to make it the present again.
import { useEffect, useState } from 'preact/hooks'
import { X, MoreHorizontal, Pencil, RotateCcw, BookmarkPlus, History } from 'lucide-preact'
import './side-panel.css'
import './versions.css'
import { peopleById, toast } from '../lib/store.js'
import { get, post, patch } from '../lib/api.js'
import { fetchVersion } from '../lib/sync.js'
import { cx, clock, dayLabel } from '../lib/util.js'
import { Button, IconButton, Menu, Modal } from '../ui.jsx'

export default function Versions({ doc, viewing, onView, onRestore, onClose }) {
  const [list, setList] = useState(null)
  const [naming, setNaming] = useState(null) // { id | null, name }
  const base = `/api/docs/${doc.id}/versions`
  const load = () => get(base).then(setList).catch((e) => { setList([]); toast(e.message, 'error') })
  // Again whenever a past version is left: restoring files a new one.
  useEffect(() => { load() }, [doc.id, viewing])

  const open = async (v) => {
    try {
      onView(v, await fetchVersion(doc.id, v.id))
    } catch {
      toast("That version couldn't be opened.", 'error')
    }
  }
  const saveName = async (e) => {
    e?.preventDefault()
    const name = naming.name.trim()
    try {
      if (naming.id) await patch(`${base}/${naming.id}`, { name })
      else if (name) await post(base, { name })
      setNaming(null)
      load()
    } catch (err) {
      toast(err.message, 'error')
    }
  }
  const restore = async (v) => {
    try {
      await onRestore(v, await fetchVersion(doc.id, v.id))
      toast('Version restored')
      load()
    } catch (err) {
      toast(err.message || "That version couldn't be restored.", 'error')
    }
  }
  const who = (v) => v.editors.map((id) => peopleById.value[id]?.name).filter(Boolean).join(', ')

  let day = ''
  return (
    <aside class="versions" aria-label="Version history">
      <header class="side-top">
        <h2>Version history</h2>
        <span class="grow" />
        <IconButton icon={X} label="Close version history" onClick={onClose} />
      </header>
      <div class="ver-list">
        <button type="button" class={cx('ver-row', !viewing && 'on')} onClick={() => onView(null)}>
          <span class="ver-dot now" />
          <span class="grow">
            <span class="ver-title">Current version</span>
            <span class="ver-sub">What everyone sees now</span>
          </span>
        </button>
        <Button icon={BookmarkPlus} class="ver-name" onClick={() => setNaming({ id: null, name: '' })}>Name this version</Button>
        {list && list.length === 0 && (
          <div class="side-empty">
            <History size={22} />
            <p>Earlier versions appear here as the {doc.kind === 'sheet' ? 'spreadsheet' : 'document'} changes. Name one to keep it for good.</p>
          </div>
        )}
        {(list || []).map((v) => {
          const label = dayLabel(v.created * 1000)
          const head = label !== day ? (day = label) : null
          return (
            <>
              {head && <div class="ver-day" key={'d' + v.id}>{head}</div>}
              <div class={cx('ver-row', viewing === v.id && 'on')} key={v.id} role="button" tabIndex={0} onClick={() => open(v)} onKeyDown={(e) => e.key === 'Enter' && open(v)}>
                <span class={cx('ver-dot', !v.auto && 'named')} />
                <span class="grow">
                  <span class="ver-title ellipsis">{v.name || clock(v.created * 1000)}</span>
                  <span class="ver-sub ellipsis">{v.name ? clock(v.created * 1000) + ' · ' : ''}{who(v) || 'Saved automatically'}</span>
                </span>
                <span onClick={(e) => e.stopPropagation()}>
                  <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label="Version options" size={16} class="side-icon" />} items={[
                    { label: v.name ? 'Rename' : 'Name this version', icon: Pencil, onSelect: () => setNaming({ id: v.id, name: v.name }) },
                    { label: 'Restore this version', icon: RotateCcw, onSelect: () => restore(v) },
                  ]} />
                </span>
              </div>
            </>
          )
        })}
      </div>
      {naming && (
        <Modal title={naming.id ? 'Name this version' : 'Name the current version'} onClose={() => setNaming(null)} footer={<><Button onClick={() => setNaming(null)}>Cancel</Button><Button kind="primary" onClick={saveName}>Save</Button></>}>
          <form onSubmit={saveName}>
            <input class="input" autofocus placeholder="For example: Sent to the board" value={naming.name} onInput={(e) => setNaming({ ...naming, name: e.target.value })} />
          </form>
          <p class="muted" style={{ fontSize: 12.5 }}>Named versions are kept for good. Unnamed ones are thinned out as they age.</p>
        </Modal>
      )}
    </aside>
  )
}

// The strip shown above a past version while it is on screen.
export function VersionBar({ version, onRestore, onBack }) {
  const [busy, setBusy] = useState(false)
  return (
    <div class="version-bar">
      <History size={16} />
      <span class="grow ellipsis">{version.name ? `${version.name} · ` : ''}{dayLabel(version.created * 1000)}, {clock(version.created * 1000)}</span>
      <Button onClick={onBack}>Back to current</Button>
      <Button kind="primary" icon={RotateCcw} busy={busy} onClick={async () => { setBusy(true); try { await onRestore() } finally { setBusy(false) } }}>Restore this version</Button>
    </div>
  )
}
