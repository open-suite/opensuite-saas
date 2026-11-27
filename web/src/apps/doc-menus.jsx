// The document's menu bar (menubar.jsx). Most of it is also in the toolbar
// or a shortcut; the bar is where everything can be found.
import {
  Users, FileDown, Printer, Pencil, Trash2, History, Undo2, Redo2, Scissors, Copy, ClipboardPaste, Search, Keyboard, PencilLine, BookOpen,
  MessageSquare, Hash, ImagePlus, Table, Link2, Minus, FileText, Superscript, ListTree, MessageSquarePlus, Bold, Italic, Underline,
  Strikethrough, Code, Pilcrow, Heading1, Heading2, Heading3, Quote, Code2, Type, AlignLeft, AlignCenter, AlignRight, AlignJustify,
  IndentIncrease, IndentDecrease, List, ListOrdered, ListChecks, RemoveFormatting, Rows3, Columns3, Image as ImageIcon, LayoutPanelTop,
  Baseline, Highlighter,
} from 'lucide-preact'
import { keys } from '../menubar.jsx'
import { fonts, fontSizes } from './doc-format.js'
import { lineHeights } from './doc-layout.js'
import { inkColors, markColors } from '../ui.jsx'

const colourNames = ['Navy', 'Grey', 'Red', 'Orange', 'Amber', 'Green', 'Teal', 'Blue', 'Indigo', 'Violet', 'Pink', 'White']
const markNames = ['Yellow', 'Peach', 'Rose', 'Mint', 'Sky', 'Blue', 'Lavender', 'Pink', 'Grey', 'Green', 'Azure', 'Lemon']

export const tableSizes = [[2, 2], [3, 3], [4, 3], [5, 4], [6, 5]]

export function docMenus(a) {
  const e = a.editor
  const can = !!e && a.canWrite && a.mode !== 'view'
  const c = () => e.chain().focus()
  const on = (name, attrs) => !!e && e.isActive(name, attrs)
  const style = e ? e.getAttributes('textStyle') : {}
  const para = e ? { ...e.getAttributes('paragraph'), ...e.getAttributes('heading') } : {}
  const inTable = on('table')
  const picture = a.picture // the selected picture, if one is
  const lh = para.lineHeight || 1.15
  return [
    { label: 'File', items: [
      { label: 'Share', icon: Users, onSelect: a.share },
      { divider: true },
      a.canEdit && { label: 'Version history', icon: History, hint: keys('Mod+Alt+Shift+H'), onSelect: a.history },
      { label: 'Download', icon: FileDown, disabled: !e, items: [
        { label: 'Microsoft Word (.docx)', onSelect: () => a.download('docx') },
        { label: 'OpenDocument (.odt)', onSelect: () => a.download('odt') },
        { label: 'PDF (print and save as PDF)', onSelect: a.print },
        { label: 'Web page (.html)', onSelect: () => a.download('html') },
        { label: 'Markdown (.md)', onSelect: () => a.download('md') },
      ] },
      { divider: true },
      { label: 'Page setup…', icon: FileText, disabled: !e, onSelect: a.pageSetup },
      { label: 'Print', icon: Printer, hint: keys('Mod+P'), disabled: !e, onSelect: a.print },
      a.canEdit && { label: 'Rename', icon: Pencil, onSelect: a.rename },
      a.doc.role === 'owner' && { divider: true },
      a.doc.role === 'owner' && { label: 'Move to trash', icon: Trash2, danger: true, onSelect: a.trash },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', icon: Undo2, hint: keys('Mod+Z'), disabled: !can || !e.can().undo(), onSelect: () => c().undo().run() },
      { label: 'Redo', icon: Redo2, hint: keys('Mod+Shift+Z'), disabled: !can || !e.can().redo(), onSelect: () => c().redo().run() },
      { divider: true },
      { label: 'Cut', icon: Scissors, hint: keys('Mod+X'), disabled: !can || e.state.selection.empty, onSelect: () => a.clipboard('cut') },
      { label: 'Copy', icon: Copy, hint: keys('Mod+C'), disabled: !e || e.state.selection.empty, onSelect: () => a.clipboard('copy') },
      { label: 'Paste', icon: ClipboardPaste, hint: keys('Mod+V'), disabled: !can, onSelect: () => a.clipboard('paste') },
      { divider: true },
      { label: 'Select all', hint: keys('Mod+A'), disabled: !e, onSelect: () => c().selectAll().run() },
      { label: 'Find and replace', icon: Search, hint: keys('Mod+Shift+H'), disabled: !e, onSelect: () => a.find(true) },
    ] },
    { label: 'View', items: [
      { heading: 'Mode' },
      a.role !== 'comment' && a.canWrite && { label: 'Editing', icon: PencilLine, checked: a.mode === 'edit', onSelect: () => a.setMode('edit') },
      a.canWrite && { label: 'Suggesting', icon: MessageSquare, checked: a.mode === 'suggest', onSelect: () => a.setMode('suggest') },
      a.canWrite && { label: 'Viewing', icon: BookOpen, checked: a.mode === 'view', onSelect: () => a.setMode('view') },
      { divider: true },
      { label: 'Comments', icon: MessageSquare, checked: a.railOpen, onSelect: a.toggleRail },
      { label: 'Word count', icon: Hash, checked: a.showCount, onSelect: a.toggleCount },
    ] },
    { label: 'Insert', items: [
      { label: 'Image…', icon: ImagePlus, disabled: !can, onSelect: a.image },
      { label: 'Table', icon: Table, disabled: !can || inTable, items: tableSizes.map(([cols, rows]) => ({ label: `${cols} × ${rows}`, onSelect: () => c().insertTable({ rows, cols, withHeaderRow: true }).run() })) },
      { label: 'Link…', icon: Link2, hint: keys('Mod+K'), disabled: !can, onSelect: a.link },
      { label: 'Horizontal line', icon: Minus, disabled: !can, onSelect: () => c().setHorizontalRule().run() },
      { divider: true },
      { label: 'Page break', icon: FileText, hint: keys('Mod+Enter'), disabled: !can, onSelect: () => c().setPageBreak().run() },
      { label: 'Footnote', icon: Superscript, hint: keys('Mod+Alt+F'), disabled: !can, onSelect: a.footnote },
      { label: 'Table of contents', icon: ListTree, disabled: !can, onSelect: () => c().insertTableOfContents().run() },
      { label: 'Header and footer…', icon: LayoutPanelTop, disabled: !can, onSelect: a.pageSetup },
      { divider: true },
      { label: 'Comment', icon: MessageSquarePlus, hint: keys('Mod+Alt+M'), disabled: !a.canWrite || !e || e.state.selection.empty, onSelect: a.comment },
    ] },
    { label: 'Format', items: [
      { label: 'Text', icon: Bold, disabled: !can, items: [
        { label: 'Bold', icon: Bold, hint: keys('Mod+B'), checked: on('bold'), onSelect: () => c().toggleBold().run() },
        { label: 'Italic', icon: Italic, hint: keys('Mod+I'), checked: on('italic'), onSelect: () => c().toggleItalic().run() },
        { label: 'Underline', icon: Underline, hint: keys('Mod+U'), checked: on('underline'), onSelect: () => c().toggleUnderline().run() },
        { label: 'Strikethrough', icon: Strikethrough, hint: keys('Mod+Shift+S'), checked: on('strike'), onSelect: () => c().toggleStrike().run() },
        { label: 'Code', icon: Code, hint: keys('Mod+E'), checked: on('code'), onSelect: () => c().toggleCode().run() },
      ] },
      { label: 'Paragraph style', icon: Pilcrow, disabled: !can, items: [
        { label: 'Normal text', icon: Pilcrow, hint: keys('Mod+Alt+0'), checked: on('paragraph') && !on('blockquote'), onSelect: () => c().setParagraph().run() },
        { label: 'Heading 1', icon: Heading1, hint: keys('Mod+Alt+1'), checked: on('heading', { level: 1 }), onSelect: () => c().setHeading({ level: 1 }).run() },
        { label: 'Heading 2', icon: Heading2, hint: keys('Mod+Alt+2'), checked: on('heading', { level: 2 }), onSelect: () => c().setHeading({ level: 2 }).run() },
        { label: 'Heading 3', icon: Heading3, hint: keys('Mod+Alt+3'), checked: on('heading', { level: 3 }), onSelect: () => c().setHeading({ level: 3 }).run() },
        { divider: true },
        { label: 'Quote', icon: Quote, checked: on('blockquote'), onSelect: () => c().toggleBlockquote().run() },
        { label: 'Code block', icon: Code2, checked: on('codeBlock'), onSelect: () => c().toggleCodeBlock().run() },
      ] },
      { label: 'Font', icon: Type, disabled: !can, items: fonts.map(([css, name]) => ({ label: name, checked: (style.fontFamily || '') === css, onSelect: () => (css ? c().setFontFamily(css).run() : c().unsetFontFamily().run()) })) },
      { label: 'Font size', icon: Type, disabled: !can, items: [
        { label: 'Default', checked: !style.fontSize, onSelect: () => c().unsetFontSize().run() },
        ...fontSizes.map((n) => ({ label: String(n), checked: style.fontSize === n + 'pt', onSelect: () => c().setFontSize(n + 'pt').run() })),
      ] },
      { label: 'Text colour', icon: Baseline, disabled: !can, items: [
        { label: 'Default', onSelect: () => c().unsetColor().run() },
        ...inkColors.map((col, i) => ({ label: colourNames[i] || col, checked: style.color === col, onSelect: () => c().setColor(col).run() })),
      ] },
      { label: 'Highlight', icon: Highlighter, disabled: !can, items: [
        { label: 'None', onSelect: () => c().unsetHighlight().run() },
        ...markColors.map((col, i) => ({ label: markNames[i] || col, onSelect: () => c().setHighlight({ color: col }).run() })),
      ] },
      { divider: true },
      { label: 'Align and indent', icon: AlignLeft, disabled: !can, items: [
        { label: 'Left', icon: AlignLeft, hint: keys('Mod+Shift+L'), checked: e?.isActive({ textAlign: 'left' }), onSelect: () => c().setTextAlign('left').run() },
        { label: 'Centre', icon: AlignCenter, hint: keys('Mod+Shift+E'), checked: e?.isActive({ textAlign: 'center' }), onSelect: () => c().setTextAlign('center').run() },
        { label: 'Right', icon: AlignRight, hint: keys('Mod+Shift+R'), checked: e?.isActive({ textAlign: 'right' }), onSelect: () => c().setTextAlign('right').run() },
        { label: 'Justified', icon: AlignJustify, hint: keys('Mod+Shift+J'), checked: e?.isActive({ textAlign: 'justify' }), onSelect: () => c().setTextAlign('justify').run() },
        { divider: true },
        { label: 'Increase indent', icon: IndentIncrease, hint: keys('Mod+]'), onSelect: () => c().indent().run() },
        { label: 'Decrease indent', icon: IndentDecrease, hint: keys('Mod+['), onSelect: () => c().outdent().run() },
      ] },
      { label: 'Line spacing', icon: Rows3, disabled: !can, items: lineHeights.map((v) => ({ label: lineLabel(v), checked: lh === v, onSelect: () => c().setLineHeight(v).run() })) },
      { label: 'Bullets and numbering', icon: List, disabled: !can, items: [
        { label: 'Bulleted list', icon: List, hint: keys('Mod+Shift+8'), checked: on('bulletList'), onSelect: () => c().toggleBulletList().run() },
        { label: 'Numbered list', icon: ListOrdered, hint: keys('Mod+Shift+7'), checked: on('orderedList'), onSelect: () => c().toggleOrderedList().run() },
        { label: 'Checklist', icon: ListChecks, hint: keys('Mod+Shift+9'), checked: on('taskList'), onSelect: () => c().toggleTaskList().run() },
      ] },
      { divider: true },
      { label: 'Table', icon: Table, disabled: !can || !inTable, items: [
        { label: 'Insert row above', icon: Rows3, onSelect: () => c().addRowBefore().run() },
        { label: 'Insert row below', icon: Rows3, onSelect: () => c().addRowAfter().run() },
        { label: 'Insert column left', icon: Columns3, onSelect: () => c().addColumnBefore().run() },
        { label: 'Insert column right', icon: Columns3, onSelect: () => c().addColumnAfter().run() },
        { divider: true },
        { label: 'Delete row', onSelect: () => c().deleteRow().run() },
        { label: 'Delete column', onSelect: () => c().deleteColumn().run() },
        { label: 'Delete table', icon: Trash2, danger: true, onSelect: () => c().deleteTable().run() },
      ] },
      { label: 'Image', icon: ImageIcon, disabled: !can || !picture, items: picture ? imageItems(a) : [] },
      { divider: true },
      { label: 'Clear formatting', icon: RemoveFormatting, hint: keys('Mod+\\'), disabled: !can, onSelect: a.clearFormatting },
    ] },
    { label: 'Tools', items: [
      { label: 'Word count', icon: Hash, hint: keys('Mod+Shift+C'), disabled: !e, onSelect: a.wordCount },
      { label: 'Find and replace', icon: Search, hint: keys('Mod+Shift+H'), disabled: !e, onSelect: () => a.find(true) },
      a.canEdit && { label: 'Version history', icon: History, onSelect: a.history },
    ] },
    { label: 'Help', items: [
      { label: 'Keyboard shortcuts', icon: Keyboard, onSelect: a.shortcuts },
    ] },
  ]
}

export const lineLabel = (v) => ({ 1: 'Single', 1.15: '1.15', 1.5: '1.5', 2: 'Double' }[v] || String(v))

export const imageSizes = [['Small', '25%'], ['Medium', '50%'], ['Large', '75%'], ['Full width', '100%'], ['Original size', null]]

export function imageItems(a) {
  const p = a.picture
  const layout = p.inline ? 'inline' : p.wrap
  return [
    { heading: 'Layout' },
    { label: 'In line with text', checked: layout === 'inline', onSelect: () => a.imageLayout({ layout: 'inline' }) },
    { label: 'Break text', checked: layout === 'break', onSelect: () => a.imageLayout({ layout: 'break' }) },
    { label: 'Wrap text, picture on the left', checked: layout === 'left', onSelect: () => a.imageLayout({ layout: 'left' }) },
    { label: 'Wrap text, picture on the right', checked: layout === 'right', onSelect: () => a.imageLayout({ layout: 'right' }) },
    { heading: 'Size' },
    ...imageSizes.map(([label, width]) => ({ label, checked: (p.width || null) === width, onSelect: () => a.imageLayout({ width }) })),
    layout === 'break' && { heading: 'Position' },
    layout === 'break' && { label: 'Left', checked: p.align === 'left', onSelect: () => a.imageLayout({ align: 'left' }) },
    layout === 'break' && { label: 'Centre', checked: p.align === 'center', onSelect: () => a.imageLayout({ align: 'center' }) },
    layout === 'break' && { label: 'Right', checked: p.align === 'right', onSelect: () => a.imageLayout({ align: 'right' }) },
  ]
}

export const shortcutList = [
  ['Bold, italic, underline', 'Mod+B · Mod+I · Mod+U'],
  ['Heading 1, 2, 3 · normal text', 'Mod+Alt+1 · 2 · 3 · 0'],
  ['Increase or decrease indent', 'Mod+] · Mod+['],
  ['Page break', 'Mod+Enter'],
  ['Footnote', 'Mod+Alt+F'],
  ['Comment', 'Mod+Alt+M'],
  ['Find and replace', 'Mod+Shift+H'],
  ['Find', 'Mod+F'],
  ['Word count', 'Mod+Shift+C'],
  ['Link', 'Mod+K'],
  ['Clear formatting', 'Mod+\\'],
  ['Search the menus', 'Alt+/'],
]
