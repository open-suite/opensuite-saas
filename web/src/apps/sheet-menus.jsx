// The spreadsheet's menu bar (menubar.jsx). Each entry calls the controller
// (sheet-core.js) or opens a dialog or panel the view owns; `a` carries the
// view's own actions.
import {
  Users, History, FileDown, Trash2, Pencil, Undo2, Redo2, Scissors, Copy, ClipboardPaste, Eraser, Bold, Italic, Underline,
  Strikethrough, AlignLeft, AlignCenter, AlignRight, Merge, Grid2x2, ChartColumn, Plus, Rows3, Columns3, TableProperties, Search,
  Replace, Snowflake, ArrowDownAZ, ArrowUpZA, ListFilter, Filter, Eye, ShieldCheck, Palette, Table2, SquareCheck, ChevronDownSquare,
  Paintbrush, WrapText, MoveHorizontal, MoveVertical, Type, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
} from 'lucide-preact'
import { keys } from '../menubar.jsx'
import { colName } from './sheet-data.js'
import { formats, fonts, sizes } from './sheet-format.js'
import { dataBlock, sortRange, setValidation, MAXR, MAXC } from './sheet-meta.js'

export function sheetMenus(a) {
  const s = a.live
  const can = a.canEdit && !a.past
  const sel = s?.sel || { r1: 1, r2: 1, c1: 1, c2: 1, row: 1, col: 1 }
  const rows = sel.r2 - sel.r1 + 1
  const cols = sel.c2 - sel.c1 + 1
  const st = s ? s.style() : {}
  const f = st.font || {}
  const align = st.alignment?.horizontal
  const valign = st.alignment?.vertical || 'bottom'
  const wrapMode = st.alignment?.wrap_text ? 'wrap' : s?.cell(sel.row, sel.col).clip ? 'clip' : 'overflow'
  const off = !s
  const fr = s ? s.model.getFrozenRowsCount(s.sheet) : 0
  const fc = s ? s.model.getFrozenColumnsCount(s.sheet) : 0
  const act = (fn) => () => { fn(); a.focusGrid() }
  const border = (type) => act(() => s.act((m) => m.setAreaWithBorder(s.area(), { item: { style: 'thin', color: '#000000' }, type })))
  const freezeRows = (n) => act(() => s.act((m) => m.setFrozenRowsCount(s.sheet, n)))
  const freezeCols = (n) => act(() => s.act((m) => m.setFrozenColumnsCount(s.sheet, n)))
  const sortSheet = (desc) => act(() => s.act((m) => {
    const block = dataBlock(m, s.sheet, { r1: 1, c1: 1, r2: MAXR, c2: MAXC })
    // Frozen rows are headings and stay where they are.
    sortRange(m, { ...block, r1: Math.max(block.r1, fr + 1) }, [{ col: sel.col, desc }], false)
  }))
  const sortSel = (desc) => act(() => s.act((m) => sortRange(m, { sheet: s.sheet, r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: sel.c2 }, [{ col: sel.col, desc }], false)))
  const views = s ? s.meta('view') : []
  const area = { sheet: s?.sheet, r1: sel.r1, c1: sel.c1, r2: Math.min(sel.r2, MAXR), c2: Math.min(sel.c2, MAXC) }
  return [
    { label: 'File', items: [
      { label: 'Share', icon: Users, onSelect: a.share },
      { divider: true },
      { label: 'Download', icon: FileDown, disabled: off, items: [
        { label: 'Microsoft Excel (.xlsx)', onSelect: a.exportXlsx },
        { label: 'Comma-separated values (.csv, this sheet)', onSelect: a.exportCsv },
      ] },
      can && { label: 'Rename', icon: Pencil, onSelect: a.rename },
      a.canEdit && { label: 'Version history', icon: History, disabled: off, onSelect: a.history },
      a.doc.role === 'owner' && { divider: true },
      a.doc.role === 'owner' && { label: 'Move to trash', icon: Trash2, danger: true, onSelect: a.trash },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', icon: Undo2, hint: keys('Mod+Z'), disabled: !can || !s.model.canUndo(), onSelect: act(() => s.undo()) },
      { label: 'Redo', icon: Redo2, hint: keys('Mod+Y'), disabled: !can || !s.model.canRedo(), onSelect: act(() => s.redo()) },
      { divider: true },
      { label: 'Cut', icon: Scissors, hint: keys('Mod+X'), disabled: !can, onSelect: () => { a.focusGrid(); document.execCommand('cut') } },
      { label: 'Copy', icon: Copy, hint: keys('Mod+C'), disabled: off, onSelect: () => { a.focusGrid(); document.execCommand('copy') } },
      { label: 'Paste', icon: ClipboardPaste, hint: keys('Mod+V'), disabled: !can, onSelect: act(() => s.pasteFromSystem()) },
      { divider: true },
      { label: 'Find and replace', icon: Replace, hint: keys('Mod+H'), disabled: off, onSelect: () => a.dialog(can ? 'replace' : 'find') },
      { divider: true },
      { label: 'Delete values', icon: Eraser, hint: 'Del', disabled: !can, onSelect: act(() => s.clear()) },
      { label: rows > 1 ? `Delete rows ${sel.r1}–${Math.min(sel.r2, MAXR)}` : `Delete row ${sel.r1}`, disabled: !can || rows > 5000, onSelect: act(() => s.act((m) => m.deleteRows(s.sheet, sel.r1, rows))) },
      { label: cols > 1 ? `Delete columns ${colName(sel.c1)}–${colName(Math.min(sel.c2, MAXC))}` : `Delete column ${colName(sel.c1)}`, disabled: !can || cols > 500, onSelect: act(() => s.act((m) => m.deleteColumns(s.sheet, sel.c1, cols))) },
      { divider: true },
      { label: 'Select all', hint: keys('Mod+A'), disabled: off, onSelect: act(() => s.selectAll()) },
    ] },
    { label: 'View', items: [
      { label: 'Freeze', icon: Snowflake, disabled: !can, items: [
        { label: 'No rows', checked: fr === 0, onSelect: freezeRows(0) },
        { label: '1 row', checked: fr === 1, onSelect: freezeRows(1) },
        { label: '2 rows', checked: fr === 2, onSelect: freezeRows(2) },
        sel.row > 2 && { label: `Up to row ${sel.row}`, checked: fr === sel.row, onSelect: freezeRows(sel.row) },
        { divider: true },
        { label: 'No columns', checked: fc === 0, onSelect: freezeCols(0) },
        { label: '1 column', checked: fc === 1, onSelect: freezeCols(1) },
        { label: '2 columns', checked: fc === 2, onSelect: freezeCols(2) },
        sel.col > 2 && { label: `Up to column ${colName(sel.col)}`, checked: fc === sel.col, onSelect: freezeCols(sel.col) },
      ] },
      { label: 'Gridlines', checked: !!s?.gridLines, disabled: !can, onSelect: act(() => s.act((m) => m.setShowGridLines(s.sheet, !s.gridLines))) },
    ] },
    { label: 'Insert', items: [
      { label: rows > 1 && rows < 1000 ? `${rows} rows above` : 'Row above', icon: Rows3, disabled: !can, onSelect: act(() => s.act((m) => m.insertRows(s.sheet, sel.r1, rows < 1000 ? rows : 1))) },
      { label: rows > 1 && rows < 1000 ? `${rows} rows below` : 'Row below', disabled: !can, onSelect: act(() => s.act((m) => m.insertRows(s.sheet, Math.min(sel.r2, MAXR - 1) + 1, rows < 1000 ? rows : 1))) },
      { label: cols > 1 && cols < 100 ? `${cols} columns left` : 'Column left', icon: Columns3, disabled: !can, onSelect: act(() => s.act((m) => m.insertColumns(s.sheet, sel.c1, cols < 100 ? cols : 1))) },
      { label: cols > 1 && cols < 100 ? `${cols} columns right` : 'Column right', disabled: !can, onSelect: act(() => s.act((m) => m.insertColumns(s.sheet, Math.min(sel.c2, MAXC - 1) + 1, cols < 100 ? cols : 1))) },
      { divider: true },
      { label: 'Chart', icon: ChartColumn, disabled: !can, onSelect: a.chart },
      { label: 'Pivot table', icon: Table2, disabled: !can, onSelect: () => a.dialog('pivot') },
      { divider: true },
      { label: 'Checkbox', icon: SquareCheck, disabled: !can, onSelect: act(() => s.act((m) => setValidation(m, area, { type: 'checkbox' }, true))) },
      { label: 'Dropdown', icon: ChevronDownSquare, disabled: !can, onSelect: () => { s.act((m) => setValidation(m, area, { type: 'list', values: ['Option 1', 'Option 2'] }, true)); a.panel('validation') } },
      { divider: true },
      { label: 'New sheet', icon: Plus, disabled: !can, onSelect: a.addSheet },
    ] },
    { label: 'Format', items: [
      { label: 'Number', icon: TableProperties, disabled: !can, items: formats.map(([code, label, example]) => ({ label, hint: example, checked: st.num_fmt === code, onSelect: act(() => s.setStyle('num_fmt', code)) })) },
      { label: 'Text', icon: Type, disabled: !can, items: [
        { label: 'Bold', icon: Bold, hint: keys('Mod+B'), checked: !!f.b, onSelect: act(() => s.toggle('font.b')) },
        { label: 'Italic', icon: Italic, hint: keys('Mod+I'), checked: !!f.i, onSelect: act(() => s.toggle('font.i')) },
        { label: 'Underline', icon: Underline, hint: keys('Mod+U'), checked: !!f.u, onSelect: act(() => s.toggle('font.u')) },
        { label: 'Strikethrough', icon: Strikethrough, hint: keys('Mod+Shift+X'), checked: !!f.strike, onSelect: act(() => s.toggle('font.strike')) },
      ] },
      { label: 'Font', disabled: !can, items: [
        { label: 'Default', checked: f.scheme !== 'none', onSelect: act(() => s.setFont('')) },
        ...fonts.map((x) => ({ label: x, checked: f.scheme === 'none' && f.name === x, onSelect: act(() => s.setFont(x)) })),
      ] },
      { label: 'Font size', disabled: !can, items: sizes.map((n) => ({ label: String(n), checked: (f.sz || 12) === n, onSelect: act(() => s.setSize(n)) })) },
      { label: 'Alignment', icon: AlignLeft, disabled: !can, items: [
        { label: 'Left', icon: AlignLeft, hint: keys('Mod+Shift+L'), checked: align === 'left', onSelect: act(() => s.setStyle('alignment.horizontal', 'left')) },
        { label: 'Centre', icon: AlignCenter, hint: keys('Mod+Shift+E'), checked: align === 'center', onSelect: act(() => s.setStyle('alignment.horizontal', 'center')) },
        { label: 'Right', icon: AlignRight, hint: keys('Mod+Shift+R'), checked: align === 'right', onSelect: act(() => s.setStyle('alignment.horizontal', 'right')) },
        { divider: true },
        { label: 'Top', icon: AlignVerticalJustifyStart, checked: valign === 'top', onSelect: act(() => s.setStyle('alignment.vertical', 'top')) },
        { label: 'Middle', icon: AlignVerticalJustifyCenter, checked: valign === 'center', onSelect: act(() => s.setStyle('alignment.vertical', 'center')) },
        { label: 'Bottom', icon: AlignVerticalJustifyEnd, checked: valign === 'bottom', onSelect: act(() => s.setStyle('alignment.vertical', 'bottom')) },
      ] },
      { label: 'Wrapping', icon: WrapText, disabled: !can, items: [
        { label: 'Overflow', checked: wrapMode === 'overflow', onSelect: act(() => s.setWrapping('overflow')) },
        { label: 'Wrap', checked: wrapMode === 'wrap', onSelect: act(() => s.setWrapping('wrap')) },
        { label: 'Clip', checked: wrapMode === 'clip', onSelect: act(() => s.setWrapping('clip')) },
      ] },
      { label: 'Borders', icon: Grid2x2, disabled: !can, items: [
        { label: 'All borders', onSelect: border('All') },
        { label: 'Outer border', onSelect: border('Outer') },
        { label: 'Bottom border', onSelect: border('Bottom') },
        { label: 'No borders', onSelect: border('None') },
      ] },
      { label: 'Merge cells', icon: Merge, disabled: !can, items: [
        { label: 'Merge all', disabled: rows * cols < 2, onSelect: act(() => s.act((m) => m.mergeCells(s.area()))) },
        { label: 'Unmerge', onSelect: act(() => s.act((m) => m.unmergeCells(s.area()))) },
      ] },
      { divider: true },
      { label: 'Column width…', icon: MoveHorizontal, disabled: !can, onSelect: () => a.dialog('colsize') },
      { label: 'Row height…', icon: MoveVertical, disabled: !can, onSelect: () => a.dialog('rowsize') },
      { label: 'Fit columns to data', disabled: !can, onSelect: act(() => s.fitColumns(sel.c1, Math.min(sel.c2, s.C))) },
      { divider: true },
      { label: 'Conditional formatting', icon: Palette, disabled: !can, onSelect: () => a.panel('cond') },
      { label: 'Paint format', icon: Paintbrush, checked: !!s?.painter, disabled: !can, onSelect: act(() => s.pickPainter()) },
      { label: 'Clear formatting', icon: Eraser, hint: keys('Mod+\\'), disabled: !can, onSelect: act(() => s.clearFormatting()) },
    ] },
    { label: 'Data', items: [
      { label: `Sort sheet by column ${colName(sel.col)}, A → Z`, icon: ArrowDownAZ, disabled: !can, onSelect: sortSheet(false) },
      { label: `Sort sheet by column ${colName(sel.col)}, Z → A`, icon: ArrowUpZA, disabled: !can, onSelect: sortSheet(true) },
      { label: 'Sort range', disabled: !can, items: [
        { label: `By column ${colName(sel.col)}, A → Z`, disabled: rows < 2, onSelect: sortSel(false) },
        { label: `By column ${colName(sel.col)}, Z → A`, disabled: rows < 2, onSelect: sortSel(true) },
        { label: 'Advanced sort options…', onSelect: () => a.dialog('sort') },
      ] },
      { divider: true },
      { label: s?.filter && !s.view ? 'Remove filter' : 'Create a filter', icon: Filter, hint: keys('Mod+Shift+F'), disabled: !can, onSelect: a.toggleFilter },
      { label: 'Filter views', icon: ListFilter, disabled: off, items: [
        can && { label: 'Create new filter view', icon: Plus, onSelect: a.newView },
        s?.view && { label: 'Close filter view', onSelect: () => a.openView(null) },
        views.length > 0 && { divider: true },
        ...views.map((v) => ({ label: v.name, icon: Eye, checked: s.view === v.id, hint: v.ownerName && v.owner !== a.me?.id ? v.ownerName : '', onSelect: () => a.openView(v.id) })),
      ] },
      { divider: true },
      { label: 'Data validation', icon: ShieldCheck, disabled: !can, onSelect: () => a.panel('validation') },
      { label: 'Pivot table', icon: Table2, disabled: !can, onSelect: () => a.dialog('pivot') },
    ] },
    { label: 'Tools', items: [
      { label: 'Find', icon: Search, hint: keys('Mod+F'), disabled: off, onSelect: () => a.dialog('find') },
    ] },
  ]
}
