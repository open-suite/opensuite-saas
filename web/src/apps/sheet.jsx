import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  ArrowLeft, Undo2, Redo2, Bold, Italic, Underline, Strikethrough, Baseline, PaintBucket, AlignLeft, AlignCenter, AlignRight,
  Grid2x2, Users, MoreHorizontal, FileDown, Trash2, Plus, FileX2, Rows3, Columns3, Merge, Pencil,
} from 'lucide-preact'
import './sheet.css'
import { user, docs, upsertDoc, toast, confirmed } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { refreshBoot } from '../lib/api.js'
import { renameDoc, trashDoc } from '../lib/docs.js'
import { cx, debounce, download } from '../lib/util.js'
import { Avatar, Button, Empty, IconButton, Menu, Modal, Popover, Swatches, inkColors, markColors } from '../ui.jsx'
import { ShareDialog } from './docs.jsx'
import { Sheet, colName, prewarmSheets } from './sheet-core.js'

export { xlsxToSnapshot } from './sheet-core.js'

export const prewarm = () => prewarmSheets(docs.value.filter((d) => d.kind === 'sheet' && !d.trashed).slice(0, 8).map((d) => d.id))

const formats = [
  ['general', 'Automatic'],
  ['#,##0.00', 'Number'],
  ['0%', 'Percent'],
  ['0.00%', 'Percent (0.00)'],
  ['"€"#,##0.00', 'Euro'],
  ['"$"#,##0.00', 'Dollar'],
  ['"£"#,##0.00', 'Pound'],
  ['dd/mm/yyyy', 'Date'],
  ['yyyy-mm-dd', 'Date (ISO)'],
  ['hh:mm', 'Time'],
]

function Toolbar({ s }) {
  const st = s.style()
  const f = st.font || {}
  const align = st.alignment?.horizontal
  const fmt = formats.find(([code]) => code === st.num_fmt) ? st.num_fmt : 'other'
  const rows = s.sel.r2 - s.sel.r1 + 1
  const cols = s.sel.c2 - s.sel.c1 + 1
  const border = (type) => s.act((m) => m.setAreaWithBorder(s.area(), { item: { style: 'thin', color: '#000000' }, type }))
  return (
    <div class="toolbar" role="toolbar" aria-label="Formatting">
      <IconButton icon={Undo2} label="Undo" disabled={!s.model.canUndo()} onClick={() => s.undo()} />
      <IconButton icon={Redo2} label="Redo" disabled={!s.model.canRedo()} onClick={() => s.redo()} />
      <span class="sep" />
      <select class="select" aria-label="Number format" value={fmt} onChange={(e) => s.setStyle('num_fmt', e.target.value)}>
        {formats.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        {fmt === 'other' && <option value="other">Custom</option>}
      </select>
      <span class="sep" />
      <IconButton icon={Bold} label="Bold" active={!!f.b} onClick={() => s.toggle('font.b')} />
      <IconButton icon={Italic} label="Italic" active={!!f.i} onClick={() => s.toggle('font.i')} />
      <IconButton icon={Underline} label="Underline" active={!!f.u} onClick={() => s.toggle('font.u')} />
      <IconButton icon={Strikethrough} label="Strikethrough" active={!!f.strike} onClick={() => s.toggle('font.strike')} />
      <Popover icon={Baseline} label="Text colour">
        <Swatches colors={inkColors} clear="Default colour" onPick={(c) => s.setStyle('font.color', c || '#000000')} />
      </Popover>
      <Popover icon={PaintBucket} label="Fill colour">
        <Swatches colors={markColors} clear="No fill" onPick={(c) => s.setStyle('fill.color', c || '')} />
      </Popover>
      <span class="sep" />
      <IconButton icon={AlignLeft} label="Align left" active={align === 'left'} onClick={() => s.setStyle('alignment.horizontal', 'left')} />
      <IconButton icon={AlignCenter} label="Centre" active={align === 'center'} onClick={() => s.setStyle('alignment.horizontal', 'center')} />
      <IconButton icon={AlignRight} label="Align right" active={align === 'right'} onClick={() => s.setStyle('alignment.horizontal', 'right')} />
      <span class="sep" />
      <Menu trigger={<IconButton icon={Grid2x2} label="Borders" />} items={[
        { label: 'All borders', onSelect: () => border('All') },
        { label: 'Outer border', onSelect: () => border('Outer') },
        { label: 'Bottom border', onSelect: () => border('Bottom') },
        { label: 'No borders', onSelect: () => border('None') },
      ]} />
      <Menu trigger={<IconButton icon={Merge} label="Merge cells" />} items={[
        { label: 'Merge cells', disabled: rows * cols < 2, onSelect: () => s.act((m) => m.mergeCells(s.area())) },
        { label: 'Unmerge', onSelect: () => s.act((m) => m.unmergeCells(s.area())) },
      ]} />
      <Menu trigger={<IconButton icon={Rows3} label="Rows" />} items={[
        { label: 'Insert row above', onSelect: () => s.act((m) => m.insertRows(s.sheet, s.sel.r1, 1)) },
        { label: 'Insert row below', onSelect: () => s.act((m) => m.insertRows(s.sheet, s.sel.r2 + 1, 1)) },
        { divider: true },
        { label: rows > 1 ? `Delete ${rows} rows` : 'Delete row', danger: true, disabled: rows > 5000, onSelect: () => s.act((m) => m.deleteRows(s.sheet, s.sel.r1, rows)) },
      ]} />
      <Menu trigger={<IconButton icon={Columns3} label="Columns" />} items={[
        { label: 'Insert column left', onSelect: () => s.act((m) => m.insertColumns(s.sheet, s.sel.c1, 1)) },
        { label: 'Insert column right', onSelect: () => s.act((m) => m.insertColumns(s.sheet, s.sel.c2 + 1, 1)) },
        { divider: true },
        { label: cols > 1 ? `Delete ${cols} columns` : 'Delete column', danger: true, disabled: cols > 500, onSelect: () => s.act((m) => m.deleteColumns(s.sheet, s.sel.c1, cols)) },
      ]} />
    </div>
  )
}

export default function SheetView({ id }) {
  const doc = docs.value.find((d) => d.id === id)
  const me = user.value
  const wrap = useRef()
  const canvas = useRef()
  const scroll = useRef()
  const spacer = useRef()
  const cellInput = useRef()
  const barInput = useRef()
  const ctl = useRef(null)
  const [, bump] = useState(0)
  const [share, setShare] = useState(false)
  const [renaming, setRenaming] = useState(null)

  useEffect(() => {
    if (!doc) refreshBoot()
  }, [id])

  useLayoutEffect(() => {
    if (!doc) return
    let raf = 0
    const s = new Sheet({
      id, me, title: doc.title || 'Workbook',
      onChange: () => {
        raf ||= requestAnimationFrame(() => {
          raf = 0
          bump((n) => n + 1)
        })
      },
    })
    s.onTitle = (title) => {
      const d = docs.value.find((x) => x.id === id)
      if (d && d.title !== title) upsertDoc({ ...d, title })
    }
    ctl.current = s
    s.open(wrap.current, canvas.current, scroll.current, spacer.current)
    bump((n) => n + 1) // draw the toolbar before this frame is painted
    return () => {
      cancelAnimationFrame(raf)
      ctl.current = null
      s.close()
    }
  }, [id, !!doc])

  const s = ctl.current
  const live = s?.model ? s : null
  const editing = live && live.draft !== null

  // When typing starts in the grid, the caret moves into the cell.
  useLayoutEffect(() => {
    if (editing && document.activeElement !== barInput.current && cellInput.current) {
      const el = cellInput.current
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [editing])

  const rename = useRef(debounce((d, title) => renameDoc(d, title), 500)).current

  if (!doc) {
    return (
      <div class="page">
        {confirmed.value && <Empty icon={FileX2} title="This spreadsheet isn't available" text="It may have been deleted, or it hasn't been shared with you."><Button onClick={() => navigate('/docs')}>Back to Docs</Button></Empty>}
      </div>
    )
  }

  const editKeys = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); live.commit(e.shiftKey ? -1 : 1, 0) }
    else if (e.key === 'Tab') { e.preventDefault(); live.commit(0, e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') { e.preventDefault(); live.cancel() }
  }
  const rect = editing ? live.rect(live.sel.row, live.sel.col) : null
  const sheets = live ? live.sheets : []
  const others = live ? [...new Map([...live.peers.values()].map((p) => [p.u.id, p.u])).values()] : []
  const status = !live ? '' : !live.online ? 'Offline · saved on this device' : live.saved ? 'Saved' : 'Saving…'
  const ref = live ? (live.sel.r1 === live.sel.r2 && live.sel.c1 === live.sel.c2 ? colName(live.sel.col) + live.sel.row : `${colName(live.sel.c1)}${live.sel.r1}:${colName(Math.min(live.sel.c2, 16384))}${Math.min(live.sel.r2, 1048576)}`) : ''
  const exportXlsx = () => {
    try {
      download(new Blob([live.model.toXlsx()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${doc.title || 'Untitled'}.xlsx`)
    } catch (e) {
      toast("This spreadsheet couldn't be exported.", 'error')
    }
  }
  const addSheet = () => {
    live.act((m) => m.newSheet())
    live.useSheet(live.sheets.length - 1)
  }

  return (
    <div class="sheet-view">
      <div class="doc-bar">
        <IconButton icon={ArrowLeft} label="All docs" onClick={() => navigate('/docs')} />
        <input class="doc-title" aria-label="Title" placeholder="Untitled" value={doc.title} disabled={doc.role === 'view'}
          onInput={(e) => { upsertDoc({ ...doc, title: e.target.value }); rename(doc, e.target.value) }}
          onKeyDown={(e) => e.key === 'Enter' && wrap.current.focus()} />
        <span class="save-state">{status}</span>
        <span class="grow" />
        <span class="presence">{others.slice(0, 5).map((u) => <span key={u.id} title={u.name}><Avatar name={u.name} id={u.id} size={28} /></span>)}</span>
        <Button icon={Users} kind={doc.access === 'org' || doc.shares?.length ? 'default' : 'primary'} onClick={() => setShare(true)}>Share</Button>
        <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label="More" />} items={[
          { label: 'Download as Excel (.xlsx)', icon: FileDown, disabled: !live, onSelect: exportXlsx },
          doc.role === 'owner' && { divider: true },
          doc.role === 'owner' && { label: 'Move to trash', icon: Trash2, danger: true, onSelect: () => { trashDoc(doc); navigate('/docs') } },
        ]} />
      </div>
      {live && live.canEdit ? <Toolbar s={live} /> : <div class="toolbar" style={{ minHeight: 43 }} />}
      <div class="formula-bar">
        <div class="ref">{ref}</div>
        <span class="fx">fx</span>
        <input ref={barInput} aria-label="Cell contents" spellcheck={false} disabled={!live?.canEdit}
          value={live ? (editing ? live.draft : live.content()) : ''}
          onFocus={() => live && !editing && live.startEdit()}
          onInput={(e) => live.setDraft(e.target.value)}
          onKeyDown={editKeys} />
      </div>
      <div class="grid-wrap" ref={wrap} tabIndex={0} onKeyDown={(e) => e.target === wrap.current && live?.onKey(e)}>
        <canvas ref={canvas} />
        <div class="grid-scroll" ref={scroll}><div ref={spacer} /></div>
        {editing && (
          <input ref={cellInput} class="cell-editor" spellcheck={false} value={live.draft}
            style={{ left: Math.max(rect.x, 46), top: Math.max(rect.y, 24), height: rect.h + 1, width: Math.max(rect.w + 1, Math.min(600, live.draft.length * 8 + 24)) }}
            onInput={(e) => live.setDraft(e.target.value)}
            onKeyDown={editKeys} />
        )}
      </div>
      <div class="sheet-tabs">
        {sheets.map((sh, i) => sh.state === 'visible' && (
          <Menu key={sh.sheet_id} align="up" trigger={
            <button class={cx('sheet-tab', live.sheet === i && 'on')} onClick={(e) => { if (live.sheet !== i) { e.stopPropagation(); live.useSheet(i) } }}>{sh.name}</button>
          } items={[
            { label: 'Rename', icon: Pencil, onSelect: () => setRenaming({ i, name: sh.name }) },
            { label: 'Delete sheet', icon: Trash2, danger: true, disabled: sheets.length < 2, onSelect: () => { live.act((m) => m.deleteSheet(i)); live.useSheet(Math.max(0, i - 1)) } },
          ]} />
        ))}
        {live?.canEdit && <IconButton icon={Plus} label="Add sheet" onClick={addSheet} />}
      </div>
      {share && <ShareDialog doc={doc} onClose={() => setShare(false)} />}
      {renaming && (
        <Modal title="Rename sheet" onClose={() => setRenaming(null)} footer={<><Button onClick={() => setRenaming(null)}>Cancel</Button><Button kind="primary" onClick={() => { live.act((m) => m.renameSheet(renaming.i, renaming.name.trim())); setRenaming(null) }}>Rename</Button></>}>
          <input class="input" autofocus value={renaming.name} onInput={(e) => setRenaming({ ...renaming, name: e.target.value })} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
    </div>
  )
}
