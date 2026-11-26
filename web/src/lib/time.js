// Calendar time. An event keeps its start as wall-clock time in its own time
// zone ("2026-11-25T14:00:00", Europe/Amsterdam); the screen shows everything
// in the viewer's zone. These helpers convert between the two without a
// time-zone library, using what the browser already knows.

export const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
export const DAY = 86400000
export const MIN = 60000

export const pad = (n) => String(n).padStart(2, '0')

// A "wall" is wall-clock time carried in a UTC timestamp: handy for date
// arithmetic that must ignore daylight saving.
export const parseWall = (s) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d))?)?/.exec(s || '')
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : NaN
}
export const formatWall = (wall) => {
  const d = new Date(wall)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

const fmts = new Map()
function zoneFmt(tz) {
  let f = fmts.get(tz)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch {
      f = null // an unknown zone name: treat the event as local time
    }
    fmts.set(tz, f)
  }
  return f
}

// wallIn gives the wall-clock time an instant has in a zone.
export function wallIn(ms, tz) {
  const f = tz && tz !== localZone ? zoneFmt(tz) : null
  if (!f) {
    const d = new Date(ms)
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds())
  }
  const p = {}
  for (const x of f.formatToParts(ms)) p[x.type] = +x.value
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
}

// instantOf gives the instant at which a zone's clocks show a wall time.
export function instantOf(wall, tz) {
  const f = tz && tz !== localZone ? zoneFmt(tz) : null
  if (!f) {
    const d = new Date(wall)
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime()
  }
  let guess = wall
  for (let i = 0; i < 3; i++) guess += wall - wallIn(guess, tz)
  return guess
}

// ISO 8601 durations, as far as calendars use them.
export function parseDuration(s) {
  const m = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s || '')
  if (!m) return 0
  const ms = (+(m[2] || 0) * 7 + +(m[3] || 0)) * DAY + +(m[4] || 0) * 3600000 + +(m[5] || 0) * MIN + +(m[6] || 0) * 1000
  return m[1] ? -ms : ms
}
export function formatDuration(ms) {
  const neg = ms < 0
  ms = Math.abs(ms)
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / 3600000)
  const mi = Math.floor((ms % 3600000) / MIN)
  let out = 'P' + (d ? d + 'D' : '')
  if (h || mi || !d) out += 'T' + (h ? h + 'H' : '') + (mi || !h ? mi + 'M' : '')
  return (neg ? '-' : '') + out
}

// --- the viewer's own calendar days ---------------------------------------

export const startOfDay = (ms) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
export const addDays = (ms, n) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes()).getTime()
}
export const addMonths = (ms, n) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime()
}
// Weeks start on Monday except where the locale says otherwise.
export const weekStartsOn = (() => {
  try {
    const loc = new Intl.Locale(navigator.language)
    const info = loc.getWeekInfo?.() || loc.weekInfo
    return info ? info.firstDay % 7 : 1
  } catch {
    return 1
  }
})()
export const startOfWeek = (ms) => {
  const d = new Date(startOfDay(ms))
  return addDays(d.getTime(), -((d.getDay() - weekStartsOn + 7) % 7))
}
export const startOfMonth = (ms) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}
export const sameDay = (a, b) => startOfDay(a) === startOfDay(b)
export const dateKey = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const timeKey = (ms) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
// fromInputs turns the values of a date and a time field into an instant.
export const fromInputs = (date, time = '00:00') => {
  const [y, m, d] = date.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  return new Date(y, m - 1, d, h || 0, mi || 0).getTime()
}

const f = (opts) => new Intl.DateTimeFormat(undefined, opts)
const fTime = f({ hour: 'numeric', minute: '2-digit' })
const fDay = f({ weekday: 'short', day: 'numeric', month: 'short' })
const fDayLong = f({ weekday: 'long', day: 'numeric', month: 'long' })
const fDayYear = f({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const fMonth = f({ month: 'long', year: 'numeric' })
export const hhmm = (ms) => fTime.format(ms)
export const dayShort = (ms) => fDay.format(ms)
export const dayLong = (ms) => fDayLong.format(ms)
export const monthTitle = (ms) => fMonth.format(ms)
const fWeekday = { short: f({ weekday: 'short' }), narrow: f({ weekday: 'narrow' }), long: f({ weekday: 'long' }) }
export const weekdayName = (ms, width = 'short') => fWeekday[width].format(ms)
const fMonthDay = f({ weekday: 'short', month: 'short' })
export const weekdayMonth = (ms) => fMonthDay.format(ms)

// Formatters for text written in another zone than the viewer's: invitation
// mails composed on the server (lib/invite.js) are in the sender's zone.
const zoned = new Map()
function formatsIn(zone) {
  if (zone === localZone) return { day: fDay, dayYear: fDayYear, time: fTime }
  let z = zoned.get(zone)
  if (!z) {
    const fz = (opts) => f({ ...opts, timeZone: zone })
    zoned.set(zone, (z = { day: fz({ weekday: 'short', day: 'numeric', month: 'short' }), dayYear: fz({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }), time: fz({ hour: 'numeric', minute: '2-digit' }) }))
  }
  return z
}

// span describes when an event happens, for popovers, mail and the agenda,
// in the viewer's zone unless another is given.
export function span(start, end, allDay, zone = localZone) {
  const fmt = formatsIn(zone)
  const yearOf = (ms) => new Date(wallIn(ms, zone)).getUTCFullYear()
  const dayOf = (ms) => Math.floor(wallIn(ms, zone) / DAY)
  const year = yearOf(start) !== yearOf(Date.now())
  const day = (ms) => (year ? fmt.dayYear : fmt.day).format(ms)
  const time = (ms) => fmt.time.format(ms)
  if (allDay) {
    const last = end - DAY
    return last <= start ? day(start) : `${day(start)} – ${day(last)}`
  }
  if (dayOf(start) === dayOf(end) || end - start <= 0) return `${day(start)}, ${time(start)} – ${time(end)}`
  return `${day(start)}, ${time(start)} – ${day(end)}, ${time(end)}`
}

export const zoneLabel = (tz) => (tz || localZone).replace(/_/g, ' ')
export const zones = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return [localZone]
  }
})()
