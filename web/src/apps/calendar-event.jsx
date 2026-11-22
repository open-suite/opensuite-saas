// Everything about one event: the card that shows it, the quick form that
// makes one, and the full editor with guests, repeats and reminders.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { AlignLeft, Bell, Check, Clock, Copy, Globe, MapPin, Pencil, Repeat, Trash2, Users, Video, X, CalendarDays, CircleHelp } from 'lucide-preact'
import { user, toast } from '../lib/store.js'
import { newMeeting, meetLink } from '../lib/docs.js'
import { cx, copyText } from '../lib/util.js'
import { Avatar, Button, IconButton, Modal } from '../ui.jsx'
import {
  calendars, events, COLORS, colorOf, calendarOf, guestsOf, myPart, myAddress, isOrganizer, organizerOf, meetingLink, placeOf,
  saveEvent, changeOccurrence, deleteOccurrence, rsvp, repeatText, occurrences, busyTimes, joinMeeting, notesOf,
} from '../lib/calendar.js'
import { suggest } from '../lib/contacts.js'
import { DAY, MIN, localZone, parseWall, formatWall, instantOf, parseDuration, formatDuration, span, hhmm, zoneLabel, zones, startOfDay } from '../lib/time.js'
import { DAYS } from '../lib/rrule.js'

export const card = signal(null) // { occ, x, y }: the event whose details are showing
export const quick = signal(null) // { ev, x, y }: a new event being named
export const draft = signal(null) // { ev, prev, occ, scope }: the editor
export const ask = signal(null) // { title, one, all, onPick }: this event or all of them?

export const closeAll = () => {
  card.value = null
  quick.value = null
}

// Floating panels sit next to what was clicked and stay inside the window.
function Floating({ x, y, class: cls, onClose, children, ...rest }) {
  const ref = useRef()
  useLayoutEffect(() => {
    const el = ref.current
    const r = el.getBoundingClientRect()
    // To the right of the pointer when there is room, otherwise to its left.
    const left = x + 10 + r.width <= innerWidth - 8 ? x + 10 : x - 10 - r.width
    el.style.left = Math.max(8, Math.min(left, innerWidth - r.width - 8)) + 'px'
    el.style.top = Math.max(8, Math.min(y - 24, innerHeight - r.height - 8)) + 'px'
    el.style.visibility = 'visible'
  })
  useEffect(() => {
    const off = (e) => !ref.current?.contains(e.target) && !e.target.closest('.modal-back') && onClose()
    const key = (e) => e.key === 'Escape' && onClose()
    // Opened by a pointer event that is still in flight: listen from the next one.
    const t = setTimeout(() => addEventListener('pointerdown', off, true), 0)
    addEventListener('keydown', key)
    return () => {
      clearTimeout(t)
      removeEventListener('pointerdown', off, true)
      removeEventListener('keydown', key)
    }
  }, [onClose])
  return <div ref={ref} class={cx('cal-float', cls)} style={{ visibility: 'hidden' }} {...rest}>{children}</div>
}

export const join = joinMeeting

const statusText = { accepted: 'Going', declined: 'Not going', tentative: 'Maybe', 'needs-action': 'No answer yet' }
const StatusMark = ({ status }) =>
  status === 'accepted' ? <Check size={13} class="st-yes" /> : status === 'declined' ? <X size={13} class="st-no" /> : status === 'tentative' ? <CircleHelp size={13} class="st-maybe" /> : null

export function Rsvp({ ev }) {
  const mine = myPart(ev)
  if (!mine || isOrganizer(ev)) return null
  const opt = (status, label) => (
    <button class={cx('rsvp-btn', mine.status === status && 'on')} aria-pressed={mine.status === status} onClick={() => rsvp(events.value[ev.id] || ev, status)}>{label}</button>
  )
  return (
    <div class="rsvp" role="group" aria-label="Your answer">
      <span class="muted">Going?</span>
      {opt('accepted', 'Yes')}{opt('tentative', 'Maybe')}{opt('declined', 'No')}
    </div>
  )
}

// scoped asks "this event or all events?" for a repeating one, then acts.
export function scoped(occ, title, act) {
  if (!occ.rid) return act('all')
  ask.value = { title, onPick: (scope) => { ask.value = null; act(scope) } }
}

export function ScopeDialog() {
  const a = ask.value
  if (!a) return null
  return (
    <Modal title={a.title} width={380} onClose={() => (ask.value = null)}>
      <p class="muted">This event repeats.</p>
      <div class="row" style={{ justifyContent: 'flex-end' }}>
        <Button onClick={() => a.onPick('one')}>This event</Button>
        <Button kind="primary" onClick={() => a.onPick('all')}>All events</Button>
      </div>
    </Modal>
  )
}

export function removeEvent(occ) {
  const mine = isOrganizer(occ.ev)
  scoped(mine ? occ : { ...occ, rid: null }, 'Delete repeating event', (scope) => {
    deleteOccurrence(occ, scope)
    card.value = null
    toast(mine ? 'Event deleted' : 'Removed from your calendar')
  })
}

export function editEvent(occ) {
  card.value = null
  scoped(occ, 'Edit repeating event', (scope) => {
    const ev = events.value[occ.id] || occ.ev
    draft.value = scope === 'one' ? { ev: occ.inst, prev: ev, occ, scope } : { ev, prev: ev, occ, scope: 'all' }
  })
}

export function EventCard() {
  const c = card.value
  if (!c) return null
  // Follow the live copy, so an answer or an edit shows at once.
  const live = events.value[c.occ.id]
  const occ = live ? occurrences(c.occ.start - 40 * DAY, c.occ.end + 40 * DAY).find((o) => o.key === c.occ.key) || c.occ : c.occ
  const ev = occ.inst
  const cal = calendarOf(ev)
  const guests = guestsOf(ev)
  const link = meetingLink(ev)
  const place = placeOf(ev)
  const mine = isOrganizer(occ.ev)
  const repeat = repeatText(occ.ev)
  const zone = !occ.allDay && ev.timeZone && ev.timeZone !== localZone ? ev.timeZone : ''
  return (
    <Floating x={c.x} y={c.y} class="ev-card" onClose={() => (card.value = null)} role="dialog" aria-label={occ.title}>
      <header>
        <span class="dot" style={{ background: occ.color }} />
        <h2 class="grow">{occ.title}</h2>
        {mine && <IconButton icon={Pencil} label="Edit" onClick={() => editEvent(occ)} />}
        <IconButton icon={Trash2} label={mine ? 'Delete' : 'Remove from my calendar'} onClick={() => removeEvent(occ)} />
        <IconButton icon={X} label="Close" onClick={() => (card.value = null)} />
      </header>
      <div class="ev-line"><Clock size={16} /><div>{span(occ.start, occ.end, occ.allDay)}{repeat && <div class="muted">{repeat}</div>}{zone && <div class="muted">{hhmm(wallToLocal(ev))} in {zoneLabel(zone)}</div>}</div></div>
      {link && <div class="ev-line"><Video size={16} /><div class="row grow"><Button kind="primary" onClick={() => join(link)}>Join meeting</Button><IconButton icon={Copy} label="Copy meeting link" onClick={async () => (await copyText(link)) && toast('Link copied')} /></div></div>}
      {place && <div class="ev-line"><MapPin size={16} /><div>{place}</div></div>}
      {guests.length > 0 && (
        <div class="ev-line"><Users size={16} />
          <div class="grow">
            {guests.map((g) => (
              <div class="guest" key={g.key} title={statusText[g.status] || ''}>
                <Avatar name={g.name || g.email} id={g.email} size={22} />
                <span class="ellipsis">{g.name || g.email}{g.email === myAddress() && ' (you)'}</span>
                {g.owner && <span class="muted">Organiser</span>}
                <StatusMark status={g.status} />
              </div>
            ))}
          </div>
        </div>
      )}
      {notesOf(ev) && <div class="ev-line"><AlignLeft size={16} /><div class="ev-desc">{notesOf(ev)}</div></div>}
      {calendars.value.length > 1 && cal && <div class="ev-line muted"><CalendarDays size={16} /><div>{cal.name}</div></div>}
      <Rsvp ev={occ.ev} />
    </Floating>
  )
}

// The clock reading in the event's own zone, shown as if it were local time.
const wallToLocal = (ev) => instantOf(parseWall(ev.start), localZone)

export function QuickCreate() {
  const q = quick.value
  const [title, setTitle] = useState('')
  const input = useRef()
  useLayoutEffect(() => {
    setTitle('')
    input.current?.focus() // typing names the event straight away
  }, [q?.ev.uid])
  if (!q) return null
  const ev = { ...q.ev, title: title.trim() }
  const allDay = !!ev.showWithoutTime
  const start = instantOf(parseWall(ev.start), localZone)
  const dur = parseDuration(ev.duration)
  const save = () => {
    saveEvent(ev)
    quick.value = null
  }
  return (
    <Floating x={q.x} y={q.y} class="ev-quick" onClose={() => (quick.value = null)} role="dialog" aria-label="New event">
      <form onSubmit={(e) => { e.preventDefault(); save() }}>
        <input ref={input} class="input quick-title" placeholder="Add a title" value={title} onInput={(e) => setTitle(e.target.value)} aria-label="Title" />
        <div class="ev-line muted"><Clock size={16} /><div>{span(start, allDay ? instantOf(parseWall(ev.start) + dur, localZone) : start + dur, allDay)}</div></div>
        <div class="row" style={{ justifyContent: 'flex-end' }}>
          <Button class="btn-ghost" onClick={() => { draft.value = { ev, prev: null, scope: 'all' }; quick.value = null }}>More options</Button>
          <Button kind="primary" type="submit">Save</Button>
        </div>
      </form>
    </Floating>
  )
}

// --- the editor --------------------------------------------------------------

const REMIND = [['none', 'No reminder'], ['0', 'At the start'], ['5', '5 minutes before'], ['10', '10 minutes before'], ['30', '30 minutes before'], ['60', '1 hour before'], ['1440', '1 day before']]
const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const NTH = ['first', 'second', 'third', 'fourth', 'last']

function formOf(ev) {
  const allDay = !!ev.showWithoutTime
  const wall = parseWall(ev.start)
  const dur = parseDuration(ev.duration) || (allDay ? DAY : 30 * MIN)
  const end = allDay ? wall + dur - DAY : wall + dur
  const d = (w) => formatWall(w).slice(0, 10)
  const t = (w) => formatWall(w).slice(11, 16)
  const rule = ev.recurrenceRule
  const alert = Object.values(ev.alerts || {})[0]
  const me = myAddress()
  return {
    title: ev.title || '', allDay,
    startDate: d(wall), startTime: allDay ? '09:00' : t(wall), endDate: d(end), endTime: allDay ? '10:00' : t(end),
    tz: ev.timeZone || localZone,
    freq: rule?.frequency || 'none', interval: rule?.interval || 1,
    days: rule?.byDay?.filter((b) => !b.nthOfPeriod).map((b) => b.day) || [],
    nth: rule?.frequency === 'monthly' && !!rule.byDay?.[0]?.nthOfPeriod,
    ends: rule?.count ? 'after' : rule?.until ? 'on' : 'never', count: rule?.count || 10, until: rule?.until ? rule.until.slice(0, 10) : '',
    place: placeOf(ev), link: meetingLink(ev), description: ev.description || '',
    calId: calendarOf(ev)?.id || '', color: ev.color || '',
    remind: alert ? String(Math.round(-parseDuration(alert.trigger?.offset) / MIN)) : 'none',
    guests: guestsOf(ev).filter((g) => g.email !== me),
  }
}

function ruleOf(f, startWall) {
  if (f.freq === 'none') return undefined
  const s = new Date(startWall)
  const rule = { '@type': 'RecurrenceRule', frequency: f.freq }
  if (f.interval > 1) rule.interval = +f.interval
  if (f.freq === 'weekly' && f.days.length) rule.byDay = [...f.days].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b)).map((day) => ({ day }))
  if (f.freq === 'monthly' && f.nth) {
    const dom = s.getUTCDate()
    const last = dom + 7 > new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0)).getUTCDate()
    rule.byDay = [{ day: DAYS[s.getUTCDay()], nthOfPeriod: last && dom > 21 ? -1 : Math.ceil(dom / 7) }]
  }
  if (f.ends === 'after') rule.count = Math.max(1, +f.count || 1)
  if (f.ends === 'on' && f.until) rule.until = f.until + 'T23:59:59'
  return rule
}

function eventOf(f, base) {
  const startWall = parseWall(f.startDate + 'T' + (f.allDay ? '00:00' : f.startTime) + ':00')
  let endWall = parseWall(f.endDate + 'T' + (f.allDay ? '00:00' : f.endTime) + ':00')
  if (f.allDay) endWall = Math.max(endWall, startWall) + DAY
  else if (endWall <= startWall) endWall = startWall + 30 * MIN
  const me = user.value
  const ev = { ...base, title: f.title.trim(), start: formatWall(startWall), duration: f.allDay ? `P${Math.round((endWall - startWall) / DAY)}D` : formatDuration(endWall - startWall) }
  ev.showWithoutTime = f.allDay || undefined
  ev.timeZone = f.allDay ? undefined : f.tz
  ev.recurrenceRule = ruleOf(f, startWall)
  if (!ev.recurrenceRule) ev.recurrenceOverrides = undefined
  ev.description = f.description.trim() || undefined
  ev.locations = f.place.trim() ? { l1: { '@type': 'Location', name: f.place.trim() } } : undefined
  ev.virtualLocations = f.link ? { v1: { '@type': 'VirtualLocation', name: 'Open Suite meeting', uri: f.link } } : undefined
  ev.alerts = f.remind === 'none' ? undefined : { a1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: +f.remind ? '-' + formatDuration(+f.remind * MIN) : 'PT0S' }, action: 'display' } }
  ev.calendarIds = f.calId ? { [f.calId]: true } : base.calendarIds
  ev.color = f.color || undefined
  if (f.guests.length) {
    const old = base.participants || {}
    const mine = Object.entries(old).find(([, p]) => (p.calendarAddress || '').toLowerCase() === 'mailto:' + me.email.toLowerCase())
    ev.organizerCalendarAddress = 'mailto:' + me.email
    ev.participants = { [mine?.[0] || 'me']: { '@type': 'Participant', name: me.name, calendarAddress: 'mailto:' + me.email, roles: { owner: true, attendee: true }, participationStatus: 'accepted' } }
    f.guests.forEach((g, i) => {
      ev.participants[g.key || 'g' + Date.now().toString(36) + i] = { ...(g.key ? old[g.key] : {}), '@type': 'Participant', name: g.name || undefined, calendarAddress: 'mailto:' + g.email, roles: { attendee: true }, participationStatus: g.status || 'needs-action', expectReply: true }
    })
  } else {
    ev.participants = undefined
    ev.organizerCalendarAddress = undefined
  }
  return ev
}

function GuestField({ guests, onChange }) {
  const [text, setText] = useState('')
  const [pick, setPick] = useState(0)
  const taken = [myAddress(), ...guests.map((g) => g.email)]
  const options = useMemo(() => suggest(text, taken), [text, guests.length])
  const add = (g) => {
    onChange([...guests, { name: g.name, email: g.email.toLowerCase(), status: 'needs-action' }])
    setText('')
    setPick(0)
  }
  const commit = () => {
    const s = text.trim().replace(/[,;]$/, '')
    if (!s) return true
    if (options[pick]) return add(options[pick]), true
    const m = s.match(/^(.*)<([^>]+)>$/)
    const email = (m ? m[2] : s).trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast(`"${s}" is not an email address.`, 'error'), false
    if (!taken.includes(email.toLowerCase())) add({ name: m ? m[1].trim().replace(/^"|"$/g, '') : '', email })
    else setText('')
    return true
  }
  return (
    <div class="guest-field">
      {guests.map((g) => (
        <span class="gchip" key={g.email}>
          <Avatar name={g.name || g.email} id={g.email} size={20} />
          <span class="ellipsis">{g.name || g.email}</span>
          <StatusMark status={g.status} />
          <button type="button" class="x" aria-label={'Remove ' + (g.name || g.email)} onClick={() => onChange(guests.filter((x) => x !== g))}><X size={13} /></button>
        </span>
      ))}
      <span class="guest-input">
        <input
          value={text} placeholder={guests.length ? 'Add another' : 'Add guests by name or email'} aria-label="Add guests" autocomplete="off"
          onInput={(e) => { setText(e.target.value); setPick(0) }}
          onBlur={() => setTimeout(() => text.includes('@') && commit(), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === ';') { if (text.trim()) { e.preventDefault(); commit() } }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setPick(Math.min(options.length - 1, pick + 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setPick(Math.max(0, pick - 1)) }
            else if (e.key === 'Backspace' && !text && guests.length) onChange(guests.slice(0, -1))
          }}
        />
        {options.length > 0 && (
          <div class="menu menu-left suggest" role="listbox">
            {options.map((o, i) => (
              <button type="button" key={o.email} role="option" aria-selected={i === pick} class={cx('menu-item', i === pick && 'pick')} onPointerDown={(e) => { e.preventDefault(); add(o) }}>
                <Avatar name={o.name || o.email} id={o.email} size={22} />
                <span class="ellipsis">{o.name || o.email}</span>
                <span class="muted ellipsis">{o.name ? o.email : ''}</span>
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  )
}

// Availability: one bar per person for the day of the event, 7:00 to 21:00,
// with the proposed time laid over it.
function Availability({ form, startMs, endMs, self }) {
  const [busy, setBusy] = useState({})
  const day = startOfDay(startMs)
  const emails = form.guests.map((g) => g.email)
  useEffect(() => {
    if (!emails.length) return
    let live = true
    const t = setTimeout(() => busyTimes(emails, day, day + DAY).then((b) => live && setBusy(b)).catch(() => {}), 150)
    return () => { live = false; clearTimeout(t) }
  }, [emails.join(), day])
  const rows = form.guests.filter((g) => busy[g.email])
  if (!rows.length || form.allDay) return null
  const from = day + 7 * 3600000
  const to = day + 21 * 3600000
  const pos = (s, e) => ({ left: Math.max(0, ((s - from) / (to - from)) * 100) + '%', width: Math.max(0.8, ((Math.min(e, to) - Math.max(s, from)) / (to - from)) * 100) + '%' })
  const mine = occurrences(day, day + DAY).filter((o) => !o.allDay && o.ev.uid !== self).map((o) => ({ s: o.start, e: o.end }))
  const clash = (list) => list.some((p) => p.s < endMs && p.e > startMs)
  const people = [{ name: 'You', list: mine }, ...rows.map((g) => ({ name: (g.name || g.email).split(' ')[0], list: busy[g.email] }))]
  const blocked = people.filter((p) => clash(p.list)).map((p) => p.name)
  return (
    <div class="avail" aria-label="Availability">
      {people.map((p) => (
        <div class="avail-row" key={p.name}>
          <span class="who ellipsis">{p.name}</span>
          <span class="track">
            {p.list.filter((b) => b.e > from && b.s < to).map((b, i) => <span key={i} class={cx('busy', b.t && 'maybe')} style={pos(b.s, b.e)} />)}
            {endMs > from && startMs < to && <span class={cx('slot', clash(p.list) && 'clash')} style={pos(startMs, endMs)} />}
          </span>
        </div>
      ))}
      <div class="avail-row scale"><span class="who" /><span class="track">{[7, 10, 13, 16, 19].map((h) => <i key={h} style={{ left: ((h - 7) / 14) * 100 + '%' }}>{hhmm(day + h * 3600000)}</i>)}</span></div>
      <div class={cx('avail-note', blocked.length && 'warn')}>{blocked.length ? `${blocked.join(' and ')} ${blocked.length > 1 || blocked[0] === 'You' ? 'are' : 'is'} busy at this time.` : 'Everyone is free at this time.'}</div>
    </div>
  )
}

export function EventEditor() {
  const d = draft.value
  const [f, setF] = useState(null)
  const [custom, setCustom] = useState(false)
  const titleRef = useRef()
  useLayoutEffect(() => {
    setF(d ? formOf(d.ev) : null)
    setCustom(false)
  }, [d])
  // Before the form is painted, so the first keystroke lands in the title.
  useLayoutEffect(() => {
    if (f) titleRef.current?.focus()
  }, [d, !!f])
  if (!d || !f) return null
  const one = d.scope === 'one'
  const set = (patch) => setF({ ...f, ...patch })
  const on = (k) => (e) => set({ [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const startWall = parseWall(f.startDate + 'T' + (f.allDay ? '00:00' : f.startTime))
  const startMs = instantOf(startWall, f.allDay ? localZone : f.tz)
  const endWall = parseWall(f.endDate + 'T' + (f.allDay ? '00:00' : f.endTime))
  const endMs = instantOf(endWall, f.allDay ? localZone : f.tz)
  const s = new Date(startWall)
  const close = () => (draft.value = null)

  // Moving the start keeps the length; the end never precedes the start.
  const setStart = (date, time) => {
    const next = parseWall(date + 'T' + time)
    if (Number.isNaN(next)) return
    const end = formatWall(next + (endWall - startWall))
    set({ startDate: date, startTime: time, endDate: end.slice(0, 10), endTime: end.slice(11, 16) })
  }
  const save = () => {
    if (!f.startDate || !f.endDate) return toast('Choose a date.', 'error')
    if (one) {
      const ev = eventOf(f, d.ev)
      const changes = { title: ev.title, start: ev.start, duration: ev.duration, description: ev.description ?? null, locations: ev.locations ?? null, virtualLocations: ev.virtualLocations ?? null }
      changeOccurrence(d.occ, changes, 'one')
    } else {
      const base = d.prev || d.ev
      saveEvent(eventOf(f, base), d.prev || undefined)
    }
    close()
  }
  const addMeeting = () => set({ link: meetLink(newMeeting(f.title.trim()).code) })
  const nthName = NTH[Math.min(4, s.getUTCDate() + 7 > new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0)).getUTCDate() && s.getUTCDate() > 21 ? 4 : Math.ceil(s.getUTCDate() / 7) - 1)]
  const preset = f.freq === 'none' ? 'none' : f.interval > 1 ? 'custom' : f.freq === 'weekly' ? (f.days.length === 5 && !f.days.includes('sa') && !f.days.includes('su') ? 'weekdays' : f.days.length > 1 ? 'custom' : 'weekly') : f.freq === 'monthly' ? (f.nth ? 'nth' : 'monthly') : f.freq
  const pickPreset = (v) => {
    setCustom(v === 'custom')
    const today = DAYS[s.getUTCDay()]
    if (v === 'none') set({ freq: 'none' })
    else if (v === 'daily') set({ freq: 'daily', interval: 1, days: [] })
    else if (v === 'weekly') set({ freq: 'weekly', interval: 1, days: [today] })
    else if (v === 'weekdays') set({ freq: 'weekly', interval: 1, days: ['mo', 'tu', 'we', 'th', 'fr'] })
    else if (v === 'monthly') set({ freq: 'monthly', interval: 1, nth: false })
    else if (v === 'nth') set({ freq: 'monthly', interval: 1, nth: true })
    else if (v === 'yearly') set({ freq: 'yearly', interval: 1 })
    else set({ freq: f.freq === 'none' ? 'weekly' : f.freq, days: f.days.length ? f.days : [today] })
  }
  const showCustom = custom || preset === 'custom'
  return (
    <Modal title={d.prev ? (one ? 'Edit this event' : 'Edit event') : 'New event'} width={600} onClose={close}
      footer={<><Button onClick={close}>Cancel</Button><Button kind="primary" onClick={save}>{f.guests.length && !one ? (d.prev ? 'Save and notify' : 'Save and invite') : 'Save'}</Button></>}>
      <form class="ev-form" onSubmit={(e) => { e.preventDefault(); save() }}>
        <input ref={titleRef} class="input ev-title" placeholder="Add a title" value={f.title} onInput={on('title')} aria-label="Title" />

        <div class="ev-row"><Clock size={17} />
          <div class="grow">
            <div class="when">
              <input class="input" type="date" value={f.startDate} aria-label="Start date" onChange={(e) => setStart(e.target.value, f.startTime)} />
              {!f.allDay && <input class="input" type="time" value={f.startTime} aria-label="Start time" step="300" onChange={(e) => setStart(f.startDate, e.target.value)} />}
              <span class="muted">to</span>
              {!f.allDay && <input class="input" type="time" value={f.endTime} aria-label="End time" step="300" onChange={on('endTime')} />}
              {(f.allDay || f.endDate !== f.startDate) && <input class="input" type="date" value={f.endDate} min={f.startDate} aria-label="End date" onChange={on('endDate')} />}
            </div>
            <div class="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <label class="check"><input type="checkbox" checked={f.allDay} onChange={on('allDay')} disabled={one} /> All day</label>
              {!f.allDay && !one && (
                <label class="zone" title="Time zone"><Globe size={14} />
                  <select class="select" value={f.tz} onChange={on('tz')} aria-label="Time zone">{(zones.includes(f.tz) ? zones : [f.tz, ...zones]).map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}</select>
                </label>
              )}
            </div>
          </div>
        </div>

        {!one && (
          <div class="ev-row"><Repeat size={17} />
            <div class="grow">
              <select class="select" value={showCustom ? 'custom' : preset} onChange={(e) => pickPreset(e.target.value)} aria-label="Repeat">
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly on {WD[s.getUTCDay()]}</option>
                <option value="monthly">Monthly on day {s.getUTCDate()}</option>
                <option value="nth">Monthly on the {nthName} {WD[s.getUTCDay()]}</option>
                <option value="yearly">Yearly on {s.toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' })}</option>
                <option value="weekdays">Every weekday (Monday to Friday)</option>
                <option value="custom">Custom</option>
              </select>
              {showCustom && f.freq !== 'none' && (
                <div class="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  <span class="muted">Every</span>
                  <input class="input" style={{ width: 64 }} type="number" min="1" max="99" value={f.interval} onInput={(e) => set({ interval: Math.max(1, +e.target.value || 1) })} aria-label="Interval" />
                  <select class="select" style={{ width: 'auto' }} value={f.freq} onChange={on('freq')} aria-label="Unit">
                    <option value="daily">days</option><option value="weekly">weeks</option><option value="monthly">months</option><option value="yearly">years</option>
                  </select>
                  {f.freq === 'weekly' && (
                    <span class="days">{['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'].map((dd) => (
                      <button type="button" key={dd} class={cx('day', f.days.includes(dd) && 'on')} aria-pressed={f.days.includes(dd)} onClick={() => set({ days: f.days.includes(dd) ? f.days.filter((x) => x !== dd) : [...f.days, dd] })}>{WD[DAYS.indexOf(dd)].slice(0, 2)}</button>
                    ))}</span>
                  )}
                </div>
              )}
              {f.freq !== 'none' && (
                <div class="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  <span class="muted">Ends</span>
                  <select class="select" style={{ width: 'auto' }} value={f.ends} onChange={on('ends')} aria-label="Ends">
                    <option value="never">never</option><option value="on">on a date</option><option value="after">after</option>
                  </select>
                  {f.ends === 'on' && <input class="input" style={{ width: 'auto' }} type="date" value={f.until} min={f.startDate} onChange={on('until')} aria-label="Last day" />}
                  {f.ends === 'after' && <><input class="input" style={{ width: 72 }} type="number" min="1" max="999" value={f.count} onInput={on('count')} aria-label="Number of times" /><span class="muted">times</span></>}
                </div>
              )}
            </div>
          </div>
        )}

        {!one && (
          <div class="ev-row"><Users size={17} />
            <div class="grow">
              <GuestField guests={f.guests} onChange={(guests) => set({ guests })} />
              <Availability form={f} startMs={startMs} endMs={endMs} self={d.ev.uid} />
            </div>
          </div>
        )}

        <div class="ev-row"><Video size={17} />
          {f.link ? (
            <div class="row grow">
              <span class="grow ellipsis link">{f.link.replace(/^https?:\/\//, '')}</span>
              <IconButton icon={Copy} label="Copy meeting link" onClick={async () => (await copyText(f.link)) && toast('Link copied')} />
              <IconButton icon={X} label="Remove meeting" onClick={() => set({ link: '' })} />
            </div>
          ) : <Button icon={Video} onClick={addMeeting}>Add meeting</Button>}
        </div>

        <div class="ev-row"><MapPin size={17} /><input class="input" placeholder="Add a place" value={f.place} onInput={on('place')} aria-label="Place" /></div>

        {!one && (
          <div class="ev-row"><Bell size={17} />
            <select class="select" value={REMIND.some(([v]) => v === f.remind) ? f.remind : 'none'} onChange={on('remind')} aria-label="Reminder">{REMIND.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
        )}

        <div class="ev-row top"><AlignLeft size={17} /><textarea class="textarea" rows="3" placeholder="Add a description" value={f.description} onInput={on('description')} aria-label="Description" /></div>

        {!one && (
          <div class="ev-row"><CalendarDays size={17} />
            <div class="row grow" style={{ flexWrap: 'wrap' }}>
              {calendars.value.length > 1 && <select class="select" style={{ width: 'auto', flex: 1 }} value={f.calId} onChange={on('calId')} aria-label="Calendar">{calendars.value.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
              <span class="swatch-row" role="group" aria-label="Colour">
                <button type="button" class={cx('swatch auto', !f.color && 'on')} style={{ background: colorOf(calendars.value.find((c) => c.id === f.calId)) }} title="Calendar colour" aria-label="Calendar colour" onClick={() => set({ color: '' })} />
                {COLORS.map((c) => <button type="button" key={c} class={cx('swatch', f.color === c && 'on')} style={{ background: c }} aria-label={'Colour ' + c} onClick={() => set({ color: c })} />)}
              </span>
            </div>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
