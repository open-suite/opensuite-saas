// The editors' menu bar: File, Edit, View, Insert, Format, Data, Tools, Help.
//
// Usage (spreadsheet, presentation and document editors):
//
//   import { MenuBar, keys } from '../menubar.jsx'
//
//   <MenuBar menus={[
//     { label: 'File', items: [
//       { label: 'Version history', icon: History, hint: keys('Mod+Alt+Shift+H'), onSelect: openHistory },
//       { divider: true },
//       { label: 'Download', items: [            // a submenu
//         { label: 'Excel (.xlsx)', onSelect: exportXlsx },
//       ] },
//     ] },
//     { label: 'View', items: [
//       { label: 'Show gridlines', checked: grid, onSelect: toggleGrid },  // a tick when checked
//     ] },
//   ]} />
//
// The bar sits under the title, in the editor's doc-bar:
//
//   <div class="doc-bar with-menus">
//     <IconButton icon={ArrowLeft} … />
//     <div class="doc-head">
//       <div class="doc-head-top"><input class="doc-title" … /><span class="save-state">…</span></div>
//       <MenuBar menus={…} />
//     </div>
//     <span class="grow" /> …presence, Share…
//   </div>
//
// An item is { label, icon?, hint?, onSelect?, disabled?, checked?, danger?,
// items? } or { divider: true } or { heading }. Falsy entries are skipped, so
// `canEdit && {...}` works. `hint` is the shortcut shown on the right; build it
// with keys('Mod+B'), which reads ⌘B on a Mac and Ctrl+B elsewhere. The bar
// does not bind shortcuts itself; the editor already handles its keys.
//
// The bar never takes focus from the document or grid: clicks keep the caret
// where it is (keepFocus), and while a menu is open the arrow keys, Enter and
// Escape are caught before the editor sees them. Help > Search the menus, or
// Alt+/ anywhere in the editor, finds any item by name.
import { useEffect, useRef, useState } from 'preact/hooks'
import { Check, ChevronRight, Search } from 'lucide-preact'
import { cx } from './lib/util.js'
import { keepFocus } from './ui.jsx'

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

// keys('Mod+Shift+V') -> '⌘⇧V' on a Mac, 'Ctrl+Shift+V' elsewhere.
export function keys(combo) {
  const parts = combo.split('+')
  if (mac) return parts.map((p) => ({ Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' }[p] || p)).join('')
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p)).join('+')
}

const live = (items) => (items || []).filter(Boolean)
const actionable = (it) => it && !it.divider && !it.heading && !it.disabled

// Every item that does something, with the path to it, for the search box.
function flatten(menus) {
  const out = []
  const walk = (items, path) => {
    for (const it of live(items)) {
      if (it.divider || it.heading) continue
      if (it.items) walk(it.items, [...path, it.label])
      else if (it.onSelect) out.push({ ...it, path })
    }
  }
  for (const m of menus) walk(m.items, [m.label])
  return out
}

function Item({ it, hot, onHover, onPick, sub, openSub }) {
  if (it.divider) return <div class="menu-sep" />
  if (it.heading) return <div class="menu-head">{it.heading}</div>
  const Icon = it.icon
  return (
    <div class="mb-item-wrap">
      <button type="button" role="menuitem" aria-haspopup={it.items ? 'menu' : undefined} aria-checked={it.checked === undefined ? undefined : !!it.checked}
        class={cx('menu-item', it.danger && 'danger', hot && 'hot')} disabled={it.disabled}
        onMouseEnter={onHover} onClick={() => (it.items ? openSub() : onPick(it))}>
        <span class="mb-icon">{it.checked ? <Check size={15} /> : Icon ? <Icon size={16} /> : null}</span>
        <span class="mb-label">{it.label}</span>
        {it.hint && <kbd>{it.hint}</kbd>}
        {it.items && <ChevronRight class="mb-more" size={15} />}
      </button>
      {sub}
    </div>
  )
}

function List({ items, path, hot, setHot, onPick, depth }) {
  const list = live(items)
  const at = hot[depth]
  const open = at !== undefined && list[at]?.items && hot.length > depth + 1
  return (
    <div class={cx('menu', depth ? 'mb-sub' : 'mb-drop')} role="menu" aria-label={path.join(' › ')}>
      {list.map((it, i) => (
        <Item key={i} it={it} hot={at === i}
          onHover={() => setHot([...hot.slice(0, depth), i, ...(it.items && !it.disabled ? [-1] : [])])}
          openSub={() => setHot([...hot.slice(0, depth), i, firstFrom(it.items, 0, 1)])}
          onPick={onPick}
          sub={open && at === i && <List items={it.items} path={[...path, it.label]} hot={hot} setHot={setHot} onPick={onPick} depth={depth + 1} />} />
      ))}
    </div>
  )
}

// The next item that can be chosen, from position i in direction d.
function firstFrom(items, i, d) {
  const list = live(items)
  for (let n = 0; n < list.length; n++) {
    const j = (i + d * n + list.length * 4) % list.length
    if (actionable(list[j])) return j
  }
  return -1
}

function SearchBox({ menus, onPick, onClose }) {
  const [q, setQ] = useState('')
  const [hot, setHot] = useState(0)
  const input = useRef()
  useEffect(() => input.current?.focus(), [])
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const found = words.length ? flatten(menus).filter((it) => it.label !== 'Search the menus').filter((it) => {
    const text = [...it.path, it.label].join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  }).slice(0, 12) : []
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHot(Math.min(found.length - 1, hot + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHot(Math.max(0, hot - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const it = found[hot]; if (it && !it.disabled) onPick(it) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
  return (
    <div class="menu mb-drop mb-search" role="dialog" aria-label="Search the menus">
      <label class="mb-search-box">
        <Search size={15} />
        <input ref={input} aria-label="Search the menus" placeholder="Search the menus" value={q}
          onInput={(e) => { setQ(e.target.value); setHot(0) }} onKeyDown={key} />
        <kbd>{keys('Alt+/')}</kbd>
      </label>
      {found.map((it, i) => {
        const Icon = it.icon
        return (
          <button key={i} type="button" role="menuitem" class={cx('menu-item', i === hot && 'hot')} disabled={it.disabled}
            onMouseEnter={() => setHot(i)} onClick={() => onPick(it)}>
            <span class="mb-icon">{Icon ? <Icon size={16} /> : null}</span>
            <span class="mb-label">{it.label}<span class="mb-path">{it.path.join(' › ')}</span></span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        )
      })}
      {words.length > 0 && !found.length && <div class="mb-none">Nothing matches “{q}”.</div>}
    </div>
  )
}

export function MenuBar({ menus: given, class: cls }) {
  const withHelp = given.some((m) => m.label === 'Help') ? given : [...given, { label: 'Help', items: [] }]
  // Help always starts with the search box.
  const menus = withHelp.map((m) => (m.label !== 'Help' ? m : {
    ...m,
    items: [{ label: 'Search the menus', icon: Search, hint: keys('Alt+/'), onSelect: () => showSearch() }, live(m.items).length > 0 && { divider: true }, ...live(m.items)],
  }))
  const [open, setOpen] = useState(-1) // which top-level menu
  const [hot, setHot] = useState([]) // highlighted index at each depth
  const [search, setSearch] = useState(false)
  const ref = useRef()
  const back = useRef(null) // what had focus before the search box took it

  const close = () => {
    setOpen(-1)
    setHot([])
    if (search) {
      setSearch(false)
      back.current?.focus?.()
    }
  }
  const pick = (it) => {
    close()
    it.onSelect?.()
  }
  const showSearch = () => {
    back.current = document.activeElement
    setOpen(menus.length - 1)
    setHot([])
    setSearch(true)
  }

  // Alt+/ opens the search box from anywhere in the editor.
  useEffect(() => {
    const k = (e) => {
      if (e.altKey && (e.key === '/' || e.code === 'Slash') && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        showSearch()
      }
    }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  })

  // While a menu is open its keys come first, before the editor's.
  useEffect(() => {
    if (open < 0) return
    const off = (e) => !ref.current?.contains(e.target) && close()
    const key = (e) => {
      if (search) return // the search box handles its own keys
      const items = (depth) => {
        let list = live(menus[open].items)
        for (let d = 0; d < depth; d++) list = live(list[hot[d]]?.items)
        return list
      }
      const depth = Math.max(0, hot.length - 1)
      const here = items(depth)
      const at = hot[depth] ?? -1
      const take = () => { e.preventDefault(); e.stopPropagation() }
      if (e.key === 'Escape') { take(); return hot.length > 1 ? setHot(hot.slice(0, -1)) : close() }
      if (e.key === 'ArrowDown') { take(); return setHot([...hot.slice(0, depth), firstFrom(here, at + 1, 1)]) }
      if (e.key === 'ArrowUp') { take(); return setHot([...hot.slice(0, depth), firstFrom(here, at < 0 ? here.length - 1 : at - 1, -1)]) }
      if (e.key === 'ArrowRight') {
        take()
        const it = here[at]
        if (it?.items && !it.disabled) return setHot([...hot.slice(0, depth + 1), firstFrom(it.items, 0, 1)])
        const next = (open + 1) % menus.length
        setOpen(next)
        return setHot([firstFrom(menus[next].items, 0, 1)])
      }
      if (e.key === 'ArrowLeft') {
        take()
        if (depth > 0) return setHot(hot.slice(0, depth))
        const prev = (open - 1 + menus.length) % menus.length
        setOpen(prev)
        return setHot([firstFrom(menus[prev].items, 0, 1)])
      }
      if (e.key === 'Enter' || e.key === ' ') {
        take()
        const it = here[at]
        if (!actionable(it)) return
        if (it.items) return setHot([...hot.slice(0, depth + 1), firstFrom(it.items, 0, 1)])
        return pick(it)
      }
      if (e.key === 'Tab') { take(); return close() }
      // Any other key closes the menu and goes on to the editor as usual.
      if (!e.metaKey && !e.ctrlKey && e.key.length === 1) close()
    }
    addEventListener('pointerdown', off, true)
    addEventListener('keydown', key, true)
    return () => {
      removeEventListener('pointerdown', off, true)
      removeEventListener('keydown', key, true)
    }
  }, [open, hot, search, menus])

  return (
    <div class={cx('menubar', cls)} role="menubar" ref={ref} onMouseDown={keepFocus}>
      {menus.map((m, i) => {
        const isHelp = m.label === 'Help'
        return (
          <span key={m.label} class="mb-top">
            <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open === i} class={cx('mb-btn', open === i && 'on')}
              onClick={() => { if (open === i) close(); else { setSearch(false); setOpen(i); setHot([]) } }}
              onMouseEnter={() => open >= 0 && open !== i && !search && (setOpen(i), setHot([]))}>
              {m.label}
            </button>
            {open === i && (search && isHelp
              ? <SearchBox menus={menus} onPick={pick} onClose={close} />
              : <List items={m.items} path={[m.label]} hot={hot} setHot={setHot} onPick={pick} depth={0} />)}
          </span>
        )
      })}
    </div>
  )
}
