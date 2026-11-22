// Search across the suite. Two faces of the same list: a palette that opens
// over any screen (click, Cmd/Ctrl+K or "/"), and a full page at /search.
// Results come from the sources registered in lib/search.js.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { Search as SearchIcon, Clock, X, ArrowRight, FileText, Table2 } from 'lucide-preact'
import '../lib/search-sources.js'
import './search.css'
import { providers, Session, parse, pieces } from '../lib/search.js'
import { docs, user } from '../lib/store.js'
import { docPath } from '../lib/docs.js'
import { navigate, path, query } from '../lib/router.js'
import { cx, when, debounce } from '../lib/util.js'
import { Avatar, Empty } from '../ui.jsx'

const END = '*end' // the row after every group ("See all results")
const NOQ = parse('')

// Recent searches stay on this device and belong to whoever made them.
const RECENT = 'os:search:recent'
function readRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT)) || {}
  } catch {
    return {}
  }
}
const recentStore = signal(readRecent())
const recent = { get value() { return recentStore.value.user === user.value?.id ? recentStore.value.list || [] : [] } }
function saveRecent(list) {
  recentStore.value = { user: user.value?.id, list }
  try {
    localStorage.setItem(RECENT, JSON.stringify(recentStore.value))
  } catch {}
}
function remember(text) {
  text = text.trim()
  if (text.length >= 2) saveRecent([text, ...recent.value.filter((r) => r.toLowerCase() !== text.toLowerCase())].slice(0, 8))
}
const forget = (text) => saveRecent(recent.value.filter((r) => r !== text))

// activate opens a hit (or runs one of its actions). A click on a link is left
// to the router; the keyboard has no link to follow, so it navigates here.
function activate(hit, e) {
  hit.before?.()
  if (hit.run) {
    e?.preventDefault()
    hit.run()
  } else if (!e) navigate(hit.href)
}

function Marked({ text, q, marked }) {
  return pieces(text, q, marked).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))
}

function Row({ row, q, on, onPick, onPoint }) {
  const { hit } = row
  const Tag = hit.href ? 'a' : 'button'
  const Icon = hit.icon || row.icon || SearchIcon
  return (
    <div class={cx('sr-row', on && 'on')} id={'sr-' + row.n} role="option" aria-selected={on} onPointerMove={() => onPoint(row)}>
      <Tag class="sr-main" href={hit.href} type={hit.href ? undefined : 'button'} tabIndex={-1} onClick={(e) => onPick(hit, e)}>
        {hit.avatar
          ? <Avatar name={hit.avatar.name} id={hit.avatar.id} size={30} />
          : <span class={cx('kind-icon', 'kind-' + (hit.tone || 'plain'))}><Icon size={17} /></span>}
        <span class="sr-text">
          <span class="sr-title ellipsis"><Marked text={hit.title} q={q} /></span>
          {(hit.snippet || hit.sub) && (
            <span class="sr-sub ellipsis">{hit.snippet ? <Marked text={hit.snippet} q={q} marked={hit.marked} /> : hit.sub}</span>
          )}
        </span>
        {hit.when > 0 && <span class="sr-when">{when(hit.when)}</span>}
      </Tag>
      {hit.actions?.map((a) => {
        const A = a.href ? 'a' : 'button'
        return (
          <A key={a.label} class="icon-btn" href={a.href} type={a.href ? undefined : 'button'} tabIndex={-1} title={a.label} aria-label={a.label} onClick={(e) => onPick(a, e)}>
            <a.icon size={16} />
          </A>
        )
      })}
    </div>
  )
}

// useList gives a set of groups one selection that the keyboard and the
// pointer share. Until someone moves, the first row is the selection and
// nothing is anchored, so better results may still arrive above it.
function useList(groups, text, session, last) {
  const [sel, setSel] = useState({ text, key: null }) // a selection belongs to the text it was made in
  const listRef = useRef()

  const rows = []
  for (const g of groups) for (const hit of g.hits) rows.push({ key: g.id + ':' + hit.id, group: g.id, icon: g.icon, hit, n: rows.length })
  if (last) rows.push({ key: END, group: END, hit: last, n: rows.length })
  const active = (sel.text === text && rows.find((r) => r.key === sel.key)) || rows[0]

  const choose = (row) => {
    setSel({ text, key: row.key })
    session?.anchor(row.group)
  }
  const move = (by) => {
    if (!rows.length) return
    const at = active ? active.n : -1
    const next = rows[Math.max(0, Math.min(rows.length - 1, at + by))]
    choose(next)
    requestAnimationFrame(() => listRef.current?.querySelector('#sr-' + next.n)?.scrollIntoView({ block: 'nearest' }))
  }
  const point = (row) => row.key !== active?.key && choose(row)
  return { rows, active, move, point, listRef }
}

function Groups({ groups, list, q, onPick }) {
  let n = 0
  return groups.filter((g) => g.hits.length).map((g) => (
    <section key={g.id} class="sr-group" aria-label={g.label}>
      <h4>{g.label}{g.more}</h4>
      {g.hits.map((hit) => {
        const row = list.rows[n++]
        return <Row key={row.key} row={row} q={q} on={row === list.active} onPick={onPick} onPoint={list.point} />
      })}
    </section>
  ))
}

// What the palette offers before anything is typed: earlier searches and the
// documents touched most recently.
function idleGroups(setText) {
  const groups = []
  if (recent.value.length) {
    groups.push({
      id: 'recent', label: 'Recent searches', icon: Clock,
      hits: recent.value.slice(0, 5).map((r) => ({
        id: r, title: r, keep: true, run: () => setText(r),
        actions: [{ icon: X, label: 'Remove from recent searches', keep: true, run: () => forget(r) }],
      })),
    })
  }
  const latest = docs.value.filter((d) => !d.trashed).slice(0, 5)
  if (latest.length) {
    groups.push({
      id: 'latest', label: 'Recently edited',
      hits: latest.map((d) => ({ id: d.id, title: d.title || 'Untitled', href: docPath(d), icon: d.kind === 'sheet' ? Table2 : FileText, tone: d.kind, when: d.updated * 1000 })),
    })
  }
  return groups
}

// --- the palette ----------------------------------------------------------------

export const searchOpen = signal(false)
let cameFrom = null

export function openSearch() {
  if (searchOpen.value) return
  // On the search page its own field is the search box.
  const page = document.querySelector('.search-page .search-input')
  if (page) return page.focus()
  cameFrom = document.activeElement
  searchOpen.value = true
}

function closeSearch(restore) {
  searchOpen.value = false
  if (restore) cameFrom?.focus?.()
  cameFrom = null
}

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

addEventListener('keydown', (e) => {
  const k = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k'
  const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented && !typing(e.target)
  if (!k && !slash) return
  if (!document.querySelector('.rail')) return // signed out, or in a call
  e.preventDefault()
  if (k && searchOpen.value) closeSearch(true)
  else openSearch()
})

// The button in the navigation rail.
export function SearchButton({ on }) {
  return (
    <button type="button" class={cx('rail-link', (on || searchOpen.value) && 'on')} onClick={openSearch} aria-label="Search" aria-keyshortcuts="Meta+K Control+K" title="Search (⌘K or /)">
      <SearchIcon size={20} strokeWidth={1.9} />
      Search
    </button>
  )
}

const palette = new Session({ perGroup: 5, remoteLimit: 8 })

export function SearchPalette() {
  if (!searchOpen.value) return null
  return <Palette />
}

function Palette() {
  const [text, setTextState] = useState('')
  const input = useRef()
  const v = palette.view.value
  const setText = (t) => {
    setTextState(t)
    palette.set(t)
    input.current?.focus()
  }
  useLayoutEffect(() => {
    input.current.focus()
    return () => palette.set('')
  }, [])

  const searching = v.q.terms.length > 0
  const groups = searching ? v.groups : idleGroups(setText)
  const found = groups.some((g) => g.hits.length)
  const all = searching && found ? { id: 'all', href: '/search?q=' + encodeURIComponent(text.trim()) } : null
  const list = useList(groups, text, searching ? palette : null, all)

  const pick = (hit, e) => {
    activate(hit, e)
    if (hit.keep) return
    if (searching) remember(text)
    closeSearch(false)
  }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); list.move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list.move(-1) }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (list.active) pick(list.active.hit) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(true) }
  }

  return (
    <div class="search-back" onPointerDown={(e) => e.target === e.currentTarget && closeSearch(true)}>
      <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search">
        <div class="search-field">
          <SearchIcon size={18} />
          <input
            ref={input} class="search-input" type="text" placeholder="Search Open Suite" value={text}
            role="combobox" aria-expanded="true" aria-controls="search-results" aria-activedescendant={list.active ? 'sr-' + list.active.n : undefined}
            autocomplete="off" autocapitalize="none" spellcheck={false} enterkeyhint="search"
            onInput={(e) => setText(e.target.value)} onKeyDown={onKey}
          />
          <button type="button" class="search-esc" onClick={() => closeSearch(true)} aria-label="Close search"><span>esc</span><span>Close</span></button>
        </div>
        <div class="search-list" id="search-results" role="listbox" data-q={v.text} data-busy={v.busy ? '1' : undefined} ref={list.listRef} onPointerLeave={() => palette.anchor(list.active && list.active.key !== list.rows[0]?.key ? list.active.group : null)}>
          <Groups groups={groups} list={list} q={searching ? v.q : NOQ} onPick={pick} />
          {searching && !found && !v.busy && <div class="search-none">Nothing found for “{text.trim()}”.</div>}
          {!searching && !found && <div class="search-none">Find people, documents, spreadsheets, mail, chat messages and meetings.</div>}
          {all && (
            <div class={cx('sr-row sr-all', list.active?.key === END && 'on')} id={'sr-' + (list.rows.length - 1)} role="option" aria-selected={list.active?.key === END} onPointerMove={() => list.point(list.rows[list.rows.length - 1])}>
              <a class="sr-main" href={all.href} tabIndex={-1} onClick={(e) => pick(all, e)}>
                <span class="kind-icon kind-plain"><ArrowRight size={17} /></span>
                <span class="sr-text"><span class="sr-title ellipsis">See all results for “{text.trim()}”</span></span>
              </a>
            </div>
          )}
        </div>
        <div class="search-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
          <span><kbd>↵</kbd> to open</span>
          <span><kbd>esc</kbd> to close</span>
        </div>
      </div>
    </div>
  )
}

// --- the full page ----------------------------------------------------------------

const syncUrl = debounce((text, only) => {
  if (path.value !== '/search') return
  const p = new URLSearchParams()
  if (text.trim()) p.set('q', text.trim())
  if (only) p.set('in', only)
  const s = p.toString()
  navigate('/search' + (s ? '?' + s : ''), { replace: true })
}, 300)

export function SearchPage() {
  const params = new URLSearchParams(query.value)
  const urlText = params.get('q') || ''
  const only = providers.some((p) => p.id === params.get('in')) ? params.get('in') : null
  const [text, setTextState] = useState(urlText)
  const current = useRef(urlText)
  const input = useRef()
  // The session answers in the same render that creates it, so switching the
  // kind filter never shows an empty frame first.
  const session = useMemo(() => {
    const s = new Session(only ? { only, perGroup: 50, remoteLimit: 50 } : { perGroup: 8, remoteLimit: 12 })
    s.set(current.current, { now: true })
    return s
  }, [only])
  useEffect(() => () => session.close(), [session])
  // The address changed from outside (the palette's "see all", back, forward).
  useEffect(() => {
    if (urlText === current.current.trim()) return
    current.current = urlText
    setTextState(urlText)
    session.set(urlText, { now: true })
  }, [urlText])
  useLayoutEffect(() => input.current.focus(), [])

  const setText = (t) => {
    current.current = t
    setTextState(t)
    session.set(t)
    syncUrl(t, only)
  }
  const v = session.view.value
  const searching = v.q.terms.length > 0
  const link = (id) => '/search?q=' + encodeURIComponent(text.trim()) + (id ? '&in=' + id : '')
  const groups = v.groups.map((g) => ({
    ...g,
    more: !only && g.total > g.hits.length && <a href={link(g.id)}>Show all</a>,
  }))
  const list = useList(groups, text, session, null)
  const found = groups.some((g) => g.hits.length)

  const pick = (hit, e) => {
    activate(hit, e)
    if (!hit.keep) remember(text)
  }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); list.move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list.move(-1) }
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (list.active) pick(list.active.hit) }
  }

  return (
    <div class="page search-page">
      <div class="page-inner">
        <div class="search-field search-field-page">
          <SearchIcon size={20} />
          <input
            ref={input} class="search-input" type="text" placeholder="Search Open Suite" value={text} aria-label="Search"
            role="combobox" aria-expanded="true" aria-controls="search-page-results" aria-activedescendant={list.active ? 'sr-' + list.active.n : undefined}
            autocomplete="off" autocapitalize="none" spellcheck={false} enterkeyhint="search"
            onInput={(e) => setText(e.target.value)} onKeyDown={onKey}
          />
          {text && <button type="button" class="icon-btn" aria-label="Clear" title="Clear" onClick={() => { setText(''); input.current.focus() }}><X size={18} /></button>}
        </div>
        <div class="tabs" role="tablist">
          <a class={cx('tab', !only && 'on')} href={link(null)} role="tab" aria-selected={!only}>All</a>
          {providers.map((p) => (
            <a key={p.id} class={cx('tab', only === p.id && 'on')} href={link(p.id)} role="tab" aria-selected={only === p.id}>{p.label}</a>
          ))}
        </div>
        <div class="search-results card" id="search-page-results" role="listbox" data-q={v.text} data-busy={v.busy ? '1' : undefined} ref={list.listRef} onPointerLeave={() => session.anchor(list.active && list.active.key !== list.rows[0]?.key ? list.active.group : null)}>
          <Groups groups={groups} list={list} q={v.q} onPick={pick} />
          {searching && !found && !v.busy && <Empty icon={SearchIcon} title={`Nothing found for “${text.trim()}”`} text={only ? 'Try all of Open Suite, or different words.' : 'Try different words.'} />}
          {!searching && (
            recent.value.length
              ? <section class="sr-group"><h4>Recent searches</h4>
                {recent.value.map((r) => (
                  <div class="sr-row" key={r}>
                    <button type="button" class="sr-main" onClick={() => { setText(r); input.current.focus() }}>
                      <span class="kind-icon kind-plain"><Clock size={17} /></span>
                      <span class="sr-text"><span class="sr-title ellipsis">{r}</span></span>
                    </button>
                    <button type="button" class="icon-btn" title="Remove from recent searches" aria-label="Remove from recent searches" onClick={() => forget(r)}><X size={16} /></button>
                  </div>
                ))}
              </section>
              : <Empty icon={SearchIcon} title="Search Open Suite" text="Find people, documents, spreadsheets, mail, chat messages and meetings." />
          )}
        </div>
      </div>
    </div>
  )
}
