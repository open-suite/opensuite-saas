// Repeating events. Rules are expanded on the device, in wall-clock time (see
// time.js), so a 9:00 meeting stays at 9:00 across daylight saving changes.
import { DAY, parseWall } from './time.js'

export const DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']
const dayStart = (wall) => wall - (((wall % DAY) + DAY) % DAY)
const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

function monthDays(y, m, rule, startDom) {
  const n = daysIn(y, m)
  const out = []
  const byDay = rule.byDay || []
  if (byDay.length) {
    for (const bd of byDay) {
      const wd = DAYS.indexOf(bd.day)
      const all = []
      for (let d = 1; d <= n; d++) if (new Date(Date.UTC(y, m, d)).getUTCDay() === wd) all.push(d)
      if (bd.nthOfPeriod) {
        const pick = bd.nthOfPeriod > 0 ? all[bd.nthOfPeriod - 1] : all[all.length + bd.nthOfPeriod]
        if (pick) out.push(pick)
      } else out.push(...all)
    }
  } else {
    for (const d of rule.byMonthDay?.length ? rule.byMonthDay : [startDom]) {
      const dom = d > 0 ? d : n + 1 + d
      if (dom >= 1 && dom <= n) out.push(dom)
    }
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

// expandRule lists the starts of a repeating event between two wall times.
export function expandRule(start, rule, from, to) {
  const out = []
  const interval = Math.max(1, rule.interval || 1)
  const until = rule.until ? parseWall(rule.until) : Infinity
  const count = rule.count || Infinity
  const last = Math.min(to, until)
  const s = new Date(start)
  const day0 = dayStart(start)
  const tod = start - day0
  const [sy, sm, sdom] = [s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()]
  const first = DAYS.indexOf(rule.firstDayOfWeek || 'mo')
  const week0 = day0 - ((s.getUTCDay() - first + 7) % 7) * DAY
  const weekDays = (rule.byDay?.length ? rule.byDay.map((b) => DAYS.indexOf(b.day)) : [s.getUTCDay()]).map((d) => (d - first + 7) % 7).sort((a, b) => a - b)
  const onlyDays = rule.byDay?.length ? new Set(rule.byDay.map((b) => DAYS.indexOf(b.day))) : null
  const months = (rule.byMonth || []).map((m) => parseInt(m, 10) - 1)

  // With no count to keep, periods long before the window can be skipped.
  let k = 0
  if (count === Infinity && from > start) {
    const span = { daily: DAY, weekly: 7 * DAY, monthly: 31 * DAY, yearly: 366 * DAY }[rule.frequency] || DAY
    k = Math.max(0, Math.floor((from - start) / (span * interval)) - 1)
  }
  let seen = 0
  for (let guard = 0; guard < 6000; guard++, k++) {
    let cands, period
    if (rule.frequency === 'daily') {
      period = day0 + k * interval * DAY
      cands = !onlyDays || onlyDays.has(new Date(period).getUTCDay()) ? [period] : []
    } else if (rule.frequency === 'weekly') {
      period = week0 + k * interval * 7 * DAY
      cands = weekDays.map((off) => period + off * DAY)
    } else if (rule.frequency === 'monthly') {
      const mi = sm + k * interval
      const y = sy + Math.floor(mi / 12)
      const m = ((mi % 12) + 12) % 12
      period = Date.UTC(y, m, 1)
      cands = monthDays(y, m, rule, sdom).map((d) => Date.UTC(y, m, d))
    } else if (rule.frequency === 'yearly') {
      const y = sy + k * interval
      period = Date.UTC(y, 0, 1)
      cands = []
      for (const m of months.length ? months : [sm]) for (const d of monthDays(y, m, rule, sdom)) cands.push(Date.UTC(y, m, d))
      cands.sort((a, b) => a - b)
    } else return out
    if (period > last) return out
    for (const c of cands) {
      const w = c + tod
      if (w < start) continue
      if (w > last || ++seen > count) return out
      if (w >= from) out.push(w)
    }
  }
  return out
}

const names = { su: 'Sunday', mo: 'Monday', tu: 'Tuesday', we: 'Wednesday', th: 'Thursday', fr: 'Friday', sa: 'Saturday' }
const ordinals = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', '-1': 'last' }

// describeRule puts a rule into words: "Weekly on Monday and Wednesday".
export function describeRule(rule, start) {
  if (!rule) return ''
  const n = Math.max(1, rule.interval || 1)
  const s = new Date(start)
  const days = (rule.byDay || []).map((b) => b.day)
  const list = (a) => (a.length > 1 ? a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1] : a[0])
  let text
  if (rule.frequency === 'daily') text = n === 1 ? 'Daily' : `Every ${n} days`
  else if (rule.frequency === 'weekly') {
    const set = [...days].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b))
    if (n === 1 && set.join() === 'mo,tu,we,th,fr') text = 'Every weekday'
    else text = (n === 1 ? 'Weekly' : `Every ${n} weeks`) + ' on ' + list((set.length ? set : [DAYS[s.getUTCDay()]]).map((d) => names[d]))
  } else if (rule.frequency === 'monthly') {
    const bd = rule.byDay?.[0]
    text = (n === 1 ? 'Monthly' : `Every ${n} months`) + (bd?.nthOfPeriod ? ` on the ${ordinals[bd.nthOfPeriod] || bd.nthOfPeriod} ${names[bd.day]}` : ` on day ${rule.byMonthDay?.[0] || s.getUTCDate()}`)
  } else if (rule.frequency === 'yearly') {
    text = (n === 1 ? 'Yearly' : `Every ${n} years`) + ' on ' + new Date(start).toLocaleDateString(undefined, { day: 'numeric', month: 'long', timeZone: 'UTC' })
  } else return ''
  if (rule.count) text += `, ${rule.count} times`
  else if (rule.until) text += ', until ' + new Date(parseWall(rule.until)).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return text
}

// applyPatch lays an occurrence's changes over the repeating event. Keys are
// property names or JSON pointers ("participants/p1/participationStatus").
export function applyPatch(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    const path = key.split('/')
    let node = out
    for (let i = 0; i < path.length - 1; i++) {
      node[path[i]] = { ...(node[path[i]] || {}) }
      node = node[path[i]]
    }
    if (value === null) delete node[path[path.length - 1]]
    else node[path[path.length - 1]] = value
  }
  return out
}
