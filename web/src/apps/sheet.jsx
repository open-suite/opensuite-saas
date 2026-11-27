import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  ArrowLeft, Undo2, Redo2, Bold, Italic, Underline, Strikethrough, Baseline, PaintBucket, AlignLeft, AlignCenter, AlignRight,
  Grid2x2, Users, Trash2, Plus, FileX2, Merge, Pencil, ChartColumn, Paintbrush, WrapText, Filter, AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
} from 'lucide-preact'
import './sheet.css'
import { user, docs, upsertDoc, toast, confirmed } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { post, refreshBoot } from '../lib/api.js'
import { renameDoc, trashDoc } from '../lib/docs.js'
import { toCsv } from '../lib/csv.js'
import { cx, debounce, download } from '../lib/util.js'
import { Avatar, Button, Empty, IconButton, Menu, Modal, Popover, Swatches, inkColors, markColors, keepFocus } from '../ui.jsx'
import { MenuBar } from '../menubar.jsx'
import { ShareDialog } from './docs.jsx'
import { Sheet, colName, prewarmSheets } from './sheet-core.js'
import { addSheet as appendSheet, extent, values } from './sheet-data.js'
import { formats, fonts, sizes } from './sheet-format.js'
import { sheetMenus } from './sheet-menus.jsx'
import { setFilter, removeFilter, dataBlock, pivotOn } from './sheet-meta.js'
import { FilterMenu, ListMenu, SortDialog, ViewBar, newView, ValidationPanel, CondPanel, PivotCreate, PivotPanel, FindDialog, SizeDialog } from './sheet-panels.jsx'
import { ChartLayer, ChartPanel, insertChart, readCharts, removeChart } from './charts.jsx'

export { xlsxToSnapshot, csvToSnapshot } from './sheet-core.js'

export const prewarm = () => prewarmSheets(docs.value.filter((d) => d.kind === 'sheet' && !d.trashed).slice(0, 8).map((d) => d.id))

// The toolbar keeps the everyday formatting; the menus have the rest.
function Toolbar({ s, onChart, onFilter }) {
  const st = s.style()
  const f = st.font || {}
  const align = st.alignment?.horizontal
  const valign = st.alignment?.vertical || 'bottom'
  const fmt = formats.find(([code]) => code === st.num_fmt) ? st.num_fmt : 'other'
  const rows = s.sel.r2 - s.sel.r1 + 1
  const cols = s.sel.c2 - s.sel.c1 + 1
  const font = f.scheme === 'none' ? f.name || '' : ''
  const size = f.sz || 12
  const wrapMode = st.alignment?.wrap_text ? 'wrap' : s.cell(s.sel.row, s.sel.col).clip ? 'clip' : 'overflow'
  const border = (type) => s.act((m) => m.setAreaWithBorder(s.area(), { item: { style: 'thin', color: '#000000' }, type }))
  const VIcon = valign === 'top' ? AlignVerticalJustifyStart : valign === 'center' ? AlignVerticalJustifyCenter : AlignVerticalJustifyEnd
  return (
    <div class="toolbar" role="toolbar" aria-label="Formatting" onMouseDown={keepFocus}>
      <IconButton icon={Undo2} label="Undo" disabled={!s.model.canUndo()} onClick={() => s.undo()} />
      <IconButton icon={Redo2} label="Redo" disabled={!s.model.canRedo()} onClick={() => s.redo()} />
      <IconButton icon={Paintbrush} label="Paint format" class={cx(s.painter && 'painting')} active={!!s.painter} onClick={() => s.pickPainter()} />
      <span class="sep" />
      <select class="select" aria-label="Number format" value={fmt} onChange={(e) => { s.setStyle('num_fmt', e.target.value); s.wrap.focus() }}>
        {formats.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        {fmt === 'other' && <option value="other">Custom</option>}
      </select>
      <span class="sep" />
      <select class="select tb-font" aria-label="Font" value={font} onChange={(e) => { s.setFont(e.target.value); s.wrap.focus() }}>
        <option value="">Default</option>
        {fonts.map((x) => <option key={x} value={x} style={{ fontFamily: x }}>{x}</option>)}
        {font && !fonts.includes(font) && <option value={font}>{font}</option>}
      </select>
      <select class="select tb-size" aria-label="Font size" value={size} onChange={(e) => { s.setSize(+e.target.value); s.wrap.focus() }}>
        {(sizes.includes(size) ? sizes : [...sizes, size].sort((a, b) => a - b)).map((n) => <option key={n} value={n}>{n}</option>)}
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
      <span class="sep" />
      <IconButton icon={AlignLeft} label="Align left" active={align === 'left'} onClick={() => s.setStyle('alignment.horizontal', 'left')} />
      <IconButton icon={AlignCenter} label="Centre" active={align === 'center'} onClick={() => s.setStyle('alignment.horizontal', 'center')} />
      <IconButton icon={AlignRight} label="Align right" active={align === 'right'} onClick={() => s.setStyle('alignment.horizontal', 'right')} />
      <Menu trigger={<IconButton icon={VIcon} label="Vertical align" />} items={[
        { label: 'Top', icon: AlignVerticalJustifyStart, active: valign === 'top', onSelect: () => s.setStyle('alignment.vertical', 'top') },
        { label: 'Middle', icon: AlignVerticalJustifyCenter, active: valign === 'center', onSelect: () => s.setStyle('alignment.vertical', 'center') },
        { label: 'Bottom', icon: AlignVerticalJustifyEnd, active: valign === 'bottom', onSelect: () => s.setStyle('alignment.vertical', 'bottom') },
      ]} />
      <Menu trigger={<IconButton icon={WrapText} label="Text wrapping" />} items={[
        { label: 'Overflow', active: wrapMode === 'overflow', onSelect: () => s.setWrapping('overflow') },
        { label: 'Wrap', active: wrapMode === 'wrap', onSelect: () => s.setWrapping('wrap') },
        { label: 'Clip', active: wrapMode === 'clip', onSelect: () => s.setWrapping('clip') },
      ]} />
      <span class="sep" />
      <IconButton icon={ChartColumn} label="Insert chart" onClick={onChart} />
      <IconButton icon={Filter} label={s.filter && !s.view ? 'Remove filter' : 'Create a filter'} active={!!s.filter && !s.view} onClick={onFilter} />
    </div>
  )
}

function Tabs({ s }) {
  return (
    <div class="sheet-tabs">
      {s.sheets.map((sh, i) => sh.state === 'visible' && <button key={sh.sheet_id} class={cx('sheet-tab', s.sheet === i && 'on')} onClick={() => s.sheet !== i && s.useSheet(i)}>{sh.name}</button>)}
    </div>
  )
}

// A past version: the same grid, read-only, laid over the live one.
function PastGrid({ id, me, title, state }) {
  const wrap = useRef()
  const canvas = useRef()
  const scroll = useRef()
  const spacer = useRef()
  const ctl = useRef(null)
  const [tick, bump] = useState(0)
  useLayoutEffect(() => {
    const s = new Sheet({ id, me, title, frozen: state, onChange: () => bump((n) => n + 1) })
    ctl.current = s
    s.open(wrap.current, canvas.current, scroll.current, spacer.current)
    return () => {
      ctl.current = null
      s.close()
    }
  }, [state])
  const s = ctl.current?.model ? ctl.current : null
  return (
    <div class="past-grid">
      <div class="grid-wrap" ref={wrap} tabIndex={0} onKeyDown={(e) => e.target === wrap.current && s?.onKey(e)}>
        <canvas ref={canvas} />
        <div class="grid-scroll" ref={scroll}><div ref={spacer} /></div>
        {s && <ChartLayer s={s} tick={tick} selected={null} onSelect={() => {}} onEdit={() => {}} />}
      </div>
      {s ? <Tabs s={s} /> : <div class="sheet-tabs" />}
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
  const titleInput = useRef()
  const ctl = useRef(null)
  // `tick` changes whenever the sheet does; see the same note in editor.jsx.
  const [tick, bump] = useState(0)
  const [share, setShare] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [chartSel, setChartSel] = useState(null) // the selected chart's id
  const [chartEdit, setChartEdit] = useState(false) // its options panel is open
  const [history, setHistory] = useState(null) // the version panel, once asked for
  const [past, setPast] = useState(null) // { version, state }: a past version on screen
  const [floating, setFloating] = useState(null) // a filter menu or dropdown list over the grid
  const [dialog, setDialog] = useState(null) // 'sort' | 'find' | 'replace' | 'pivot' | 'colsize' | 'rowsize'
  const [panel, setPanel] = useState(null) // 'validation' | 'cond' | 'pivot'

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
    // Clicking a cell lets go of a selected chart.
    s.onGridDown = () => setChartSel(null)
    s.onToast = (text, kind) => toast(text, kind)
    s.onWidget = (w) => setFloating(w)
    // A link to a filter view (?fv=) opens it on this screen.
    s.view = new URLSearchParams(location.search).get('fv')
    ctl.current = s
    window.__sheet = s // for tests/e2e-sheet-tools.cjs
    s.open(wrap.current, canvas.current, scroll.current, spacer.current)
    bump((n) => n + 1) // draw the toolbar before this frame is painted
    return () => {
      cancelAnimationFrame(raf)
      if (window.__sheet === s) window.__sheet = null
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

  // The pivot table editor opens by itself on a pivot table's sheet.
  const pivot = live ? pivotOn(live.model, live.sheet, live, live.rev) : null
  useEffect(() => {
    if (pivot && live?.canEdit && !panel) setPanel('pivot')
    if (!pivot && (panel === 'pivot' || panel === 'closed')) setPanel(null)
  }, [pivot?.id, live?.sheet])

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
  const exportCsv = () => {
    const e = extent(live.model, live.sheet)
    const text = e.rows ? toCsv(values(live.model, live.sheet, 1, 1, e.rows, e.cols)) : ''
    download(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${doc.title || 'Untitled'} - ${live.sheets[live.sheet]?.name || 'Sheet'}.csv`)
  }
  const exportXlsx = async () => {
    try {
      const { exportXlsx: toXlsx } = await import('./sheet-xlsx.js')
      download(new Blob([await toXlsx(live.model)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${doc.title || 'Untitled'}.xlsx`)
    } catch (e) {
      console.warn(e)
      toast("This spreadsheet couldn't be exported.", 'error')
    }
  }
  const addSheet = () => {
    live.act((m) => appendSheet(m))
    live.useSheet(live.sheets.length - 1)
  }
  const shown = sheets.map((sh, i) => (sh.state === 'visible' ? i : -1)).filter((i) => i >= 0)
  const dropSheet = (i) => {
    // Move to a visible neighbour first, then find it again once the
    // positions have shifted.
    const at = shown.indexOf(i)
    const stay = sheets[shown[at > 0 ? at - 1 : 1]].sheet_id
    const index = () => Math.max(0, live.sheets.findIndex((sh) => sh.sheet_id === stay))
    live.useSheet(index())
    live.act((m) => m.deleteSheet(i))
    live.useSheet(index())
  }

  const canEdit = doc.role === 'owner' || doc.role === 'edit'
  const chart = live && chartSel ? readCharts(live).find((c) => c.id === chartSel) : null
  const newChart = () => {
    if (live.draft !== null) live.commit()
    setHistory(null)
    setPanel(null)
    setChartSel(insertChart(live))
    setChartEdit(true)
  }
  const dropChart = () => {
    removeChart(live, chartSel)
    setChartSel(null)
    wrap.current.focus()
  }
  const focusGrid = () => wrap.current?.focus()
  // The toolbar's filter button: on with the data around the selection, or off.
  const toggleFilter = () => {
    if (live.view) return openView(null)
    if (live.filter) live.act((m) => removeFilter(m, live.sheet))
    else live.act((m) => setFilter(m, live.sheet, dataBlock(m, live.sheet, live.sel)))
    focusGrid()
  }
  const openView = (vid) => {
    live.openView(vid)
    const url = new URL(location.href)
    if (vid) url.searchParams.set('fv', vid)
    else url.searchParams.delete('fv')
    window.history.replaceState(window.history.state, '', url)
    focusGrid()
  }
  const copyViewLink = (v) => {
    const url = new URL(location.href)
    url.search = ''
    url.searchParams.set('fv', v.id)
    navigator.clipboard?.writeText(url.toString()).then(() => toast('Link to the filter view copied'), () => toast(url.toString()))
  }
  const gridKeys = (e) => {
    if (e.target !== wrap.current || !live) return
    if (chart && (e.key === 'Delete' || e.key === 'Backspace') && live.canEdit) { e.preventDefault(); return dropChart() }
    if (chart && e.key === 'Escape') return setChartSel(null)
    const mod = e.metaKey || e.ctrlKey
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); return setDialog('find') }
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'h') { e.preventDefault(); return setDialog('replace') }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f' && live.canEdit) { e.preventDefault(); return toggleFilter() }
    live.onKey(e)
  }
  const openHistory = async () => {
    const m = await import('./versions.jsx')
    setChartEdit(false)
    setPanel(null)
    setHistory(() => m)
  }
  const HistoryPanel = history?.default
  const VersionBar = history?.VersionBar
  // The server swaps in the old state and sends it to everyone connected,
  // this tab included; what was there is filed as a version first.
  const restore = async (version) => {
    await post(`/api/docs/${id}/versions/${version.id}/restore`)
    setPast(null)
  }
  const openPanel = (p) => {
    setHistory(null)
    setChartEdit(false)
    setPanel(p)
  }

  const side = HistoryPanel
    ? <HistoryPanel doc={doc} viewing={past?.version.id || null} onView={(version, state) => setPast(version ? { version, state } : null)} onRestore={restore} onClose={() => { setHistory(null); setPast(null) }} />
    : chartEdit && chart && live.canEdit ? <ChartPanel s={live} chart={chart} tick={tick} onClose={() => setChartEdit(false)} onDelete={dropChart} />
      : live && panel === 'validation' ? <ValidationPanel s={live} tick={tick} onClose={() => { setPanel(null); focusGrid() }} />
        : live && panel === 'cond' ? <CondPanel s={live} tick={tick} onClose={() => { setPanel(null); focusGrid() }} />
          : live && panel === 'pivot' && pivot ? <PivotPanel s={live} pivot={pivot} tick={tick} onClose={() => { setPanel('closed'); focusGrid() }} />
            : null

  return (
    <div class="sheet-view">
      <div class="doc-bar with-menus">
        <IconButton icon={ArrowLeft} label="All docs" onClick={() => navigate('/docs')} />
        <div class="doc-head">
          <div class="doc-head-top">
            <input class="doc-title" aria-label="Title" placeholder="Untitled" value={doc.title} disabled={!canEdit} ref={titleInput}
              onInput={(e) => { upsertDoc({ ...doc, title: e.target.value }); rename(doc, e.target.value) }}
              onKeyDown={(e) => e.key === 'Enter' && wrap.current.focus()} />
            <span class="save-state">{status}</span>
          </div>
          <MenuBar menus={sheetMenus({
            doc, live, canEdit: !!live?.canEdit, past, me,
            share: () => setShare(true), rename: () => titleInput.current?.select(), history: openHistory, exportXlsx, exportCsv,
            trash: () => { trashDoc(doc); navigate('/docs') }, chart: newChart, addSheet, focusGrid,
            dialog: setDialog, panel: openPanel, toggleFilter, openView, newView: () => { const v = newView(live); if (v) openView(v) },
          })} />
        </div>
        <span class="grow" />
        <span class="presence">{others.slice(0, 5).map((u) => <span key={u.id} title={u.name}><Avatar name={u.name} id={u.id} size={28} /></span>)}</span>
        <Button icon={Users} kind={doc.access === 'org' || doc.shares?.length ? 'default' : 'primary'} onClick={() => setShare(true)}>Share</Button>
      </div>
      {past && VersionBar && <VersionBar version={past.version} onBack={() => setPast(null)} onRestore={() => restore(past.version).then(() => toast('Version restored'), (e) => toast(e.message, 'error'))} />}
      {!past && (live && live.canEdit ? <Toolbar s={live} tick={tick} onChart={newChart} onFilter={toggleFilter} /> : <div class="toolbar" style={{ minHeight: 43 }} />)}
      {!past && live?.view && <ViewBar s={live} tick={tick} onClose={() => openView(null)} onLink={copyViewLink} />}
      {!past && (
        <div class="formula-bar">
          <div class="ref">{ref}</div>
          <span class="fx">fx</span>
          <input ref={barInput} aria-label="Cell contents" spellcheck={false} disabled={!live?.canEdit}
            value={live ? (editing ? live.draft : live.content()) : ''}
            onFocus={() => live && !editing && live.startEdit()}
            onInput={(e) => live.setDraft(e.target.value)}
            onKeyDown={editKeys} />
        </div>
      )}
      <div class="sheet-body">
        <div class="sheet-main">
          <div class="grid-wrap" ref={wrap} tabIndex={0} onKeyDown={gridKeys}>
            <canvas ref={canvas} />
            <div class="grid-scroll" ref={scroll}><div ref={spacer} /></div>
            {live && <ChartLayer s={live} tick={tick} selected={chartSel} onSelect={setChartSel} onEdit={(cid) => { setChartSel(cid); setHistory(null); setPanel(null); setChartEdit(true) }} />}
            {editing && (
              <input ref={cellInput} class="cell-editor" spellcheck={false} value={live.draft}
                style={{ left: Math.max(rect.x, 46), top: Math.max(rect.y, 24), height: rect.h + 1, width: Math.max(rect.w + 1, Math.min(600, live.draft.length * 8 + 24)) }}
                onInput={(e) => live.setDraft(e.target.value)}
                onKeyDown={editKeys} />
            )}
            {live && floating?.kind === 'filter' && <FilterMenu key={floating.col} s={live} col={floating.col} rect={floating.rect} onClose={() => { setFloating(null); focusGrid() }} />}
            {live && floating?.kind === 'list' && live.canEdit && <ListMenu s={live} rect={floating.rect} onClose={() => { setFloating(null); focusGrid() }} />}
          </div>
          <div class="sheet-tabs">
            {sheets.map((sh, i) => sh.state === 'visible' && (
              <Menu key={sh.sheet_id} align="up" trigger={
                <button class={cx('sheet-tab', live.sheet === i && 'on')} onClick={(e) => { if (live.sheet !== i) { e.stopPropagation(); live.useSheet(i) } }}>{sh.name}</button>
              } items={[
                { label: 'Rename', icon: Pencil, onSelect: () => setRenaming({ i, name: sh.name }) },
                { label: 'Delete sheet', icon: Trash2, danger: true, disabled: shown.length < 2, onSelect: () => dropSheet(i) },
              ]} />
            ))}
            {live?.canEdit && <IconButton icon={Plus} label="Add sheet" onClick={addSheet} />}
          </div>
          {past && <PastGrid id={id} me={me} title={doc.title} state={past.state} />}
        </div>
        {side}
      </div>
      {share && <ShareDialog doc={doc} onClose={() => setShare(false)} />}
      {live && dialog === 'sort' && <SortDialog s={live} onClose={() => { setDialog(null); focusGrid() }} />}
      {live && (dialog === 'find' || dialog === 'replace') && <FindDialog s={live} replace={dialog === 'replace'} onClose={() => { setDialog(null); focusGrid() }} />}
      {live && dialog === 'pivot' && <PivotCreate s={live} onClose={() => setDialog(null)} onMade={(made) => { live.useSheet(made.sheet); setPanel('pivot') }} />}
      {live && (dialog === 'colsize' || dialog === 'rowsize') && <SizeDialog s={live} kind={dialog === 'colsize' ? 'col' : 'row'} onClose={() => { setDialog(null); focusGrid() }} />}
      {renaming && (
        <Modal title="Rename sheet" onClose={() => setRenaming(null)} footer={<><Button onClick={() => setRenaming(null)}>Cancel</Button><Button kind="primary" onClick={() => { live.act((m) => m.renameSheet(renaming.i, renaming.name.trim())); setRenaming(null) }}>Rename</Button></>}>
          <input class="input" autofocus value={renaming.name} onInput={(e) => setRenaming({ ...renaming, name: e.target.value })} onFocus={(e) => e.target.select()} />
        </Modal>
      )}
    </div>
  )
}
