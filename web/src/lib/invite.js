// Who takes part in an event, and the invitation mails a change to it sends.
// The calendar (calendar.js) and the server's headless engine (src/headless/)
// both write their mails here, so a change made in the app and one made
// through the API tell guests exactly the same thing.
//
// `me` is { name, email } of whoever makes the change; `zone` is the time
// zone the mail's text is written in (the viewer's own, in the app).
import { escapeHtml } from './util.js'
import { DAY, parseWall, instantOf, parseDuration, span, zoneLabel } from './time.js'
import { describeRule } from './rrule.js'
import { toICS, buildMail, addressOf } from './ics.js'

const addressOfMe = (me) => (me.email || '').toLowerCase()

export const guestsOf = (ev) => Object.entries(ev.participants || {}).map(([key, p]) => ({ key, name: p.name || '', email: addressOf(p), status: p.participationStatus || 'needs-action', owner: !!p.roles?.owner }))
export const partOf = (ev, me) => guestsOf(ev).find((g) => g.email === addressOfMe(me))
// An event with no guests is simply mine; with guests, the one who wrote it
// organises and everyone else answers.
export function organizes(ev, me) {
  if (!ev.participants || !Object.keys(ev.participants).length) return true
  const org = (ev.organizerCalendarAddress || '').replace(/^mailto:/i, '').toLowerCase()
  return org ? org === addressOfMe(me) : !!partOf(ev, me)?.owner
}
export const organizerOf = (ev) => guestsOf(ev).find((g) => g.owner) || { email: (ev.organizerCalendarAddress || '').replace(/^mailto:/i, ''), name: '' }

// An invitation written elsewhere may carry its meeting link only as text;
// links of the well-known kinds are recognised so the event still gets a
// Join button.
const MEETING = /https?:\/\/[^\s<>"]*(?:\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}\b|meet\.google\.com\/|zoom\.us\/j\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet\/|whereby\.com\/|meet\.jit\.si\/)[^\s<>"]*/i
export const meetingLink = (ev) => Object.values(ev.virtualLocations || {})[0]?.uri || ((Object.values(ev.locations || {})[0]?.name || '') + '\n' + (ev.description || '')).match(MEETING)?.[0] || ''
// The description without the "Join:" line that invitations carry for
// calendars which show nothing else.
export const notesOf = (ev) => (ev.description || '').replace(/\n*Join: https?:\/\/\S+\s*$/, '').trim()
export function placeOf(ev) {
  const name = Object.values(ev.locations || {})[0]?.name || ''
  return /^https?:\/\/\S+$/.test(name) ? '' : name // a bare link is a meeting, not a place
}
export const repeatText = (ev) => describeRule(ev.recurrenceRule, parseWall(ev.start))

// answered is an event with my answer to it.
export function answered(ev, status, me) {
  const mine = partOf(ev, me)
  return mine ? { ...ev, participants: { ...ev.participants, [mine.key]: { ...ev.participants[mine.key], participationStatus: status } } } : ev
}

// reanswered is an event as its organiser saves it: a new time needs new
// answers from the guests.
export function reanswered(ev, prev, me) {
  const timing = (e) => JSON.stringify([e.start, e.duration, e.timeZone, e.showWithoutTime, e.recurrenceRule])
  if (!ev.participants || !organizes(ev, me) || timing(ev) === timing(prev)) return ev
  return { ...ev, participants: Object.fromEntries(Object.entries(ev.participants).map(([k, p]) => [k, addressOf(p) === addressOfMe(me) ? p : { ...p, participationStatus: 'needs-action', expectReply: true }])) }
}

// --- the mails ----------------------------------------------------------------

const statusWord = { accepted: 'Accepted', declined: 'Declined', tentative: 'Maybe' }

function whenText(ev, zone) {
  const allDay = !!ev.showWithoutTime
  const tz = allDay ? zone : ev.timeZone || zone
  const wall = parseWall(ev.start)
  const dur = parseDuration(ev.duration) || (allDay ? DAY : 0)
  const start = instantOf(wall, tz)
  let text = span(start, allDay ? instantOf(wall + dur, tz) : start + dur, allDay, zone)
  if (!allDay) text += ` (${zoneLabel(tz)})`
  const repeat = repeatText(ev)
  return repeat ? `${text}. ${repeat}` : text
}

function mailBody(ev, lead, zone) {
  const rows = [['When', whenText(ev, zone)]]
  if (placeOf(ev)) rows.push(['Where', placeOf(ev)])
  const link = meetingLink(ev)
  if (link) rows.push(['Join', link])
  const guests = guestsOf(ev).map((g) => g.name || g.email).join(', ')
  if (guests) rows.push(['Guests', guests])
  const title = ev.title || '(no title)'
  const text = [lead, '', title, ...rows.map(([k, v]) => `${k}: ${v}`), ev.description ? '\n' + ev.description : ''].join('\n')
  const cell = (v) => (/^https?:\/\//.test(v) ? `<a href="${escapeHtml(v)}" style="color:#1269e8">${escapeHtml(v)}</a>` : escapeHtml(v))
  const html = `<div style="font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#102033;max-width:560px">
<p style="margin:0 0 14px;color:#617385">${escapeHtml(lead)}</p>
<div style="border:1px solid #e2e8ef;border-radius:12px;padding:18px 20px">
<div style="font-size:18px;font-weight:650;margin-bottom:10px">${escapeHtml(title)}</div>
<table style="border-collapse:collapse;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:3px 14px 3px 0;color:#617385;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:3px 0">${cell(v)}</td></tr>`).join('')}</table>
${ev.description ? `<p style="margin:12px 0 0;white-space:pre-wrap">${escapeHtml(ev.description)}</p>` : ''}
</div></div>`
  return { text, html }
}

// Each mail is { to: [{ name, email }], subject, raw (the whole message) }.
function mail(me, zone, { to, subject, lead, ev, method, only }) {
  const { text, html } = mailBody(ev, lead, zone)
  return { to, subject, raw: buildMail({ from: me, to, subject, text, html, method, ics: toICS(ev, { method, only, zone }) }) }
}

const others = (ev, me) => guestsOf(ev).filter((g) => g.email && g.email !== addressOfMe(me))

// guestMails is what I send as the organiser when I save an event (`prev`
// is how it was, or null when it is new) or delete one (ev null): new and
// existing guests get the event, removed guests (or all, when the event is
// deleted) a cancellation.
export function guestMails(ev, prev, me, zone) {
  const out = []
  const send = (m) => m.to.length && out.push(mail(me, zone, m))
  if (!ev) {
    if (organizes(prev, me)) send({ to: others(prev, me), subject: 'Cancelled: ' + (prev.title || '(no title)'), lead: `${me.name} cancelled this event.`, ev: prev, method: 'CANCEL' })
    return out
  }
  if (!organizes(ev, me)) return out
  const now = others(ev, me)
  const before = prev && organizes(prev, me) ? others(prev, me) : []
  const dropped = before.filter((g) => !now.find((n) => n.email === g.email))
  send({ to: dropped, subject: 'Cancelled: ' + (prev?.title || '(no title)'), lead: `${me.name} removed you from this event.`, ev: prev, method: 'CANCEL' })
  // Only what guests can see is worth a new message.
  const shown = (e) => JSON.stringify([e.title, e.start, e.duration, e.timeZone, e.showWithoutTime, e.recurrenceRule, e.recurrenceOverrides, e.locations, e.virtualLocations, e.description, others(e, me).map((g) => g.email)])
  if (prev && before.length && shown(prev) === shown(ev)) return out
  const fresh = !prev || !before.length
  send({ to: now, subject: (fresh ? 'Invitation: ' : 'Updated invitation: ') + (ev.title || '(no title)'), lead: fresh ? `${me.name} invited you to an event.` : `${me.name} changed this event.`, ev, method: 'REQUEST' })
  return out
}

// replyMails tells the organiser my answer; `ev` already carries it.
export function replyMails(ev, status, me, zone) {
  const org = organizerOf(ev)
  if (!org.email || org.email === addressOfMe(me)) return []
  return [mail(me, zone, {
    to: [org], subject: `${statusWord[status] || 'Answer'}: ${ev.title || '(no title)'}`,
    lead: `${me.name} ${status === 'accepted' ? 'accepted' : status === 'declined' ? 'declined' : 'might attend'} this event.`,
    ev, method: 'REPLY', only: addressOfMe(me),
  })]
}

// deleteMails is what deleting an event sends: guests hear that it is off;
// an organiser hears that I am not coming.
export function deleteMails(ev, me, zone) {
  if (organizes(ev, me)) return guestMails(null, ev, me, zone)
  const part = partOf(ev, me)
  return part && part.status !== 'declined' ? replyMails(ev, 'declined', me, zone) : []
}
