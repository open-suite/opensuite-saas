// Events unrolled into the occurrences that fall in a window of time. Shared
// by the calendar (calendar.js) and the server's headless engine
// (src/headless/), so both see the same occurrences.
import { DAY, parseWall, formatWall, wallIn, instantOf, parseDuration } from './time.js'
import { expandRule, applyPatch } from './rrule.js'

// All-day events, and events without a zone of their own, happen in `zone`.
function instance(ev, inst, rid, out, from, to, zone) {
  if (inst.status === 'cancelled') return
  const allDay = !!inst.showWithoutTime
  const tz = allDay ? zone : inst.timeZone || zone
  const wall = parseWall(inst.start)
  if (Number.isNaN(wall)) return
  const dur = parseDuration(inst.duration) || (allDay ? DAY : 0)
  const start = instantOf(wall, tz)
  const end = allDay ? instantOf(wall + dur, tz) : start + dur
  if (end < from || start >= to || (end === from && dur > 0)) return
  out.push({ key: ev.id + '|' + (rid || ''), id: ev.id, rid, ev, inst, start, end, allDay, title: inst.title || '(no title)' })
}

// expandEvents lists everything in `events` that happens between two
// instants, repeating events unrolled, in time order.
export function expandEvents(events, from, to, zone) {
  const out = []
  for (const ev of events) {
    if (!ev.recurrenceRule) {
      instance(ev, ev, null, out, from, to, zone)
      continue
    }
    const tz = ev.showWithoutTime ? zone : ev.timeZone || zone
    const dur = parseDuration(ev.duration) || 0
    const walls = expandRule(parseWall(ev.start), ev.recurrenceRule, wallIn(from, tz) - dur - 2 * DAY, wallIn(to, tz) + 2 * DAY)
    for (const w of walls) {
      const rid = formatWall(w)
      const ov = ev.recurrenceOverrides?.[rid]
      if (ov?.excluded) continue
      const inst = ov ? applyPatch({ ...ev, start: rid }, ov) : { ...ev, start: rid }
      instance(ev, inst, rid, out, from, to, zone)
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end || a.title.localeCompare(b.title))
}
