// End-to-end check of the headless content engine (src/headless/): spawns
// the built engine, plays the server's part of the protocol and runs every
// op, including writes that must merge with a colleague's edit made at the
// same moment. Build first, then run from anywhere:
//   npm --prefix web run build && node web/scripts/check-headless.mjs
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import { initSync, Model } from '@ironcalc/wasm-xlsx'
import { getSchema } from '@tiptap/core'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { formatExtensions } from '../src/apps/doc-format.js'

initSync({ module: readFileSync(new URL('../node_modules/@ironcalc/wasm-xlsx/wasm_bg.wasm', import.meta.url)) })

const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// --- the engine, and the server's side of the protocol ---------------------------

const t0 = performance.now()
const engine = spawn(process.execPath, [fileURLToPath(new URL('../dist-headless/engine.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] })
const waiting = new Map()
const calls = []
const stored = new Map() // what the "store" call kept, by address
const unaddressed = [] // answers to lines that were not requests
createInterface({ input: engine.stdout }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.call) {
    calls.push(msg.call)
    let reply = null
    if (msg.call === 'blob' && msg.args.src === '/api/blobs/pic1') reply = { data: PNG, mime: 'image/png', w: 1, h: 1 }
    if (msg.call === 'store') {
      const url = '/api/blobs/stored' + (stored.size + 1)
      stored.set(url, msg.args)
      reply = { url }
    }
    engine.stdin.write(JSON.stringify({ id: msg.id, reply }) + '\n')
    return
  }
  if (msg.id === null) return unaddressed.push(msg)
  waiting.get(msg.id)(msg)
  waiting.delete(msg.id)
})

let seq = 0
const timings = {}
let cold = null
function request(op, args) {
  const id = ++seq
  const start = performance.now()
  return new Promise((resolve) => {
    waiting.set(id, (msg) => {
      const ms = performance.now() - start
      cold ??= performance.now() - t0
      ;(timings[op] ||= []).push(ms)
      resolve(msg)
    })
    engine.stdin.write(JSON.stringify({ id, op, args }) + '\n')
  })
}
async function ok(op, args) {
  const r = await request(op, args)
  if (r.error) throw new Error(`${op}: ${r.error}`)
  return r.ok
}
async function fails(op, args, pattern) {
  const r = await request(op, args)
  assert.ok(r.error, `${op} should fail`)
  assert.match(r.error, pattern)
}

// A document's state as the server keeps it: a base and the log after it.
const empty = () => ({ base: '', updates: [] })
const plus = (state, ...updates) => ({ base: state.base, updates: [...state.updates, ...updates.filter(Boolean)] })
function ydocOf(state) {
  const d = new Y.Doc()
  if (state.base) Y.applyUpdate(d, unb64(state.base))
  for (const u of state.updates) Y.applyUpdate(d, unb64(u))
  return d
}
// edit makes a change as a browser would and returns its update.
function edit(state, fn) {
  const d = ydocOf(state)
  const made = []
  d.on('update', (u) => made.push(u))
  fn(d)
  d.destroy()
  return b64(Y.mergeUpdates(made))
}

// --- text documents ------------------------------------------------------------------

const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(engine.pid)]).toString().trim()) / 1024
let doc = empty()
assert.deepEqual(await ok('doc.read', { state: doc }), { html: '', text: '' })
const started = rss()
let w = await ok('doc.write', {
  state: doc, mode: 'replace',
  html: '<h1>Plan</h1><p>First we buy apples.</p><p style="text-align: center">Centred line</p><ul><li><p>one</p></li><li><p>two</p></li></ul>',
})
doc = plus(doc, w.update)
let r = await ok('doc.read', { state: doc })
assert.match(r.html, /<h1>Plan<\/h1>/)
assert.match(r.html, /<p style="text-align: center;?">Centred line<\/p>/)
assert.equal(r.text, 'Plan\nFirst we buy apples.\nCentred line\none\ntwo')
assert.equal(w.text, r.text)

const ada = { id: 'u-ada', name: 'Ada' }
const grace = { id: 'u-grace', name: 'Grace' }
const c = await ok('doc.comment', { state: doc, quote: 'apples', text: 'Which kind?', author: ada })
assert.equal(c.thread.quote, 'apples')
assert.deepEqual(c.thread.author, ada)
doc = plus(doc, c.update)
doc = plus(doc, (await ok('doc.reply', { state: doc, thread: c.thread.id, text: 'Green ones.', author: grace })).update)
doc = plus(doc, (await ok('doc.resolve', { state: doc, thread: c.thread.id, resolved: true, author: grace })).update)
let threads = (await ok('doc.comments', { state: doc })).threads
assert.equal(threads.length, 1)
assert.equal(threads[0].quote, 'apples')
assert.equal(threads[0].replies[0].text, 'Green ones.')
assert.deepEqual(threads[0].resolved && { id: threads[0].resolved.id, name: threads[0].resolved.name }, grace)
r = await ok('doc.read', { state: doc })
assert.doesNotMatch(r.html, /data-c=|class="cmt"/) // the reading form has no comment markup
await fails('doc.comment', { state: doc, quote: 'bananas', text: 'x', author: ada }, /does not contain/)
await fails('doc.reply', { state: doc, thread: 'nope', text: 'x', author: ada }, /No comment thread/)

// Writing back what was read changes nothing.
assert.equal((await ok('doc.write', { state: doc, mode: 'replace', html: r.html })).update, '')

// An edit inside the commented paragraph keeps the comment on its words.
const version1 = doc
w = await ok('doc.write', { state: doc, mode: 'replace', html: r.html.replace('First we buy apples.', 'First we buy ripe apples.') })
doc = plus(doc, w.update)
threads = (await ok('doc.comments', { state: doc })).threads
assert.equal(threads[0].quote, 'apples')

// Two edits made from the same state, one through the engine (the heading)
// and one in a browser (typing in the centred line), both survive in either
// order.
const browser = edit(doc, (d) => d.getXmlFragment('default').get(2).get(0).insert(0, 'Typed '))
const api = (await ok('doc.write', { state: doc, mode: 'replace', html: (await ok('doc.read', { state: doc })).html.replace('Plan', 'Plan v2') })).update
const one = (await ok('doc.read', { state: plus(doc, browser, api) })).text
const two = (await ok('doc.read', { state: plus(doc, api, browser) })).text
assert.equal(one, two)
assert.match(one, /^Plan v2\n/)
assert.match(one, /\nTyped Centred line\n/)
doc = plus(doc, browser, api)

doc = plus(doc, (await ok('doc.write', { state: doc, mode: 'append', html: '<p>The end.</p>' })).update)
doc = plus(doc, (await ok('doc.write', { state: doc, mode: 'prepend', html: '<p>Draft</p>' })).update)
r = await ok('doc.read', { state: doc })
assert.match(r.text, /^Draft\nPlan v2\n[^]*\nThe end\.$/)
assert.equal((await ok('doc.write', { state: doc, mode: 'append', html: '' })).update, '')

// Restoring a version is an edit back to its text.
const restored = await ok('doc.restore', { state: doc, version: version1, author: ada })
assert.equal(restored.text, (await ok('doc.read', { state: version1 })).text)
doc = plus(doc, restored.update)
assert.equal((await ok('doc.read', { state: doc })).text, restored.text)
assert.equal((await ok('doc.comments', { state: doc })).threads[0].quote, 'apples')

// Suggestions read as accepted, and survive a write that leaves them be.
const schema = getSchema(formatExtensions(null))
const sug = { id: 's1', by: 'u-grace', name: 'Grace', at: 1 }
const suggested = edit(empty(), (d) => prosemirrorJSONToYXmlFragment(schema, {
  type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Keep this ' }, { type: 'text', text: 'old', marks: [{ type: 'del', attrs: sug }] }, { type: 'text', text: 'new', marks: [{ type: 'ins', attrs: sug }] }, { type: 'text', text: ' word.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second.' }] },
  ],
}, d.getXmlFragment('default')))
const sdoc = plus(empty(), suggested)
r = await ok('doc.read', { state: sdoc })
assert.equal(r.html, '<p>Keep this new word.</p><p>Second.</p>')
assert.equal(r.text, 'Keep this oldnew word.\nSecond.') // the search text has every word
w = await ok('doc.write', { state: sdoc, mode: 'replace', html: '<p>Keep this new word.</p><p>Second, changed.</p>' })
assert.match((await ok('doc.read', { state: plus(sdoc, w.update) })).text, /^Keep this oldnew word\.\nSecond, changed\.$/)

// --- spreadsheets ----------------------------------------------------------------------

let sheet = empty()
let s = await ok('sheet.write', { state: sheet, start: 'A1', values: [['Item', 'Qty'], ['Apples', 3], ['Pears', 4], ['Total', '=SUM(B2:B3)']] })
sheet = plus(sheet, s.update)
let sr = await ok('sheet.read', { state: sheet })
assert.equal(sr.range, 'A1:B4')
assert.deepEqual(sr.values, [['Item', 'Qty'], ['Apples', '3'], ['Pears', '4'], ['Total', '7']])
assert.equal(sr.formulas[3][1], '=SUM(B2:B3)')
assert.equal(sr.csv, 'Item,Qty\r\nApples,3\r\nPears,4\r\nTotal,7')
assert.deepEqual(sr.sheets, [{ name: 'Sheet1', index: 0, rows: 4, cols: 2 }])
assert.match(s.text, /Apples 3/)

// Another person's diff lands first; the engine's, made without it, still
// applies after it.
const theirs = new Model('Workbook', 'en', 'UTC', 'en')
for (const u of sheet.updates) theirs.applyExternalDiffs(unb64(u))
theirs.setUserInput(0, 2, 2, '10')
theirs.newSheet()
theirs.renameSheet(1, '_charts_x1')
theirs.hideSheet(1)
const other = b64(theirs.flushSendQueue())
theirs.free()
s = await ok('sheet.write', { state: sheet, start: 'D1', values: [['Note'], [null], ['=B4*2']] })
sheet = plus(sheet, other, s.update)
sr = await ok('sheet.read', { state: sheet, range: 'A1:D4' })
assert.deepEqual(sr.values.map((row) => row[1]), ['Qty', '10', '4', '14'])
assert.deepEqual(sr.values.map((row) => row[3]), ['Note', '', '28', ''])
assert.deepEqual(sr.sheets.map((x) => x.name), ['Sheet1']) // the hidden chart sheet stays hidden
await fails('sheet.read', { state: sheet, range: "'_charts_x1'!A1" }, /No sheet/)
await fails('sheet.read', { state: sheet, sheet: 'Nope' }, /No sheet "Nope"/)
await fails('sheet.write', { state: sheet, start: 'nowhere', values: [['x']] }, /start must be a cell/)

s = await ok('sheet.addSheet', { state: sheet, name: 'Budget' })
sheet = plus(sheet, s.update)
await fails('sheet.addSheet', { state: sheet, name: 'budget' }, /already a sheet/)
sheet = plus(sheet, (await ok('sheet.write', { state: sheet, sheet: 'Budget', start: 'B2', csv: 'Rent,1200\n"Food, drink",300' })).update)
sr = await ok('sheet.read', { state: sheet, sheet: 1 })
assert.equal(sr.sheet, 'Budget')
assert.equal(sr.range, 'A1:C3')
assert.deepEqual(sr.values[2], ['', 'Food, drink', '300'])
sheet = plus(sheet, (await ok('sheet.write', { state: sheet, sheet: 'Budget', clear: 'B2:C2' })).update)
assert.deepEqual((await ok('sheet.read', { state: sheet, sheet: 'Budget', range: 'B2:C3' })).values, [['', ''], ['Food, drink', '300']])
assert.equal((await ok('sheet.write', { state: sheet, start: 'A1', values: [[null]] })).update, '')

const xlsx = (await ok('sheet.xlsx', { state: sheet })).xlsx
assert.equal(Buffer.from(xlsx, 'base64').subarray(0, 2).toString(), 'PK')
const fromX = await ok('sheet.fromXlsx', { xlsx, name: 'Copy' })
assert.match(fromX.text, /Apples 10/)
assert.doesNotMatch(fromX.text, /_charts_/)
assert.deepEqual((await ok('sheet.read', { state: { base: fromX.snapshot, updates: [] } })).sheets.map((x) => x.name), ['Sheet1', 'Budget'])
const fromC = await ok('sheet.fromCsv', { csv: 'a;b\n1;2', name: 'Semi' })
assert.deepEqual((await ok('sheet.read', { state: { base: fromC.snapshot, updates: [] } })).values, [['a', 'b'], ['1', '2']])

// --- presentations ---------------------------------------------------------------------

let deck = empty()
assert.deepEqual(await ok('slides.read', { state: deck }), { theme: 'paper', empty: true, slides: [] })
let sw = await ok('slides.write', { state: deck, author: ada, ops: [{ op: 'addSlide', layout: 'titleBody', title: 'Agenda', body: 'Alpha\nBeta\n- one\n- two', notes: 'Say hello' }] })
deck = plus(deck, sw.update)
let deckJSON = await ok('slides.read', { state: deck })
assert.deepEqual(deckJSON.slides.map((x) => [x.id, x.layout]), [['first', 'title'], [sw.added[0], 'titleBody']])
const agenda = deckJSON.slides[1]
const body = agenda.elements.find((e) => e.role === 'body')
assert.equal(agenda.elements.find((e) => e.role === 'title').text, 'Agenda')
assert.equal(body.text, 'Alpha\nBeta\none\ntwo')
assert.match(body.html, /<ul><li><p>one<\/p><\/li><li><p>two<\/p><\/li><\/ul>/)
assert.equal(agenda.notes, 'Say hello')
assert.match(sw.text, /Agenda\nAlpha/)

// A colleague types in "Beta" while the engine rewrites "Alpha".
const typing = edit(deck, (d) => d.getMap('slides').get(agenda.id).get('els').get(body.id).get('text').get(1).get(0).insert(0, 'X'))
const rewrite = (await ok('slides.write', { state: deck, author: ada, ops: [{ op: 'setText', slide: agenda.id, element: body.id, text: 'Alpha changed\nBeta\n- one\n- two' }] })).update
const bodyAfter = async (state) => (await ok('slides.read', { state })).slides[1].elements.find((e) => e.id === body.id).text
assert.equal(await bodyAfter(plus(deck, typing, rewrite)), 'Alpha changed\nXBeta\none\ntwo')
assert.equal(await bodyAfter(plus(deck, rewrite, typing)), 'Alpha changed\nXBeta\none\ntwo')
deck = plus(deck, typing, rewrite)

sw = await ok('slides.write', {
  state: deck, author: ada, ops: [
    { op: 'setText', slide: 'first', element: 'first0', text: 'Welcome' },
    { op: 'setNotes', slide: 'first', notes: 'Open warmly' },
    { op: 'addSlide', layout: 'section', title: 'Part two', position: 2, id: 'part2' },
    { op: 'moveSlide', slide: agenda.id, position: 1 },
    { op: 'setLayout', slide: 'part2', layout: 'titleBody' },
    { op: 'setTheme', theme: 'midnight' },
  ],
})
deck = plus(deck, sw.update)
deckJSON = await ok('slides.read', { state: deck })
assert.equal(deckJSON.theme, 'midnight')
assert.deepEqual(deckJSON.slides.map((x) => x.id), [agenda.id, 'first', 'part2'])
assert.equal(deckJSON.slides[1].elements[0].text, 'Welcome')
assert.equal(deckJSON.slides[1].notes, 'Open warmly')
assert.deepEqual(deckJSON.slides[2].elements.map((e) => e.role), ['title', 'body'])
await fails('slides.write', { state: deck, author: ada, ops: [{ op: 'addSlide', layout: 'fancy' }] }, /ops\[0\] \(addSlide\): Unknown layout "fancy". The layouts are title/)
await fails('slides.write', { state: deck, author: ada, ops: [{ op: 'setTheme', theme: 'neon' }] }, /theme must be one of: paper, midnight/)
await fails('slides.write', { state: deck, author: ada, ops: [{ op: 'addSlide', layout: 'blank', title: 'x' }] }, /no place for a title/)
deck = plus(deck, (await ok('slides.write', { state: deck, author: ada, ops: [{ op: 'deleteSlide', slide: 'part2' }] })).update)
assert.equal((await ok('slides.read', { state: deck })).slides.length, 2)

// PowerPoint out (the picture comes from the server) and back in (the
// picture goes to the server).
deck = plus(deck, edit(deck, (d) => {
  const el = new Y.Map()
  for (const [k, v] of Object.entries({ id: 'pic', type: 'image', src: '/api/blobs/pic1', x: 100, y: 100, w: 200, h: 200, rot: 0, z: 9 })) el.set(k, v)
  d.getMap('slides').get('first').get('els').set('pic', el)
}))
const pptx = (await ok('slides.pptx', { state: deck, title: 'Deck' })).pptx
assert.ok(calls.includes('blob'))
assert.equal(Buffer.from(pptx, 'base64').subarray(0, 2).toString(), 'PK')
const imported = await ok('slides.fromPptx', { pptx })
assert.equal(stored.size, 1)
assert.equal([...stored.values()][0].mime, 'image/png')
const back = await ok('slides.read', { state: { base: imported.snapshot, updates: [] } })
assert.equal(back.slides.length, 2)
assert.ok(back.slides[1].elements.some((e) => e.type === 'image' && e.src === '/api/blobs/stored1'))
assert.match(imported.text, /Agenda[^]*Welcome/)

// --- calendar ----------------------------------------------------------------------------

const ev = {
  id: 'e1', uid: 'u1@office.test', title: 'Planning', start: '2026-11-23T09:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H',
  recurrenceRule: { frequency: 'weekly', count: 3 }, organizerCalendarAddress: 'mailto:ada@office.test',
  participants: {
    a: { name: 'Ada', calendarAddress: 'mailto:ada@office.test', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
    g: { name: 'Grace', calendarAddress: 'mailto:grace@office.test', roles: { attendee: true }, participationStatus: 'needs-action' },
  },
}
const allDay = { id: 'e2', uid: 'u2', title: 'Holiday', start: '2026-11-25T00:00:00', duration: 'P1D', showWithoutTime: true }
const occ = (await ok('calendar.occurrences', { events: [ev, allDay], from: Date.parse('2026-11-23T00:00:00Z'), to: Date.parse('2026-12-31T00:00:00Z'), zone: 'Asia/Tokyo' })).occurrences
assert.deepEqual(occ.map((o) => [o.id, o.recurrenceId, new Date(o.start).toISOString()]), [
  ['e1', '2026-11-23T09:00:00', '2026-11-23T08:00:00.000Z'],
  ['e2', null, '2026-11-24T15:00:00.000Z'], // midnight in Tokyo
  ['e1', '2026-11-30T09:00:00', '2026-11-30T08:00:00.000Z'],
  ['e1', '2026-12-07T09:00:00', '2026-12-07T08:00:00.000Z'],
])
const me = { name: 'Ada', email: 'ada@office.test' }
const mails = (m) => m.mails.map((x) => ({ ...x, raw: Buffer.from(x.raw, 'base64').toString() }))
let sent = mails(await ok('calendar.mails', { kind: 'save', ev, prev: null, me, zone: 'Europe/Berlin' }))
assert.equal(sent.length, 1)
assert.deepEqual(sent[0].to, [{ name: 'Grace', email: 'grace@office.test' }])
assert.equal(sent[0].subject, 'Invitation: Planning')
assert.match(sent[0].raw, /^From: "Ada" <ada@office.test>\r\n/)
assert.match(sent[0].raw, /Content-Type: text\/calendar; charset=UTF-8; method=REQUEST/)
assert.match(Buffer.from(sent[0].raw.split('\r\n\r\n')[3].split('\r\n--')[0], 'base64').toString(), /When: Mon, 23 Nov, 09:00 – 10:00 \(Europe\/Berlin\)|When: Mon, Nov 23, 9:00\s?AM – 10:00\s?AM \(Europe\/Berlin\)/)
const moved = await ok('calendar.reanswer', { ev: { ...ev, start: '2026-11-23T10:00:00' }, prev: ev, me })
assert.equal(moved.ev.participants.g.participationStatus, 'needs-action')
assert.equal(moved.ev.participants.g.expectReply, true)
sent = mails(await ok('calendar.mails', { kind: 'save', ev: moved.ev, prev: ev, me, zone: 'Europe/Berlin' }))
assert.equal(sent[0].subject, 'Updated invitation: Planning')
sent = mails(await ok('calendar.mails', { kind: 'delete', ev, prev: null, me, zone: 'Europe/Berlin' }))
assert.equal(sent[0].subject, 'Cancelled: Planning')
const grace2 = { name: 'Grace', email: 'grace@office.test' }
sent = mails(await ok('calendar.mails', { kind: 'rsvp', ev, status: 'accepted', me: grace2, zone: 'Europe/Berlin' }))
assert.deepEqual(sent.map((x) => [x.subject, x.to[0].email]), [['Accepted: Planning', 'ada@office.test']])
assert.match(sent[0].raw, /method=REPLY/)
assert.deepEqual((await ok('calendar.mails', { kind: 'delete', ev, me: { name: 'Nobody', email: 'x@office.test' }, zone: 'UTC' })).mails, [])
await fails('calendar.mails', { kind: 'rsvp', ev, status: 'accepted', me: { name: 'X', email: 'x@office.test' }, zone: 'UTC' }, /not a guest/)
await fails('calendar.occurrences', { events: [], from: 0, to: 1, zone: 'Mars/Base' }, /Unknown time zone/)

// --- what must never bring the engine down --------------------------------------------

engine.stdin.write('this is not json\n')
await fails('no.such.op', {}, /Unknown op "no.such.op"/)
await fails('doc.write', { state: doc, mode: 'replace' }, /html must be a string/)
const garbage ={ base: b64([255, 255, 255, 255, 7, 1, 2, 3, 200, 9]), updates: [b64([1, 1, 250, 250, 250])] }
for (const op of ['doc.read', 'doc.comments', 'sheet.read', 'slides.read']) await request(op, { state: garbage }) // answered either way
await fails('sheet.read', { state: { base: b64([1, 2, 3]), updates: [] } }, /./)
await fails('slides.write', { state: deck, ops: 'nope' }, /ops must be an array/)
assert.equal((await ok('doc.read', { state: doc })).text, restored.text) // still answering
assert.deepEqual(unaddressed, [{ id: null, error: 'A request must be one line of JSON' }])

// Many requests in a row do not grow the engine without bound.
for (let i = 0; i < 50; i++) await ok('doc.write', { state: doc, mode: 'append', html: '<p>more</p>' })
const before = rss()
for (let i = 0; i < 400; i++) {
  await ok('doc.write', { state: doc, mode: 'append', html: '<p>more</p>' })
  await ok('sheet.write', { state: sheet, start: 'E1', values: [[i]] })
  await ok('slides.read', { state: deck })
}
const after = rss()
assert.ok(after - before < 120, `engine memory grew from ${before.toFixed(0)} MB to ${after.toFixed(0)} MB`)

engine.stdin.end()
const med = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
console.log(`cold start to first answer: ${cold.toFixed(0)} ms; memory at start ${started.toFixed(0)} MB, ${before.toFixed(0)} -> ${after.toFixed(0)} MB over 1200 requests`)
for (const [op, list] of Object.entries(timings)) console.log(`  ${op.padEnd(22)} median ${med(list).toFixed(1)} ms over ${list.length}`)
console.log('all good')
