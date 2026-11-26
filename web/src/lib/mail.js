// Mail data layer: JMAP through the suite's own endpoint. Folders, message
// lists and opened conversations are kept on the device, so the inbox paints
// from local data and opening a message does not wait on the network.
//
// A person has their own mailbox and one more for each group they belong to
// (a shared inbox such as sales@). Each is a box with the same shape; the
// server picks the group's mailbox from ?group= and decides by the person's
// role what they may do in it.
import { signal, computed, effect } from '@preact/signals'
import { boot, unread, user } from './store.js'
import { api } from './api.js'
import { kvGet, kvSet } from './idb.js'
import { debounce, idle } from './util.js'

export const mailReady = signal(false)

const SUMMARY = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'subject', 'receivedAt', 'preview', 'hasAttachment']
const FULL = [...SUMMARY, 'bcc', 'replyTo', 'messageId', 'inReplyTo', 'references', 'sentAt', 'htmlBody', 'textBody', 'bodyValues', 'attachments']
const PAGE = 50
const BOXES = ['name', 'role', 'totalEmails', 'unreadEmails', 'parentId', 'sortOrder']

// The marks members leave on a group's messages so the others see who read
// and who answered (server/groups.go).
export const readMark = (id) => 'os-read-' + id
export const replyMark = (id) => 'os-replied-' + id

// The groups whose mail this person can open, with their role in each.
export const myGroups = computed(() => (boot.value?.groups || []).filter((g) => g.role))

// groupQuery is what every mail request adds to work in a group's mailbox.
export const groupQuery = (group, sep = '?') => (group ? sep + 'group=' + encodeURIComponent(group.id) : '')

export async function jmap(calls, group) {
  // passive: mail traffic never changes what /api/boot reports
  const res = await api('POST', '/api/mail/jmap' + groupQuery(group), { methodCalls: calls.map((c, i) => [c[0], c[1], c[2] || String(i)]) }, { passive: true })
  return res.methodResponses.map((r) => r[1])
}

function makeBox(group) {
  const box = {
    group, // null for the person's own mailbox
    mailboxes: signal([]), // [{ id, name, role, totalEmails, unreadEmails, parentId, sortOrder }]
    lists: signal({}), // listKey -> { ids: [emailId], total, at }
    emails: signal({}), // emailId -> message (summary, plus body once opened)
    threads: signal({}), // threadId -> [emailId]
    identity: signal(null),
  }
  const call = (calls) => jmap(calls, box.group)
  const store = () => (box.group ? 'mail:' + box.group.id : 'mail')
  // Users and group admins may write in a group's mailbox; viewers only read.
  box.maySend = () => !box.group || box.group.role !== 'viewer'
  box.address = () => (box.group ? box.group.email : boot.value?.mail?.address)

  const persist = debounce(() => {
    // Keep the device copy bounded: summaries for what is listed, bodies for
    // the most recently opened conversations.
    const keep = new Set()
    for (const l of Object.values(box.lists.value)) l.ids.slice(0, PAGE).forEach((id) => keep.add(id))
    const slim = {}
    let bodies = 0
    for (const [id, e] of Object.entries(box.emails.value)) {
      if (!keep.has(id)) continue
      slim[id] = e.bodyValues && bodies++ > 40 ? Object.fromEntries(SUMMARY.map((k) => [k, e[k]])) : e
    }
    kvSet(store(), { user: boot.value?.mail?.address, mailboxes: box.mailboxes.value, lists: box.lists.value, emails: slim, threads: box.threads.value, identity: box.identity.value })
  }, 1000)

  function setMailboxes(list) {
    const order = { inbox: 0, drafts: 1, sent: 2, archive: 3, junk: 4, trash: 5 }
    box.mailboxes.value = [...list].sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name))
    if (!box.group) unread.value = { ...unread.value, mail: list.find((m) => m.role === 'inbox')?.unreadEmails || 0 }
  }

  function mergeEmails(list) {
    const next = { ...box.emails.value }
    for (const e of list) next[e.id] = { ...next[e.id], ...e }
    box.emails.value = next
  }

  box.byRole = (role) => box.mailboxes.value.find((m) => m.role === role)

  // loadList fetches one page of conversations for a folder or a search.
  box.loadList = async (mailboxId, { search = '', more = false } = {}) => {
    const key = listKey(mailboxId, search)
    const cur = box.lists.value[key]
    const position = more && cur ? cur.ids.length : 0
    const filter = search ? { text: search } : { inMailbox: mailboxId }
    const [q, g, t, mb] = await call([
      ['Email/query', { filter, sort: [{ property: 'receivedAt', isAscending: false }], collapseThreads: true, position, limit: PAGE, calculateTotal: true }, 'q'],
      ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: SUMMARY }, 'g'],
      ['Thread/get', { '#ids': { resultOf: 'g', name: 'Email/get', path: '/list/*/threadId' } }, 't'],
      ['Mailbox/get', { properties: BOXES }, 'm'],
    ])
    mergeEmails(g.list || [])
    box.threads.value = { ...box.threads.value, ...Object.fromEntries((t.list || []).map((x) => [x.id, x.emailIds])) }
    if (mb.list) setMailboxes(mb.list)
    const ids = more && cur ? [...cur.ids, ...q.ids.filter((id) => !cur.ids.includes(id))] : q.ids
    box.lists.value = { ...box.lists.value, [key]: { ids, total: q.total ?? ids.length, at: Date.now() } }
    persist()
    // Warm the conversations at the top of the list so opening one is instant.
    if (!more) idle(() => (g.list || []).slice(0, 8).forEach((e) => box.loadThread(e.threadId, true)))
  }

  const loading = new Map()

  // loadThread fetches every message of a conversation with bodies.
  box.loadThread = (threadId, quiet = false) => {
    const have = box.threads.value[threadId]
    if (have && have.every((id) => box.emails.value[id]?.bodyValues)) return Promise.resolve()
    if (loading.has(threadId)) return loading.get(threadId)
    const p = call([
      ['Thread/get', { ids: [threadId] }, 't'],
      ['Email/get', { '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' }, properties: FULL, fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 1500000 }, 'g'],
    ])
      .then(([t, g]) => {
        mergeEmails(g.list || [])
        if (t.list?.[0]) box.threads.value = { ...box.threads.value, [threadId]: t.list[0].emailIds }
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
  box.update = async (ids, patch, local) => {
    const next = { ...box.emails.value }
    for (const id of ids) if (next[id]) next[id] = local(next[id])
    box.emails.value = next
    persist()
    await call([['Email/set', { update: Object.fromEntries(ids.map((id) => [id, patch])) }]])
    box.refreshCounts()
  }

  // setKeywords switches keywords on (true) or off (false) on messages.
  box.setKeywords = (ids, words) =>
    box.update(ids, Object.fromEntries(Object.entries(words).map(([k, on]) => ['keywords/' + k, on || null])), (e) => {
      const k = { ...e.keywords }
      for (const [w, on] of Object.entries(words)) on ? (k[w] = true) : delete k[w]
      return { ...e, keywords: k }
    })
  box.setKeyword = (ids, keyword, on) => box.setKeywords(ids, { [keyword]: on })

  // markRead marks messages read; in a group it also says who read them.
  box.markRead = (ids) => box.setKeywords(ids, box.group ? { $seen: true, [readMark(user.value.id)]: true } : { $seen: true })

  // moveTo files whole conversations into a folder and drops them from lists.
  box.moveTo = async (ids, mailboxId) => {
    const gone = new Set(ids)
    box.lists.value = Object.fromEntries(Object.entries(box.lists.value).map(([k, l]) => [k, k === mailboxId ? l : { ...l, ids: l.ids.filter((id) => !gone.has(id)), total: Math.max(0, l.total - ids.filter((id) => l.ids.includes(id)).length) }]))
    await box.update(ids, { mailboxIds: { [mailboxId]: true } }, (e) => ({ ...e, mailboxIds: { [mailboxId]: true } }))
  }

  box.destroy = async (ids) => {
    const gone = new Set(ids)
    box.lists.value = Object.fromEntries(Object.entries(box.lists.value).map(([k, l]) => [k, { ...l, ids: l.ids.filter((id) => !gone.has(id)) }]))
    await call([['Email/set', { destroy: ids }]])
    box.refreshCounts()
  }

  // ensureMailbox finds a standard folder, creating it in the person's own
  // mailbox the first time it is wanted. A group's has them all from the start.
  box.ensureMailbox = async (role, name) => {
    const have = box.byRole(role)
    if (have || box.group) return have?.id
    const [r] = await call([['Mailbox/set', { create: { n: { name, role } } }]])
    await box.refreshCounts()
    return r.created?.n?.id
  }

  box.refreshCounts = async () => {
    const [mb] = await call([['Mailbox/get', { properties: BOXES }]])
    if (mb.list) setMailboxes(mb.list)
    persist()
  }

  box.uploadAttachment = async (file) => {
    const res = await api('POST', '/api/mail/upload' + groupQuery(box.group), file, { type: file.type || 'application/octet-stream', passive: true })
    return { blobId: res.blobId, type: file.type || 'application/octet-stream', name: file.name, size: file.size }
  }

  // send stores the message and submits it in one request; the server moves
  // it from Drafts to Sent once it has been accepted for delivery. A reply
  // from a group marks the message it answers, so the group sees who did.
  box.send = async ({ to, cc, bcc, subject, html, text, attachments = [], inReplyTo, references, answers }) => {
    const drafts = box.byRole('drafts')?.id
    const sent = box.byRole('sent')?.id
    const me = box.identity.value
    const email = {
      mailboxIds: { [drafts]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ name: box.group ? box.group.name : me.name, email: me.email }],
      to, cc, bcc, subject,
      bodyValues: { t: { value: text }, h: { value: html } },
      textBody: [{ partId: 't', type: 'text/plain' }],
      htmlBody: [{ partId: 'h', type: 'text/html' }],
      attachments: attachments.map((a) => ({ blobId: a.blobId, type: a.type, name: a.name, disposition: 'attachment' })),
    }
    if (inReplyTo) email.inReplyTo = inReplyTo
    if (references) email.references = references
    const [set, sub] = await call([
      ['Email/set', { create: { m: email } }],
      ['EmailSubmission/set', {
        create: { s: { identityId: me.id, emailId: '#m' } },
        onSuccessUpdateEmail: { '#s': { ['mailboxIds/' + drafts]: null, ['mailboxIds/' + sent]: true, 'keywords/$draft': null } },
      }],
    ])
    const err = set.notCreated?.m || sub.notCreated?.s
    if (err) throw new Error(err.description || "That message couldn't be sent.")
    if (box.group && answers) box.setKeywords([answers], { $answered: true, [replyMark(user.value.id)]: true }).catch(() => {})
    else box.refreshCounts()
  }

  // start paints from the device, then asks the server.
  box.start = async () => {
    const saved = await kvGet(store())
    if (saved?.user === boot.value.mail.address) {
      box.mailboxes.value = saved.mailboxes || []
      box.lists.value = saved.lists || {}
      box.emails.value = saved.emails || {}
      box.threads.value = saved.threads || {}
      box.identity.value = saved.identity || null
      if (!box.group) {
        unread.value = { ...unread.value, mail: box.byRole('inbox')?.unreadEmails || 0 }
        if (box.mailboxes.value.length) mailReady.value = true
      }
    }
    const calls = [['Mailbox/get', { properties: BOXES }]]
    if (box.maySend()) calls.push(['Identity/get', {}])
    const [mb, idn] = await call(calls)
    setMailboxes(mb.list || [])
    // A person's own mailbox also lists their groups' addresses; each is sent
    // from its own box, so the copy lands in the right Sent.
    box.identity.value = idn?.list?.find((i) => i.email.toLowerCase() === box.address().toLowerCase()) || null
    if (!box.group) mailReady.value = true
    const inbox = box.byRole('inbox')
    if (inbox) await box.loadList(inbox.id)
  }

  // changed reloads what a push says is out of date.
  box.changed = debounce(() => {
    box.refreshCounts().catch(() => {})
    for (const key of Object.keys(box.lists.value)) {
      if (!key.startsWith('q:') && Date.now() - box.lists.value[key].at < 3600000) box.loadList(key).catch(() => {})
    }
  }, 400)

  return box
}

export const listKey = (mailboxId, search) => (search ? 'q:' + search : mailboxId)

// The person's own mailbox. Other parts of the suite (home, calendar, search)
// work with it through these names.
export const own = makeBox(null)
export const { mailboxes, lists, emails, threads, identity } = own
export const boxByRole = own.byRole
export const ensureMailbox = own.ensureMailbox

// Group mailboxes, made as the person joins groups and dropped as they leave.
const groupBoxes = new Map() // group id -> box

// boxFor returns the mailbox of a group the person belongs to (own for none).
export function boxFor(group) {
  if (!group) return own
  let box = groupBoxes.get(group.id)
  if (!box) {
    box = makeBox(group)
    groupBoxes.set(group.id, box)
    box.start().catch(() => {})
  }
  box.group = group
  return box
}

let events = null
let stopGroups = null

export async function startMail() {
  if (events || !boot.value?.mail?.ready) return
  try {
    await own.start()
  } catch {}
  stopGroups = effect(() => {
    const mine = new Set(myGroups.value.map((g) => g.id))
    for (const id of groupBoxes.keys()) if (!mine.has(id)) groupBoxes.delete(id)
    myGroups.value.forEach(boxFor)
  })
  // New mail arrives as a push, not a poll. One stream carries every
  // mailbox the person can open, each change under its account's id.
  events = new EventSource('/api/mail/events')
  events.addEventListener('state', (e) => {
    let changed = {}
    try {
      changed = JSON.parse(e.data).changed || {}
    } catch {}
    const types = Object.assign({}, ...Object.values(changed))
    if (!Object.keys(types).length) own.changed()
    for (const [account, kinds] of Object.entries(changed)) {
      if (!kinds.Email && !kinds.Mailbox) continue
      if (account === boot.value?.mail?.accountId) own.changed()
      for (const box of groupBoxes.values()) if (box.group.accountId === account) box.changed()
    }
    // Calendar and contacts subscribe for their own kinds.
    for (const fn of onPush) fn(types)
  })
}

// onPush: functions called with the kinds of data that just changed.
export const onPush = new Set()

export function stopMail() {
  events?.close()
  events = null
  stopGroups?.()
  stopGroups = null
  groupBoxes.clear()
}
