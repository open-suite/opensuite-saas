// Calendar logic the server cannot do itself: unrolling repeating events and
// writing invitation mails, with the calendar screen's own code
// (lib/occurrences.js, lib/invite.js). The app takes the viewer's time zone
// from the browser; here it is passed in.
import { expandEvents } from '../lib/occurrences.js'
import { answered, reanswered, guestMails, replyMails, deleteMails, partOf } from '../lib/invite.js'
import { arg, oneOf, person, toB64 } from './wire.js'

function zone(args) {
  const z = arg(args, 'zone', 'string')
  try {
    new Intl.DateTimeFormat('en', { timeZone: z })
  } catch {
    throw new Error(`Unknown time zone ${JSON.stringify(z)}`)
  }
  return z
}

const sender = (args) => person(args, 'me', ['name', 'email'])

function events(args, key) {
  const list = arg(args, key, 'array')
  if (list.some((e) => e === null || typeof e !== 'object' || Array.isArray(e))) throw new Error(`${key} must be an array of events`)
  return list
}

const mailJSON = (m) => ({ to: m.to.map((t) => ({ name: t.name || '', email: t.email })), subject: m.subject, raw: toB64(new TextEncoder().encode(m.raw)) })

export const calendarOps = {
  'calendar.occurrences': (args) => ({
    occurrences: expandEvents(events(args, 'events'), arg(args, 'from', 'number'), arg(args, 'to', 'number'), zone(args))
      .map((o) => ({ id: o.id, recurrenceId: o.rid, start: o.start, end: o.end, allDay: o.allDay, title: o.title })),
  }),

  // The event as the organiser stores it, before the mails for it are
  // written: a new time asks the guests to answer again.
  'calendar.reanswer': (args) => ({ ev: reanswered(arg(args, 'ev', 'object'), arg(args, 'prev', 'object'), sender(args)) }),

  // The mails one change sends, in order: "save" (ev as stored, prev as it
  // was or null when new), "delete" (ev) or "rsvp" (ev and my status).
  'calendar.mails': (args) => {
    const kind = oneOf(args, 'kind', ['save', 'delete', 'rsvp'])
    const me = sender(args)
    const z = zone(args)
    const ev = arg(args, 'ev', 'object')
    let mails
    if (kind === 'save') mails = guestMails(ev, arg(args, 'prev', 'object', true) ?? null, me, z)
    else if (kind === 'delete') mails = deleteMails(ev, me, z)
    else {
      const status = oneOf(args, 'status', ['accepted', 'declined', 'tentative'])
      if (!partOf(ev, me)) throw new Error(`${me.email} is not a guest of this event`)
      mails = replyMails(answered(ev, status, me), status, me, z)
    }
    return { mails: mails.map(mailJSON) }
  },
}
