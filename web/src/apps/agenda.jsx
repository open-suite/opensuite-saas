// The parts of the calendar that show outside the calendar screen: today's
// agenda on the home page, reminders wherever the person is, and the
// invitation card inside a mail message.
import { useEffect, useState } from 'preact/hooks'
import { Bell, CalendarDays, CalendarCheck, CalendarX, MapPin, Video, X } from 'lucide-preact'
import './agenda.css'
import { toast } from '../lib/store.js'
import { cx } from '../lib/util.js'
import { Button, IconButton } from '../ui.jsx'
import {
  calendars, events, reminders, dismissReminder, today, joinMeeting, meetingLink, placeOf, findByUid, myPart, myAddress, isOrganizer, rsvp,
  importInvitation, syncCalendar, deleteOccurrence,
} from '../lib/calendar.js'
import { parseICS } from '../lib/ics.js'
import { span, hhmm, dateKey } from '../lib/time.js'

export function AgendaCard() {
  // Read both so the card follows the calendar as it changes.
  const all = events.value
  const cals = calendars.value
  const list = all && cals ? today() : []
  const now = Date.now()
  return (
    <section class="card wide agenda-card">
      <div class="card-head"><h2>Today</h2><a href="/calendar">Open calendar</a></div>
      {list.length === 0 ? (
        <div class="list-row agenda-none"><CalendarDays size={18} /><span class="grow">Nothing planned for the rest of today.</span><a class="btn" href="/calendar?new=1">New event</a></div>
      ) : list.slice(0, 6).map((o) => {
        const link = meetingLink(o.inst)
        const live = !o.allDay && o.start <= now + 10 * 60000 && o.end > now
        return (
          <a class="list-row" href={'/calendar?day=' + dateKey(Math.max(o.start, now))} key={o.key}>
            <span class="agenda-time">{o.allDay ? 'All day' : hhmm(o.start)}<i style={{ background: o.color }} /></span>
            <span class="grow" style={{ minWidth: 0 }}>
              <div class="ellipsis" style={{ fontWeight: 600 }}>{o.title}</div>
              <div class="sub ellipsis">{o.allDay ? '' : `until ${hhmm(o.end)}`}{placeOf(o.inst) && (o.allDay ? '' : ' · ') + placeOf(o.inst)}</div>
            </span>
            {link && <Button kind={live ? 'primary' : 'default'} icon={Video} onClick={(e) => { e.preventDefault(); e.stopPropagation(); joinMeeting(link) }}>Join</Button>}
          </a>
        )
      })}
    </section>
  )
}

export function Reminders() {
  const list = reminders.value
  if (!list.length) return null
  return (
    <div class="reminders" role="alert">
      {list.map((r) => (
        <div class="reminder" key={r.key}>
          <Bell size={17} />
          <div class="grow" style={{ minWidth: 0 }}>
            <div class="ellipsis" style={{ fontWeight: 650 }}>{r.title}</div>
            <div class="sub ellipsis">{span(r.start, r.end, r.allDay)}{r.place && ' · ' + r.place}</div>
          </div>
          {r.link && <Button kind="primary" onClick={() => { dismissReminder(r.key); joinMeeting(r.link) }}>Join</Button>}
          <IconButton icon={X} label="Dismiss" onClick={() => dismissReminder(r.key)} />
        </div>
      ))}
    </div>
  )
}

// --- invitations in mail -----------------------------------------------------

const parsed = new Map() // blob id -> parsed calendar message
const isCalendar = (a) => a.type === 'text/calendar' || a.type === 'application/ics' || /\.ics$/i.test(a.name || '')
export const calendarPart = (email) => (email.attachments || []).find(isCalendar)
// The card stands for the calendar parts, so they are not listed as files.
export const notCalendar = (a) => !isCalendar(a)

const verb = { accepted: 'accepted', declined: 'declined', tentative: 'might attend' }

export function Invitation({ email }) {
  const part = calendarPart(email)
  const [inv, setInv] = useState(part ? parsed.get(part.blobId) : null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!part || parsed.has(part.blobId)) return setInv(part ? parsed.get(part.blobId) : null)
    let live = true
    fetch(`/api/mail/blob/${part.blobId}/invite.ics?type=text%2Fcalendar&dl=1`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        const p = text ? parseICS(text) : null
        parsed.set(part.blobId, p)
        if (live) setInv(p)
      })
      .catch(() => {})
    return () => (live = false)
  }, [part?.blobId])
  const all = events.value // follow the calendar: answers show at once
  if (!part || !inv || !inv.start) return null
  const ev = all && findByUid(inv.uid)
  const mine = ev && myPart(ev)
  const me = myAddress()
  const invited = inv.attendees.some((a) => a.email === me)
  const fromMe = inv.organizer?.email === me
  const open = <a class="btn btn-ghost" href={'/calendar?day=' + dateKey(inv.start)}>Open calendar</a>

  const answer = async (status) => {
    setBusy(true)
    try {
      let target = ev
      if (!target) {
        await syncCalendar()
        target = findByUid(inv.uid) || (await importInvitation(part.blobId))
      }
      if (!myPart(target)) throw new Error('This invitation was sent to a different address.')
      rsvp(target, status)
    } catch (e) {
      toast(e.message, 'error')
    }
    setBusy(false)
  }

  let body
  let Icon = CalendarDays
  if (inv.method === 'REPLY') {
    const who = inv.attendees[0]
    Icon = who?.status === 'declined' ? CalendarX : CalendarCheck
    body = <div class="inv-actions"><span class="grow">{who?.name || who?.email || 'A guest'} {verb[who?.status] || 'answered'}.</span>{open}</div>
  } else if (inv.method === 'CANCEL' || inv.cancelled) {
    Icon = CalendarX
    body = (
      <div class="inv-actions"><span class="grow">This event was cancelled.</span>
        {ev && !isOrganizer(ev) && <Button onClick={() => deleteOccurrence({ id: ev.id, ev, rid: null })}>Remove from calendar</Button>}
      </div>
    )
  } else if (fromMe) {
    body = <div class="inv-actions"><span class="grow muted">You organised this event.</span>{open}</div>
  } else if (invited || mine) {
    const status = mine?.status || 'needs-action'
    const opt = (s, label) => <button class={cx('rsvp-btn', status === s && 'on')} disabled={busy} aria-pressed={status === s} onClick={() => answer(s)}>{label}</button>
    body = <div class="inv-actions"><span class="grow" style={{ fontWeight: 600 }}>Going?</span>{opt('accepted', 'Accept')}{opt('tentative', 'Maybe')}{opt('declined', 'Decline')}{open}</div>
  } else {
    body = <div class="inv-actions"><span class="grow muted">Calendar event</span>{open}</div>
  }
  return (
    <div class="inv" aria-label="Invitation">
      <div class="inv-icon"><Icon size={20} /></div>
      <div class="grow" style={{ minWidth: 0 }}>
        <div class="inv-title">{inv.title || '(no title)'}</div>
        <div class="inv-when">{span(inv.start, inv.end, inv.allDay)}{inv.repeats && ' · repeats'}</div>
        {inv.location && <div class="inv-where ellipsis"><MapPin size={13} />{inv.location}</div>}
        {inv.method !== 'REPLY' && inv.organizer && !fromMe && <div class="muted ellipsis">Organised by {inv.organizer.name || inv.organizer.email}</div>}
        {body}
      </div>
    </div>
  )
}
