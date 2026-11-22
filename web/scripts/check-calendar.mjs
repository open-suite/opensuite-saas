// Checks for the calendar's date arithmetic, repeat rules and the invitation
// format. Plain Node, no browser:
//   node web/scripts/check-calendar.mjs
// Run it under a few zones to be sure nothing depends on the machine's own:
//   TZ=America/New_York node web/scripts/check-calendar.mjs
import assert from 'node:assert/strict'
import { parseWall, formatWall, wallIn, instantOf, parseDuration, formatDuration, DAY, MIN } from '../src/lib/time.js'
import { expandRule, describeRule, applyPatch } from '../src/lib/rrule.js'
import { toICS, parseICS, buildMail } from '../src/lib/ics.js'

const utc = (s) => Date.parse(s)
const walls = (list) => list.map((w) => formatWall(w))

// --- time zones ----------------------------------------------------------------
assert.equal(instantOf(parseWall('2026-11-25T14:00:00'), 'Europe/Amsterdam'), utc('2026-11-25T13:00:00Z'))
assert.equal(instantOf(parseWall('2026-07-01T09:30:00'), 'Europe/Amsterdam'), utc('2026-07-01T07:30:00Z'))
assert.equal(instantOf(parseWall('2026-07-01T09:30:00'), 'America/New_York'), utc('2026-07-01T13:30:00Z'))
assert.equal(instantOf(parseWall('2026-01-15T00:00:00'), 'Asia/Kolkata'), utc('2026-01-14T18:30:00Z'))
assert.equal(formatWall(wallIn(utc('2026-11-25T13:00:00Z'), 'Europe/Amsterdam')), '2026-11-25T14:00:00')
assert.equal(formatWall(wallIn(utc('2026-03-29T01:30:00Z'), 'Europe/Amsterdam')), '2026-03-29T03:30:00') // just after the spring change
// Local wall time round-trips whatever zone this machine is in.
const local = parseWall('2026-06-10T08:15:00')
assert.equal(wallIn(instantOf(local, null), null), local)

// --- durations -----------------------------------------------------------------
assert.equal(parseDuration('PT1H30M'), 90 * MIN)
assert.equal(parseDuration('P2D'), 2 * DAY)
assert.equal(parseDuration('-PT10M'), -10 * MIN)
assert.equal(parseDuration('P1W'), 7 * DAY)
assert.equal(formatDuration(90 * MIN), 'PT1H30M')
assert.equal(formatDuration(2 * DAY), 'P2D')
assert.equal(formatDuration(30 * MIN), 'PT30M')
assert.equal(formatDuration(DAY + 60 * MIN), 'P1DT1H')

// --- repeat rules ---------------------------------------------------------------
const start = parseWall('2026-11-23T09:00:00') // a Monday
const far = parseWall('2030-01-01T00:00:00')
assert.deepEqual(walls(expandRule(start, { frequency: 'daily', count: 3 }, start, far)), ['2026-11-23T09:00:00', '2026-11-24T09:00:00', '2026-11-25T09:00:00'])
assert.deepEqual(walls(expandRule(start, { frequency: 'weekly', count: 4, byDay: [{ day: 'mo' }, { day: 'we' }] }, start, far)),
  ['2026-11-23T09:00:00', '2026-11-25T09:00:00', '2026-11-30T09:00:00', '2026-12-02T09:00:00'])
// A window in the middle: the count is still kept from the first occurrence.
assert.deepEqual(walls(expandRule(start, { frequency: 'weekly', count: 4, byDay: [{ day: 'mo' }, { day: 'we' }] }, parseWall('2026-11-29T00:00:00'), far)),
  ['2026-11-30T09:00:00', '2026-12-02T09:00:00'])
assert.deepEqual(walls(expandRule(start, { frequency: 'weekly', interval: 2 }, start, parseWall('2026-12-31T00:00:00'))), ['2026-11-23T09:00:00', '2026-12-07T09:00:00', '2026-12-21T09:00:00'])
assert.deepEqual(walls(expandRule(start, { frequency: 'weekly', until: '2026-12-07T23:59:59' }, start, far)), ['2026-11-23T09:00:00', '2026-11-30T09:00:00', '2026-12-07T09:00:00'])
// Monthly on the 31st skips short months.
assert.deepEqual(walls(expandRule(parseWall('2026-01-31T10:00:00'), { frequency: 'monthly', count: 3 }, 0, far)), ['2026-01-31T10:00:00', '2026-03-31T10:00:00', '2026-05-31T10:00:00'])
// The fourth Monday, and the last Friday.
assert.deepEqual(walls(expandRule(start, { frequency: 'monthly', count: 3, byDay: [{ day: 'mo', nthOfPeriod: 4 }] }, start, far)), ['2026-11-23T09:00:00', '2026-12-28T09:00:00', '2027-01-25T09:00:00'])
assert.deepEqual(walls(expandRule(parseWall('2026-11-27T09:00:00'), { frequency: 'monthly', count: 2, byDay: [{ day: 'fr', nthOfPeriod: -1 }] }, 0, far)), ['2026-11-27T09:00:00', '2026-12-25T09:00:00'])
assert.deepEqual(walls(expandRule(parseWall('2024-02-29T12:00:00'), { frequency: 'yearly', count: 2 }, 0, far)), ['2024-02-29T12:00:00', '2028-02-29T12:00:00'])
// An open-ended daily event years old is found without walking every day.
const old = expandRule(parseWall('2001-01-01T08:00:00'), { frequency: 'daily' }, parseWall('2026-11-22T00:00:00'), parseWall('2026-11-24T00:00:00'))
assert.deepEqual(walls(old), ['2026-11-22T08:00:00', '2026-11-23T08:00:00'])
// A repeating event keeps its clock time across a daylight saving change.
const spring = expandRule(parseWall('2026-03-27T09:00:00'), { frequency: 'daily', count: 4 }, 0, far)
assert.deepEqual(spring.map((w) => new Date(instantOf(w, 'Europe/Amsterdam')).toISOString().slice(11, 16)), ['08:00', '08:00', '07:00', '07:00'])

assert.equal(describeRule({ frequency: 'weekly', byDay: [{ day: 'we' }, { day: 'mo' }], count: 10 }, start), 'Weekly on Monday and Wednesday, 10 times')
assert.equal(describeRule({ frequency: 'weekly', byDay: ['mo', 'tu', 'we', 'th', 'fr'].map((day) => ({ day })) }, start), 'Every weekday')
assert.equal(describeRule({ frequency: 'monthly', byDay: [{ day: 'fr', nthOfPeriod: -1 }] }, start), 'Monthly on the last Friday')
assert.equal(describeRule({ frequency: 'daily', interval: 3 }, start), 'Every 3 days')
assert.deepEqual(applyPatch({ a: 1, p: { x: { s: 'no' } } }, { title: 'T', 'p/x/s': 'yes', a: null }), { p: { x: { s: 'yes' } }, title: 'T' })

// --- invitations ----------------------------------------------------------------
const ev = {
  uid: 'u1@office.test', title: 'Planning; with, punctuation', start: '2026-11-25T14:00:00', timeZone: 'Europe/Amsterdam', duration: 'PT1H', sequence: 2,
  description: 'Line one\nLine two', locations: { l1: { name: 'Room 4' } }, virtualLocations: { v1: { uri: 'https://office.test/meet/abc-defg-hij' } },
  recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'we' }], until: '2026-12-31T23:59:59' },
  recurrenceOverrides: { '2026-12-02T14:00:00': { excluded: true }, '2026-12-09T14:00:00': { start: '2026-12-09T16:00:00', title: 'Planning (late)' } },
  organizerCalendarAddress: 'mailto:ada@office.test',
  participants: {
    me: { name: 'Ada Lovelace', calendarAddress: 'mailto:ada@office.test', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
    g1: { name: 'Grace Hopper', calendarAddress: 'mailto:Grace.Hopper@office.test', roles: { attendee: true }, participationStatus: 'needs-action' },
  },
}
const ics = toICS(ev, { method: 'REQUEST' })
for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'line longer than 75 bytes: ' + line)
const flat = ics.replace(/\r\n /g, '')
assert.match(flat, /METHOD:REQUEST/)
assert.match(flat, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Amsterdam/)
assert.match(flat, /TZOFFSETFROM:\+0100\r\nTZOFFSETTO:\+0200\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU/)
assert.match(flat, /DTSTART;TZID=Europe\/Amsterdam:20261125T140000/)
assert.match(flat, /DTEND;TZID=Europe\/Amsterdam:20261125T150000/)
assert.match(flat, /SUMMARY:Planning\\; with\\, punctuation/)
assert.match(flat, /RRULE:FREQ=WEEKLY;UNTIL=20261231T225959Z;BYDAY=WE/)
assert.match(flat, /EXDATE;TZID=Europe\/Amsterdam:20261202T140000/)
assert.match(flat, /RECURRENCE-ID;TZID=Europe\/Amsterdam:20261209T140000\r\nDTSTART;TZID=Europe\/Amsterdam:20261209T160000/)
assert.match(flat, /ORGANIZER;CN="Ada Lovelace":mailto:ada@office.test/)
assert.match(flat, /ATTENDEE;CN="Grace Hopper";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:grace.hopper@office.test/)
assert.match(flat, /SEQUENCE:2/)
assert.match(flat, /CONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL="Open Suite meeting":https:\/\/office.test\/meet\/abc-defg-hij/)
assert.doesNotMatch(ics, /stalwart/i)

const back = parseICS(ics)
assert.equal(back.method, 'REQUEST')
assert.equal(back.uid, 'u1@office.test')
assert.equal(back.title, 'Planning; with, punctuation')
assert.equal(back.start, utc('2026-11-25T13:00:00Z'))
assert.equal(back.end, utc('2026-11-25T14:00:00Z'))
assert.equal(back.location, 'Room 4')
assert.equal(back.repeats, true)
assert.equal(back.organizer.email, 'ada@office.test')
assert.deepEqual(back.attendees.map((a) => [a.email, a.status]), [['ada@office.test', 'accepted'], ['grace.hopper@office.test', 'needs-action']])
assert.match(back.description, /Line one\nLine two/)

const reply = toICS({ ...ev, participants: { ...ev.participants, g1: { ...ev.participants.g1, participationStatus: 'declined' } } }, { method: 'REPLY', only: 'grace.hopper@office.test' })
const r = parseICS(reply)
assert.equal(r.method, 'REPLY')
assert.deepEqual(r.attendees, [{ name: 'Grace Hopper', email: 'grace.hopper@office.test', status: 'declined' }])
assert.doesNotMatch(reply, /RRULE:FREQ=WEEKLY|DESCRIPTION/)
assert.equal(parseICS(toICS(ev, { method: 'CANCEL' })).cancelled, true)

// All-day events carry dates, not times.
const day = toICS({ uid: 'd1', title: 'Holiday', start: '2026-11-27T00:00:00', duration: 'P2D', showWithoutTime: true }, { method: 'REQUEST' })
assert.match(day, /DTSTART;VALUE=DATE:20261127\r\nDTEND;VALUE=DATE:20261129/)
assert.doesNotMatch(day, /VTIMEZONE/)
const d = parseICS(day)
assert.equal(d.allDay, true)
assert.equal(d.end - d.start, 2 * DAY)

// A message written by another calendar program.
const foreign = parseICS(['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:x1', 'DTSTART:20261201T100000Z', 'DURATION:PT45M', 'SUMMARY:Call',
  'ORGANIZER;CN="Doe, Jane":MAILTO:Jane@Example.org', 'ATTENDEE;PARTSTAT=TENTATIVE;CN=Me:mailto:me@office.test', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\n'))
assert.equal(foreign.end - foreign.start, 45 * MIN)
assert.deepEqual(foreign.organizer, { name: 'Doe, Jane', email: 'jane@example.org', status: 'needs-action' })
assert.equal(foreign.attendees[0].status, 'tentative')

const mail = buildMail({ from: { name: 'Ada Lovelace', email: 'ada@office.test' }, to: [{ name: 'Zoë Ångström', email: 'zoe@example.org' }], subject: 'Invitation: Café ☕ meeting', text: 'Hi', html: '<p>Hi</p>', ics, method: 'REQUEST' })
assert.match(mail, /^From: "Ada Lovelace" <ada@office.test>\r\n/)
assert.match(mail, /\r\nTo: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <zoe@example.org>\r\n/)
assert.match(mail, /Content-Type: text\/calendar; charset=UTF-8; method=REQUEST/)
assert.match(mail, /Content-Disposition: attachment; filename="invite.ics"/)
for (const line of mail.split('\r\n')) assert.ok(line.length <= 78, 'mail line too long')

console.log('calendar checks pass in', Intl.DateTimeFormat().resolvedOptions().timeZone)
