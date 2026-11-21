export const cx = (...a) => a.filter(Boolean).join(' ')

export function initials(name = '') {
  const p = name.trim().split(/\s+/).filter(Boolean)
  if (!p.length) return '?'
  return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase()
}

const palette = ['#1269e8', '#0e9f6e', '#c2410c', '#7c3aed', '#be185d', '#0891b2', '#a16207', '#4f46e5', '#dc2626', '#15803d']

export function colorFor(key = '') {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

const dayMs = 86400000
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const yearFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// when formats a timestamp (ms) the way a mail list does: time today, date
// this year, full date before that.
export function when(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d)
  if (now - d < 6 * dayMs && now > d) return d.toLocaleDateString(undefined, { weekday: 'short' })
  if (d.getFullYear() === now.getFullYear()) return dayFmt.format(d)
  return yearFmt.format(d)
}

export const whenFull = (ms) => (ms ? fullFmt.format(new Date(ms)) : '')
export const clock = (ms) => timeFmt.format(new Date(ms))

export function dayLabel(ms) {
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Today'
  if (new Date(now - dayMs).toDateString() === d.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function bytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1 << 20) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1 << 30) return (n / (1 << 20)).toFixed(1) + ' MB'
  return (n / (1 << 30)).toFixed(1) + ' GB'
}

export function debounce(fn, ms) {
  let t
  const d = (...a) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
  d.flush = (...a) => {
    clearTimeout(t)
    fn(...a)
  }
  return d
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => resolve(input.files[0] || null)
    input.click()
  })
}

const idAlphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
export function newId(n = 14) {
  const b = crypto.getRandomValues(new Uint8Array(n))
  return Array.from(b, (x) => idAlphabet[x % idAlphabet.length]).join('')
}

export function newMeetCode() {
  const letters = 'abcdefghijkmnopqrstuvwxyz'
  const b = crypto.getRandomValues(new Uint8Array(10))
  const s = Array.from(b, (x) => letters[x % letters.length]).join('')
  return `${s.slice(0, 3)}-${s.slice(3, 7)}-${s.slice(7)}`
}

export const escapeHtml = (s = '') => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// idle runs low-priority work without competing with input.
export const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 400))
