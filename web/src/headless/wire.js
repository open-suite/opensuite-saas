// What crosses the wire between the server and the engine: arguments are
// checked here, binary values travel as base64, and a document's state is
// { base, updates } exactly as lib/sync.js fetchFrames returns it.
import * as Y from 'yjs'

export const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
export const toB64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')

const article = (type) => (/^[aeiou]/.test(type) ? 'an ' : 'a ') + type

// arg reads one argument and checks its type: string, number, integer,
// boolean, object or array. An optional one may be missing or null.
export function arg(args, key, type, optional = false) {
  const v = args[key]
  if (v == null && optional) return undefined
  const ok = type === 'array' ? Array.isArray(v)
    : type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v)
      : type === 'integer' ? Number.isInteger(v)
        : type === 'number' ? Number.isFinite(v)
          : typeof v === type
  if (!ok) throw new Error(`${key} must be ${article(type)}`)
  return v
}

export function oneOf(args, key, values, optional = false) {
  const v = arg(args, key, 'string', optional)
  if (v !== undefined && !values.includes(v)) throw new Error(`${key} must be one of: ${values.join(', ')}`)
  return v
}

// person reads { id, name } (an author) or { name, email } (a sender).
export function person(args, key, fields = ['id', 'name']) {
  const p = arg(args, key, 'object')
  for (const f of fields) if (typeof p[f] !== 'string' || (f !== 'name' && !p[f])) throw new Error(`${key}.${f} must be a string`)
  return Object.fromEntries(fields.map((f) => [f, p[f]]))
}

// frames reads a document's state: a snapshot (empty for none) and the
// updates after it, in server order.
export function frames(args, key = 'state') {
  const s = arg(args, key, 'object')
  if (typeof s.base !== 'string') throw new Error(`${key}.base must be a string (base64, empty for none)`)
  if (!Array.isArray(s.updates) || s.updates.some((u) => typeof u !== 'string')) throw new Error(`${key}.updates must be an array of strings (base64)`)
  return { base: fromB64(s.base), updates: s.updates.map(fromB64) }
}

export function openY(state) {
  const ydoc = new Y.Doc()
  if (state.base.length) Y.applyUpdate(ydoc, state.base)
  for (const u of state.updates) Y.applyUpdate(ydoc, u)
  return ydoc
}

// change runs `fn` as one transaction and returns, as base64, the update it
// made: what the server stores and relays to everyone with the document
// open. Nothing changed is an empty string.
export function change(ydoc, fn) {
  const made = []
  const keep = (u) => made.push(u)
  ydoc.on('update', keep)
  try {
    ydoc.transact(fn)
  } finally {
    ydoc.off('update', keep)
  }
  return made.length ? toB64(Y.mergeUpdates(made)) : ''
}
