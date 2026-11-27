// The spreadsheet's menu bar. Each entry calls the controller (sheet-core.js)
// or a panel the view opens; `a` carries the view's own actions.
import {
  Users, History, FileDown, Trash2, Pencil, Undo2, Redo2, Scissors, Copy, ClipboardPaste, Eraser, Bold, Italic, Underline,
  Strikethrough, AlignLeft, AlignCenter, AlignRight, Merge, Grid2x2, ChartColumn, Plus, Rows3, Columns3, TableProperties,
} from 'lucide-preact'
import { keys } from '../menubar.jsx'
import { formats } from './sheet-format.js'

export function sheetMenus(a) {
  const s = a.live
  const can = a.canEdit && !a.past
  const sel = s?.sel || { r1: 1, r2: 1, c1: 1, c2: 1 }
  const rows = sel.r2 - sel.r1 + 1
  const cols = sel.c2 - sel.c1 + 1
  const st = s ? s.style() : {}
  const f = st.font || {}
  const align = st.alignment?.horizontal
  const off = !s
  const act = (fn) => () => { fn(); a.focusGrid() }
  const border = (type) => act(() => s.act((m) => m.setAreaWithBorder(s.area(), { item: { style: 'thin', color: '#000000' }, type })))
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
      { label: 'Delete values', icon: Eraser, hint: 'Del', disabled: !can, onSelect: act(() => s.clear()) },
      { label: rows > 1 ? `Delete rows ${sel.r1}–${Math.min(sel.r2, 1048576)}` : `Delete row ${sel.r1}`, disabled: !can || rows > 5000, onSelect: act(() => s.act((m) => m.deleteRows(s.sheet, sel.r1, rows))) },
      { label: cols > 1 ? 'Delete columns' : 'Delete column', disabled: !can || cols > 500, onSelect: act(() => s.act((m) => m.deleteColumns(s.sheet, sel.c1, cols))) },
      { divider: true },
      { label: 'Select all', hint: keys('Mod+A'), disabled: off, onSelect: act(() => s.selectAll()) },
    ] },
    { label: 'View', items: [
      { label: 'Gridlines', checked: !!s?.gridLines, disabled: !can, onSelect: act(() => s.act((m) => m.setShowGridLines(s.sheet, !s.gridLines))) },
    ] },
    { label: 'Insert', items: [
      { label: 'Row above', icon: Rows3, disabled: !can, onSelect: act(() => s.act((m) => m.insertRows(s.sheet, sel.r1, 1))) },
      { label: 'Row below', disabled: !can, onSelect: act(() => s.act((m) => m.insertRows(s.sheet, sel.r2 + 1, 1))) },
      { label: 'Column left', icon: Columns3, disabled: !can, onSelect: act(() => s.act((m) => m.insertColumns(s.sheet, sel.c1, 1))) },
      { label: 'Column right', disabled: !can, onSelect: act(() => s.act((m) => m.insertColumns(s.sheet, sel.c2 + 1, 1))) },
      { divider: true },
      { label: 'Chart', icon: ChartColumn, disabled: !can, onSelect: a.chart },
      { divider: true },
      { label: 'New sheet', icon: Plus, disabled: !can, onSelect: a.addSheet },
    ] },
    { label: 'Format', items: [
      { label: 'Number', icon: TableProperties, disabled: !can, items: formats.map(([code, label, example]) => ({ label, hint: example, checked: st.num_fmt === code, onSelect: act(() => s.setStyle('num_fmt', code)) })) },
      { label: 'Text', disabled: !can, items: [
        { label: 'Bold', icon: Bold, hint: keys('Mod+B'), checked: !!f.b, onSelect: act(() => s.toggle('font.b')) },
        { label: 'Italic', icon: Italic, hint: keys('Mod+I'), checked: !!f.i, onSelect: act(() => s.toggle('font.i')) },
        { label: 'Underline', icon: Underline, hint: keys('Mod+U'), checked: !!f.u, onSelect: act(() => s.toggle('font.u')) },
        { label: 'Strikethrough', icon: Strikethrough, hint: keys('Mod+Shift+X'), checked: !!f.strike, onSelect: act(() => s.toggle('font.strike')) },
      ] },
      { label: 'Alignment', disabled: !can, items: [
        { label: 'Left', icon: AlignLeft, hint: keys('Mod+Shift+L'), checked: align === 'left', onSelect: act(() => s.setStyle('alignment.horizontal', 'left')) },
        { label: 'Centre', icon: AlignCenter, hint: keys('Mod+Shift+E'), checked: align === 'center', onSelect: act(() => s.setStyle('alignment.horizontal', 'center')) },
        { label: 'Right', icon: AlignRight, hint: keys('Mod+Shift+R'), checked: align === 'right', onSelect: act(() => s.setStyle('alignment.horizontal', 'right')) },
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
      { label: 'Clear formatting', icon: Eraser, hint: keys('Mod+\\'), disabled: !can, onSelect: act(() => s.clearFormatting()) },
    ] },
  ]
}
