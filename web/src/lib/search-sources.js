// The built-in search sources: people, documents and spreadsheets, mail,
// chat and meetings. Each one is a provider as described in lib/search.js;
// a new part of the suite adds its own with addProvider in the same way.
import { Users, FileText, Table2, Mail as MailIcon, MessageSquare, Video, PenSquare, Folder, File as FileIcon } from 'lucide-preact'
import { CalendarDays, Contact } from 'lucide-preact'
import { items, folders, itemHref } from './files.js'
import { occurrences, placeOf, notesOf, guestsOf } from './calendar.js'
import { cards, nameOf as contactName, emailsOf, phonesOf, companyOf } from './contacts.js'
import { DAY, startOfDay, dateKey, span } from './time.js'
import { boot, docs, people, peopleById, meetings, user, upsertDoc } from './store.js'
import { docPath } from './docs.js'
import { navigate } from './router.js'
import { emails, jmap } from './mail.js'
import { rooms, roomTitle, nameOf, openDirect } from './matrix.js'
import { searchChatHistory } from './search-chat.js'
import { addProvider, rank, excerpt } from './search.js'

const roomPath = (id) => '/chat/' + encodeURIComponent(id)

// --- people -----------------------------------------------------------------------

addProvider({
  id: 'people',
  label: 'People',
  order: 10,
  icon: Users,
  local(q) {
    const me = user.value?.id
    return rank(people.value.filter((p) => p.status === 'active'), q, (p) => [p.name, p.email]).map(({ item: p, score }) => {
      const write = '/mail?compose=1&to=' + encodeURIComponent(p.email)
      const chat = p.id !== me && p.mx && boot.value?.chat?.ready
        ? () => openDirect(p.mx).then((id) => navigate(roomPath(id))).catch(() => navigate(write))
        : null
      return {
        id: p.id, title: p.name, snippet: p.email, avatar: { name: p.name, id: p.id }, score,
        ...(chat ? { run: chat } : { href: write }),
        actions: [
          chat && { icon: MessageSquare, label: 'Chat with ' + p.name, run: chat },
          { icon: PenSquare, label: 'Write to ' + p.name, href: write },
        ].filter(Boolean),
      }
    })
  },
})

// --- documents and spreadsheets ---------------------------------------------------

const docKind = (d) => (d.kind === 'sheet' ? 'Spreadsheet' : 'Document')
const docIcon = (d) => (d.kind === 'sheet' ? Table2 : FileText)

function docSub(d) {
  const owner = d.owner === user.value?.id ? 'You' : peopleById.value[d.owner]?.name
  return docKind(d) + (owner ? ' · ' + owner : '')
}

addProvider({
  id: 'docs',
  label: 'Documents',
  order: 20,
  icon: FileText,
  local(q) {
    return rank(docs.value.filter((d) => !d.trashed), q, (d) => [d.title || 'Untitled'], (d) => d.updated).map(({ item: d, score }) => ({
      id: d.id, title: d.title || 'Untitled', sub: docSub(d), when: d.updated * 1000, href: docPath(d), icon: docIcon(d), tone: d.kind, score,
    }))
  },
  // The server knows the words inside documents; the device only the titles.
  async remote(q, { limit, signal }) {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q.text)}&limit=${limit}`, { credentials: 'same-origin', signal })
    if (!res.ok) return []
    const out = await res.json()
    return (out.docs || []).map(({ snippet, ...d }) => ({
      id: d.id, title: d.title || 'Untitled', sub: docSub(d), snippet, marked: true,
      when: d.updated * 1000, href: docPath(d), icon: docIcon(d), tone: d.kind,
      // One shared a moment ago is not in this device's list yet; the editor needs it there.
      before: () => docs.value.some((x) => x.id === d.id) || upsertDoc(d),
    }))
  },
})

// --- files and folders ------------------------------------------------------------
//
// The drive keeps every folder and file this person can reach on the device,
// so names are searched here and need no server call. Documents in the drive
// are the source above.

addProvider({
  id: 'files',
  label: 'Files',
  order: 25,
  icon: Folder,
  local(q) {
    const list = items.value.filter((i) => i.type !== 'doc' && !i.trashed && !i.uploading)
    return rank(list, q, (i) => [i.name], (i) => i.updated).map(({ item: i, score }) => {
      const owner = i.owner === user.value?.id ? 'You' : peopleById.value[i.owner]?.name
      const where = folders.value[i.parent]?.name
      return {
        id: i.id, title: i.name, sub: [i.type === 'folder' ? 'Folder' : where && 'In ' + where, owner].filter(Boolean).join(' · '),
        when: i.updated * 1000, href: itemHref(i), icon: i.type === 'folder' ? Folder : FileIcon, tone: 'doc', score,
      }
    })
  },
})

// --- calendar ---------------------------------------------------------------------
//
// Every event is on the device. A repeating event is shown once, at its next
// occurrence (or its last one, if it has ended).

const SPAN_BACK = 180 * DAY
const SPAN_AHEAD = 400 * DAY

addProvider({
  id: 'events',
  label: 'Calendar',
  order: 27,
  icon: CalendarDays,
  local(q) {
    const now = Date.now()
    const day = startOfDay(now)
    const best = new Map()
    for (const o of occurrences(day - SPAN_BACK, day + SPAN_AHEAD)) {
      const had = best.get(o.id)
      const ahead = o.end >= now
      if (!had || (ahead && had.end < now) || (!ahead && had.end < now && o.start > had.start)) best.set(o.id, o)
    }
    return rank([...best.values()], q, (o) => [o.title, placeOf(o.inst), notesOf(o.inst), guestsOf(o.inst).map((g) => g.name + ' ' + g.email).join(' ')], (o) => -Math.abs(o.start - now)).map(({ item: o, score }) => ({
      id: o.id, title: o.title, sub: [span(o.start, o.end, o.allDay), placeOf(o.inst)].filter(Boolean).join(' · '),
      when: o.start, href: '/calendar?day=' + dateKey(o.start), icon: CalendarDays, tone: 'meet', score,
    }))
  },
})

// --- contacts ---------------------------------------------------------------------

addProvider({
  id: 'contacts',
  label: 'Contacts',
  order: 15,
  icon: Contact,
  local(q) {
    return rank(cards.value, q, (c) => [contactName(c), emailsOf(c).join(' '), companyOf(c), phonesOf(c).join(' ')]).map(({ item: c, score }) => {
      const email = emailsOf(c)[0]
      return {
        id: c.id, title: contactName(c), snippet: [email, companyOf(c)].filter(Boolean).join(' · '), avatar: { name: contactName(c), id: c.id }, score,
        href: '/contacts?open=' + encodeURIComponent(c.id),
        actions: email ? [{ icon: PenSquare, label: 'Write to ' + contactName(c), href: '/mail?compose=1&to=' + encodeURIComponent(email) }] : [],
      }
    })
  },
})

// --- mail -------------------------------------------------------------------------

const who = (a) => a?.name || a?.email || ''
const MAIL_FIELDS = ['id', 'threadId', 'from', 'to', 'subject', 'receivedAt', 'preview', 'keywords']

function mailHit(e, q, snippet, marked) {
  const from = who(e.from?.[0])
  return {
    id: e.threadId, title: e.subject || '(no subject)', sub: from,
    snippet: (from ? from + ' — ' : '') + (snippet || ''), marked,
    when: Date.parse(e.receivedAt) || 0, href: '/mail?open=' + encodeURIComponent(e.threadId), icon: MailIcon, tone: 'mail',
  }
}

// SearchSnippet marks matches with <mark> in HTML-escaped text; turn that
// into plain text with the markers lib/search.js understands.
function unmark(html) {
  return (html || '')
    .replace(/<mark>/g, '\x02').replace(/<\/mark>/g, '\x03').replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim()
}

addProvider({
  id: 'mail',
  label: 'Mail',
  order: 30,
  icon: MailIcon,
  local(q) {
    const list = Object.values(emails.value).filter((e) => e.threadId && !e.keywords?.$draft)
    const ranked = rank(list, q, (e) => [e.subject, who(e.from?.[0]), e.from?.[0]?.email, e.preview, (e.to || []).map(who).join(' ')], (e) => Date.parse(e.receivedAt))
    const seen = new Set()
    const out = []
    for (const { item: e, score } of ranked) {
      if (seen.has(e.threadId)) continue // one row per conversation
      seen.add(e.threadId)
      out.push({ ...mailHit(e, q, excerpt(e.preview, q, 120), false), score })
    }
    return out
  },
  // The whole mailbox, searched where it lives.
  async remote(q, { limit }) {
    if (!boot.value?.mail?.ready) return []
    const filter = { text: q.text }
    const [found, got, snips] = await jmap([
      ['Email/query', { filter, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, limit }, 'q'],
      ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: MAIL_FIELDS }, 'g'],
      ['SearchSnippet/get', { filter, '#emailIds': { resultOf: 'q', name: 'Email/query', path: '/ids' } }, 's'],
    ])
    const byId = Object.fromEntries((got.list || []).map((e) => [e.id, e]))
    const snip = Object.fromEntries((snips.list || []).map((s) => [s.emailId, s]))
    return (found.ids || []).map((id) => byId[id]).filter(Boolean).map((e) => {
      const s = unmark(snip[e.id]?.preview)
      return s ? mailHit(e, q, s, true) : mailHit(e, q, excerpt(e.preview, q, 120), false)
    })
  },
})

// --- chat -------------------------------------------------------------------------

function chatMessageHit(room, e, q) {
  return {
    id: e.id, title: roomTitle(room), snippet: nameOf(e.sender, room) + ': ' + excerpt(e.body, q, 110),
    when: e.ts, href: roomPath(room.id), avatar: { name: roomTitle(room), id: room.id },
  }
}

addProvider({
  id: 'chat',
  label: 'Chat',
  order: 40,
  icon: MessageSquare,
  local(q) {
    const all = Object.values(rooms.value)
    // Conversations by name first, then the messages this device holds.
    const out = rank(all, q, (r) => [roomTitle(r)], (r) => r.ts).map(({ item: r, score }) => {
      const last = r.timeline[r.timeline.length - 1]
      return {
        id: r.id, title: roomTitle(r), sub: last?.kind === 'text' ? last.body : 'Conversation', when: r.ts,
        href: roomPath(r.id), avatar: { name: roomTitle(r), id: r.id }, score: score + 100,
      }
    })
    const messages = []
    for (const r of all) for (const e of r.timeline) if (e.kind === 'text' && !e.pending) messages.push({ r, e })
    for (const { item, score } of rank(messages, q, (m) => ['', m.e.body], (m) => m.e.ts)) out.push({ ...chatMessageHit(item.r, item.e, q), score })
    return out
  },
  // Older messages, from the chat server's own index.
  async remote(q, { limit }) {
    if (!boot.value?.chat?.ready) return []
    const found = await searchChatHistory(q.text, limit)
    return found.filter((m) => rooms.value[m.roomId]).map((m) => chatMessageHit(rooms.value[m.roomId], m, q))
  },
})

// --- meetings ---------------------------------------------------------------------

addProvider({
  id: 'meetings',
  label: 'Meetings',
  order: 50,
  icon: Video,
  local(q) {
    return rank(meetings.value, q, (m) => [m.title || 'Meeting', m.code], (m) => m.used || m.created).map(({ item: m, score }) => ({
      id: m.code, title: m.title || 'Meeting', sub: m.code, href: '/meet/' + m.code, icon: Video, tone: 'meet', score,
    }))
  },
})
