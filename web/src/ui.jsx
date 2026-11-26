// The one component kit every part of the suite draws from.
import { useEffect, useRef, useState } from 'preact/hooks'
import { X } from 'lucide-preact'
import { toasts, photoFor } from './lib/store.js'
import { cx, initials, colorFor } from './lib/util.js'

// A person's picture if they have one (id may be their member id, address
// or chat id; email is for callers that know only the address), otherwise
// their initials on their colour.
export function Avatar({ name, id, email, size = 32 }) {
  const photo = photoFor(id) || photoFor(email)
  return (
    <span class="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: colorFor(id || name) }} aria-hidden="true">
      {initials(name)}
      {photo && <img class="avatar-photo" src={photo} alt="" decoding="async" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
    </span>
  )
}

export function Button({ kind = 'default', icon: Icon, children, class: cls, busy, ...rest }) {
  return (
    <button type="button" class={cx('btn', 'btn-' + kind, cls)} disabled={busy || rest.disabled} {...rest}>
      {Icon && <Icon size={16} />}
      {children}
    </button>
  )
}

export function IconButton({ icon: Icon, label, active, size = 18, class: cls, ...rest }) {
  return (
    <button type="button" class={cx('icon-btn', active && 'on', cls)} title={label} aria-label={label} aria-pressed={active} {...rest}>
      <Icon size={size} />
    </button>
  )
}

// Menu: a button that opens a list of actions. Closes on outside click,
// Escape, or after a choice.
export function Menu({ trigger, items, align = 'left', class: cls }) {
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
    <span class={cx('menu-wrap', cls)} ref={ref}>
      <span onClick={() => setOpen(!open)}>{trigger}</span>
      {open && (
        <div class={cx('menu', 'menu-' + align)} role="menu">
          {items.filter(Boolean).map((it, i) =>
            it.divider ? (
              <div class="menu-sep" key={i} />
            ) : it.heading ? (
              <div class="menu-head" key={i}>{it.heading}</div>
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                class={cx('menu-item', it.danger && 'danger', it.active && 'on')}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false)
                  it.onSelect?.()
                }}
              >
                {it.icon && <it.icon size={16} />}
                <span>{it.label}</span>
                {it.hint && <kbd>{it.hint}</kbd>}
              </button>
            ),
          )}
        </div>
      )}
    </span>
  )
}

// keepFocus goes on a toolbar's mousedown: its buttons act on the text or
// grid without taking the caret away from it, so typing can carry straight
// on. Dropdowns and text fields still take focus as they must.
export const keepFocus = (e) => e.target.closest('select, input') || e.preventDefault()

// Popover: an icon button that opens a small panel (colour pickers).
export function Popover({ icon, label, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef()
  useEffect(() => {
    if (!open) return
    const off = (e) => !ref.current?.contains(e.target) && setOpen(false)
    addEventListener('pointerdown', off, true)
    return () => removeEventListener('pointerdown', off, true)
  }, [open])
  return (
    <span class="menu-wrap" ref={ref}>
      <IconButton icon={icon} label={label} onClick={() => setOpen(!open)} />
      {open && <div class="menu menu-left" onClick={() => setOpen(false)}>{children}</div>}
    </span>
  )
}

export function Swatches({ colors, onPick, clear }) {
  return (
    <div>
      <div class="swatches">{colors.map((c) => <button key={c} class="swatch" style={{ background: c }} aria-label={c} onClick={() => onPick(c)} />)}</div>
      <button class="menu-item" onClick={() => onPick(null)}>{clear}</button>
    </div>
  )
}

export const inkColors = ['#102033', '#617385', '#c8321f', '#c2410c', '#a16207', '#15803d', '#0891b2', '#1269e8', '#4f46e5', '#7c3aed', '#be185d', '#ffffff']
export const markColors = ['#fff3a3', '#ffd6a5', '#ffc9c9', '#d3f9d8', '#c5f6fa', '#d0ebff', '#e5dbff', '#fcc2d7', '#e9ecef', '#b2f2bb', '#a5d8ff', '#ffec99']

export function Modal({ title, onClose, children, footer, width = 460 }) {
  useEffect(() => {
    const key = (e) => e.key === 'Escape' && onClose?.()
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div class="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </header>
        <div class="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

export function Field({ label, hint, error, children }) {
  return (
    <label class="field">
      {label && <span class="field-label">{label}</span>}
      {children}
      {error ? <span class="field-error">{error}</span> : hint ? <span class="field-hint">{hint}</span> : null}
    </label>
  )
}

export function Empty({ icon: Icon, title, text, children }) {
  return (
    <div class="empty">
      {Icon && <Icon size={28} />}
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {children}
    </div>
  )
}

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={cx('toast', 'toast-' + t.kind)}>{t.text}</div>
      ))}
    </div>
  )
}

export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Open Suite" role="img">
      <rect width="64" height="64" rx="14" fill="#ff5a1f" />
      <circle cx="32" cy="32" r="15" fill="none" stroke="#071c2f" stroke-width="8" />
    </svg>
  )
}
