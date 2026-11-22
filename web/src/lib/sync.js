// Client side of the document sync protocol (see server/docs.go). One class
// serves both editors: it delivers the server's ordered log, tags each local
// update with an id, resends anything unacknowledged after a reconnect and
// recognises its own updates when they come back.

const UPDATE = 1, AWARENESS = 2, SNAPSHOT = 3, SYNCED = 4, ACK = 5, BASE = 6, LEAVE = 7, HELLO = 8, TITLE = 9
const TEXT = 10 // the document's plain text, for the server's search index

function writeVarint(n) {
  const out = []
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80)
    n = Math.floor(n / 0x80)
  }
  out.push(n)
  return out
}

function readVarint(buf, pos) {
  let v = 0, mul = 1
  for (;;) {
    const b = buf[pos++]
    v += (b & 0x7f) * mul
    if (b < 0x80) return [v, pos]
    mul *= 0x80
  }
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// fetchState downloads a document's whole state in one request, without a
// live connection: { base: bytes, updates: [bytes], seq }.
export async function fetchState(id) {
  const res = await fetch(`/api/docs/${id}/state`, { credentials: 'same-origin' })
  if (!res.ok) throw new Error('state ' + res.status)
  const buf = new Uint8Array(await res.arrayBuffer())
  const out = { base: new Uint8Array(0), updates: [], seq: 0 }
  let pos = 0
  while (pos < buf.length) {
    let len
    ;[len, pos] = readVarint(buf, pos)
    const m = buf.subarray(pos, pos + len)
    pos += len
    const [seq, p] = readVarint(m, 1)
    if (m[0] === BASE) out.base = m.slice(p)
    else if (m[0] === UPDATE) out.updates.push(m.slice(p + 8))
    out.seq = seq
  }
  return out
}

export class DocSocket {
  // handlers: base(seq, bytes), update(seq, bytes, mine), synced(seq),
  //           awareness(peer, bytes), leave(peer), hello(peer, canEdit),
  //           title(text), status(online)
  constructor(id, handlers, since = 0, ready = Promise.resolve()) {
    this.id = id
    this.h = handlers
    this.seq = since
    this.pending = new Map() // op id (hex) -> framed payload
    this.synced = false
    this.closed = false
    this.retry = 0
    ready.then(() => this.connect())
    this.onOnline = () => this.ws?.readyState > 1 && this.connect()
    addEventListener('online', this.onOnline)
    this.onHide = () => this.sendText() // a tab closed mid-thought still gets indexed
    addEventListener('pagehide', this.onHide)
  }

  connect() {
    if (this.closed) return
    clearTimeout(this.timer)
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/docs/${this.id}/sync?since=${this.seq}`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.synced = false
    ws.onmessage = (e) => this.receive(new Uint8Array(e.data))
    ws.onclose = () => {
      if (this.ws !== ws || this.closed) return
      this.synced = false
      this.h.status?.(false)
      this.timer = setTimeout(() => this.connect(), Math.min(8000, 300 * 2 ** this.retry++))
    }
  }

  receive(m) {
    const type = m[0]
    if (type === UPDATE) {
      const [seq, p] = readVarint(m, 1)
      const op = hex(m.subarray(p, p + 8))
      const mine = this.pending.delete(op)
      this.seq = seq
      this.h.update?.(seq, m.subarray(p + 8), mine)
    } else if (type === ACK) {
      const [seq, p] = readVarint(m, 1)
      this.pending.delete(hex(m.subarray(p, p + 8)))
      this.seq = Math.max(this.seq, seq)
      this.h.ack?.(seq)
    } else if (type === BASE) {
      const [seq, p] = readVarint(m, 1)
      this.seq = seq
      this.h.base?.(seq, m.subarray(p))
    } else if (type === SYNCED) {
      const [seq] = readVarint(m, 1)
      this.seq = seq
      this.synced = true
      this.retry = 0
      // Anything written while offline, or sent but never confirmed.
      for (const frame of this.pending.values()) this.ws.send(frame)
      if (this.textStale || this.textDirty) this.textSoon(1500)
      this.h.synced?.(seq)
      this.h.status?.(true)
    } else if (type === AWARENESS) {
      const [peer, p] = readVarint(m, 1)
      this.h.awareness?.(peer, m.subarray(p))
    } else if (type === LEAVE) {
      this.h.leave?.(readVarint(m, 1)[0])
    } else if (type === HELLO) {
      const [peer, p] = readVarint(m, 1)
      this.peer = peer
      this.canEdit = m[p] === 1
      this.textStale = m[p + 1] === 0
      this.h.hello?.(peer, m[p] === 1)
    } else if (type === TITLE) {
      this.h.title?.(new TextDecoder().decode(m.subarray(1)))
    }
  }

  get online() {
    return this.ws?.readyState === 1 && this.synced
  }

  // sendUpdate queues a local change; it is delivered now or after reconnect.
  sendUpdate(bytes) {
    const op = crypto.getRandomValues(new Uint8Array(8))
    const frame = new Uint8Array(9 + bytes.length)
    frame[0] = UPDATE
    frame.set(op, 1)
    frame.set(bytes, 9)
    this.pending.set(hex(op), frame)
    if (this.online) this.ws.send(frame)
    this.textSoon()
  }

  // Search. The server cannot read a document, so an editor sets `text` to a
  // function returning the document as plain text; a few seconds after the
  // last change (and when the server says its copy is out of date) that text
  // is sent for the index. Only someone who may edit is listened to.
  textSoon(ms = 4000) {
    if (!this.text || this.canEdit === false || this.closed) return
    this.textDirty = true
    clearTimeout(this.textTimer)
    this.textTimer = setTimeout(() => this.sendText(), ms)
  }

  sendText() {
    clearTimeout(this.textTimer)
    if (!this.textDirty || !this.online || !this.text) return
    let text
    try {
      text = this.text()
    } catch {}
    if (typeof text !== 'string') return
    text = text.slice(0, 400000)
    const same = text === this.textSent && !this.textStale
    this.textDirty = this.textStale = false
    if (same) return // formatting changed, the words did not
    this.textSent = text
    const bytes = new TextEncoder().encode(text)
    const frame = new Uint8Array(1 + bytes.length)
    frame[0] = TEXT
    frame.set(bytes, 1)
    this.ws.send(frame)
  }

  sendAwareness(bytes) {
    if (!this.online) return
    const frame = new Uint8Array(1 + bytes.length)
    frame[0] = AWARENESS
    frame.set(bytes, 1)
    this.ws.send(frame)
  }

  // sendSnapshot offers a compact state that covers the log up to seq.
  sendSnapshot(seq, bytes) {
    if (!this.online) return
    const head = [SNAPSHOT, ...writeVarint(seq)]
    const frame = new Uint8Array(head.length + bytes.length)
    frame.set(head, 0)
    frame.set(bytes, head.length)
    this.ws.send(frame)
  }

  close() {
    this.sendText()
    this.closed = true
    clearTimeout(this.timer)
    removeEventListener('online', this.onOnline)
    removeEventListener('pagehide', this.onHide)
    this.ws?.close()
  }
}
