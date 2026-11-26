// The headless content engine. The server (Go) cannot read or write the
// documents it stores, so for the public API it runs this: the app's own code
// for each kind of document, in Node, built into one file
// (vite.headless.config.js) and kept running.
//
// Protocol: one JSON message per line. The server sends one request at a
// time, {"id":N,"op":"...","args":{...}}, and gets {"id":N,"ok":{...}} or
// {"id":N,"error":"..."}. While working on it the engine may ask the server
// for something, {"id":N,"call":"blob"|"store","args":{...}}, and the server
// answers {"id":N,"reply":...}. Binary values are base64. Logs go to stderr.
import './dom.js'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { initSync } from '@ironcalc/wasm-xlsx'
import { docOps } from './docs.js'
import { sheetOps } from './sheets.js'
import { slideOps } from './slides.js'
import { calendarOps } from './calendar.js'

// stdout carries the protocol and nothing else.
console.log = console.info = console.debug = console.error

initSync({ module: readFileSync(new URL('./ironcalc.wasm', import.meta.url)) })

const ops = { ...docOps, ...sheetOps, ...slideOps, ...calendarOps }

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

// Calls to the server are answered in the order they were made.
let current = null
const waiting = []
const call = (name, args) => new Promise((resolve) => {
  waiting.push(resolve)
  send({ id: current, call: name, args })
})

async function handle(msg) {
  const id = msg?.id ?? null
  current = id
  try {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('A request must be a JSON object')
    const op = ops[msg.op]
    if (!op) throw new Error(`Unknown op ${JSON.stringify(msg.op)}. The ops are ${Object.keys(ops).join(', ')}`)
    const args = msg.args ?? {}
    if (typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be an object')
    send({ id, ok: await op(args, call) })
  } catch (e) {
    send({ id, error: e instanceof Error ? e.message : String(e) })
  }
}

let queue = Promise.resolve()
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    send({ id: null, error: 'A request must be one line of JSON' })
    return
  }
  if (msg && typeof msg === 'object' && 'reply' in msg) waiting.shift()?.(msg.reply)
  else queue = queue.then(() => handle(msg))
})
// The server has gone: finish what was asked, then stop.
lines.on('close', () => queue.then(() => process.exit(0)))
