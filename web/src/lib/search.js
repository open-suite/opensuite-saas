// Search across the suite: one registry of sources, one way to match and
// highlight, and a session that keeps the list steady while results arrive.
//
// A source ("provider") answers twice. `local` runs on every keystroke, from
// what the device already holds, and must return within a millisecond or two.
// `remote` is optional and asks a server; its results are merged in behind.
//
//   addProvider({
//     id: 'files',                 // unique
//     label: 'Files',              // group heading and filter name
//     order: 25,                   // position among the groups
//     icon: Folder,                // lucide icon for the filter and for hits without one
//     local(q, ctx) => Hit[],      // synchronous
//     remote(q, ctx) => Promise<Hit[]>,   // optional; ctx.signal aborts, ctx.limit caps
//   })
//
// q is a parsed query: { text, terms } (see parse). Use rank() and excerpt()
// below to match and to cut snippets the same way every source does.
//
// A Hit is { id, title, href | run, before?, sub?, snippet?, marked?, when?,
// icon?, tone?, avatar?, actions?, score? }:
//   id       unique within the provider; a remote hit with the id of a local
//            one fills in that row (its snippet) instead of adding another
//   href     where it opens (in-app path), or run() for anything else
//   before   called just before the hit opens (to put what the destination
//            needs in the store)
//   sub      one quiet line under the title (who, where)
//   snippet  text around the match, shown instead of sub; with marked: true
//            the matched words sit between \x02 and \x03 (server snippets),
//            otherwise they are found and highlighted here
//   when     timestamp in ms, shown at the right
//   tone     colour of the icon tile: doc | sheet | meet | mail | chat
//   avatar   { name, id } to show a person instead of an icon
//   actions  [{ icon, label, href | run }] small buttons at the right
import { signal } from '@preact/signals'

export const providers = []

export function addProvider(p) {
  const i = providers.findIndex((x) => x.id === p.id)
  if (i >= 0) providers.splice(i, 1)
  providers.push(p)
  providers.sort((a, b) => a.order - b.order)
}

// --- matching -----------------------------------------------------------------

const folded = new Map()

// fold makes text comparable: lower case, accents removed.
export function fold(s) {
  if (!s) return ''
  let f = folded.get(s)
  if (f === undefined) {
    f = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    if (folded.size > 20000) folded.clear()
    folded.set(s, f)
  }
  return f
}

export function parse(text) {
  const terms = [...new Set(fold(text.trim()).split(/\s+/).filter(Boolean))].slice(0, 8)
  return { text: text.trim(), terms }
}

const wordStart = (hay, i) => i === 0 || !/[\p{L}\p{N}]/u.test(hay[i - 1])

// score rates one item: every term must appear in the title or in the other
// text; a title that starts with the term beats one that merely contains it.
// 0 means no match.
export function score(q, title, ...rest) {
  const t = fold(title)
  let total = 0
  for (const term of q.terms) {
    const i = t.indexOf(term)
    if (i === 0) total += 100
    else if (i > 0) total += wordStart(t, i) ? 70 : 40
    else {
      let found = false
      for (const r of rest) {
        if (r && fold(r).includes(term)) {
          found = true
          break
        }
      }
      if (!found) return 0
      total += 10
    }
  }
  if (q.terms.length > 1 && t.startsWith(fold(q.text))) total += 50
  return total
}

// rank filters and orders items: best match first, then most recent.
// fields(item) returns [title, ...other text]; at(item) a timestamp.
export function rank(items, q, fields, at = () => 0) {
  const out = []
  for (const item of items) {
    const f = fields(item)
    const s = score(q, f[0], ...f.slice(1))
    if (s > 0) out.push({ item, score: s, at: at(item) || 0 })
  }
  return out.sort((a, b) => b.score - a.score || b.at - a.at)
}

// excerpt cuts a window of text around the first matched term.
export function excerpt(text, q, width = 110) {
  if (!text) return ''
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length <= width) return text
  const f = fold(text)
  let at = -1
  for (const term of q.terms) {
    const i = f.indexOf(term)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 30) return text.slice(0, width).trimEnd() + '…'
  let start = Math.max(0, at - 30)
  const space = text.indexOf(' ', start)
  if (space > 0 && space < at) start = space + 1
  const end = Math.min(text.length, start + width)
  return '…' + text.slice(start, end).trimEnd() + (end < text.length ? '…' : '')
}

// pieces splits text into [{ text, hit }] for highlighting. With marked, the
// hits are already delimited by \x02 and \x03; otherwise the query's terms are
// found, ignoring case and accents.
export function pieces(text, q, marked) {
  if (!text) return []
  if (marked) {
    return text.split(/\x02|\x03/).map((t, i) => ({ text: t, hit: i % 2 === 1 })).filter((p) => p.text)
  }
  if (!q?.terms.length) return [{ text, hit: false }]
  // Fold one character at a time so positions map back to the original.
  let f = ''
  const map = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    for (let k = 0; k < c.length; k++) map.push(i)
    f += c
  }
  map.push(text.length)
  const on = new Uint8Array(text.length)
  for (const term of q.terms) {
    for (let i = f.indexOf(term); i >= 0; i = f.indexOf(term, i + term.length)) {
      for (let k = map[i]; k < map[i + term.length - 1] + 1; k++) on[k] = 1
    }
  }
  const out = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || on[i] !== on[start]) {
      out.push({ text: text.slice(start, i), hit: on[start] === 1 })
      start = i
    }
  }
  return out
}

// --- a search in progress -------------------------------------------------------

const REMOTE_DELAY = 110 // ms of quiet before asking a server

// A Session turns keystrokes into a list. set(text) fills the list at once
// from local sources and schedules the remote ones. What it guarantees:
//   - rows never reorder within a group; remote hits are appended, or fill in
//     the snippet of a row that is already there;
//   - nothing is inserted above the row someone is on. Results for an earlier
//     group wait (see anchor) until the selection moves up to it or the text
//     changes. Rows below may be added freely: that never moves the cursor.
export class Session {
  constructor({ perGroup = 6, only = null, remoteLimit = 12 } = {}) {
    this.perGroup = perGroup
    this.only = only
    this.remoteLimit = remoteLimit
    this.view = signal({ text: '', q: parse(''), groups: [], busy: false })
    this.seq = 0
    this.anchorAt = -1
    this.held = new Map()
    this.waiting = 0
  }

  sources() {
    return this.only ? providers.filter((p) => p.id === this.only) : providers
  }

  set(text, { now = false } = {}) {
    this.seq++
    clearTimeout(this.timer)
    this.abort?.abort()
    this.held.clear()
    this.waiting = 0
    this.anchorAt = -1
    const q = parse(text)
    if (!q.terms.length) {
      this.view.value = { text, q, groups: [], busy: false }
      return
    }
    const groups = []
    for (const p of this.sources()) {
      let hits = []
      try {
        hits = p.local?.(q, { limit: this.perGroup }) || []
      } catch (e) {
        console.warn('search: ' + p.id, e)
      }
      groups.push({ id: p.id, label: p.label, icon: p.icon, hits: hits.slice(0, this.perGroup), total: hits.length })
    }
    const remote = this.sources().some((p) => p.remote)
    this.view.value = { text, q, groups, busy: remote }
    if (remote) this.timer = setTimeout(() => this.ask(q), now ? 0 : REMOTE_DELAY)
  }

  ask(q) {
    const seq = this.seq
    this.abort = new AbortController()
    const ctx = { limit: this.remoteLimit, signal: this.abort.signal }
    for (const p of this.sources()) {
      if (!p.remote) continue
      this.waiting++
      Promise.resolve()
        .then(() => p.remote(q, ctx))
        .then((hits) => seq === this.seq && this.offer(p.id, hits || []))
        .catch(() => {})
        .finally(() => {
          if (seq !== this.seq) return
          if (--this.waiting === 0) this.view.value = { ...this.view.value, busy: false }
        })
    }
  }

  // offer takes remote hits for one group: merged now, or held while the
  // active row is in a later group.
  offer(id, hits) {
    const at = this.view.value.groups.findIndex((g) => g.id === id)
    if (at < 0) return
    if (this.anchorAt > at && this.grows(at, hits)) this.held.set(id, hits)
    else this.merge(at, hits)
  }

  grows(at, hits) {
    const g = this.view.value.groups[at]
    const have = new Set(g.hits.map((h) => h.id))
    return g.hits.length < this.perGroup && hits.some((h) => !have.has(h.id))
  }

  merge(at, hits) {
    const v = this.view.value
    const g = v.groups[at]
    const index = new Map(g.hits.map((h, i) => [h.id, i]))
    const next = [...g.hits]
    let total = g.total
    for (const h of hits) {
      const i = index.get(h.id)
      if (i !== undefined) {
        // Already listed from the device: keep its place, add the server's snippet.
        if (h.snippet && !next[i].snippet) next[i] = { ...next[i], snippet: h.snippet, marked: h.marked }
      } else {
        total++
        if (next.length < this.perGroup) next.push(h)
      }
    }
    const groups = [...v.groups]
    groups[at] = { ...g, hits: next, total }
    this.view.value = { ...v, groups }
  }

  // anchor tells the session which group holds the row under the cursor or
  // the keyboard selection (-1 for none), and releases whatever may now be
  // shown without moving it.
  anchor(groupId) {
    const groups = this.view.value.groups
    this.anchorAt = groupId == null ? -1 : groups.findIndex((g) => g.id === groupId)
    for (const [id, hits] of this.held) {
      const at = groups.findIndex((g) => g.id === id)
      if (at >= this.anchorAt) {
        this.held.delete(id)
        this.merge(at, hits)
      }
    }
  }

  close() {
    this.seq++
    clearTimeout(this.timer)
    this.abort?.abort()
  }
}
