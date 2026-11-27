// The presentation's menu bar (menubar.jsx). Everything here is also in the
// toolbar, the right-click menus or a shortcut; the bar is where to find it.
import {
  Users, FileDown, FileUp, Printer, Pencil, Trash2, Undo2, Redo2, Scissors, Copy, ClipboardPaste, Files, Play, AppWindow, StickyNote,
  Plus, Type, Square, Squircle, Circle, Minus, MoveRight, ImagePlus, Bold, Italic, Underline, List, ListOrdered, BringToFront, SendToBack,
  ArrowUp, ArrowDown, LayoutTemplate, Sparkles,
} from 'lucide-preact'
import { keys } from '../menubar.jsx'
import { layouts, layoutIds } from './slides-model.js'

export function slideMenus(a) {
  const deck = a.deck
  const can = !!deck && a.canEdit
  const sel = deck ? deck.selected() : []
  const any = sel.length > 0
  const f = deck?.formatting()
  const layout = deck?.slide()?.get('layout') || 'blank'
  const trans = deck?.meta.get('transition') || 'fade'
  const fmt = (run) => () => deck.format(run)
  return [
    { label: 'File', items: [
      { label: 'Share', icon: Users, onSelect: a.share },
      { divider: true },
      { label: 'Download', icon: FileDown, disabled: !deck, items: [
        { label: 'Microsoft PowerPoint (.pptx)', onSelect: a.exportPptx },
        { label: 'PDF (print and save as PDF)', onSelect: a.print },
      ] },
      can && { label: 'Add slides from PowerPoint…', icon: FileUp, onSelect: a.importPptx },
      can && { label: 'Rename', icon: Pencil, onSelect: a.rename },
      { label: 'Print', icon: Printer, hint: keys('Mod+P'), disabled: !deck, onSelect: a.print },
      a.doc.role === 'owner' && { divider: true },
      a.doc.role === 'owner' && { label: 'Move to trash', icon: Trash2, danger: true, onSelect: a.trash },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', icon: Undo2, hint: keys('Mod+Z'), disabled: !can || !deck.undoer.undoStack.length, onSelect: () => deck.undo() },
      { label: 'Redo', icon: Redo2, hint: keys('Mod+Shift+Z'), disabled: !can || !deck.undoer.redoStack.length, onSelect: () => deck.redo() },
      { divider: true },
      { label: 'Cut', icon: Scissors, hint: keys('Mod+X'), disabled: !can || !any, onSelect: () => a.copy(true) },
      { label: 'Copy', icon: Copy, hint: keys('Mod+C'), disabled: !deck || !any, onSelect: () => a.copy(false) },
      { label: 'Paste', icon: ClipboardPaste, hint: keys('Mod+V'), disabled: !can || !a.clip, onSelect: () => deck.paste(a.clip) },
      { label: 'Duplicate', icon: Files, hint: keys('Mod+D'), disabled: !can || !any, onSelect: () => deck.duplicate() },
      { label: 'Delete', icon: Trash2, hint: 'Del', disabled: !can || !any, onSelect: () => deck.remove() },
      { divider: true },
      { label: 'Select all', hint: keys('Mod+A'), disabled: !deck, onSelect: () => deck.select(deck.els().map((x) => x.id)) },
    ] },
    { label: 'View', items: [
      { label: 'Present', icon: Play, hint: 'F5', disabled: !deck, onSelect: () => a.present(deck.order()[0]) },
      { label: 'Present from this slide', icon: Play, disabled: !deck, onSelect: () => a.present(deck.cur) },
      { label: 'Presenter view', icon: AppWindow, disabled: !deck, onSelect: () => a.present(deck.cur, true) },
      { divider: true },
      { label: 'Speaker notes', icon: StickyNote, checked: a.notes, onSelect: a.toggleNotes },
    ] },
    { label: 'Insert', items: [
      { label: 'New slide', icon: Plus, hint: 'Ctrl+M', disabled: !can, onSelect: () => deck.addSlide() },
      { label: 'Slide with layout', icon: LayoutTemplate, disabled: !can, items: layoutIds.map((id) => ({ label: layouts[id].name, onSelect: () => deck.addSlide(id) })) },
      { divider: true },
      { label: 'Text box', icon: Type, disabled: !can, onSelect: () => deck.addText() },
      { label: 'Picture', icon: ImagePlus, disabled: !can, onSelect: a.image },
      { label: 'Shape', icon: Square, disabled: !can, items: [
        { label: 'Rectangle', icon: Square, onSelect: () => deck.addShape('rect') },
        { label: 'Rounded rectangle', icon: Squircle, onSelect: () => deck.addShape('round') },
        { label: 'Ellipse', icon: Circle, onSelect: () => deck.addShape('ellipse') },
        { label: 'Line', icon: Minus, onSelect: () => deck.addShape('line') },
        { label: 'Arrow', icon: MoveRight, onSelect: () => deck.addShape('arrow') },
      ] },
    ] },
    { label: 'Format', items: [
      { label: 'Text', disabled: !can || !f, items: f ? [
        { label: 'Bold', icon: Bold, hint: keys('Mod+B'), checked: f.bold, onSelect: fmt((c) => c.toggleBold()) },
        { label: 'Italic', icon: Italic, hint: keys('Mod+I'), checked: f.italic, onSelect: fmt((c) => c.toggleItalic()) },
        { label: 'Underline', icon: Underline, hint: keys('Mod+U'), checked: f.underline, onSelect: fmt((c) => c.toggleUnderline()) },
      ] : [] },
      { label: 'Bullets and numbering', disabled: !can || !f, items: f ? [
        { label: 'Bulleted list', icon: List, checked: f.bullet, onSelect: fmt((c) => c.toggleBulletList()) },
        { label: 'Numbered list', icon: ListOrdered, checked: f.ordered, onSelect: fmt((c) => c.toggleOrderedList()) },
      ] : [] },
      { label: 'Arrange', disabled: !can || !any, items: [
        { label: 'Bring to front', icon: BringToFront, hint: keys('Mod+Shift+]'), onSelect: () => deck.arrange('front') },
        { label: 'Bring forward', icon: ArrowUp, hint: keys('Mod+]'), onSelect: () => deck.arrange('forward') },
        { label: 'Send backward', icon: ArrowDown, hint: keys('Mod+['), onSelect: () => deck.arrange('backward') },
        { label: 'Send to back', icon: SendToBack, hint: keys('Mod+Shift+['), onSelect: () => deck.arrange('back') },
      ] },
      { label: 'Align', disabled: !can || !any, items: [
        { label: 'Left', onSelect: () => deck.align('left') },
        { label: 'Centre', onSelect: () => deck.align('center') },
        { label: 'Right', onSelect: () => deck.align('right') },
        { label: 'Top', onSelect: () => deck.align('top') },
        { label: 'Middle', onSelect: () => deck.align('middle') },
        { label: 'Bottom', onSelect: () => deck.align('bottom') },
        { divider: true },
        { label: 'Distribute across', disabled: sel.length < 3, onSelect: () => deck.distribute('x') },
        { label: 'Distribute down', disabled: sel.length < 3, onSelect: () => deck.distribute('y') },
      ] },
    ] },
    { label: 'Slide', items: [
      { label: 'New slide', icon: Plus, disabled: !can, onSelect: () => deck.addSlide() },
      { label: 'Duplicate slide', icon: Files, disabled: !can, onSelect: () => deck.duplicateSlides() },
      { label: 'Delete slide', icon: Trash2, disabled: !can, onSelect: () => deck.deleteSlides() },
      { divider: true },
      { label: 'Layout', icon: LayoutTemplate, disabled: !can, items: layoutIds.map((id) => ({ label: layouts[id].name, checked: id === layout, onSelect: () => deck.setLayout(id) })) },
      { label: 'Transition', icon: Sparkles, disabled: !can, items: [
        { label: 'None', checked: trans === 'none', onSelect: () => deck.setTransition('none') },
        { label: 'Fade', checked: trans === 'fade', onSelect: () => deck.setTransition('fade') },
        { label: 'Slide', checked: trans === 'slide', onSelect: () => deck.setTransition('slide') },
      ] },
    ] },
  ]
}
