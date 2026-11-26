// Calendar data layer. Every calendar and event of the signed-in person is
// kept on the device, so the calendar paints at once, works offline and can
// be searched locally. Changes show on screen first and reach the server
// behind; other tabs and devices hear about them through the push stream.
import { signal } from '@preact/signals'
import { boot, user, people, toast } from './store.js'
import { api, post } from './api.js'
import { navigate } from './router.js'
import { kvGet, kvSet } from './idb.js'
import { debounce, newId } from './util.js'
import { boxByRole, ensureMailbox, identity, onPush } from './mail.js'
import { DAY, MIN, localZone, parseWall, formatWall, wallIn, parseDuration, formatDuration, span, startOfDay } from './time.js'
import { expandEvents } from './occurrences.js'
import { partOf, organizes, meetingLink, placeOf, answered, reanswered, guestMails, replyMails, deleteMails } from './invite.js'

export { guestsOf, organizerOf, meetingLink, notesOf, placeOf, repeatText } from './invite.js'

export const calendars = signal([]) // [{ id, name, color, isVisible, isDefault, sortOrder }]
export const events = signal({}) // id -> event (a repeating event is one entry)
export const calReady = signal(false)
export const reminders = signal([]) // [{ key, title, start, end, allDay, link }] waiting to be dismissed

export const COLORS = ['#1269e8', '#0e9f6e', '#c2410c', '#7c3aed', '#be185d', '#0891b2', '#a16207', '#4f46e5', '#dc2626', '#617385']
export const colorOf = (cal) => cal?.color || COLORS[0]

let evState = null
let syncing = null
let again = false
const busy = new Map() // event id -> number of local changes still on their way
const alias = new Map() // temporary id -> the server's id
const real = (id) => alias.get(id) || id

// jm sends calendar and contact calls; a refused call throws.
export async function jm(calls) {
  const res = await api('POST', '/api/mail/jmap', { methodCalls: calls.map((c, i) => [c[0], c[1], c[2] || String(i)]) }, { passive: true })
  return res.methodResponses.map((r) => {
    if (r[0] === 'error') throw Object.assign(new Error(r[1].description || r[1].type || 'The calendar could not be reached.'), { type: r[1].type })
    return r[1]
  })
}

const persist = debounce(() => {
  kvSet('calendar', { user: boot.value?.mail?.address, calendars: calendars.value, events: events.value, state: evState })
}, 600)

function setEvents(next) {
  events.value = next
  cache.clear()
  persist()
  scheduleReminders()
}

function setCalendars(list) {
  calendars.value = [...list].sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name))
  persist()
}

export const defaultCalendar = () => calendars.value.find((c) => c.isDefault) || calendars.value[0]
export const calendarOf = (ev) => calendars.value.find((c) => ev.calendarIds?.[c.id]) || defaultCalendar()

// --- sync ----------------------------------------------------------------

async function loadCalendars() {
  const [c] = await jm([['Calendar/get', { properties: ['name', 'color', 'isVisible', 'isDefault', 'sortOrder'] }]])
  const list = c.list || []
  // A fresh account's calendar carries a machine-made name; give it the
  // person's own.
  const def = list.find((x) => x.isDefault)
  if (def && /\(.+@.+\)$/.test(def.name)) {
    def.name = user.value.name
    jm([['Calendar/set', { update: { [def.id]: { name: def.name } } }]]).catch(() => {})
  }
  setCalendars(list)
}

async function loadAll() {
  const [q] = await jm([['CalendarEvent/query', { limit: 5000 }]])
  const next = {}
  let state = null
  for (let i = 0; i < q.ids.length || i === 0; i += 400) {
    const [g] = await jm([['CalendarEvent/get', { ids: q.ids.slice(i, i + 400) }]])
    for (const e of g.list || []) next[e.id] = e
    state = g.state
  }
  for (const [id, n] of busy) if (n > 0 && events.value[id]) next[id] = events.value[id]
  evState = state
  setEvents(next)
}

async function loadChanges() {
  const [ch, made, changed] = await jm([
    ['CalendarEvent/changes', { sinceState: evState, maxChanges: 400 }, 'c'],
    ['CalendarEvent/get', { '#ids': { resultOf: 'c', name: 'CalendarEvent/changes', path: '/created' } }, 'a'],
    ['CalendarEvent/get', { '#ids': { resultOf: 'c', name: 'CalendarEvent/changes', path: '/updated' } }, 'b'],
  ])
  const next = { ...events.value }
  // An event being created here right now is already on screen under a
  // temporary id; its own save will swap that for the server's.
  const pending = new Set(Object.values(next).filter((e) => String(e.id).startsWith('tmp-') && !alias.has(e.id)).map((e) => e.uid))
  for (const e of [...(made.list || []), ...(changed.list || [])]) if (!busy.get(e.id) && !pending.has(e.uid)) next[e.id] = e
  for (const id of ch.destroyed || []) if (!busy.get(id)) delete next[id]
  // An event made here a moment ago is known under its temporary id.
  for (const [tmp, id] of alias) if (next[id] && next[tmp]) delete next[tmp]
  evState = ch.newState
  setEvents(next)
  if (ch.hasMoreChanges) return loadChanges()
}

// syncCalendar brings the device copy up to date. Calls made while one is
// running are folded into a single follow-up.
export function syncCalendar() {
  if (syncing) {
    again = true
    return syncing
  }
  syncing = (async () => {
    try {
      if (!calendars.value.length) await loadCalendars()
      if (evState) await loadChanges().catch((e) => (e.type === 'cannotCalculateChanges' ? loadAll() : Promise.reject(e)))
      else await loadAll()
      calReady.value = true
    } catch {
      // Offline or the engine is away: the device copy stays in use.
    } finally {
      syncing = null
      if (again) {
        again = false
        syncCalendar()
      }
    }
  })()
  return syncing
}

// The device copy is read while the page is still starting, so the calendar
// has its events by the time it is first drawn.
const savedCopy = kvGet('calendar')

let started = false
export async function startCalendar() {
  if (started || !boot.value?.mail?.ready) return
  started = true
  const saved = await savedCopy
  if (saved?.user === boot.value.mail.address) {
    calendars.value = saved.calendars || []
    events.value = saved.events || {}
    evState = saved.state || null
    if (calendars.value.length) calReady.value = true
    scheduleReminders()
  }
  await syncCalendar()
  onPush.add((types) => {
    if (types.Calendar) loadCalendars().catch(() => {})
    if (types.CalendarEvent || types.Calendar) syncCalendar()
  })
  setInterval(checkReminders, 30000)
}

// --- calendars -----------------------------------------------------------

export async function saveCalendar(cal) {
  if (cal.id) {
    setCalendars(calendars.value.map((c) => (c.id === cal.id ? { ...c, ...cal } : c)))
    const { id, ...patch } = cal
    await jm([['Calendar/set', { update: { [id]: patch } }]]).catch((e) => toast(e.message, 'error'))
  } else {
    const [r] = await jm([['Calendar/set', { create: { n: { name: cal.name, color: cal.color, isVisible: true } } }]])
    if (!r.created?.n) throw new Error(r.notCreated?.n?.description || "That calendar couldn't be created.")
    setCalendars([...calendars.value, { ...cal, id: r.created.n.id, isVisible: true }])
  }
}

export async function deleteCalendar(cal) {
  setCalendars(calendars.value.filter((c) => c.id !== cal.id))
  setEvents(Object.fromEntries(Object.entries(events.value).filter(([, e]) => !e.calendarIds?.[cal.id])))
  await jm([['Calendar/set', { destroy: [cal.id], onDestroyRemoveEvents: true }]]).catch((e) => toast(e.message, 'error'))
}

// --- people in an event ---------------------------------------------------

// The signed-in person, as invite.js needs them.
const me = () => ({ name: user.value?.name || '', email: user.value?.email || '' })
export const myAddress = () => me().email.toLowerCase()
export const myPart = (ev) => partOf(ev, me())
export const isOrganizer = (ev) => organizes(ev, me())
// joinMeeting opens a meeting link: one of ours in place, any other in a tab.
export function joinMeeting(link) {
  const here = location.origin + '/meet/'
  if (link.startsWith(here)) navigate('/meet/' + link.slice(here.length))
  else window.open(link, '_blank', 'noopener')
}

// --- occurrences ----------------------------------------------------------

const cache = new Map()

// occurrences lists everything that happens between two instants, repeating
// events unrolled, in the viewer's own time.
export function occurrences(from, to) {
  const key = from + ':' + to
  let out = cache.get(key)
  if (out) return out
  out = expandEvents(Object.values(events.value), from, to, localZone).map((o) => {
    const cal = calendarOf(o.inst)
    return { ...o, calId: cal?.id, color: o.inst.color || colorOf(cal) }
  })
  if (cache.size > 24) cache.clear()
  cache.set(key, out)
  return out
}

export const visible = (list) => {
  const hidden = new Set(calendars.value.filter((c) => c.isVisible === false).map((c) => c.id))
  return hidden.size ? list.filter((o) => !hidden.has(o.calId)) : list
}

// --- writing --------------------------------------------------------------

const SERVER_SET = new Set(['id', '@type', 'uid', 'created', 'updated', 'sequence', 'isOrigin', 'isDraft', 'version', 'useDefaultAlerts', 'mayInviteSelf', 'mayInviteOthers', 'hideAttendees', 'baseEventId', 'utcStart', 'utcEnd', 'method', 'iCalendar'])

function diff(prev, next) {
  const patch = {}
  for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (SERVER_SET.has(k)) continue
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) patch[k] = next[k] === undefined ? null : next[k]
  }
  return patch
}

const hold = (id, n) => busy.set(id, (busy.get(id) || 0) + n)
const chains = new Map() // per event: its writes go out in order

function queue(id, fn) {
  hold(id, 1)
  const run = (chains.get(id) || Promise.resolve()).then(fn).finally(() => hold(id, -1))
  chains.set(id, run.catch(() => {}))
  return run
}

function put(ev) {
  setEvents({ ...events.value, [ev.id]: ev })
}

function failed(e, undo) {
  toast(e.message || "That change couldn't be saved.", 'error')
  undo?.()
  syncCalendar()
}

export function blankEvent(start, end, allDay) {
  const tz = localZone
  const wall = wallIn(start, tz)
  const cal = defaultCalendar()
  return {
    '@type': 'Event',
    uid: crypto.randomUUID() + '@' + (boot.value?.mailDomain || 'opensuite'),
    calendarIds: cal ? { [cal.id]: true } : {},
    title: '',
    start: formatWall(allDay ? wallIn(startOfDay(start), tz) : wall),
    duration: allDay ? `P${Math.max(1, Math.round((end - start) / DAY))}D` : formatDuration(end - start),
    ...(allDay ? { showWithoutTime: true } : { timeZone: tz, alerts: { a1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT10M' }, action: 'display' } } }),
  }
}

// saveEvent stores a new event or the changes to an existing one, then
// tells the guests. `prev` is the event as it was before editing.
export function saveEvent(ev, prev) {
  if (!prev) {
    const local = { ...ev, id: 'tmp-' + newId(10), isOrigin: true }
    put(local)
    queue(local.id, async () => {
      const { id, isOrigin, ...body } = local
      const [r] = await jm([['CalendarEvent/set', { create: { n: body } }]])
      const made = r.created?.n
      if (!made) throw new Error(r.notCreated?.n?.description || "That event couldn't be saved.")
      alias.set(local.id, made.id)
      const { [local.id]: mine, ...rest } = events.value
      const stored = { ...(mine || local), ...made }
      setEvents({ ...rest, [made.id]: stored })
      await notifyGuests(stored, null)
    }).catch((e) => failed(e, () => {
      const { [local.id]: _, ...rest } = events.value
      setEvents(rest)
    }))
    return local
  }
  if (alias.has(ev.id)) ev = { ...ev, id: real(ev.id) }
  ev = reanswered(ev, prev, me())
  const patch = diff(prev, ev)
  if (!Object.keys(patch).length) return ev
  put(ev)
  queue(ev.id, async () => {
    const id = real(ev.id)
    const [r] = await jm([['CalendarEvent/set', { update: { [id]: patch } }]])
    if (r.notUpdated?.[id]) throw new Error(r.notUpdated[id].description || "That change couldn't be saved.")
    const stored = { ...(events.value[id] || ev), ...(r.updated?.[id] || {}), id }
    put(stored)
    await notifyGuests(stored, prev)
  }).catch((e) => failed(e, () => put(prev)))
  return ev
}

// changeOccurrence applies a change to one occurrence of a repeating event
// (scope 'one') or to the whole event.
export function changeOccurrence(occ, changes, scope = 'all') {
  const ev = events.value[real(occ.id)] || occ.ev
  if (occ.rid && scope === 'one') {
    const cur = ev.recurrenceOverrides?.[occ.rid] || {}
    return saveEvent({ ...ev, recurrenceOverrides: { ...ev.recurrenceOverrides, [occ.rid]: { ...cur, ...changes } } }, ev)
  }
  const next = { ...ev, ...changes }
  // Moving the whole series: shift its first day by the same amount.
  if (occ.rid && changes.start) next.start = formatWall(parseWall(ev.start) + (parseWall(changes.start) - parseWall(occ.rid)))
  return saveEvent(next, ev)
}

export function deleteOccurrence(occ, scope = 'all') {
  const ev = events.value[real(occ.id)] || occ.ev
  if (occ.rid && scope === 'one') {
    return saveEvent({ ...ev, recurrenceOverrides: { ...ev.recurrenceOverrides, [occ.rid]: { excluded: true } } }, ev)
  }
  const { [ev.id]: gone, ...rest } = events.value
  setEvents(rest)
  queue(ev.id, async () => {
    const id = real(ev.id)
    // Guests hear that it is off; an organiser hears that I am not coming.
    // Either way the event goes, and only the organiser hears of a failure.
    try {
      await deliver(deleteMails(ev, me(), localZone))
    } catch (e) {
      if (isOrganizer(ev)) unsent(e)
    }
    await jm([['CalendarEvent/set', { destroy: [id] }]])
  }).catch((e) => failed(e, () => put(ev)))
}

// rsvp records my answer to an invitation and tells the organiser.
export function rsvp(ev, status) {
  const mine = myPart(ev)
  if (!mine) return
  const next = answered(ev, status, me())
  put(next)
  queue(ev.id, async () => {
    const id = real(ev.id)
    const [r] = await jm([['CalendarEvent/set', { update: { [id]: { [`participants/${mine.key}/participationStatus`]: status } } }]])
    if (r.notUpdated?.[id]) throw new Error(r.notUpdated[id].description || "Your answer couldn't be saved.")
    await deliver(replyMails(next, status, me(), localZone))
  }).catch((e) => failed(e, () => put(ev)))
}

// importInvitation adds an event that arrived by mail but is not yet in the
// calendar (parsed from the message's calendar part), and returns it.
export async function importInvitation(blobId) {
  const [p] = await jm([['CalendarEvent/parse', { blobIds: [blobId] }]])
  const parsed = p.parsed?.[blobId]?.[0]
  const cal = defaultCalendar()
  if (!parsed || !cal) throw new Error("That invitation couldn't be read.")
  const body = Object.fromEntries(Object.entries(parsed).filter(([k, v]) => v !== null && !SERVER_SET.has(k) && k !== 'calendarIds'))
  if (body.recurrenceRule === undefined) delete body.recurrenceRule
  const [r] = await jm([['CalendarEvent/set', { create: { n: { ...body, uid: parsed.uid, calendarIds: { [cal.id]: true } } } }]])
  if (!r.created?.n) throw new Error(r.notCreated?.n?.description || "That invitation couldn't be added.")
  const ev = { ...body, uid: parsed.uid, calendarIds: { [cal.id]: true }, ...r.created.n }
  put(ev)
  return ev
}

export const findByUid = (uid) => Object.values(events.value).find((e) => e.uid === uid)

// --- invitations by mail ----------------------------------------------------
// The mails themselves are written by invite.js; this sends them.

async function deliver(mails) {
  for (const m of mails) await submit(m)
}

async function submit({ to, raw }) {
  const from = me()
  const up = await api('POST', '/api/mail/upload', new Blob([raw]), { type: 'message/rfc822', passive: true })
  const sent = boxByRole('sent')?.id || (await ensureMailbox('sent', 'Sent'))
  let idn = identity.value?.id
  if (!idn) idn = (await jm([['Identity/get', {}]]))[0].list?.[0]?.id
  const [imp, sub] = await jm([
    ['Email/import', { emails: { m: { blobId: up.blobId, mailboxIds: { [sent]: true }, keywords: { $seen: true } } } }],
    // The calendar is the record of an invitation; no copy stays in Sent.
    // The envelope names the recipients, so the server can check them
    // without reading the uploaded message.
    ['EmailSubmission/set', {
      create: { s: { identityId: idn, emailId: '#m', envelope: { mailFrom: { email: from.email }, rcptTo: to.map((t) => ({ email: t.email })) } } },
      onSuccessDestroyEmail: ['#s'],
    }],
  ])
  const err = imp.notCreated?.m || sub.notCreated?.s
  if (err) throw new Error(err.description || 'The invitation could not be sent.')
}

const unsent = (e) => toast(e.message || 'The invitation could not be sent.', 'error')

// notifyGuests mails whoever needs to hear about a change I made as the
// organiser. A mail that fails is reported; the change itself stands.
async function notifyGuests(ev, prev) {
  try {
    await deliver(guestMails(ev, prev, me(), localZone))
  } catch (e) {
    unsent(e)
  }
}

// --- free/busy --------------------------------------------------------------

// busyTimes asks when colleagues are busy. Only people in this organisation
// have an answer; everyone else simply has no entry.
export async function busyTimes(emails, from, to) {
  const ids = emails.map((e) => people.value.find((p) => p.email.toLowerCase() === e.toLowerCase())?.id).filter(Boolean)
  if (!ids.length) return {}
  const res = await post('/api/calendar/freebusy', { people: ids, from: new Date(from).toISOString(), to: new Date(to).toISOString() }, { passive: true })
  const out = {}
  for (const p of people.value) if (res.busy?.[p.id]) out[p.email.toLowerCase()] = res.busy[p.id]
  return out
}

// --- reminders ----------------------------------------------------------------

const FIRED = 'os:cal-fired'
let fired = null
function firedSet() {
  if (!fired) {
    try {
      fired = JSON.parse(localStorage.getItem(FIRED)) || {}
    } catch {
      fired = {}
    }
  }
  return fired
}

const scheduleReminders = debounce(() => checkReminders(), 300)

// checkReminders shows a notice for every alert that has come due on an
// event that is not yet over. Each alert fires once per device.
export function checkReminders() {
  if (!user.value) return
  const now = Date.now()
  const seen = firedSet()
  let changed = false
  for (const o of visible(occurrences(now - DAY, now + 2 * DAY))) {
    if (o.end <= now || (myPart(o.inst) && myPart(o.inst).status === 'declined')) continue
    for (const [aid, a] of Object.entries(o.inst.alerts || {})) {
      const off = parseDuration(a.trigger?.offset)
      const at = (a.trigger?.relativeTo === 'end' ? o.end : o.start) + off
      const key = o.key + '|' + aid + '|' + o.start
      if (a.trigger?.['@type'] !== 'OffsetTrigger' || now < at || seen[key]) continue
      seen[key] = now
      changed = true
      if (now - at > 6 * 3600000) continue // long past: note it, show nothing
      const r = { key, title: o.title, start: o.start, end: o.end, allDay: o.allDay, link: meetingLink(o.inst), place: placeOf(o.inst) }
      reminders.value = [...reminders.value.filter((x) => x.key !== key), r]
      if (window.Notification?.permission === 'granted' && document.visibilityState !== 'visible') {
        try {
          new Notification(o.title, { body: span(o.start, o.end, o.allDay), tag: key })
        } catch {}
      }
    }
  }
  if (changed) {
    for (const k of Object.keys(seen)) if (now - seen[k] > 14 * DAY) delete seen[k]
    try {
      localStorage.setItem(FIRED, JSON.stringify(seen))
    } catch {}
  }
}

export const dismissReminder = (key) => (reminders.value = reminders.value.filter((r) => r.key !== key))

// today lists what is still to come today, for the home screen.
export function today() {
  const now = Date.now()
  const from = startOfDay(now)
  return visible(occurrences(from, from + DAY)).filter((o) => o.allDay || o.end > now - 5 * MIN)
}
