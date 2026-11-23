// Chat data layer: a compact Matrix client that talks to the homeserver on
// our own origin with the token the suite issued. State is kept on the device
// so chat paints from local data and then catches up.
import { signal } from '@preact/signals'
import { boot, patchBoot, peopleByMx, unread } from './store.js'
import { post } from './api.js'
import { kvGet, kvSet } from './idb.js'
import { debounce } from './util.js'

// { [roomId]: room } where room = { id, name, members, timeline, unread, prev, typing, ts }
export const rooms = signal({})
export const chatReady = signal(false)

let since = null
let running = false
let abort = null
let txn = 0
const KEEP = 60 // events per room kept on the device

const me = () => boot.value?.chat?.userId
const base = '/_matrix/client/v3'

export async function mx(method, path, body, raw) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = boot.value?.chat?.token
    const res = await fetch(path.startsWith('/_matrix') ? path : base + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
      signal: method === 'GET' && path.startsWith('/sync') ? abort?.signal : undefined,
    })
    if (res.status === 401 && attempt === 0) {
      // Token replaced (signed in elsewhere, password reset): fetch the current one.
      const fresh = await post('/api/chat/token', { bad: token }, { passive: true })
      patchBoot({ chat: { ...boot.value.chat, token: fresh.token, ready: true } })
      continue
    }
    if (!res.ok) throw new Error('chat ' + res.status)
    return raw === 'blob' ? res.blob() : res.json()
  }
}

const persist = debounce(() => {
  const slim = {}
  for (const [id, r] of Object.entries(rooms.value)) {
    slim[id] = { ...r, timeline: r.timeline.filter((e) => !e.pending).slice(-KEEP), typing: [] }
  }
  kvSet('chat', { since, rooms: slim, user: me() })
}, 800)

function commit(next) {
  rooms.value = next
  unread.value = { ...unread.value, chat: Object.values(next).reduce((n, r) => n + (r.unread || 0), 0) }
  persist()
}

export function isExternalMx(mxid) {
  return typeof mxid === 'string' && mxid.startsWith('@slack_')
}

export function nameOf(mxid, room) {
  return peopleByMx.value[mxid]?.name || room?.members?.[mxid]?.name || mxid?.slice(1).split(':')[0] || ''
}

// A room without a name is a direct conversation: title it by who is in it.
export function roomTitle(room) {
  if (room.name) return room.name
  const others = Object.keys(room.members || {}).filter((m) => m !== me() && room.members[m].in)
  if (!others.length) return 'Just you'
  return others.map((m) => nameOf(m, room)).join(', ')
}

export function directPeer(room) {
  if (room.name) return null
  const others = Object.keys(room.members || {}).filter((m) => m !== me() && room.members[m].in)
  return others.length === 1 ? others[0] : null
}

function toEvent(ev) {
  const c = ev.content || {}
  const out = { id: ev.event_id, sender: ev.sender, ts: ev.origin_server_ts, txn: ev.unsigned?.transaction_id }
  if (ev.type === 'm.room.message') {
    if (c['m.relates_to']?.rel_type === 'm.replace') {
      const target = c['m.relates_to']?.event_id
      const body = c['m.new_content']?.body || c.body
      return target && body ? { ...out, kind: 'edit', target, body } : null
    }
    if (c.msgtype === 'm.image') return { ...out, kind: 'image', body: c.body, url: c.url, w: c.info?.w, h: c.info?.h }
    if (c.msgtype === 'm.file' || c.msgtype === 'm.video' || c.msgtype === 'm.audio') return { ...out, kind: 'file', body: c.body, url: c.url, size: c.info?.size }
    if (!c.body) return null
    return { ...out, kind: 'text', body: c.body }
  }
  if (ev.type === 'm.reaction') {
    const rel = c['m.relates_to']
    if (rel?.rel_type === 'm.annotation' && rel.event_id && rel.key) {
      return { ...out, kind: 'reaction', target: rel.event_id, key: rel.key }
    }
    return null
  }
  if (ev.type === 'm.room.member' && ev.state_key) {
    const prev = ev.unsigned?.prev_content?.membership
    if (c.membership === 'join' && prev !== 'join') return { ...out, kind: 'note', who: ev.state_key, body: 'joined' }
    if (c.membership === 'leave' && prev === 'join') return { ...out, kind: 'note', who: ev.state_key, body: 'left' }
    return null
  }
  if (ev.type === 'm.room.redaction' && ev.redacts) return { ...out, kind: 'redact', target: ev.redacts }
  return null
}

function foldTimeline(timeline, events) {
  let out = timeline
  for (const e of events) {
    if (e.kind === 'edit') {
      out = out.map((m) => (m.id === e.target ? { ...m, body: e.body, edited: true } : m))
      continue
    }
    if (e.kind === 'redact') {
      out = out
        .filter((m) => m.id !== e.target)
        .map((m) => {
          if (!m.reactions) return m
          let changed = false
          const next = {}
          for (const [k, ids] of Object.entries(m.reactions)) {
            const kept = ids.filter((id) => id !== e.target)
            if (kept.length !== ids.length) changed = true
            if (kept.length) next[k] = kept
          }
          return changed ? { ...m, reactions: next } : m
        })
      continue
    }
    if (e.kind === 'reaction') {
      out = out.map((m) => {
        if (m.id !== e.target) return m
        const cur = m.reactions || {}
        const ids = cur[e.key] || []
        if (ids.includes(e.id)) return m
        return { ...m, reactions: { ...cur, [e.key]: [...ids, e.id] } }
      })
      continue
    }
    out = out.filter((m) => m.id !== e.id && !(m.pending && e.txn && m.txn === e.txn))
    out = [...out, e]
  }
  return out
}

function applyState(room, ev) {
  if (ev.type === 'm.room.name') room.name = ev.content?.name || ''
  if (ev.type === 'm.room.member' && ev.state_key) {
    const m = ev.content?.membership
    room.members = { ...room.members, [ev.state_key]: { name: ev.content?.displayname || '', in: m === 'join' || m === 'invite' } }
  }
}

function applySync(data) {
  const next = { ...rooms.value }
  for (const [id, j] of Object.entries(data.rooms?.join || {})) {
    const room = { id, name: '', members: {}, timeline: [], unread: 0, typing: [], ts: 0, ...next[id] }
    for (const ev of j.state?.events || []) applyState(room, ev)
    let timeline = j.timeline?.limited ? [] : room.timeline
    if (j.timeline?.limited || !room.prev) room.prev = j.timeline?.prev_batch || room.prev
    const fresh = []
    for (const ev of j.timeline?.events || []) {
      if (ev.state_key !== undefined) applyState(room, ev)
      const e = toEvent(ev)
      if (e) fresh.push(e)
    }
    if (fresh.length) {
      timeline = foldTimeline(timeline, fresh)
      const lastMsg = [...fresh].reverse().find((e) => e.kind !== 'edit' && e.kind !== 'redact' && e.kind !== 'reaction')
      if (lastMsg?.ts) room.ts = lastMsg.ts
    }
    room.timeline = timeline
    if (j.unread_notifications) room.unread = j.unread_notifications.notification_count || 0
    // Whoever just sent a message has, by definition, stopped typing.
    if (fresh.length && room.typing?.length) room.typing = room.typing.filter((u) => !fresh.some((e) => e.sender === u))
    for (const ev of j.ephemeral?.events || []) {
      if (ev.type !== 'm.typing') continue
      room.typing = (ev.content?.user_ids || []).filter((u) => u !== me())
      if (room.typing.length) expireTyping(id)
    }
    // Members the server names as the faces of the room (direct chats).
    for (const hero of j.summary?.['m.heroes'] || []) {
      if (!room.members[hero]) room.members = { ...room.members, [hero]: { name: '', in: true } }
    }
    if (!room.ts) room.ts = Date.now()
    next[id] = room
  }
  for (const id of Object.keys(data.rooms?.leave || {})) delete next[id]
  // Invitations from colleagues are accepted on arrival: no inbox of invites.
  // The room is shown at once, so the person invited never starts a second
  // conversation with someone who has just written to them.
  for (const [id, inv] of Object.entries(data.rooms?.invite || {})) {
    if (next[id] || joining.has(id)) continue
    const events = inv.invite_state?.events || []
    const mine = events.find((e) => e.type === 'm.room.member' && e.state_key === me())
    const name = events.find((e) => e.type === 'm.room.name')?.content?.name || ''
    const members = { [me()]: { name: '', in: true } }
    for (const e of events) if (e.type === 'm.room.member' && e.state_key !== me()) members[e.state_key] = { name: e.content?.displayname || '', in: true }
    if (mine?.sender && !members[mine.sender]) members[mine.sender] = { name: '', in: true }
    next[id] = { id, name, members, timeline: [], unread: 1, typing: [], ts: Date.now() }
    joining.add(id)
    mx('POST', `/join/${encodeURIComponent(id)}`, {}).catch(() => {}).finally(() => joining.delete(id))
  }
  commit(next)
}

const joining = new Set()

// A "typing" notice is only good for a few seconds; never let one linger if
// the all-clear from the server is missed.
const typingTimers = new Map()
function expireTyping(id) {
  clearTimeout(typingTimers.get(id))
  typingTimers.set(id, setTimeout(() => {
    const room = rooms.value[id]
    if (room?.typing?.length) commit({ ...rooms.value, [id]: { ...room, typing: [] } })
  }, 8000))
}

const filter = JSON.stringify({
  // Full membership: who is in a room decides its title and whether it is a
  // direct conversation, so it must be complete, not inferred from senders.
  room: { timeline: { limit: 40 }, state: { lazy_load_members: false }, account_data: { types: [] } },
  presence: { types: [] },
  account_data: { types: [] },
})

async function loop() {
  let backoff = 1000
  while (running) {
    try {
      abort = new AbortController()
      const q = new URLSearchParams({ timeout: since ? '30000' : '0', filter })
      if (since) q.set('since', since)
      const data = await mx('GET', '/sync?' + q)
      if (!running) return
      since = data.next_batch
      applySync(data)
      chatReady.value = true
      backoff = 1000
    } catch (e) {
      if (!running) return
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}

export async function startChat() {
  if (running || !boot.value?.chat?.ready) return
  running = true
  const saved = await kvGet('chat')
  if (saved?.user === me() && saved.rooms) {
    since = saved.since
    rooms.value = saved.rooms
    unread.value = { ...unread.value, chat: Object.values(saved.rooms).reduce((n, r) => n + (r.unread || 0), 0) }
    chatReady.value = true
  }
  loop()
}

export function stopChat() {
  running = false
  abort?.abort()
}

function echo(roomId, event) {
  const room = rooms.value[roomId]
  if (!room) return
  commit({ ...rooms.value, [roomId]: { ...room, timeline: [...room.timeline, event], ts: event.ts } })
}

function settle(roomId, txnId, patch) {
  const room = rooms.value[roomId]
  if (!room) return
  commit({ ...rooms.value, [roomId]: { ...room, timeline: room.timeline.map((e) => (e.txn === txnId && e.pending ? { ...e, ...patch } : e)) } })
}

async function sendContent(roomId, content, local) {
  const txnId = 'os' + Date.now() + '.' + txn++
  echo(roomId, { id: '~' + txnId, txn: txnId, sender: me(), ts: Date.now(), pending: true, ...local })
  try {
    const res = await mx('PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`, content)
    settle(roomId, txnId, { id: res.event_id, pending: false })
  } catch {
    settle(roomId, txnId, { failed: true })
  }
}

export function sendText(roomId, body) {
  typingAt = 0
  mx('PUT', `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(me())}`, { typing: false }).catch(() => {})
  return sendContent(roomId, { msgtype: 'm.text', body }, { kind: 'text', body })
}

export async function sendFile(roomId, file) {
  const up = await mx('POST', '/_matrix/media/v3/upload?filename=' + encodeURIComponent(file.name), file, true)
  const image = file.type.startsWith('image/')
  const content = { msgtype: image ? 'm.image' : 'm.file', body: file.name, url: up.content_uri, info: { mimetype: file.type, size: file.size } }
  return sendContent(roomId, content, { kind: image ? 'image' : 'file', body: file.name, url: up.content_uri, size: file.size })
}

export async function markRead(roomId) {
  const room = rooms.value[roomId]
  if (!room) return
  const last = [...room.timeline].reverse().find((e) => !e.pending && e.id?.startsWith('$'))
  if (room.unread) commit({ ...rooms.value, [roomId]: { ...room, unread: 0 } })
  if (last && room.readUpTo !== last.id) {
    room.readUpTo = last.id
    mx('POST', `/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(last.id)}`, {}).catch(() => {})
  }
}

let typingAt = 0
export function sendTyping(roomId) {
  if (Date.now() - typingAt < 4000) return
  typingAt = Date.now()
  mx('PUT', `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(me())}`, { typing: true, timeout: 6000 }).catch(() => {})
}

// loadOlder pages back through history; returns false at the beginning.
export async function loadOlder(roomId) {
  const room = rooms.value[roomId]
  if (!room?.prev) return false
  const data = await mx('GET', `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=50&from=${encodeURIComponent(room.prev)}`)
  const older = (data.chunk || []).map(toEvent).filter((e) => e && e.kind !== 'edit' && e.kind !== 'redact' && e.kind !== 'reaction').reverse()
  const cur = rooms.value[roomId]
  const have = new Set(cur.timeline.map((e) => e.id))
  commit({ ...rooms.value, [roomId]: { ...cur, prev: data.end || null, timeline: [...older.filter((e) => !have.has(e.id)), ...cur.timeline] } })
  return !!data.end && older.length > 0
}

// openDirect returns the room for a one-to-one conversation, creating it the
// first time.
export async function openDirect(mxid) {
  for (const r of Object.values(rooms.value)) if (directPeer(r) === mxid) return r.id
  const res = await mx('POST', '/createRoom', { preset: 'trusted_private_chat', is_direct: true, invite: [mxid] })
  seed(res.room_id, '', [mxid])
  return res.room_id
}

export async function createRoom(name, mxids) {
  const res = await mx('POST', '/createRoom', { preset: 'private_chat', name, invite: mxids })
  seed(res.room_id, name, mxids)
  return res.room_id
}

// seed shows a new room immediately instead of waiting for the next sync.
function seed(id, name, mxids) {
  if (rooms.value[id]) return
  const members = { [me()]: { name: '', in: true } }
  for (const m of mxids) members[m] = { name: '', in: true }
  commit({ ...rooms.value, [id]: { id, name, members, timeline: [], unread: 0, typing: [], ts: Date.now() } })
}

export const inviteTo = (roomId, mxid) => mx('POST', `/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: mxid })

export async function leaveRoom(roomId) {
  await mx('POST', `/rooms/${encodeURIComponent(roomId)}/leave`, {})
  const next = { ...rooms.value }
  delete next[roomId]
  commit(next)
}

// Media needs the token, so images are fetched and handed over as object URLs.
const media = new Map()
export function mediaUrl(mxc, thumb) {
  const key = mxc + (thumb ? ':t' : '')
  if (!media.has(key)) {
    const [server, id] = mxc.replace('mxc://', '').split('/')
    const path = thumb
      ? `/_matrix/client/v1/media/thumbnail/${server}/${id}?width=640&height=480&method=scale`
      : `/_matrix/client/v1/media/download/${server}/${id}`
    media.set(key, mx('GET', path, undefined, 'blob').then((b) => URL.createObjectURL(b)))
  }
  return media.get(key)
}
