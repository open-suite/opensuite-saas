// The presentation editor: slide strip, stage, toolbar and notes. All state
// lives in the Deck controller (slides-core.js); these components draw it and
// turn pointer and key input into calls on it.
import { render } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  ArrowLeft, Undo2, Redo2, Bold, Italic, Underline, Baseline, Link2, List, ListOrdered, AlignLeft, AlignCenter, AlignRight,
  Type, Shapes, Square, Squircle, Circle, Minus, MoveRight, ImagePlus, Play, Users, MoreHorizontal, Printer, FileDown, FileUp, Trash2, FileX2,
  Plus, Copy, Scissors, ClipboardPaste, Files, LayoutTemplate, Palette, PaintBucket, PenLine, Layers, BringToFront, SendToBack, ArrowUp, ArrowDown,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
  AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter, AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd,
  ChevronDown, Sparkles, AppWindow, StickyNote, Ban,
} from 'lucide-preact'
import './slides.css'
import { user, docs, upsertDoc, toast, confirmed } from '../lib/store.js'
import { navigate } from '../lib/router.js'
import { refreshBoot } from '../lib/api.js'
import { renameDoc, trashDoc } from '../lib/docs.js'
import { cx, debounce, download, pickFile } from '../lib/util.js'
import { Avatar, Button, Empty, IconButton, Menu, Modal, keepFocus } from '../ui.jsx'
import { ShareDialog } from './docs.jsx'
import {
  W, H, themes, themeIds, fonts, fontKey, layouts, layoutIds, tokenLabels, palette, fontSizes, roleStyle, resolve,
  isLine, isShape, outer, union, shifted, resized, snap, rotate,
} from './slides-model.js'
import { Deck, prewarm, uploadImage } from './slides-core.js'
import { isBlank } from './slides-text.js'
import { SlideView } from './slides-render.jsx'
import { Show, Presenter } from './slides-show.jsx'

export { prewarm }

let clip = null // the last thing copied here, for the menus
const CLIP_TYPE = 'application/x-opensuite-slides'
const inField = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"], .modal')
const wordChar = /[\p{L}\p{N}_'’-]/u

// --- small pieces -------------------------------------------------------------

// A menu that opens where the pointer is.
function ContextMenu({ at, items, onClose }) {
  const ref = useRef()
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  useLayoutEffect(() => {
    const r = ref.current.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) })
  }, [at.x, at.y])
  useEffect(() => {
    const off = (e) => !ref.current?.contains(e.target) && onClose()
    const key = (e) => e.key === 'Escape' && onClose()
    addEventListener('pointerdown', off, true)
    addEventListener('keydown', key)
    return () => {
      removeEventListener('pointerdown', off, true)
      removeEventListener('keydown', key)
    }
  }, [])
  return (
    <div class="menu sl-context" role="menu" ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      {items.filter(Boolean).map((it, i) => it.divider ? <div class="menu-sep" key={i} /> : (
        <button key={i} type="button" role="menuitem" class={cx('menu-item', it.danger && 'danger')} disabled={it.disabled} onClick={() => { onClose(); it.onSelect() }}>
          {it.icon && <it.icon size={16} />}<span>{it.label}</span>{it.hint && <kbd>{it.hint}</kbd>}
        </button>
      ))}
    </div>
  )
}

// A toolbar button that opens a panel and keeps it open while it is used.
function Panel({ icon: Icon, label, text, swatch, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    if (!open) return
    const off = (e) => !ref.current?.contains(e.target) && setOpen(false)
    const key = (e) => e.key === 'Escape' && setOpen(false)
    addEventListener('pointerdown', off, true)
    addEventListener('keydown', key)
    return () => {
      removeEventListener('pointerdown', off, true)
      removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <span class="menu-wrap" ref={ref}>
      <button type="button" class={cx(text ? 'btn btn-ghost sl-tool' : 'icon-btn sl-tool', open && 'on')} title={label} aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon size={18} />
        {swatch !== undefined && <span class="sl-chip" style={{ background: swatch || 'transparent' }} />}
        {text}
      </button>
      {open && <div class="menu menu-left sl-panel" onClick={(e) => e.target.closest('[data-close]') && setOpen(false)}>{children}</div>}
    </span>
  )
}

function Colors({ deck, onPick, none, literal }) {
  const colors = deck.colors()
  return (
    <div class="sl-colors">
      <div class="menu-head">Theme</div>
      <div class="swatches">
        {['ink', 'muted', 'accent', 'soft', 'bg', 'line'].map((t) => (
          <button key={t} type="button" data-close class="swatch" style={{ background: colors[t] }} title={tokenLabels[t]} aria-label={tokenLabels[t]} onClick={() => onPick(literal ? colors[t] : t)} />
        ))}
      </div>
      <div class="menu-head">Colours</div>
      <div class="swatches">
        {palette.map((c) => <button key={c} type="button" data-close class="swatch" style={{ background: c }} aria-label={c} onClick={() => onPick(c)} />)}
      </div>
      {none && <button type="button" data-close class="menu-item" onClick={() => onPick(null)}><Ban size={16} /><span>{none}</span></button>}
    </div>
  )
}

function ThemeCards({ deck }) {
  const cur = deck.themeId()
  return (
    <div class="sl-themes">
      {themeIds.map((id) => {
        const t = themes[id]
        return (
          <button key={id} type="button" data-close class={cx('sl-theme', id === cur && 'on')} onClick={() => deck.setTheme(id)} aria-label={t.name + ' theme'} aria-pressed={id === cur}>
            <span class="sl-theme-card" style={{ background: t.bg, color: t.ink, fontFamily: fonts[t.font].css, borderColor: t.line }}>
              <i style={{ background: t.accent }} />
              <b>Aa</b>
            </span>
            {t.name}
          </button>
        )
      })}
    </div>
  )
}

// --- toolbar --------------------------------------------------------------------

function Toolbar({ deck, onImage }) {
  const [link, setLink] = useState(null)
  const sel = deck.selected()
  const boxes = sel.filter((e) => e.type === 'box')
  const lines = sel.filter(isLine)
  const layout = deck.slide()?.get('layout') || 'blank'
  const colors = deck.colors()
  const f = deck.formatting()
  const fmt = (run) => deck.format(run)
  const back = () => deck.editor?.view.focus()
  const base = boxes[0] ? roleStyle(layout, boxes[0]) : null
  const size = f?.size || base?.size || 24
  const align = f?.align || base?.align || 'left'
  const valign = boxes[0]?.valign || (boxes[0] && isShape(boxes[0]) ? 'middle' : 'top')
  const sizes = fontSizes.includes(size) ? fontSizes : [...fontSizes, size].sort((a, b) => a - b)
  const frames = boxes.length > 0
  const slideBg = deck.slide()?.get('bg')
  const trans = deck.meta.get('transition') || 'fade'
  return (
    <div class="toolbar sl-toolbar" role="toolbar" aria-label="Presentation tools" onMouseDown={keepFocus}>
      <IconButton icon={Undo2} label="Undo" disabled={!deck.undoer.undoStack.length} onClick={() => deck.undo()} />
      <IconButton icon={Redo2} label="Redo" disabled={!deck.undoer.redoStack.length} onClick={() => deck.redo()} />
      <span class="sep" />
      <Menu trigger={<button type="button" class="btn btn-ghost sl-tool" aria-label="New slide" title="New slide"><Plus size={18} /><span class="sl-lbl">Slide</span><ChevronDown size={14} /></button>} items={[
        { heading: 'New slide' },
        ...layoutIds.map((id) => ({ label: layouts[id].name, onSelect: () => deck.addSlide(id) })),
      ]} />
      <span class="sep" />
      <IconButton icon={Type} label="Text box" onClick={() => deck.addText()} />
      <Menu trigger={<IconButton icon={Shapes} label="Shape" />} items={[
        { label: 'Rectangle', icon: Square, onSelect: () => deck.addShape('rect') },
        { label: 'Rounded rectangle', icon: Squircle, onSelect: () => deck.addShape('round') },
        { label: 'Ellipse', icon: Circle, onSelect: () => deck.addShape('ellipse') },
        { divider: true },
        { label: 'Line', icon: Minus, onSelect: () => deck.addShape('line') },
        { label: 'Arrow', icon: MoveRight, onSelect: () => deck.addShape('arrow') },
      ]} />
      <IconButton icon={ImagePlus} label="Picture" onClick={() => onImage()} />

      {f && <>
        <span class="sep" />
        <select class="select" aria-label="Font" value={fontKey(f.font) || ''} onChange={(e) => { fmt((c) => (e.target.value ? c.setFontFamily(fonts[e.target.value].css) : c.unsetFontFamily())); back() }}>
          <option value="">Theme font</option>
          {Object.entries(fonts).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select class="select" aria-label="Text size" value={size} onChange={(e) => { fmt((c) => c.setFontSize(e.target.value + 'px')); back() }}>
          {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <IconButton icon={Bold} label="Bold" active={f.bold} onClick={() => fmt((c) => c.toggleBold())} />
        <IconButton icon={Italic} label="Italic" active={f.italic} onClick={() => fmt((c) => c.toggleItalic())} />
        <IconButton icon={Underline} label="Underline" active={f.underline} onClick={() => fmt((c) => c.toggleUnderline())} />
        <Panel icon={Baseline} label="Text colour" swatch={f.color}>
          <Colors deck={deck} literal none="Theme colour" onPick={(col) => fmt((c) => (col ? c.setColor(col) : c.unsetColor()))} />
        </Panel>
        {deck.editor && <IconButton icon={Link2} label="Link" active={f.link} onClick={() => setLink(deck.editor.getAttributes('link').href || '')} />}
        <span class="sep" />
        <IconButton icon={AlignLeft} label="Align left" active={align === 'left'} onClick={() => fmt((c) => c.setTextAlign('left'))} />
        <IconButton icon={AlignCenter} label="Centre" active={align === 'center'} onClick={() => fmt((c) => c.setTextAlign('center'))} />
        <IconButton icon={AlignRight} label="Align right" active={align === 'right'} onClick={() => fmt((c) => c.setTextAlign('right'))} />
        <Menu trigger={<IconButton icon={valign === 'middle' ? AlignVerticalJustifyCenter : valign === 'bottom' ? AlignVerticalJustifyEnd : AlignVerticalJustifyStart} label="Vertical position" />} items={[
          { label: 'Top', icon: AlignVerticalJustifyStart, active: valign === 'top', onSelect: () => deck.patchSelected({ valign: 'top' }) },
          { label: 'Middle', icon: AlignVerticalJustifyCenter, active: valign === 'middle', onSelect: () => deck.patchSelected({ valign: 'middle' }) },
          { label: 'Bottom', icon: AlignVerticalJustifyEnd, active: valign === 'bottom', onSelect: () => deck.patchSelected({ valign: 'bottom' }) },
        ]} />
        <IconButton icon={List} label="Bulleted list" active={f.bullet} onClick={() => fmt((c) => c.toggleBulletList())} />
        <IconButton icon={ListOrdered} label="Numbered list" active={f.ordered} onClick={() => fmt((c) => c.toggleOrderedList())} />
      </>}

      {frames && <>
        <span class="sep" />
        <Panel icon={PaintBucket} label="Fill" swatch={resolve(colors, boxes[0].fill)}>
          <Colors deck={deck} none="No fill" onPick={(c) => deck.patch(Object.fromEntries(boxes.map((b) => [b.id, { fill: c }])))} />
        </Panel>
        <Panel icon={PenLine} label="Border" swatch={boxes[0].sw === 0 ? null : resolve(colors, boxes[0].stroke)}>
          <Colors deck={deck} none="No border" onPick={(c) => deck.patch(Object.fromEntries(boxes.map((b) => [b.id, { stroke: c, sw: c ? b.sw || 2 : null }])))} />
          <div class="menu-sep" />
          <div class="sl-weights">
            {[1, 2, 4, 8].map((n) => (
              <button key={n} type="button" data-close class={cx('sl-weight', (boxes[0].sw || 2) === n && boxes[0].stroke && 'on')} aria-label={`Border ${n} px`} onClick={() => deck.patch(Object.fromEntries(boxes.map((b) => [b.id, { sw: n, stroke: b.stroke || 'ink' }])))}>
                <i style={{ height: n }} />
              </button>
            ))}
          </div>
        </Panel>
      </>}

      {lines.length > 0 && <>
        <span class="sep" />
        <Panel icon={PenLine} label="Line colour" swatch={resolve(colors, lines[0].stroke)}>
          <Colors deck={deck} onPick={(c) => deck.patch(Object.fromEntries(lines.map((l) => [l.id, { stroke: c }])))} />
          <div class="menu-sep" />
          <div class="sl-weights">
            {[2, 4, 6, 10].map((n) => (
              <button key={n} type="button" data-close class={cx('sl-weight', (lines[0].sw || 4) === n && 'on')} aria-label={`Line ${n} px`} onClick={() => deck.patch(Object.fromEntries(lines.map((l) => [l.id, { sw: n }])))}>
                <i style={{ height: n }} />
              </button>
            ))}
          </div>
        </Panel>
        <Menu trigger={<IconButton icon={MoveRight} label="Line ends" />} items={[
          { label: 'Plain line', icon: Minus, active: (lines[0].head || 'none') === 'none', onSelect: () => deck.patch(Object.fromEntries(lines.map((l) => [l.id, { head: 'none' }]))) },
          { label: 'Arrow', icon: MoveRight, active: lines[0].head === 'end', onSelect: () => deck.patch(Object.fromEntries(lines.map((l) => [l.id, { head: 'end' }]))) },
          { label: 'Arrow at both ends', icon: MoveRight, active: lines[0].head === 'both', onSelect: () => deck.patch(Object.fromEntries(lines.map((l) => [l.id, { head: 'both' }]))) },
        ]} />
      </>}

      {sel.length > 0 ? <>
        <span class="sep" />
        <Menu trigger={<button type="button" class="btn btn-ghost sl-tool" aria-label="Arrange" title="Arrange"><Layers size={18} /><span class="sl-lbl">Arrange</span><ChevronDown size={14} /></button>} items={[
          { label: 'Bring to front', icon: BringToFront, onSelect: () => deck.arrange('front') },
          { label: 'Bring forward', icon: ArrowUp, onSelect: () => deck.arrange('forward') },
          { label: 'Send backward', icon: ArrowDown, onSelect: () => deck.arrange('backward') },
          { label: 'Send to back', icon: SendToBack, onSelect: () => deck.arrange('back') },
          { divider: true },
          { label: 'Align left', icon: AlignStartVertical, onSelect: () => deck.align('left') },
          { label: 'Align centre', icon: AlignCenterVertical, onSelect: () => deck.align('center') },
          { label: 'Align right', icon: AlignEndVertical, onSelect: () => deck.align('right') },
          { label: 'Align top', icon: AlignStartHorizontal, onSelect: () => deck.align('top') },
          { label: 'Align middle', icon: AlignCenterHorizontal, onSelect: () => deck.align('middle') },
          { label: 'Align bottom', icon: AlignEndHorizontal, onSelect: () => deck.align('bottom') },
          { divider: true },
          { label: 'Distribute across', icon: AlignHorizontalDistributeCenter, disabled: sel.length < 3, onSelect: () => deck.distribute('x') },
          { label: 'Distribute down', icon: AlignVerticalDistributeCenter, disabled: sel.length < 3, onSelect: () => deck.distribute('y') },
        ]} />
      </> : <>
        <span class="sep" />
        <Menu trigger={<button type="button" class="btn btn-ghost sl-tool" aria-label="Layout" title="Layout"><LayoutTemplate size={18} /><span class="sl-lbl">Layout</span><ChevronDown size={14} /></button>} items={
          layoutIds.map((id) => ({ label: layouts[id].name, active: id === layout, onSelect: () => deck.setLayout(id) }))
        } />
        <Panel icon={PaintBucket} label="Slide background" swatch={slideBg || colors.bg}>
          <Colors deck={deck} literal none="Theme background" onPick={(c) => deck.setBackground(c)} />
        </Panel>
        <Panel icon={Palette} label="Theme" text={<><span class="sl-lbl">Theme</span><ChevronDown size={14} /></>}>
          <ThemeCards deck={deck} />
        </Panel>
        <Menu trigger={<button type="button" class="btn btn-ghost sl-tool" aria-label="Transition" title="Transition between slides"><Sparkles size={18} /><span class="sl-lbl">Transition</span><ChevronDown size={14} /></button>} items={[
          { label: 'None', active: trans === 'none', onSelect: () => deck.setTransition('none') },
          { label: 'Fade', active: trans === 'fade', onSelect: () => deck.setTransition('fade') },
          { label: 'Slide', active: trans === 'slide', onSelect: () => deck.setTransition('slide') },
        ]} />
      </>}

      {link !== null && (
        <Modal title="Link" onClose={() => setLink(null)} footer={<>
          {deck.editor?.isActive('link') && <Button kind="danger" onClick={() => { fmt((c) => c.unsetLink()); setLink(null) }}>Remove</Button>}
          <Button kind="primary" onClick={() => {
            const href = link.trim()
            fmt((c) => (href ? c.extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(href) ? href : 'https://' + href }) : c.unsetLink()))
            setLink(null)
          }}>Apply</Button>
        </>}>
          <input class="input" autofocus placeholder="https://" value={link} onInput={(e) => setLink(e.target.value)} />
        </Modal>
      )}
    </div>
  )
}

// --- slide strip ------------------------------------------------------------------

function Strip({ deck, onMenu }) {
  const order = deck.order()
  const themeId = deck.themeId()
  const peers = deck.peers()
  const [drop, setDrop] = useState(null)
  const ref = useRef()

  useEffect(() => {
    ref.current?.querySelector('.sl-thumb.cur')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [deck.cur])

  const down = (e, id) => {
    if (e.button !== 0) return
    deck.zone = 'strip'
    const mode = e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'keep'
    deck.goto(id, mode)
    ref.current.focus({ preventScroll: true })
    const x0 = e.clientX, y0 = e.clientY
    let dragging = false, index = null
    const move = (ev) => {
      if (!deck.state.canEdit || (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6)) return
      dragging = true
      const across = getComputedStyle(ref.current).flexDirection === 'row'
      const thumbs = [...ref.current.querySelectorAll('[data-slide]')]
      index = thumbs.length
      for (let i = 0; i < thumbs.length; i++) {
        const r = thumbs[i].getBoundingClientRect()
        if (across ? ev.clientX < r.left + r.width / 2 : ev.clientY < r.top + r.height / 2) {
          index = i
          break
        }
      }
      setDrop(index)
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      if (dragging && index != null) deck.moveSlides(deck.pickedInOrder(), index)
      else if (mode === 'keep') deck.goto(id)
      setDrop(null)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  return (
    <div class="sl-strip" ref={ref} tabIndex={-1} role="listbox" aria-label="Slides" aria-multiselectable="true" onPointerDown={() => (deck.zone = 'strip')}>
      {order.map((id, i) => {
        const here = peers.filter((p) => p.at.slide === id)
        return (
          <div key={id} class={cx('sl-thumb', id === deck.cur && 'cur', deck.picked.has(id) && 'on', drop === i && 'drop-before', drop === order.length && i === order.length - 1 && 'drop-after')}
            data-slide={id} role="option" aria-selected={deck.picked.has(id)} aria-label={`Slide ${i + 1}`}
            onPointerDown={(e) => down(e, id)} onContextMenu={(e) => onMenu(e, id)}>
            <span class="sl-num">{i + 1}</span>
            <div class="sl-thumb-frame">
              <div class="sl-thumb-scale"><SlideView deck={deck} id={id} v={deck.versions.get(id) || 0} themeId={themeId} mode="thumb" /></div>
              {here.length > 0 && <span class="sl-thumb-peers">{here.slice(0, 4).map((p) => <i key={p.cid} style={{ background: p.user.color }} title={p.user.name} />)}</span>}
            </div>
          </div>
        )
      })}
      {deck.state.canEdit && <button type="button" class="sl-add" aria-label="Add slide" title="Add slide" onClick={() => deck.addSlide('titleBody', order[order.length - 1])}><Plus size={18} /></button>}
    </div>
  )
}

// --- stage -----------------------------------------------------------------------

const handles = [['nw', -1, -1], ['n', 0, -1], ['ne', 1, -1], ['e', 1, 0], ['se', 1, 1], ['s', 0, 1], ['sw', -1, 1], ['w', -1, 0]]

function Overlay({ deck, scale: s }) {
  const sel = deck.selected()
  const can = deck.state.canEdit
  const single = sel.length === 1 ? sel[0] : null
  const frame = (e, extra, children) => (
    <div class={cx('sl-frame', extra)} style={{ left: e.x * s, top: e.y * s, width: e.w * s, height: e.h * s, transform: e.rot ? `rotate(${e.rot}deg)` : undefined }}>{children}</div>
  )
  const group = sel.length > 1 ? union(sel.map(outer)) : null
  const peers = deck.peers().filter((p) => p.at.slide === deck.cur && p.at.sel?.length)
  return (
    <div class="sl-overlay">
      {peers.flatMap((p) => p.at.sel.map((id) => {
        const e = deck.el(id)
        if (!e) return null
        const b = isLine(e) ? outer(e) : e
        return (
          <div key={p.cid + id} class="sl-frame sl-peer" style={{ left: b.x * s, top: b.y * s, width: b.w * s, height: b.h * s, transform: b.rot ? `rotate(${b.rot}deg)` : undefined, borderColor: p.user.color }}>
            <span style={{ background: p.user.color }}>{p.user.name}</span>
          </div>
        )
      }))}
      {sel.map((e) => isLine(e) ? (
        <div key={e.id}>
          {can && single && [['p1', e.x1, e.y1], ['p2', e.x2, e.y2]].map(([hname, x, y]) => <span key={hname} class="sl-h sl-h-pt" data-h={hname} style={{ left: x * s, top: y * s }} />)}
          {!single && frame(outer(e), 'thin')}
        </div>
      ) : frame(e, cx(deck.editing === e.id && 'editing', !single && 'thin'), can && single && <>
        {handles.map(([n]) => <span key={n} class={'sl-h sl-h-' + n} data-h={n} />)}
        <span class="sl-h sl-h-rot" data-h="rot" />
      </>))}
      {group && <div class="sl-frame group" style={{ left: group.x * s, top: group.y * s, width: group.w * s, height: group.h * s }} />}
      {deck.guides?.x.map((x) => <i key={'x' + x} class="sl-guide v" style={{ left: x * s }} />)}
      {deck.guides?.y.map((y) => <i key={'y' + y} class="sl-guide h" style={{ top: y * s }} />)}
      {deck.marquee && <div class="sl-marquee" style={{ left: deck.marquee.x * s, top: deck.marquee.y * s, width: deck.marquee.w * s, height: deck.marquee.h * s }} />}
    </div>
  )
}

function Stage({ deck, onMenu, onImage }) {
  const area = useRef(), canvas = useRef(), host = useRef()
  const [size, setSize] = useState(null)
  useLayoutEffect(() => {
    const measure = () => setSize({ w: area.current.clientWidth, h: area.current.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(area.current)
    measure()
    return () => ro.disconnect()
  }, [])
  const pad = size && size.w < 700 ? 10 : 28
  const scale = size ? Math.max(0.05, Math.min((size.w - pad * 2) / W, (size.h - pad * 2) / H)) : 0
  deck.scale = scale
  useLayoutEffect(() => {
    deck.host = host.current || null
    deck.placeHost()
    const t = window.__slidesTiming
    if (t && host.current && !t.shown) t.shown = performance.now() - t.t0
  })

  const point = (e) => {
    const r = canvas.current.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }
  const track = (move, up) => {
    const done = (ev) => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', done)
      removeEventListener('pointercancel', done)
      up(ev)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', done)
    addEventListener('pointercancel', done)
  }
  // Lines other elements already sit on, for snapping.
  const rails = () => {
    const rest = deck.els().filter((o) => !deck.sel.has(o.id)).map(outer)
    return {
      xs: [0, W / 2, W, ...rest.flatMap((b) => [b.x, b.x + b.w / 2, b.x + b.w])],
      ys: [0, H / 2, H, ...rest.flatMap((b) => [b.y, b.y + b.h / 2, b.y + b.h])],
    }
  }
  const settle = () => {
    const live = deck.live
    deck.live = deck.guides = null
    if (live) deck.patch(live)
    deck.changed()
  }

  const startMove = (e, id, was) => {
    const p0 = point(e)
    let ids = [...deck.sel]
    let start = new Map(ids.map((i) => [i, deck.el(i)]))
    const box0 = union([...start.values()].map(outer))
    const { xs, ys } = rails()
    let moved = false
    track((ev) => {
      const p = point(ev)
      let dx = p.x - p0.x, dy = p.y - p0.y
      if (!moved && Math.hypot(dx, dy) * scale < 4) return
      if (!moved && ev.altKey) {
        // Alt-drag leaves the original and moves a copy.
        ids = deck.duplicate(ids, 0)
        start = new Map(ids.map((i) => [i, deck.el(i)]))
      }
      moved = true
      if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
      const s = ev.metaKey || ev.ctrlKey ? { dx: 0, dy: 0, gx: [], gy: [] } : snap({ x: box0.x + dx, y: box0.y + dy, w: box0.w, h: box0.h }, xs, ys, 6 / scale)
      dx += s.dx
      dy += s.dy
      deck.live = new Map(ids.map((i) => [i, shifted(start.get(i), dx, dy)]))
      deck.guides = { x: s.gx, y: s.gy }
      deck.changed()
    }, (ev) => {
      if (moved) return settle()
      if (ev.type === 'pointercancel' || ev.shiftKey || ev.metaKey || ev.ctrlKey) return
      const el = deck.el(id)
      if (!el) return
      // A second click on a box, or a first click on an empty placeholder,
      // starts typing where the pointer is.
      if (el.type === 'box' && (was || (el.role && isBlank(el.text)))) deck.startEdit(id, { point: { left: ev.clientX, top: ev.clientY } })
      else if (el.type === 'image' && !el.src) onImage(id)
    })
  }

  const startHandle = (e, name) => {
    const id = [...deck.sel][0]
    const start = deck.el(id)
    if (!start) return
    const p0 = point(e)
    const { xs, ys } = rails()
    const reach = 6 / scale
    track((ev) => {
      const p = point(ev)
      const free = ev.metaKey || ev.ctrlKey
      let next, guides = { x: [], y: [] }
      if (name === 'rot') {
        const cx0 = start.x + start.w / 2, cy0 = start.y + start.h / 2
        let a = (Math.atan2(p.y - cy0, p.x - cx0) * 180) / Math.PI + 90
        a = ev.shiftKey ? Math.round(a / 15) * 15 : Math.abs(a - Math.round(a / 45) * 45) < 3 ? Math.round(a / 45) * 45 : Math.round(a)
        next = { rot: ((a + 540) % 360) - 180 }
      } else if (name === 'p1' || name === 'p2') {
        const other = name === 'p1' ? { x: start.x2, y: start.y2 } : { x: start.x1, y: start.y1 }
        let x = p.x, y = p.y
        if (ev.shiftKey) {
          const len = Math.hypot(x - other.x, y - other.y)
          const a = (Math.round(Math.atan2(y - other.y, x - other.x) / (Math.PI / 4)) * Math.PI) / 4
          x = other.x + Math.cos(a) * len
          y = other.y + Math.sin(a) * len
        } else if (!free) {
          const s = snap({ x, y, w: 0, h: 0 }, xs, ys, reach, { x: [0], y: [0] })
          x += s.dx
          y += s.dy
          guides = { x: s.gx, y: s.gy }
        }
        next = name === 'p1' ? { x1: x, y1: y } : { x2: x, y2: y }
      } else {
        const [, hx, hy] = handles.find((h) => h[0] === name)
        const ratio = hx && hy && (start.type === 'image' ? !ev.shiftKey : ev.shiftKey)
        next = resized(start, hx, hy, p.x - p0.x, p.y - p0.y, ratio)
        if (!start.rot && !ratio && !free) {
          const s = snap(next, xs, ys, reach, { x: hx < 0 ? [0] : hx > 0 ? [1] : [], y: hy < 0 ? [0] : hy > 0 ? [1] : [] })
          if (hx < 0) { next.x += s.dx; next.w -= s.dx } else if (hx > 0) next.w += s.dx
          if (hy < 0) { next.y += s.dy; next.h -= s.dy } else if (hy > 0) next.h += s.dy
          guides = { x: s.gx, y: s.gy }
        }
      }
      deck.live = new Map([[id, next]])
      deck.guides = guides
      deck.changed()
    }, settle)
  }

  const startMarquee = (e) => {
    const p0 = point(e)
    const keep = e.shiftKey ? [...deck.sel] : []
    const all = deck.els().map((el) => ({ id: el.id, b: outer(el) }))
    track((ev) => {
      const p = point(ev)
      const m = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) }
      if (m.w * scale < 3 && m.h * scale < 3) return
      deck.marquee = m
      deck.sel = new Set([...keep, ...all.filter(({ b }) => b.x < m.x + m.w && b.x + b.w > m.x && b.y < m.y + m.h && b.y + b.h > m.y).map((x) => x.id)])
      deck.changed()
    }, () => {
      deck.marquee = null
      deck.publish()
      deck.changed()
    })
  }

  const down = (e) => {
    if (e.button !== 0 || !canvas.current) return
    deck.zone = 'stage'
    if (deck.editor && host.current.contains(e.target)) return
    const handle = e.target.closest('[data-h]')
    const id = e.target.closest('[data-el]')?.dataset.el
    e.preventDefault()
    if (!deck.state.canEdit) return
    if (handle) return startHandle(e, handle.dataset.h)
    if (deck.editing) deck.stopEdit()
    if (document.activeElement !== area.current) {
      document.activeElement?.blur?.()
      area.current.focus({ preventScroll: true })
    }
    if (id) {
      const was = deck.sel.size === 1 && deck.sel.has(id)
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        const next = new Set(deck.sel)
        next.has(id) ? next.delete(id) : next.add(id)
        deck.select(next)
        if (!next.has(id)) return
      } else if (!deck.sel.has(id)) deck.select([id])
      startMove(e, id, was)
    } else {
      if (!e.shiftKey) deck.select([])
      startMarquee(e)
    }
  }

  const twice = (e) => {
    const id = e.target.closest('[data-el]')?.dataset.el
    if (deck.editor) {
      // The second click already put the caret in; widen it to the word.
      const view = deck.editor.view
      const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!at) return
      const $p = view.state.doc.resolve(at.pos)
      const text = $p.parent.textContent
      let a = Math.min($p.parentOffset, text.length), b = a
      while (a > 0 && wordChar.test(text[a - 1])) a--
      while (b < text.length && wordChar.test(text[b])) b++
      if (b > a) deck.editor.commands.setTextSelection({ from: $p.start() + a, to: $p.start() + b })
    } else if (id && deck.el(id)?.type === 'box') deck.startEdit(id, { all: true })
  }

  const drop = (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    const into = e.target.closest('[data-el]')?.dataset.el
    files.forEach((f, i) => deck.addImage(f, i === 0 && deck.el(into)?.type === 'image' && !deck.el(into).src ? into : undefined))
  }

  return (
    <div class="sl-area" ref={area} tabIndex={-1} onPointerDown={down} onMouseDown={(e) => !(deck.editor && host.current?.contains(e.target)) && e.preventDefault()}
      onDblClick={twice} onContextMenu={(e) => onMenu(e, e.target.closest('[data-el]')?.dataset.el)} onDragOver={(e) => e.preventDefault()} onDrop={drop}
      onClick={(e) => e.target.closest('a') && e.preventDefault()}>
      {scale > 0 && deck.cur && (
        <div class="sl-canvas" ref={canvas} style={{ width: W * scale, height: H * scale }}>
          <div class="sl-scaled" style={`transform:scale(${scale})`}>
            <SlideView deck={deck} id={deck.cur} v={deck.versions.get(deck.cur) || 0} themeId={deck.themeId()} mode="edit" live={deck.live} editing={deck.editing} />
            <div class="sl-edit-host" ref={host} hidden />
          </div>
          <Overlay deck={deck} scale={scale} />
        </div>
      )}
    </div>
  )
}

// --- printing ---------------------------------------------------------------------
// Every slide becomes one page. The pages are built in one go when the browser
// is about to print, whether that came from our menu or the browser's own.

function buildPrint(deck) {
  if (document.querySelector('.sl-print')) return
  const box = document.createElement('div')
  box.className = 'sl-print'
  const style = document.createElement('style')
  style.className = 'sl-print-page'
  style.textContent = `@page { size: ${W}px ${H}px; margin: 0 }`
  document.head.append(style)
  document.body.append(box)
  document.documentElement.classList.add('sl-printing')
  const themeId = deck.themeId()
  render(<>{deck.order().map((id) => <div class="sl-page" key={id}><SlideView deck={deck} id={id} v={0} themeId={themeId} mode="print" /></div>)}</>, box)
}

function clearPrint() {
  const box = document.querySelector('.sl-print')
  if (box) {
    render(null, box)
    box.remove()
  }
  document.querySelector('.sl-print-page')?.remove()
  document.documentElement.classList.remove('sl-printing')
}

async function printDeck(deck) {
  buildPrint(deck)
  await Promise.all([...document.querySelectorAll('.sl-print img')].map((img) => img.decode?.().catch(() => {})))
  window.print()
}

// --- keys and clipboard -----------------------------------------------------------

function onKey(e, deck, ui) {
  // While a menu or dialog is open, keys belong to it.
  if (inField(e.target) || ui.busy() || document.querySelector('.menu, .modal-back')) return
  const mod = e.metaKey || e.ctrlKey
  const k = e.key
  const can = deck.state.canEdit
  const strip = deck.zone === 'strip'
  const done = () => e.preventDefault()
  if (mod && k.toLowerCase() === 'z') return done(), e.shiftKey ? deck.redo() : deck.undo()
  if (mod && k.toLowerCase() === 'y') return done(), deck.redo()
  if (mod && k === 'Enter') return done(), ui.present(deck.cur)
  if (k === 'F5') return done(), ui.present(deck.order()[0])
  if (mod && k.toLowerCase() === 'p') return done(), printDeck(deck)
  if (k === 'PageDown') return done(), deck.step(1)
  if (k === 'PageUp') return done(), deck.step(-1)
  if (k === 'Home' || k === 'End') return done(), deck.goto(deck.order()[k === 'Home' ? 0 : deck.order().length - 1])
  if (strip) {
    if (k === 'ArrowDown' || k === 'ArrowRight') return done(), deck.step(1)
    if (k === 'ArrowUp' || k === 'ArrowLeft') return done(), deck.step(-1)
    if (!can) return
    if (mod && k.toLowerCase() === 'a') return done(), (deck.picked = new Set(deck.order())), deck.changed()
    if (mod && k.toLowerCase() === 'd') return done(), deck.duplicateSlides()
    if (k === 'Delete' || k === 'Backspace') return done(), deck.deleteSlides()
    if (k === 'Enter' || (e.ctrlKey && k.toLowerCase() === 'm')) return done(), deck.addSlide()
    return
  }
  const any = deck.sel.size > 0
  if (k === 'Escape') return deck.select([])
  if (!any && (k === 'ArrowDown' || k === 'ArrowRight')) return done(), deck.step(1)
  if (!any && (k === 'ArrowUp' || k === 'ArrowLeft')) return done(), deck.step(-1)
  if (!can) return
  if (e.ctrlKey && k.toLowerCase() === 'm') return done(), deck.addSlide()
  if (mod && k.toLowerCase() === 'a') return done(), deck.select(deck.els().map((x) => x.id))
  if (k === 'Tab') {
    const els = deck.els()
    if (!els.length) return
    const i = els.findIndex((x) => deck.sel.has(x.id))
    return done(), deck.select([els[(i + (e.shiftKey ? -1 : 1) + els.length) % els.length].id])
  }
  if (!any) return
  const step = e.shiftKey ? 10 : 1
  if (k === 'ArrowLeft') return done(), deck.nudge(-step, 0)
  if (k === 'ArrowRight') return done(), deck.nudge(step, 0)
  if (k === 'ArrowUp') return done(), deck.nudge(0, -step)
  if (k === 'ArrowDown') return done(), deck.nudge(0, step)
  if (k === 'Delete' || k === 'Backspace') return done(), deck.remove()
  if (mod && k.toLowerCase() === 'd') return done(), deck.duplicate()
  if (mod && k === ']') return done(), deck.arrange(e.shiftKey ? 'front' : 'forward')
  if (mod && k === '[') return done(), deck.arrange(e.shiftKey ? 'back' : 'backward')
  if (mod && k.toLowerCase() === 'b') return done(), deck.format((c) => c.toggleBold())
  if (mod && k.toLowerCase() === 'i') return done(), deck.format((c) => c.toggleItalic())
  if (mod && k.toLowerCase() === 'u') return done(), deck.format((c) => c.toggleUnderline())
  const one = deck.sel.size === 1 && deck.el([...deck.sel][0])
  if (one?.type !== 'box') return
  if (k === 'Enter' || k === 'F2') return done(), deck.startEdit(one.id, { all: true })
  // Typing with a box selected goes straight into it. The editor is built and
  // focused inside this very key press, so nothing typed next is lost.
  if (k.length === 1 && !mod && !e.altKey) return done(), deck.startEdit(one.id, { all: true, insert: k })
}

function onCopy(e, deck, ui, cut) {
  if (inField(e.target) || ui.busy()) return
  const data = deck.copy()
  if (!data) return
  clip = data
  e.clipboardData?.setData(CLIP_TYPE, JSON.stringify(data))
  e.clipboardData?.setData('text/plain', data.plain || '')
  e.preventDefault()
  if (cut && deck.state.canEdit) data.t === 'slides' ? deck.deleteSlides() : deck.remove()
}

function onPaste(e, deck, ui) {
  if (inField(e.target) || ui.busy() || !deck.state.canEdit) return
  const cd = e.clipboardData
  const raw = cd?.getData(CLIP_TYPE)
  const images = [...(cd?.files || [])].filter((f) => f.type.startsWith('image/'))
  if (raw) {
    try {
      deck.paste(JSON.parse(raw))
    } catch {}
  } else if (images.length) images.forEach((f) => deck.addImage(f))
  else {
    const text = cd?.getData('text/plain')?.trim()
    if (!text) return
    deck.addText(text)
  }
  e.preventDefault()
}

// --- the view -----------------------------------------------------------------------

export default function SlidesView({ id }) {
  const doc = docs.value.find((d) => d.id === id)
  const session = useRef(null)
  const [tick, bump] = useState(0)
  const [share, setShare] = useState(false)
  const [show, setShow] = useState(null) // id of the slide a show starts on
  const [menu, setMenu] = useState(null)
  const [notes, setNotes] = useState(true)
  const ui = useRef({})
  const me = user.value
  const presenter = useRef(new URLSearchParams(location.search).has('presenter')).current

  useEffect(() => {
    if (!doc) refreshBoot()
  }, [id])

  // A layout effect: the deck and its first slide are in place before the
  // browser paints the frame that follows the click.
  useLayoutEffect(() => {
    if (!doc) return
    let raf = 0
    const deck = new Deck(id, me, () => {
      raf ||= requestAnimationFrame(() => {
        raf = 0
        bump((n) => n + 1)
      })
    })
    session.current = deck
    window.__deck = deck
    bump((n) => n + 1)
    const key = (e) => onKey(e, deck, ui.current)
    const copy = (e) => onCopy(e, deck, ui.current, false)
    const cut = (e) => onCopy(e, deck, ui.current, true)
    const paste = (e) => onPaste(e, deck, ui.current)
    const before = () => buildPrint(deck)
    addEventListener('keydown', key)
    document.addEventListener('copy', copy)
    document.addEventListener('cut', cut)
    document.addEventListener('paste', paste)
    addEventListener('beforeprint', before)
    addEventListener('afterprint', clearPrint)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('keydown', key)
      document.removeEventListener('copy', copy)
      document.removeEventListener('cut', cut)
      document.removeEventListener('paste', paste)
      removeEventListener('beforeprint', before)
      removeEventListener('afterprint', clearPrint)
      clearPrint()
      session.current = null
      if (window.__deck === deck) window.__deck = null
      deck.close()
    }
  }, [id, !!doc])

  const rename = useRef(debounce((d, title) => renameDoc(d, title), 500)).current

  if (!doc) {
    return (
      <div class="page">
        {confirmed.value && <Empty icon={FileX2} title="This presentation isn't available" text="It may have been deleted, or it hasn't been shared with you."><Button onClick={() => navigate('/docs')}>Back to Docs</Button></Empty>}
      </div>
    )
  }

  const deck = session.current
  const title = doc.title
  if (presenter) return deck ? <Presenter deck={deck} tick={tick} title={title} /> : <div class="sl-presenter" />

  const canEdit = !!deck && deck.state.canEdit && doc.role !== 'view'
  // The same person in a second window (the presenter view) is not "someone else".
  const others = deck ? [...new Map(deck.peers().filter((p) => p.user.id !== me.id).map((p) => [p.user.id, p.user])).values()] : []
  const status = !deck ? '' : !deck.state.online ? 'Offline · saved on this device' : deck.saved() ? 'Saved' : 'Saving…'

  const present = (from, withNotes) => {
    if (!deck) return
    deck.stopEdit()
    if (withNotes) {
      const w = window.open(location.pathname + '?presenter=1', 'os-presenter-' + id, 'popup,width=1180,height=740')
      if (!w) return toast('Allow pop-ups for Open Suite to open the presenter view.', 'error')
    }
    document.documentElement.requestFullscreen?.().catch(() => {})
    setShow(from || deck.cur)
  }
  const pickImage = async (into) => {
    const f = await pickFile('image/*')
    if (f) deck.addImage(f, into)
  }
  const exportPptx = async () => {
    try {
      const { deckToPptx } = await import('./slides-pptx.js')
      download(await deckToPptx(deck.toJSON(), title), `${title || 'Untitled'}.pptx`)
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  const importPptx = async () => {
    const f = await pickFile('.pptx')
    if (!f) return
    try {
      const { pptxToDeck } = await import('./slides-pptx.js')
      const data = await pptxToDeck(f, uploadImage)
      let after = deck.order()[deck.order().length - 1]
      for (const s of data.slides) after = deck.addSlide(s.layout, after, s)
      toast(`${data.slides.length} slide${data.slides.length === 1 ? '' : 's'} added`)
    } catch (e) {
      toast(e.message || 'That file could not be read.', 'error')
    }
  }
  ui.current = { busy: () => show !== null || share, present }

  const copyNow = (cut) => {
    clip = deck.copy()
    if (clip) navigator.clipboard?.writeText(clip.plain || '').catch(() => {})
    if (cut && clip) clip.t === 'slides' ? deck.deleteSlides() : deck.remove()
  }
  const elementMenu = (e, elId) => {
    e.preventDefault()
    if (!canEdit) return
    deck.zone = 'stage'
    if (elId && !deck.sel.has(elId)) deck.select([elId])
    else if (!elId) deck.select([])
    const any = deck.sel.size > 0
    setMenu({ at: { x: e.clientX, y: e.clientY }, items: [
      any && { label: 'Cut', icon: Scissors, onSelect: () => copyNow(true) },
      any && { label: 'Copy', icon: Copy, onSelect: () => copyNow(false) },
      { label: 'Paste', icon: ClipboardPaste, disabled: !clip, onSelect: () => deck.paste(clip) },
      any && { label: 'Duplicate', icon: Files, onSelect: () => deck.duplicate() },
      any && { divider: true },
      any && { label: 'Bring to front', icon: BringToFront, onSelect: () => deck.arrange('front') },
      any && { label: 'Send to back', icon: SendToBack, onSelect: () => deck.arrange('back') },
      any && { divider: true },
      any && { label: 'Delete', icon: Trash2, danger: true, onSelect: () => deck.remove() },
      !any && { divider: true },
      !any && { label: 'New slide', icon: Plus, onSelect: () => deck.addSlide() },
    ] })
  }
  const slideMenu = (e, sid) => {
    e.preventDefault()
    if (!canEdit) return
    deck.zone = 'strip'
    if (!deck.picked.has(sid)) deck.goto(sid)
    setMenu({ at: { x: e.clientX, y: e.clientY }, items: [
      { label: 'New slide', icon: Plus, onSelect: () => deck.addSlide('titleBody', sid) },
      { label: 'Duplicate', icon: Files, onSelect: () => deck.duplicateSlides() },
      { divider: true },
      { label: 'Cut', icon: Scissors, onSelect: () => copyNow(true) },
      { label: 'Copy', icon: Copy, onSelect: () => copyNow(false) },
      { label: 'Paste', icon: ClipboardPaste, disabled: clip?.t !== 'slides', onSelect: () => deck.paste(clip) },
      { divider: true },
      { label: 'Present from here', icon: Play, onSelect: () => present(sid) },
      { divider: true },
      { label: deck.picked.size > 1 ? `Delete ${deck.picked.size} slides` : 'Delete slide', icon: Trash2, danger: true, onSelect: () => deck.deleteSlides() },
    ] })
  }

  return (
    <div class={cx('doc-view sl-view', !canEdit && 'readonly')}>
      <div class="doc-bar">
        <IconButton icon={ArrowLeft} label="All docs" onClick={() => navigate('/docs')} />
        <input class="doc-title" aria-label="Title" placeholder="Untitled" value={title} disabled={doc.role === 'view'}
          onInput={(e) => { upsertDoc({ ...doc, title: e.target.value }); rename(doc, e.target.value) }} />
        <span class="save-state">{status}</span>
        <span class="grow" />
        <span class="presence">{others.slice(0, 5).map((u) => <span key={u.id} title={u.name}><Avatar name={u.name} id={u.id} size={28} /></span>)}</span>
        <span class="sl-present">
          <Button icon={Play} onClick={() => present(deck?.order()[0])}><span class="sl-lbl">Present</span></Button>
          <Menu align="right" trigger={<button type="button" class="btn sl-present-more" aria-label="Presenting options"><ChevronDown size={15} /></button>} items={[
            { label: 'From the first slide', icon: Play, hint: 'F5', onSelect: () => present(deck.order()[0]) },
            { label: 'From this slide', icon: Play, onSelect: () => present(deck.cur) },
            { divider: true },
            { label: 'With presenter view', icon: AppWindow, onSelect: () => present(deck.cur, true) },
          ]} />
        </span>
        <Button icon={Users} kind={doc.access === 'org' || doc.shares?.length ? 'default' : 'primary'} onClick={() => setShare(true)}>Share</Button>
        <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label="More" />} items={[
          { label: 'Print or save as PDF', icon: Printer, onSelect: () => printDeck(deck) },
          { label: 'Download as PowerPoint (.pptx)', icon: FileDown, onSelect: exportPptx },
          canEdit && { label: 'Add slides from PowerPoint…', icon: FileUp, onSelect: importPptx },
          { divider: true },
          { label: notes ? 'Hide speaker notes' : 'Show speaker notes', icon: StickyNote, onSelect: () => setNotes(!notes) },
          doc.role === 'owner' && { divider: true },
          doc.role === 'owner' && { label: 'Move to trash', icon: Trash2, danger: true, onSelect: () => { trashDoc(doc); navigate('/docs') } },
        ]} />
      </div>
      {deck && canEdit && <Toolbar deck={deck} tick={tick} onImage={pickImage} />}
      <div class="sl-body">
        {deck && <Strip deck={deck} tick={tick} onMenu={slideMenu} />}
        <div class="sl-main">
          {deck && <Stage deck={deck} tick={tick} onMenu={elementMenu} onImage={pickImage} />}
          {deck && notes && (
            <div class="sl-notes">
              <textarea aria-label="Speaker notes" placeholder="Speaker notes" value={deck.notes()} readOnly={!canEdit} onInput={(e) => deck.setNotes(e.target.value)} />
            </div>
          )}
        </div>
      </div>
      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
      {show !== null && deck && <Show deck={deck} tick={tick} start={show} onExit={() => { setShow(null); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}) }} />}
      {share && <ShareDialog doc={doc} onClose={() => setShare(false)} />}
    </div>
  )
}
