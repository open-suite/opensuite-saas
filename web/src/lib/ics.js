// Invitations travel between calendars as iCalendar text inside ordinary
// mail. This module writes those messages (the invitation, the answer, the
// cancellation) and reads the ones that arrive.
import { DAY, MIN, pad, parseWall, formatWall, wallIn, instantOf, parseDuration, localZone } from './time.js'
import { applyPatch } from './rrule.js'

const CRLF = '\r\n'
const esc = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const quoted = (s = '') => '"' + String(s).replace(/["\r\n]/g, ' ') + '"'
const compact = (wall) => formatWall(wall).replace(/[-:]/g, '')
const utcStamp = (ms) => compact(ms) + 'Z' // formatWall reads UTC fields, so an instant prints as UTC
const enc = new TextEncoder()

// Lines are folded at 75 bytes, as the format requires.
function fold(line) {
  if (enc.encode(line).length <= 75) return line
  const out = []
  let cur = ''
  let n = 0
  for (const ch of line) {
    const w = enc.encode(ch).length
    if (n + w > (out.length ? 74 : 75)) {
      out.push(cur)
      cur = ''
      n = 0
    }
    cur += ch
    n += w
  }
  out.push(cur)
  return out.join(CRLF + ' ')
}

const offsetAt = (ms, tz) => Math.round((wallIn(ms, tz) - ms) / MIN)
const offsetText = (min) => (min < 0 ? '-' : '+') + pad(Math.floor(Math.abs(min) / 60)) + pad(Math.abs(min) % 60)

// timezoneBlock describes a zone's clock changes around a year, so that
// calendars which do not know the zone's name still place the event right.
function timezoneBlock(tz, year) {
  const lines = ['BEGIN:VTIMEZONE', 'TZID:' + tz]
  const changes = []
  let t = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  let prev = offsetAt(t, tz)
  for (let day = t + DAY; day <= end; day += DAY) {
    const cur = offsetAt(day, tz)
    if (cur === prev) continue
    let lo = day - DAY
    let hi = day
    while (hi - lo > MIN) {
      const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN
      if (offsetAt(mid, tz) === prev) lo = mid
      else hi = mid
    }
    changes.push({ at: hi, from: prev, to: cur })
    prev = cur
  }
  if (!changes.length) {
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:' + offsetText(prev), 'TZOFFSETTO:' + offsetText(prev), 'END:STANDARD')
  }
  for (const c of changes) {
    const kind = c.to > c.from ? 'DAYLIGHT' : 'STANDARD'
    const wall = c.at + c.from * MIN // the clock reading at which the change happens
    const d = new Date(wall)
    const dom = d.getUTCDate()
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    const nth = dom + 7 > lastDay ? -1 : Math.ceil(dom / 7)
    const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][d.getUTCDay()]
    lines.push('BEGIN:' + kind, 'DTSTART:' + compact(wall), 'TZOFFSETFROM:' + offsetText(c.from), 'TZOFFSETTO:' + offsetText(c.to),
      `RRULE:FREQ=YEARLY;BYMONTH=${d.getUTCMonth() + 1};BYDAY=${nth}${wd}`, 'END:' + kind)
  }
  lines.push('END:VTIMEZONE')
  return lines
}

function rruleText(rule, ev, zone) {
  const parts = ['FREQ=' + rule.frequency.toUpperCase()]
  if (rule.interval > 1) parts.push('INTERVAL=' + rule.interval)
  if (rule.count) parts.push('COUNT=' + rule.count)
  else if (rule.until) {
    const wall = parseWall(rule.until)
    parts.push('UNTIL=' + (ev.showWithoutTime ? compact(wall).slice(0, 8) : utcStamp(instantOf(wall, ev.timeZone || zone))))
  }
  if (rule.byDay?.length) parts.push('BYDAY=' + rule.byDay.map((b) => (b.nthOfPeriod || '') + b.day.toUpperCase()).join(','))
  if (rule.byMonthDay?.length) parts.push('BYMONTHDAY=' + rule.byMonthDay.join(','))
  if (rule.byMonth?.length) parts.push('BYMONTH=' + rule.byMonth.map((m) => parseInt(m, 10)).join(','))
  return parts.join(';')
}

const mailOf = (addr = '') => addr.replace(/^mailto:/i, '').toLowerCase()
export const addressOf = (p) => mailOf(p?.calendarAddress || p?.sendTo?.imip || '')

// when writes a date property in the form the event uses; a time without a
// zone of its own is read in `zone`.
function when(name, wallText, ev, zone) {
  const wall = parseWall(wallText)
  if (ev.showWithoutTime) return `${name};VALUE=DATE:${compact(wall).slice(0, 8)}`
  if (ev.timeZone) return `${name};TZID=${ev.timeZone}:${compact(wall)}`
  return `${name}:${utcStamp(instantOf(wall, zone))}`
}

function eventLines(ev, { method, sequence, only, recurrenceId, master, zone }) {
  const startWall = parseWall(ev.start)
  const endWall = startWall + (parseDuration(ev.duration) || (ev.showWithoutTime ? DAY : 0))
  const l = ['BEGIN:VEVENT', 'UID:' + ev.uid, 'DTSTAMP:' + utcStamp(Date.now()), 'SEQUENCE:' + (sequence ?? ev.sequence ?? 0)]
  if (recurrenceId) l.push(when('RECURRENCE-ID', recurrenceId, master, zone))
  l.push(when('DTSTART', ev.start, ev, zone), when('DTEND', formatWall(endWall), ev, zone))
  l.push('SUMMARY:' + esc(ev.title || '(no title)'))
  const place = Object.values(ev.locations || {})[0]?.name
  const link = Object.values(ev.virtualLocations || {})[0]?.uri
  if (method !== 'REPLY') {
    const notes = [ev.description, link && 'Join: ' + link].filter(Boolean).join('\n\n')
    if (notes) l.push('DESCRIPTION:' + esc(notes))
    if (place || link) l.push('LOCATION:' + esc(place || link))
    if (link) l.push('URL:' + link, 'CONFERENCE;VALUE=URI;FEATURE=VIDEO;LABEL="Open Suite meeting":' + link)
    if (ev.recurrenceRule && !recurrenceId) {
      l.push('RRULE:' + rruleText(ev.recurrenceRule, ev, zone))
      for (const [rid, patch] of Object.entries(ev.recurrenceOverrides || {})) if (patch?.excluded) l.push(when('EXDATE', rid, ev, zone))
    }
    l.push('STATUS:' + (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'), 'TRANSP:OPAQUE')
  }
  const people = Object.values(ev.participants || {})
  const owner = people.find((p) => p.roles?.owner)
  const organizer = mailOf(ev.organizerCalendarAddress) || addressOf(owner)
  if (organizer) l.push(`ORGANIZER${owner?.name ? ';CN=' + quoted(owner.name) : ''}:mailto:${organizer}`)
  for (const p of people) {
    const addr = addressOf(p)
    if (!addr || (only && addr !== only) || (!p.roles?.attendee && !p.roles?.optional && p.roles?.owner && !only)) continue
    const status = (p.participationStatus || 'needs-action').toUpperCase()
    l.push(`ATTENDEE${p.name ? ';CN=' + quoted(p.name) : ''};ROLE=REQ-PARTICIPANT;PARTSTAT=${status}${status === 'NEEDS-ACTION' && method === 'REQUEST' ? ';RSVP=TRUE' : ''}:mailto:${addr}`)
  }
  l.push('END:VEVENT')
  return l
}

// toICS writes the calendar object for one event and one purpose.
//   method: REQUEST (invite or update), CANCEL, REPLY (only = my address)
//   zone: where a time without a zone of its own is read (the viewer's)
export function toICS(ev, { method, sequence, only, zone = localZone } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Open Suite//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:' + method]
  if (ev.timeZone && !ev.showWithoutTime) lines.push(...timezoneBlock(ev.timeZone, new Date(parseWall(ev.start)).getUTCFullYear()))
  lines.push(...eventLines(ev, { method, sequence, only, zone }))
  if (method === 'REQUEST') {
    for (const [rid, patch] of Object.entries(ev.recurrenceOverrides || {})) {
      if (!patch || patch.excluded) continue
      const one = applyPatch({ ...ev, start: rid, recurrenceRule: undefined, recurrenceOverrides: undefined }, patch)
      lines.push(...eventLines(one, { method, sequence, recurrenceId: rid, master: ev, zone }))
    }
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join(CRLF) + CRLF
}

// --- reading -------------------------------------------------------------

function unescape(s = '') {
  return s.replace(/\\([nN;,\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))
}

function parseLine(line) {
  // NAME;PARAM=value;PARAM="quoted:value":content
  let i = 0
  let inQuote = false
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuote = !inQuote
    else if (c === ':' && !inQuote) break
  }
  const head = line.slice(0, i)
  const value = line.slice(i + 1)
  const [name, ...rest] = head.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/)
  const params = {}
  for (const p of rest) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: name.toUpperCase(), params, value }
}

function readTime(prop) {
  if (!prop) return null
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?/.exec(prop.value)
  if (!m) return null
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
  if (!m[4]) return { ms: instantOf(wall, localZone), allDay: true }
  if (m[7]) return { ms: wall, allDay: false }
  return { ms: instantOf(wall, prop.params.TZID || localZone), allDay: false, zone: prop.params.TZID }
}

const person = (prop) => ({ name: prop.params.CN || '', email: mailOf(prop.value), status: (prop.params.PARTSTAT || 'NEEDS-ACTION').toLowerCase() })

// parseICS reads the first event of a calendar message.
export function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const out = { method: '', attendees: [] }
  let depth = null
  let done = false
  const props = {}
  for (const raw of lines) {
    if (!raw) continue
    const p = parseLine(raw)
    if (p.name === 'METHOD') out.method = p.value.trim().toUpperCase()
    else if (p.name === 'BEGIN') {
      if (p.value.toUpperCase() === 'VEVENT' && !done) depth = 'event'
      else if (depth === 'event') depth = 'inner' // alarms inside the event
    } else if (p.name === 'END') {
      if (p.value.toUpperCase() === 'VEVENT' && depth) {
        // Prefer the series over a single changed occurrence.
        done = !props['RECURRENCE-ID']
        depth = null
        if (!done) for (const k of Object.keys(props)) delete props[k]
      } else if (depth === 'inner') depth = 'event'
    } else if (depth === 'event') {
      if (p.name === 'ATTENDEE') (props.ATTENDEE ||= []).push(p)
      else props[p.name] = p
    }
  }
  if (!props.UID) return null
  const start = readTime(props.DTSTART)
  let end = readTime(props.DTEND)
  if (!end && start) end = { ms: start.ms + (parseDuration(props.DURATION?.value) || (start.allDay ? DAY : 0)) }
  return {
    ...out,
    uid: props.UID.value.trim(),
    title: unescape(props.SUMMARY?.value || ''),
    description: unescape(props.DESCRIPTION?.value || ''),
    location: unescape(props.LOCATION?.value || ''),
    start: start?.ms, end: end?.ms, allDay: !!start?.allDay,
    repeats: !!props.RRULE,
    cancelled: props.STATUS?.value?.toUpperCase() === 'CANCELLED',
    sequence: parseInt(props.SEQUENCE?.value || '0', 10) || 0,
    organizer: props.ORGANIZER ? person(props.ORGANIZER) : null,
    attendees: (props.ATTENDEE || []).map(person),
  }
}

// --- the mail that carries it ---------------------------------------------

function base64(text) {
  const bytes = enc.encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/(.{76})/g, '$1' + CRLF)
}

// Header text outside ASCII is carried as encoded words.
function word(text = '') {
  if (/^[\x20-\x7e]*$/.test(text)) return text
  const out = []
  let chunk = ''
  for (const ch of text) {
    if (enc.encode(chunk + ch).length > 42) {
      out.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  out.push(chunk)
  return out.map((c) => '=?UTF-8?B?' + btoa(String.fromCharCode(...enc.encode(c))) + '?=').join(CRLF + ' ')
}
const mailbox = (a) => (a.name ? `${/^[\w .'-]*$/.test(a.name) ? '"' + a.name + '"' : word(a.name)} <${a.email}>` : `<${a.email}>`)

// buildMail returns a complete message whose calendar part other mail and
// calendar programs recognise and act on.
export function buildMail({ from, to, subject, text, html, ics, method }) {
  const boundary = () => 'os' + crypto.randomUUID().replace(/-/g, '').slice(0, 20)
  const outer = boundary()
  const inner = boundary()
  const domain = from.email.split('@')[1] || 'localhost'
  const part = (type, body, extra = []) => [`Content-Type: ${type}`, 'Content-Transfer-Encoding: base64', ...extra, '', base64(body)].join(CRLF)
  return [
    'From: ' + mailbox(from),
    'To: ' + to.map(mailbox).join(',' + CRLF + ' '),
    'Subject: ' + word(subject),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
    '--' + outer,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    '',
    '--' + inner,
    part('text/plain; charset=UTF-8', text),
    '--' + inner,
    part('text/html; charset=UTF-8', html),
    '--' + inner,
    part(`text/calendar; charset=UTF-8; method=${method}`, ics),
    '--' + inner + '--',
    '--' + outer,
    part('application/ics; name="invite.ics"', ics, ['Content-Disposition: attachment; filename="invite.ics"']),
    '--' + outer + '--',
    '',
  ].join(CRLF)
}
