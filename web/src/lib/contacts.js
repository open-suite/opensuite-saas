// Contacts data layer. A person's address book is kept whole on the device:
// the list paints at once, search is local, and address fields everywhere in
// the suite complete from it together with the organisation's own people.
import { signal, computed } from '@preact/signals'
import { boot, people, toast } from './store.js'
import { kvGet, kvSet } from './idb.js'
import { debounce, newId } from './util.js'
import { onPush } from './mail.js'
import { jm } from './calendar.js'

export const cards = signal([]) // the person's own contacts
export const contactsReady = signal(false)
let bookId = null
let state = null
const busy = new Set() // ids with a local change still on its way

const persist = debounce(() => kvSet('contacts', { user: boot.value?.mail?.address, cards: cards.value, bookId, state }), 600)
const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' })
function setCards(list) {
  cards.value = [...list].sort(byName)
  persist()
}

// --- reading a card ---------------------------------------------------------

const part = (card, kind) => card.name?.components?.find((c) => c.kind === kind)?.value || ''
export const emailsOf = (card) => Object.values(card.emails || {}).map((e) => e.address).filter(Boolean)
export const phonesOf = (card) => Object.values(card.phones || {}).map((p) => p.number).filter(Boolean)
export const companyOf = (card) => Object.values(card.organizations || {})[0]?.name || ''
export const titleOf = (card) => Object.values(card.titles || {})[0]?.name || ''
export function nameOf(card) {
  return card.name?.full || [part(card, 'given'), part(card, 'surname')].filter(Boolean).join(' ') || companyOf(card) || emailsOf(card)[0] || 'No name'
}

const label = (ctx) => (ctx?.work ? 'work' : ctx?.private ? 'home' : '')

export function toForm(card = {}) {
  let given = part(card, 'given')
  let surname = part(card, 'surname')
  if (!given && !surname && card.name?.full) {
    const bits = card.name.full.trim().split(/\s+/)
    surname = bits.length > 1 ? bits.pop() : ''
    given = bits.join(' ')
  }
  return {
    given, surname,
    company: companyOf(card), title: titleOf(card),
    emails: Object.values(card.emails || {}).map((e) => ({ value: e.address || '', label: label(e.contexts) })),
    phones: Object.values(card.phones || {}).map((p) => ({ value: p.number || '', label: p.features?.mobile ? 'mobile' : label(p.contexts) })),
    address: Object.values(card.addresses || {})[0]?.full || '',
    notes: Object.values(card.notes || {})[0]?.note || '',
  }
}

const contexts = (l) => (l === 'work' ? { contexts: { work: true } } : l === 'home' ? { contexts: { private: true } } : {})
const keyed = (list, prefix, make) => {
  const out = {}
  list.forEach((x, i) => (out[prefix + (i + 1)] = make(x)))
  return list.length ? out : undefined
}

export function fromForm(f) {
  const given = f.given.trim()
  const surname = f.surname.trim()
  const emails = f.emails.filter((e) => e.value.trim())
  const phones = f.phones.filter((p) => p.value.trim())
  const card = { '@type': 'Card', version: '1.0' }
  if (given || surname) {
    card.name = { full: [given, surname].filter(Boolean).join(' '), components: [given && { kind: 'given', value: given }, surname && { kind: 'surname', value: surname }].filter(Boolean), isOrdered: true }
  }
  card.emails = keyed(emails, 'e', (e) => ({ address: e.value.trim(), ...contexts(e.label) }))
  card.phones = keyed(phones, 'p', (p) => ({ number: p.value.trim(), ...(p.label === 'mobile' ? { features: { mobile: true } } : contexts(p.label)) }))
  card.organizations = f.company.trim() ? { o1: { name: f.company.trim() } } : undefined
  card.titles = f.title.trim() ? { t1: { name: f.title.trim(), kind: 'title' } } : undefined
  card.addresses = f.address.trim() ? { a1: { full: f.address.trim() } } : undefined
  card.notes = f.notes.trim() ? { n1: { note: f.notes.trim() } } : undefined
  return card
}

// --- sync -------------------------------------------------------------------

async function loadBook() {
  const [b] = await jm([['AddressBook/get', { properties: ['name', 'isDefault'] }]])
  const def = (b.list || []).find((x) => x.isDefault) || b.list?.[0]
  bookId = def?.id || null
  if (def && /\(.+@.+\)$/.test(def.name)) jm([['AddressBook/set', { update: { [def.id]: { name: 'My contacts' } } }]]).catch(() => {})
}

async function loadAll() {
  const [q] = await jm([['ContactCard/query', { limit: 20000 }]])
  const next = []
  let st = null
  for (let i = 0; i < q.ids.length || i === 0; i += 400) {
    const [g] = await jm([['ContactCard/get', { ids: q.ids.slice(i, i + 400) }]])
    next.push(...(g.list || []))
    st = g.state
  }
  for (const c of cards.value) if (busy.has(c.id) && !next.find((x) => x.id === c.id)) next.push(c)
  state = st
  setCards(next)
}

async function loadChanges() {
  const [ch, made, changed] = await jm([
    ['ContactCard/changes', { sinceState: state, maxChanges: 400 }, 'c'],
    ['ContactCard/get', { '#ids': { resultOf: 'c', name: 'ContactCard/changes', path: '/created' } }, 'a'],
    ['ContactCard/get', { '#ids': { resultOf: 'c', name: 'ContactCard/changes', path: '/updated' } }, 'b'],
  ])
  const map = new Map(cards.value.map((c) => [c.id, c]))
  for (const c of [...(made.list || []), ...(changed.list || [])]) if (!busy.has(c.id)) map.set(c.id, c)
  for (const id of ch.destroyed || []) map.delete(id)
  state = ch.newState
  setCards([...map.values()])
  if (ch.hasMoreChanges) return loadChanges()
}

let syncing = null
export function syncContacts() {
  syncing ??= (async () => {
    try {
      if (!bookId) await loadBook()
      if (state) await loadChanges().catch((e) => (e.type === 'cannotCalculateChanges' ? loadAll() : Promise.reject(e)))
      else await loadAll()
      contactsReady.value = true
    } catch {
      // Offline: carry on with the device copy.
    } finally {
      syncing = null
    }
  })()
  return syncing
}

const savedCopy = kvGet('contacts') // read while the page is still starting

let started = false
export async function startContacts() {
  if (started || !boot.value?.mail?.ready) return
  started = true
  const saved = await savedCopy
  if (saved?.user === boot.value.mail.address) {
    cards.value = saved.cards || []
    bookId = saved.bookId || null
    state = saved.state || null
    contactsReady.value = true
  }
  await syncContacts()
  onPush.add((types) => (types.ContactCard || types.AddressBook) && syncContacts())
}

// --- writing ----------------------------------------------------------------

export function saveContact(card, prev) {
  if (!prev) {
    const local = { ...card, id: 'tmp-' + newId(10) }
    busy.add(local.id)
    setCards([...cards.value, local])
    const done = (async () => {
      if (!bookId) await loadBook()
      const [r] = await jm([['ContactCard/set', { create: { n: { ...card, addressBookIds: { [bookId]: true } } } }]])
      const id = r.created?.n?.id
      if (!id) throw new Error(r.notCreated?.n?.description || "That contact couldn't be saved.")
      setCards(cards.value.map((c) => (c.id === local.id ? { ...c, id, addressBookIds: { [bookId]: true } } : c)))
      return id
    })()
      .catch((e) => {
        toast(e.message, 'error')
        setCards(cards.value.filter((c) => c.id !== local.id))
      })
      .finally(() => busy.delete(local.id))
    return { card: local, done }
  }
  const next = { ...prev, ...card }
  for (const k of ['name', 'emails', 'phones', 'organizations', 'titles', 'addresses', 'notes']) if (card[k] === undefined) delete next[k]
  busy.add(prev.id)
  setCards(cards.value.map((c) => (c.id === prev.id ? next : c)))
  const patch = {}
  for (const k of ['name', 'emails', 'phones', 'organizations', 'titles', 'addresses', 'notes']) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(card[k])) patch[k] = card[k] ?? null
  }
  const done = jm([['ContactCard/set', { update: { [prev.id]: patch } }]])
    .then(([r]) => {
      if (r.notUpdated?.[prev.id]) throw new Error(r.notUpdated[prev.id].description || "That change couldn't be saved.")
    })
    .catch((e) => {
      toast(e.message, 'error')
      setCards(cards.value.map((c) => (c.id === prev.id ? prev : c)))
    })
    .finally(() => busy.delete(prev.id))
  return { card: next, done }
}

export function deleteContact(card) {
  setCards(cards.value.filter((c) => c.id !== card.id))
  return jm([['ContactCard/set', { destroy: [card.id] }]]).catch((e) => {
    toast(e.message, 'error')
    syncContacts()
  })
}

// --- address completion -----------------------------------------------------

// addressBook: everyone an address field can complete to — colleagues first,
// then the person's own contacts — without duplicates.
export const addressBook = computed(() => {
  const seen = new Set()
  const out = []
  const add = (name, email, kind, id) => {
    const key = (email || '').toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ name: name || '', email, kind, id })
  }
  for (const p of people.value) if (p.status !== 'suspended') add(p.name, p.email, 'colleague', p.id)
  for (const c of cards.value) for (const e of emailsOf(c)) add(nameOf(c), e, 'contact', c.id)
  return out
})

export function suggest(q, taken = [], limit = 6) {
  const s = q.trim().toLowerCase()
  if (!s) return []
  const skip = new Set(taken.map((t) => t.toLowerCase()))
  const score = (a) => {
    const n = a.name.toLowerCase()
    const e = a.email.toLowerCase()
    if (n.startsWith(s) || e.startsWith(s)) return 0
    if (n.split(/\s+/).some((w) => w.startsWith(s))) return 1
    return n.includes(s) || e.includes(s) ? 2 : 9
  }
  return addressBook.value.filter((a) => !skip.has(a.email.toLowerCase())).map((a) => [score(a), a]).filter(([n]) => n < 9).sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, a]) => a)
}

// --- vCard ------------------------------------------------------------------

const vesc = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const vun = (s = '') => s.replace(/\\([nN;,\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))

export function toVCard(list) {
  const out = []
  for (const card of list) {
    const f = toForm(card)
    out.push('BEGIN:VCARD', 'VERSION:3.0', 'FN:' + vesc(nameOf(card)), `N:${vesc(f.surname)};${vesc(f.given)};;;`)
    for (const e of f.emails) out.push(`EMAIL;TYPE=INTERNET${e.label ? ',' + e.label.toUpperCase() : ''}:${vesc(e.value)}`)
    for (const p of f.phones) out.push(`TEL${p.label ? ';TYPE=' + (p.label === 'mobile' ? 'CELL' : p.label.toUpperCase()) : ''}:${vesc(p.value)}`)
    if (f.company) out.push('ORG:' + vesc(f.company))
    if (f.title) out.push('TITLE:' + vesc(f.title))
    if (f.address) out.push('ADR:;;' + vesc(f.address) + ';;;;')
    if (f.notes) out.push('NOTE:' + vesc(f.notes))
    out.push('END:VCARD')
  }
  return out.join('\r\n') + '\r\n'
}

function decodeQP(s) {
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(s.charCodeAt(i) & 0xff)
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

// parseVCard reads a .vcf file (versions 2.1, 3.0 and 4.0) into form values.
export function parseVCard(text) {
  const lines = text.replace(/=\r?\n/g, '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const out = []
  let f = null
  for (const line of lines) {
    const i = line.indexOf(':')
    if (i < 0) continue
    const [rawName, ...params] = line.slice(0, i).split(';')
    const name = rawName.replace(/^.*\./, '').toUpperCase() // "item1.EMAIL" -> EMAIL
    const p = params.join(';').toUpperCase()
    let value = line.slice(i + 1)
    if (p.includes('QUOTED-PRINTABLE')) value = decodeQP(value)
    const kind = /CELL|MOBILE/.test(p) ? 'mobile' : /WORK/.test(p) ? 'work' : /HOME/.test(p) ? 'home' : ''
    if (name === 'BEGIN' && value.toUpperCase() === 'VCARD') f = { given: '', surname: '', company: '', title: '', emails: [], phones: [], address: '', notes: '', full: '' }
    else if (!f) continue
    else if (name === 'END') {
      if (!f.given && !f.surname && f.full) {
        const bits = f.full.trim().split(/\s+/)
        f.surname = bits.length > 1 ? bits.pop() : ''
        f.given = bits.join(' ')
      }
      if (f.given || f.surname || f.company || f.emails.length || f.phones.length) out.push(f)
      f = null
    } else if (name === 'FN') f.full = vun(value)
    else if (name === 'N') {
      const [sur = '', giv = ''] = value.split(/(?<!\\);/).map(vun)
      f.surname = sur.trim()
      f.given = giv.trim()
    } else if (name === 'EMAIL') f.emails.push({ value: vun(value).trim(), label: kind === 'mobile' ? '' : kind })
    else if (name === 'TEL') f.phones.push({ value: vun(value).replace(/^tel:/i, '').trim(), label: kind })
    else if (name === 'ORG') f.company = vun(value.split(/(?<!\\);/)[0]).trim()
    else if (name === 'TITLE') f.title = vun(value).trim()
    else if (name === 'NOTE') f.notes = vun(value)
    else if (name === 'ADR' && !f.address) f.address = value.split(/(?<!\\);/).map(vun).map((s) => s.trim()).filter(Boolean).join(', ')
  }
  return out
}

// importContacts adds every card of a .vcf file, skipping ones whose address
// is already known.
export async function importContacts(text) {
  const known = new Set(cards.value.flatMap(emailsOf).map((e) => e.toLowerCase()))
  const fresh = parseVCard(text).filter((f) => !f.emails.length || !f.emails.some((e) => known.has(e.value.toLowerCase())))
  if (!fresh.length) return 0
  if (!bookId) await loadBook()
  for (let i = 0; i < fresh.length; i += 100) {
    const create = {}
    fresh.slice(i, i + 100).forEach((f, n) => (create['c' + n] = { ...fromForm(f), addressBookIds: { [bookId]: true } }))
    await jm([['ContactCard/set', { create }]])
  }
  await syncContacts()
  return fresh.length
}
