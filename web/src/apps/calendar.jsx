// The calendar screen: month, week, day and agenda over the events held on
// the device. Nothing here waits on the network to draw.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { ChevronLeft, ChevronRight, Plus, MoreHorizontal, CalendarDays, Bell, Video, Repeat as RepeatIcon } from 'lucide-preact'
import './calendar.css'
import { toast } from '../lib/store.js'
import { query, navigate } from '../lib/router.js'
import { cx } from '../lib/util.js'
import { Button, Empty, Field, IconButton, Menu, Modal } from '../ui.jsx'
import {
  calendars, events, calReady, COLORS, colorOf, occurrences, visible, blankEvent, changeOccurrence, isOrganizer, saveCalendar, deleteCalendar,
  myPart, meetingLink, placeOf,
} from '../lib/calendar.js'
import {
  DAY, MIN, localZone, addDays, addMonths, startOfDay, startOfWeek, startOfMonth, sameDay, hhmm, monthTitle, weekdayName, dayLong,
  wallIn, formatWall, formatDuration,
} from '../lib/time.js'
import { card, quick, draft, closeAll, scoped, join, EventCard, QuickCreate, EventEditor, ScopeDialog } from './calendar-event.jsx'

const HOUR = 48 // pixels per hour in the time grid
const SNAP = 15 * MIN
const narrow = () => innerWidth <= 760

let savedView = null
try {
  savedView = localStorage.getItem('os:cal-view')
} catch {}
const view = signal(['month', 'week', 'day', 'agenda'].includes(savedView) ? savedView : narrow() ? 'day' : 'week')
const cursor = signal(startOfDay(Date.now()))
const agendaDays = signal(45)
const editingCal = signal(null) // a calendar being named or coloured

function setView(v) {
  view.value = v
  closeAll()
  try {
    localStorage.setItem('os:cal-view', v)
  } catch {}
}

const weekSpan = () => (narrow() ? 3 : 7)
function range() {
  const c = cursor.value
  if (view.value === 'day') return [c, addDays(c, 1)]
  if (view.value === 'week') {
    const from = narrow() ? c : startOfWeek(c)
    return [from, addDays(from, weekSpan())]
  }
  if (view.value === 'month') {
    const from = startOfWeek(startOfMonth(c))
    return [from, addDays(from, 42)]
  }
  return [c, addDays(c, agendaDays.value)]
}

function step(dir) {
  const c = cursor.value
  closeAll()
  if (view.value === 'day') cursor.value = addDays(c, dir)
  else if (view.value === 'week') cursor.value = addDays(c, dir * weekSpan())
  else if (view.value === 'month') cursor.value = startOfDay(addMonths(c, dir))
  else cursor.value = addDays(c, dir * 30)
}

function title() {
  const [from, to] = range()
  if (view.value === 'day') return new Date(from).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  if (view.value === 'month') return monthTitle(cursor.value)
  const last = addDays(to, -1)
  const a = new Date(from)
  const b = new Date(last)
  if (a.getMonth() === b.getMonth()) return monthTitle(from)
  const short = (d, year) => d.toLocaleDateString(undefined, { month: 'short', ...(year ? { year: 'numeric' } : {}) })
  return `${short(a, a.getFullYear() !== b.getFullYear())} – ${short(b, true)}`
}

// newAt opens the small form for a new event at a time the person pointed at.
function newAt(start, end, allDay, x, y) {
  card.value = null
  quick.value = { ev: blankEvent(start, end, allDay), x, y }
}

function newEvent() {
  closeAll()
  const now = Date.now()
  const day = view.value === 'agenda' || sameDay(cursor.value, now) ? startOfDay(now) : cursor.value
  const start = sameDay(day, now) ? Math.ceil((now + 5 * MIN) / (30 * MIN)) * 30 * MIN : day + 9 * 3600000
  draft.value = { ev: blankEvent(start, start + 3600000, false), prev: null, scope: 'all' }
}

const openCard = (occ, e) => {
  quick.value = null
  const r = e.currentTarget?.getBoundingClientRect?.()
  card.value = { occ, x: r ? Math.min(r.right, e.clientX + 40) : e.clientX, y: r ? r.top + 24 : e.clientY }
}

// moveTo puts an occurrence at a new start (and optionally a new length).
function moveTo(occ, start, end) {
  const allDay = occ.allDay
  const tz = allDay ? localZone : occ.inst.timeZone || localZone
  const changes = {}
  if (start !== occ.start) changes.start = formatWall(wallIn(start, tz))
  if (end - start !== occ.end - occ.start) changes.duration = allDay ? `P${Math.max(1, Math.round((end - start) / DAY))}D` : formatDuration(end - start)
  if (!Object.keys(changes).length) return
  scoped(occ, 'Move repeating event', (scope) => changeOccurrence(occ, changes, scope))
}

const pending = (o) => myPart(o.inst)?.status === 'needs-action'
const declined = (o) => myPart(o.inst)?.status === 'declined'

// --- shared layout -----------------------------------------------------------

// lanes places bars that span days (all-day and multi-day events) in rows so
// that none overlap. Each item gets { lane, from, to } in day columns.
function lanes(list, days) {
  const first = days[0]
  const n = days.length
  const out = []
  const ends = []
  for (const o of list) {
    const from = Math.max(0, Math.round((startOfDay(o.start) - first) / DAY))
    const lastDay = o.end > o.start ? startOfDay(o.end - 1) : startOfDay(o.start)
    const to = Math.min(n - 1, Math.round((lastDay - first) / DAY))
    if (to < 0 || from > n - 1) continue
    let lane = ends.findIndex((e) => e < from)
    if (lane < 0) lane = ends.length
    ends[lane] = to
    out.push({ o, lane, from, to, before: startOfDay(o.start) < first, after: lastDay > days[n - 1] })
  }
  return out
}

const spansDays = (o) => o.allDay || o.end - o.start >= DAY

// --- week and day ---------------------------------------------------------------

function columns(items) {
  // Events that overlap share the width of their day.
  items.sort((a, b) => a.s - b.s || b.e - a.e)
  let cluster = []
  let clusterEnd = -Infinity
  const cols = []
  const close = () => {
    const n = Math.max(1, ...cluster.map((i) => i.col + 1))
    for (const i of cluster) i.cols = n
  }
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) {
      close()
      cluster = []
      cols.length = 0
    }
    let c = cols.findIndex((end) => end <= it.s)
    if (c < 0) c = cols.length
    cols[c] = it.e
    it.col = c
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd, it.e)
  }
  if (cluster.length) close()
  return items
}

function TimeGrid({ days, occs }) {
  const scroll = useRef()
  const colsRef = useRef()
  const drag = useRef(null)
  const [ghost, setGhost] = useState(null) // { day, from, to } in minutes, while dragging
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])
  // Open on the working day rather than at midnight.
  useLayoutEffect(() => {
    const today = days.find((d) => sameDay(d, Date.now()))
    const hour = today ? Math.max(0, new Date().getHours() - 2) : 7
    scroll.current.scrollTop = Math.min(hour, 7.5) * HOUR
  }, [])

  const bars = lanes(occs.filter(spansDays), days)
  const barRows = Math.max(1, ...bars.map((b) => b.lane + 1))
  const perDay = days.map((day) =>
    columns(occs.filter((o) => !spansDays(o) && o.start < day + DAY && (o.end > day || (o.end === o.start && o.start >= day))).map((o) => ({ o, s: Math.max(o.start, day), e: Math.max(Math.min(o.end, day + DAY), Math.max(o.start, day) + 20 * MIN) }))),
  )

  const at = (e) => {
    const r = colsRef.current.getBoundingClientRect()
    const day = Math.max(0, Math.min(days.length - 1, Math.floor(((e.clientX - r.left) / r.width) * days.length)))
    const min = Math.max(0, Math.min(1440, ((e.clientY - r.top) / HOUR) * 60))
    return { day, min }
  }
  const snap = (min) => Math.round(min / 15) * 15

  const down = (e) => {
    if (e.button !== 0 || e.target.closest('.cal-float')) return
    const p = at(e)
    const el = e.target.closest('.tg-ev')
    const occ = el && occs.find((o) => o.key === el.dataset.key)
    if (occ) {
      const mode = e.target.closest('.grip') ? 'resize' : 'move'
      const startMin = (occ.start - startOfDay(occ.start)) / MIN
      drag.current = { mode, occ, x: e.clientX, y: e.clientY, grab: p.min - startMin, len: (occ.end - occ.start) / MIN, moved: false, can: isOrganizer(occ.ev), ev: e }
    } else {
      closeAll()
      drag.current = { mode: 'new', day: p.day, from: Math.min(1380, Math.floor(p.min / 15) * 15), x: e.clientX, y: e.clientY, moved: false }
    }
    colsRef.current.setPointerCapture(e.pointerId)
  }
  const move = (e) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return
    d.moved = true
    const p = at(e)
    if (d.mode === 'new') {
      const to = snap(p.min)
      setGhost({ day: d.day, from: Math.min(d.from, to), to: Math.max(d.from + 15, to), fresh: true })
    } else if (!d.can) {
      return
    } else if (d.mode === 'move') {
      const from = Math.max(0, Math.min(1440 - 15, snap(p.min - d.grab)))
      setGhost({ day: p.day, from, to: from + d.len, occ: d.occ })
    } else {
      const startDay = days.findIndex((x) => sameDay(x, d.occ.start))
      const from = (d.occ.start - startOfDay(d.occ.start)) / MIN
      setGhost({ day: startDay < 0 ? p.day : startDay, from, to: Math.max(from + 15, snap(p.min)), occ: d.occ })
    }
  }
  const up = (e) => {
    const d = drag.current
    drag.current = null
    const g = ghost
    setGhost(null)
    if (!d) return
    if (d.mode === 'new') {
      const from = d.moved && g ? g.from : d.from
      const to = d.moved && g ? g.to : d.from + 60
      const start = days[d.day] + from * MIN
      newAt(start, start + (to - from) * MIN, false, e.clientX, e.clientY)
    } else if (!d.moved) {
      const el = colsRef.current.querySelector(`[data-key="${CSS.escape(d.occ.key)}"]`)
      openCard(d.occ, { currentTarget: el, clientX: e.clientX, clientY: e.clientY })
    } else if (!d.can) {
      toast('Only the organiser can move this event.')
    } else if (g) {
      const start = days[g.day] + g.from * MIN
      moveTo(d.occ, start, start + (g.to - g.from) * MIN)
    }
  }

  const nowDay = days.findIndex((d) => sameDay(d, now))
  const nowTop = ((now - startOfDay(now)) / 3600000) * HOUR
  return (
    <div class="tg" style={{ '--days': String(days.length) }}>
      <div class="tg-head">
        <div class="tg-gutter" />
        {days.map((d) => (
          <button class={cx('tg-day', sameDay(d, now) && 'today')} key={d} onClick={() => { cursor.value = d; setView('day') }}>
            <span class="wd">{weekdayName(d)}</span><span class="num">{new Date(d).getDate()}</span>
          </button>
        ))}
      </div>
      <div class="tg-allday" style={{ height: barRows * 24 + 6 }}>
        <div class="tg-gutter muted">All day</div>
        <div class="tg-bars">
          {days.map((d, i) => <button key={d} class="tg-slot" aria-label={'New all-day event, ' + dayLong(d)} style={{ gridColumn: i + 1 }} onClick={(e) => newAt(d, d + DAY, true, e.clientX, e.clientY)} />)}
          {bars.map((b) => (
            <button key={b.o.key} class={cx('bar', pending(b.o) && 'pending', declined(b.o) && 'declined', b.before && 'cut-l', b.after && 'cut-r')}
              style={{ gridColumn: `${b.from + 1} / ${b.to + 2}`, top: b.lane * 24 + 3, '--c': b.o.color }} onClick={(e) => openCard(b.o, e)}>
              {!b.o.allDay && <span class="t">{hhmm(b.o.start)}</span>}<span class="ellipsis">{b.o.title}</span>
            </button>
          ))}
        </div>
      </div>
      <div class="tg-scroll" ref={scroll}>
        <div class="tg-body" style={{ height: 24 * HOUR }}>
          <div class="tg-gutter">
            {Array.from({ length: 23 }, (_, h) => <span key={h} style={{ top: (h + 1) * HOUR }}>{hhmm(new Date(2020, 0, 1, h + 1).getTime())}</span>)}
          </div>
          <div class="tg-cols" ref={colsRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; setGhost(null) }}>
            {days.map((day, i) => (
              <div class={cx('tg-col', sameDay(day, now) && 'today')} key={day}>
                {perDay[i].map(({ o, s, e, col, cols }) => {
                  const hide = ghost?.occ?.key === o.key
                  const short = e - s <= 30 * MIN
                  return (
                    <div key={o.key} data-key={o.key} role="button" tabIndex={0} aria-label={`${o.title}, ${hhmm(o.start)}`}
                      class={cx('tg-ev', short && 'short', pending(o) && 'pending', declined(o) && 'declined', hide && 'lifting', o.end < now && 'past')}
                      style={{ top: ((s - day) / 3600000) * HOUR, height: Math.max(18, ((e - s) / 3600000) * HOUR - 2), left: `calc(${(col / cols) * 100}% + 1px)`, width: `calc(${100 / cols}% - 3px)`, '--c': o.color }}
                      onKeyDown={(ev) => ev.key === 'Enter' && openCard(o, { currentTarget: ev.currentTarget, clientX: 0, clientY: 0 })}>
                      <div class="ttl ellipsis">{o.title}</div>
                      <div class="sub ellipsis">{short ? hhmm(o.start) : `${hhmm(o.start)} – ${hhmm(o.end)}`}{!short && placeOf(o.inst) && ' · ' + placeOf(o.inst)}</div>
                      {!short && (o.rid || meetingLink(o.inst)) && <span class="marks">{meetingLink(o.inst) && <Video size={11} />}{o.rid && <RepeatIcon size={11} />}</span>}
                      {isOrganizer(o.ev) && <span class="grip" />}
                    </div>
                  )
                })}
                {ghost && ghost.day === i && (
                  <div class={cx('tg-ev ghost', ghost.fresh && 'fresh')} style={{ top: (ghost.from / 60) * HOUR, height: Math.max(12, ((ghost.to - ghost.from) / 60) * HOUR - 2), left: 1, right: 3, '--c': ghost.occ?.color || 'var(--accent)' }}>
                    <div class="ttl ellipsis">{ghost.occ?.title || 'New event'}</div>
                    <div class="sub">{hhmm(day + ghost.from * MIN)} – {hhmm(day + ghost.to * MIN)}</div>
                  </div>
                )}
                {nowDay === i && <div class="now" style={{ top: nowTop }} />}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- month --------------------------------------------------------------------

function Month({ from, occs }) {
  const grid = useRef()
  const [rows, setRows] = useState(4)
  const [drop, setDrop] = useState(null)
  const drag = useRef(null)
  useLayoutEffect(() => {
    const fit = () => {
      const h = grid.current?.querySelector('.mo-week')?.clientHeight || 120
      setRows(Math.max(1, Math.floor((h - 30) / 22)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(grid.current)
    return () => ro.disconnect()
  }, [])
  const month = new Date(cursor.value).getMonth()
  const now = Date.now()
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(from, w * 7 + d)))

  const dayAt = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-day]')
    return el ? +el.dataset.day : null
  }
  const down = (e, o) => {
    if (e.button !== 0) return
    drag.current = { o, x: e.clientX, y: e.clientY, moved: false, el: e.currentTarget }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return
    d.moved = true
    if (isOrganizer(d.o.ev)) setDrop(dayAt(e))
  }
  const up = (e) => {
    const d = drag.current
    drag.current = null
    setDrop(null)
    if (!d) return
    if (!d.moved) return openCard(d.o, { currentTarget: d.el, clientX: e.clientX, clientY: e.clientY })
    if (!isOrganizer(d.o.ev)) return toast('Only the organiser can move this event.')
    const day = dayAt(e)
    if (day == null) return
    const delta = Math.round((day - startOfDay(d.o.start)) / DAY)
    if (delta) moveTo(d.o, addDays(d.o.start, delta), addDays(d.o.start, delta) + (d.o.end - d.o.start))
  }

  return (
    <div class="mo" ref={grid}>
      <div class="mo-head">{weeks[0].map((d) => <span key={d}>{weekdayName(d)}</span>)}</div>
      {weeks.map((days) => {
        const inWeek = occs.filter((o) => o.start < days[6] + DAY && (o.end > days[0] || o.start >= days[0]))
        const placed = lanes(inWeek, days)
        // When a week holds more than fits, its last row says how many more.
        const shown = placed.some((b) => b.lane >= rows) ? rows - 1 : rows
        const hiddenPerDay = days.map((_, i) => placed.filter((b) => b.lane >= shown && b.from <= i && b.to >= i).length)
        return (
          <div class="mo-week" key={days[0]}>
            {days.map((d, i) => (
              <div key={d} data-day={d} class={cx('mo-cell', new Date(d).getMonth() !== month && 'out', sameDay(d, now) && 'today', drop === d && 'drop')}
                onClick={(e) => e.target === e.currentTarget && newAt(d, d + DAY, true, e.clientX, e.clientY)}>
                <button class="num" onClick={() => { cursor.value = d; setView('day') }} aria-label={dayLong(d)}>{new Date(d).getDate()}</button>
                {hiddenPerDay[i] > 0 && <button class="more" style={{ top: 26 + shown * 22 }} onClick={() => { cursor.value = d; setView('day') }}>{hiddenPerDay[i]} more</button>}
              </div>
            ))}
            <div class="mo-bars">
              {placed.map((b) => {
                if (b.lane >= shown) return null
                const solid = spansDays(b.o)
                return (
                  <button key={b.o.key} class={cx(solid ? 'bar' : 'chip', pending(b.o) && 'pending', declined(b.o) && 'declined', b.before && 'cut-l', b.after && 'cut-r')}
                    style={{ gridColumn: `${b.from + 1} / ${b.to + 2}`, top: 26 + b.lane * 22, '--c': b.o.color }}
                    onPointerDown={(e) => down(e, b.o)} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; setDrop(null) }}
                    onKeyDown={(e) => e.key === 'Enter' && openCard(b.o, e)}>
                    {!solid && <span class="dot" />}{!b.o.allDay && <span class="t">{hhmm(b.o.start)}</span>}<span class="ellipsis">{b.o.title}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// --- agenda -------------------------------------------------------------------

function Agenda({ from, to, occs }) {
  const days = []
  for (let d = from; d < to; d = addDays(d, 1)) {
    const list = occs.filter((o) => o.start < d + DAY && (o.end > d || (o.end === o.start && o.start >= d)))
    if (list.length) days.push([d, list])
  }
  const now = Date.now()
  return (
    <div class="ag">
      {days.length === 0 && <Empty icon={CalendarDays} title="Nothing planned" text="No events in the coming weeks." />}
      {days.map(([d, list]) => (
        <section class="ag-day" key={d}>
          <button class={cx('ag-date', sameDay(d, now) && 'today')} onClick={() => { cursor.value = d; setView('day') }}>
            <span class="num">{new Date(d).getDate()}</span>
            <span class="wd">{new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short' })}</span>
          </button>
          <div class="ag-list">
            {list.map((o) => (
              <button class={cx('ag-row', pending(o) && 'pending', declined(o) && 'declined')} key={o.key + d} onClick={(e) => openCard(o, e)}>
                <span class="dot" style={{ background: o.color }} />
                <span class="time">{o.allDay ? 'All day' : o.start < d ? 'Until ' + hhmm(o.end) : `${hhmm(o.start)} – ${hhmm(o.end)}`}</span>
                <span class="grow ellipsis ttl">{o.title}</span>
                {placeOf(o.inst) && <span class="muted ellipsis place">{placeOf(o.inst)}</span>}
                {meetingLink(o.inst) && <Button class="btn-ghost" icon={Video} onClick={(e) => { e.stopPropagation(); join(meetingLink(o.inst)) }}>Join</Button>}
              </button>
            ))}
          </div>
        </section>
      ))}
      <div class="more-row"><Button onClick={() => (agendaDays.value += 60)}>Show later events</Button></div>
    </div>
  )
}

// --- the side panel -----------------------------------------------------------

function MiniMonth() {
  const [shown, setShown] = useState(startOfMonth(cursor.value))
  useEffect(() => setShown(startOfMonth(cursor.value)), [startOfMonth(cursor.value)])
  const from = startOfWeek(shown)
  const [a, b] = range()
  const now = Date.now()
  const month = new Date(shown).getMonth()
  return (
    <div class="mini">
      <div class="mini-head">
        <span class="grow">{monthTitle(shown)}</span>
        <IconButton icon={ChevronLeft} label="Previous month" size={16} onClick={() => setShown(addMonths(shown, -1))} />
        <IconButton icon={ChevronRight} label="Next month" size={16} onClick={() => setShown(addMonths(shown, 1))} />
      </div>
      <div class="mini-grid">
        {Array.from({ length: 7 }, (_, i) => <span class="wd" key={i}>{weekdayName(addDays(from, i), 'narrow')}</span>)}
        {Array.from({ length: 42 }, (_, i) => {
          const d = addDays(from, i)
          return (
            <button key={d} class={cx(new Date(d).getMonth() !== month && 'out', sameDay(d, now) && 'today', d >= a && d < b && view.value !== 'agenda' && 'in')} onClick={() => { closeAll(); cursor.value = d }} aria-label={dayLong(d)}>
              {new Date(d).getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function CalendarForm() {
  const c = editingCal.value
  const [name, setName] = useState('')
  const [color, setColor] = useState(COLORS[1])
  const [busy, setBusy] = useState(false)
  const input = useRef()
  useEffect(() => {
    setName(c?.name || '')
    setColor(c?.color || (c?.id ? COLORS[0] : COLORS[1 + (calendars.value.length % (COLORS.length - 1))]))
    input.current?.focus()
  }, [c])
  if (!c) return null
  const close = () => (editingCal.value = null)
  const save = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await saveCalendar({ ...(c.id ? { id: c.id } : {}), name: name.trim(), color })
      close()
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy(false)
  }
  return (
    <Modal title={c.id ? 'Calendar settings' : 'New calendar'} width={380} onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>Save</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); save() }} style={{ display: 'contents' }}>
        <Field label="Name"><input ref={input} class="input" value={name} onInput={(e) => setName(e.target.value)} /></Field>
        <Field label="Colour">
          <span class="swatch-row">{COLORS.map((x) => <button type="button" key={x} class={cx('swatch', color === x && 'on')} style={{ background: x }} aria-label={'Colour ' + x} aria-pressed={color === x} onClick={() => setColor(x)} />)}</span>
        </Field>
      </form>
    </Modal>
  )
}

function CalendarList() {
  const toggle = (c) => saveCalendar({ id: c.id, isVisible: c.isVisible === false })
  const remove = (c) => {
    deleteCalendar(c)
    toast(`"${c.name}" and its events were deleted`)
  }
  return (
    <div class="cal-list">
      <div class="cal-list-head"><span class="grow">My calendars</span><IconButton icon={Plus} label="New calendar" size={16} onClick={() => (editingCal.value = {})} /></div>
      {calendars.value.map((c) => (
        <div class="cal-item" key={c.id}>
          <label class="grow">
            <input type="checkbox" checked={c.isVisible !== false} onChange={() => toggle(c)} style={{ accentColor: colorOf(c) }} />
            <span class="ellipsis">{c.name}</span>
          </label>
          <Menu align="right" trigger={<IconButton icon={MoreHorizontal} label={'Options for ' + c.name} size={16} />} items={[
            { label: 'Name and colour', onSelect: () => (editingCal.value = c) },
            !c.isDefault && { label: 'Delete calendar', danger: true, onSelect: () => remove(c) },
          ]} />
        </div>
      ))}
    </div>
  )
}

function askNotifications() {
  if (!window.Notification) return toast('This browser cannot show notifications.')
  Notification.requestPermission().then((p) => toast(p === 'granted' ? 'Reminders will also appear as notifications.' : 'Notifications are blocked for this site in your browser settings.'))
}

// --- the screen ------------------------------------------------------------------

export default function Calendar() {
  // Read the data here so the screen follows every change to it.
  const all = events.value
  const cals = calendars.value
  const v = view.value
  const [from, to] = range()
  const occs = useMemo(() => visible(occurrences(from, to)), [all, cals, from, to])
  const days = useMemo(() => Array.from({ length: Math.round((to - from) / DAY) }, (_, i) => addDays(from, i)), [from, to])

  useEffect(() => {
    // A link such as /calendar?new=1 or ?day=2026-11-25 lands in the right place.
    const p = new URLSearchParams(query.value)
    if (p.get('day')) cursor.value = startOfDay(new Date(p.get('day') + 'T12:00').getTime()) || cursor.value
    if (p.get('new')) newEvent()
    if (p.get('day') || p.get('new')) navigate('/calendar', { replace: true })
  }, [query.value])

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input,textarea,select,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal-back')) return
      const k = e.key
      if (k === 't') { closeAll(); cursor.value = startOfDay(Date.now()) }
      else if (k === 'ArrowLeft' || k === 'k' || k === 'p') step(-1)
      else if (k === 'ArrowRight' || k === 'j' || k === 'n') step(1)
      else if (k === 'm') setView('month')
      else if (k === 'w') setView('week')
      else if (k === 'd') setView('day')
      else if (k === 'a') setView('agenda')
      else if (k === 'c') { e.preventDefault(); newEvent() }
      else return
    }
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('keydown', onKey)
      closeAll()
    }
  }, [])

  const tab = (key, label) => <button class={cx('seg', v === key && 'on')} aria-pressed={v === key} onClick={() => setView(key)}>{label}</button>
  return (
    <div class="cal">
      <aside class="cal-side">
        <Button kind="primary" icon={Plus} onClick={newEvent}>New event</Button>
        <MiniMonth />
        <CalendarList />
        {window.Notification && Notification.permission === 'default' && <button class="cal-note" onClick={askNotifications}><Bell size={14} />Show reminders as notifications</button>}
      </aside>
      <section class="cal-main">
        <header class="cal-bar">
          <Button onClick={() => { closeAll(); cursor.value = startOfDay(Date.now()) }}>Today</Button>
          <IconButton icon={ChevronLeft} label="Earlier" onClick={() => step(-1)} />
          <IconButton icon={ChevronRight} label="Later" onClick={() => step(1)} />
          <h1 class="grow ellipsis">{title()}</h1>
          <div class="segs" role="group" aria-label="View">{tab('day', 'Day')}{tab('week', narrow() ? '3 days' : 'Week')}{tab('month', 'Month')}{tab('agenda', 'Agenda')}</div>
          <IconButton icon={Plus} label="New event" class="only-narrow cal-add" onClick={newEvent} />
        </header>
        {!calReady.value && !cals.length ? (
          <Empty icon={CalendarDays} title="Your calendar is being prepared" text="It will appear here on its own in a moment." />
        ) : v === 'month' ? <Month key={from} from={from} occs={occs} />
          : v === 'agenda' ? <Agenda from={from} to={to} occs={occs} />
          : <TimeGrid key={v + days.length} days={days} occs={occs} />}
      </section>
      <EventCard />
      <QuickCreate />
      <EventEditor />
      <ScopeDialog />
      <CalendarForm />
    </div>
  )
}
