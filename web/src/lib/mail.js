// Mail data layer: JMAP through the suite's own endpoint. Folders, message
// lists and opened conversations are kept on the device, so the inbox paints
// from local data and opening a message does not wait on the network.
import { signal } from '@preact/signals'
import { boot, unread } from './store.js'
import { api } from './api.js'
import { kvGet, kvSet } from './idb.js'
import { debounce, idle } from './util.js'

export const mailboxes = signal([]) // [{ id, name, role, totalEmails, unreadEmails, parentId, sortOrder }]
export const lists = signal({}) // listKey -> { ids: [emailId], total, at }
export const emails = signal({}) // emailId -> message (summary, plus body once opened)
export const threads = signal({}) // threadId -> [emailId]
export const identity = signal(null)
export const mailReady = signal(false)

const SUMMARY = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'subject', 'receivedAt', 'preview', 'hasAttachment']
const FULL = [...SUMMARY, 'bcc', 'replyTo', 'messageId', 'inReplyTo', 'references', 'sentAt', 'htmlBody', 'textBody', 'bodyValues', 'attachments']
const PAGE = 50

export async function jmap(calls) {
  // passive: mail traffic never changes what /api/boot reports
  const res = await api('POST', '/api/mail/jmap', { methodCalls: calls.map((c, i) => [c[0], c[1], c[2] || String(i)]) }, { passive: true })
  return res.methodResponses.map((r) => r[1])
}

const persist = debounce(() => {
  // Keep the device copy bounded: summaries for what is listed, bodies for
  // the most recently opened conversations.
  const keep = new Set()
  for (const l of Object.values(lists.value)) l.ids.slice(0, PAGE).forEach((id) => keep.add(id))
  const slim = {}
  let bodies = 0
  for (const [id, e] of Object.entries(emails.value)) {
    if (!keep.has(id)) continue
    slim[id] = e.bodyValues && bodies++ > 40 ? Object.fromEntries(SUMMARY.map((k) => [k, e[k]])) : e
  }
  kvSet('mail', { user: boot.value?.mail?.address, mailboxes: mailboxes.value, lists: lists.value, emails: slim, threads: threads.value, identity: identity.value })
}, 1000)

function setMailboxes(list) {
  const order = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5 }
  mailboxes.value = [...list].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name))
  unread.value = { ...unread.value, mail: list.find((m) => m.role === 'inbox')?.unreadEmails || 0 }
}

function mergeEmails(list) {
  const next = { ...emails.value }
  for (const e of list) next[e.id] = { ...next[e.id], ...e }
  emails.value = next
}

export const boxByRole = (role) => mailboxes.value.find((m) => m.role === role)

export const listKey = (mailboxId, search) => (search ? 'q:' + search : mailboxId)

// loadList fetches one page of conversations for a folder or a search.
export async function loadList(mailboxId, { search = '', more = false } = {}) {
  const key = listKey(mailboxId, search)
  const cur = lists.value[key]
  const position = more && cur ? cur.ids.length : 0
  const filter = search ? { text: search } : { inMailbox: mailboxId }
  const [q, g, t, mb] = await jmap([
    ['Email/query', { filter, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, position, limit: PAGE, calculateTotal: true }, 'q'],
    ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: SUMMARY }, 'g'],
    ['Thread/get', { '#ids': { resultOf: 'g', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
    ['Mailbox/get', { properties: ['name', 'role', 'totalEmails', 'unreadEmails', 'parentId', 'sortOrder'] }, 'm'],
  ])
  mergeEmails(g.list || [])
  threads.value = { ...threads.value, ...Object.fromEntries((t.list || []).map((x) => [x.id, x.emailIds])) }
  if (mb.list) setMailboxes(mb.list)
  const ids = more && cur ? [...cur.ids, ...q.ids.filter((id) => !cur.ids.includes(id))] : q.ids
  lists.value = { ...lists.value, [key]: { ids, total: q.total ?? ids.length, at: Date.now() } }
  persist()
  // Warm the conversations at the top of the list so opening one is instant.
  if (!more) idle(() => (g.list || []).slice(0, 8).forEach((e) => loadThread(e.threadId, true)))
}

const loading = new Map()

// loadThread fetches every message of a conversation with bodies.
export function loadThread(threadId, quiet = false) {
  const have = threads.value[threadId]
  if (have && have.every((id) => emails.value[id]?.bodyValues)) return Promise.resolve()
  if (loading.has(threadId)) return loading.get(threadId)
  const p = jmap([
    ['Thread/get', { ids: [threadId] }, 't'],
    ['Email/get', { '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: FULL, fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 1500000 }, 'g'],
  ])
    .then(([t, g]) => {
      mergeEmails(g.list || [])
      if (t.list?.[0]) threads.value = { ...threads.value, [threadId]: t.list[0].emailIds }
      persist()
    })
    .catch((e) => {
      if (!quiet) throw e
    })
    .finally(() => loading.delete(threadId))
  loading.set(threadId, p)
  return p
}

// update applies a JMAP patch to messages, on screen first, then on the server.
export async function update(ids, patch, local) {
  const next = { ...emails.value }
  for (const id of ids) if (next[id]) next[id] = local(next[id])
  emails.value = next
  persist()
  await jmap([['Email/set', { update: Object.fromEntries(ids.map((id) => [id, patch])) }]])
  refreshCounts()
}

export const setKeyword = (ids, keyword, on) =>
  update(ids, { ['keywords/' + keyword]: on ? true : null }, (e) => {
    const k = { ...e.keywords }
    if (on) k[keyword] = true
    else delete k[keyword]
    return { ...e, keywords: k }
  })

// moveTo files whole conversations into a folder and drops them from lists.
export async function moveTo(ids, mailboxId) {
  const gone = new Set(ids)
  lists.value = Object.fromEntries(Object.entries(lists.value).map(([k, l]) => [k, k === mailboxId ? l : { ...l, ids: l.ids.filter((id) => !gone.has(id)), total: Math.max(0, l.total - ids.filter((id) => l.ids.includes(id)).length) }]))
  await update(ids, { mailboxIds: { [mailboxId]: true } }, (e) => ({ ...e, mailboxIds: { [mailboxId]: true } }))
}

export async function destroy(ids) {
  const gone = new Set(ids)
  lists.value = Object.fromEntries(Object.entries(lists.value).map(([k, l]) => [k, { ...l, ids: l.ids.filter((id) => !gone.has(id)) }]))
  await jmap([['Email/set', { destroy: ids }]])
  refreshCounts()
}

export async function ensureMailbox(role, name) {
  const have = boxByRole(role)
  if (have) return have.id
  const [r] = await jmap([['Mailbox/set', { create: { n: { name, role } } }]])
  await refreshCounts()
  return r.created?.n?.id
}

export async function refreshCounts() {
  const [mb] = await jmap([['Mailbox/get', { properties: ['name', 'role', 'totalEmails', 'unreadEmails', 'parentId', 'sortOrder'] }]])
  if (mb.list) setMailboxes(mb.list)
  persist()
}

export async function uploadAttachment(file) {
  const res = await api('POST', '/api/mail/upload', file, { type: file.type || 'application/octet-stream', passive: true })
  return { blobId: res.blobId, type: file.type || 'application/octet-stream', name: file.name, size: file.size }
}

// send stores the message and submits it in one request; the server moves it
// from Drafts to Sent once it has been accepted for delivery.
export async function send({ to, cc, bcc, subject, html, text, attachments = [], inReplyTo, references }) {
  const drafts = boxByRole('drafts')?.id
  const sent = boxByRole('sent')?.id
  const me = identity.value
  const email = {
    mailboxIds: { [drafts]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ name: me.name, email: me.email }],
    to, cc, bcc, subject,
    bodyValues: { t: { value: text }, h: { value: html } },
    textBody: [{ partId: 't', type: 'text/plain' }],
    htmlBody: [{ partId: 'h', type: 'text/html' }],
    attachments: attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' })),
  }
  if (inReplyTo) email.inReplyTo = inReplyTo
  if (references) email.references = references
  const [set, sub] = await jmap([
    ['Email/set', { create: { m: email } }],
    ['EmailSubmission/set', {
      create: { s: { identityId: me.id, emailId: '#m' } },
      onSuccessUpdateEmail: { '#s': { ['mailboxIds/' + drafts]: null, ['mailboxIds/' + sent]: true, 'keywords/$draft': null } },
    }],
  ])
  const err = set.notCreated?.m || sub.notCreated?.s
  if (err) throw new Error(err.description || "That message couldn't be sent.")
  refreshCounts()
}

let events = null

export async function startMail() {
  if (events || !boot.value?.mail?.ready) return
  const saved = await kvGet('mail')
  if (saved?.user === boot.value.mail.address) {
    mailboxes.value = saved.mailboxes || []
    lists.value = saved.lists || {}
    emails.value = saved.emails || {}
    threads.value = saved.threads || {}
    identity.value = saved.identity || null
    unread.value = { ...unread.value, mail: boxByRole('inbox')?.unreadEmails || 0 }
    if (mailboxes.value.length) mailReady.value = true
  }
  try {
    const [mb, idn] = await jmap([
      ['Mailbox/get', { properties: ['name', 'role', 'totalEmails', 'unreadEmails', 'parentId', 'sortOrder'] }],
      ['Identity/get', {}],
    ])
    setMailboxes(mb.list || [])
    identity.value = idn.list?.[0] || null
    mailReady.value = true
    const inbox = boxByRole('inbox')
    if (inbox) await loadList(inbox.id)
  } catch {}
  // New mail arrives as a push, not a poll.
  events = new EventSource('/api/mail/events')
  const changed = debounce(() => {
    refreshCounts().catch(() => {})
    for (const key of Object.keys(lists.value)) {
      if (!key.startsWith('q:') && Date.now() - lists.value[key].at < 3600000) loadList(key).catch(() => {})
    }
  }, 400)
  events.addEventListener('state', changed)
}

export function stopMail() {
  events?.close()
  events = null
}
