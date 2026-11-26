// Builds the stored state of the demo organisation's documents, spreadsheet
// and presentation (server/demo/*.bin), with the app's own schema, comment
// format, slide model and spreadsheet engine, so each opens exactly like one
// made in the app. The server copies them in at every demo reset
// (server/demo.go). Run it again after changing the story here:
//
//   node web/scripts/demo-seed.mjs
//
// Two things in a document depend on the reset: who wrote a comment and
// when. Comments are written with stand-ins of the same size, which the
// server swaps for the real values: a person's id is "@<key>" padded with "@"
// to 12 characters, and a time is 8e15 plus the minutes before the reset
// (Yjs stores a number that large as a fixed-width float).
import { readFileSync, writeFileSync } from 'node:fs'
import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { initSync, Model } from '@ironcalc/wasm-xlsx'
import { formatExtensions } from '../src/apps/doc-format.js'
import { buildDeck } from '../src/apps/slides-doc.js'

const OUT = new URL('../../server/demo/', import.meta.url)
const person = (key) => ('@' + key + '@'.repeat(12)).slice(0, 12)
const minutesAgo = (m) => 8e15 + m
const names = { ada: 'Ada Lovelace', grace: 'Grace Hopper' }

// A document with a fixed author id, so the same story gives the same bytes.
function ydoc(n) {
  const d = new Y.Doc()
  d.clientID = n
  return d
}

function save(name, bytes) {
  writeFileSync(new URL(name, OUT), bytes)
  console.log(name, bytes.length, 'bytes')
}

// --- text documents ----------------------------------------------------------

const t = (text, ...marks) => ({ type: 'text', text, ...(marks.length ? { marks } : {}) })
const bold = { type: 'bold' }
const comment = (id) => ({ type: 'comment', attrs: { id } })
const p = (...inline) => ({ type: 'paragraph', content: inline.map((x) => (typeof x === 'string' ? t(x) : x)) })
const h = (level, text) => ({ type: 'heading', attrs: { level }, content: [t(text)] })
const bullets = (...items) => ({ type: 'bulletList', content: items.map((x) => ({ type: 'listItem', content: [typeof x === 'string' ? p(x) : x] })) })
const tasks = (...items) => ({ type: 'taskList', content: items.map(([checked, text]) => ({ type: 'taskItem', attrs: { checked }, content: [p(text)] })) })
const cell = (type, text) => ({ type, content: [p(text)] })
const table = (head, ...rows) => ({
  type: 'table',
  content: [
    { type: 'tableRow', content: head.map((x) => cell('tableHeader', x)) },
    ...rows.map((r) => ({ type: 'tableRow', content: r.map((x) => cell('tableCell', x)) })),
  ],
})

const schema = getSchema(formatExtensions({ name: '', color: '#000' }))

// threads: [{ id, by, ago, text, mentions, replies: [{ id, by, ago, text }] }]
// in the shape apps/doc-comments.js reads.
function textDoc(n, content, threads = []) {
  const d = ydoc(n)
  schema.nodeFromJSON({ type: 'doc', content }).check()
  prosemirrorJSONToYXmlFragment(schema, { type: 'doc', content }, d.getXmlFragment('default'))
  const map = d.getMap('comments')
  d.transact(() => {
    for (const th of threads) {
      const m = new Y.Map()
      m.set('by', person(th.by))
      m.set('name', names[th.by])
      m.set('at', minutesAgo(th.ago))
      m.set('text', th.text)
      m.set('mentions', (th.mentions || []).map(person))
      const replies = new Y.Array()
      m.set('replies', replies)
      map.set(th.id, m)
      replies.push(th.replies.map((r) => ({ id: r.id, by: person(r.by), name: names[r.by], at: minutesAgo(r.ago), text: r.text, mentions: (r.mentions || []).map(person) })))
    }
  })
  return Y.encodeStateAsUpdate(d)
}

save('brief.bin', textDoc(101, [
  h(1, 'Loom 1.0 launch brief'),
  p(t('Owner: ', bold), 'Ada Lovelace. ', t('Engineering: ', bold), 'Grace Hopper. ', t('Launch: ', bold), 'Thursday next week.'),
  h(2, 'Summary'),
  p('Loom is our production planner for small workshops: upholsterers, joiners, sign makers and anyone else who builds to order. It turns the wall of sticky notes into a live schedule the whole team can see. Version 1.0 leaves the pilot and goes on public sale on launch day.'),
  h(2, 'Goals for the first 90 days'),
  bullets(
    '120 paying workshops. Today we have 14 pilots, and 9 of them have said they will convert.',
    'Less than two hours from sign-up to a first real schedule.',
    'A support load the two of us can carry: fewer than 15 requests a week.',
  ),
  h(2, 'Who it is for'),
  p('Owners of workshops with 3 to 25 people who plan on paper or in a spreadsheet, and lose orders when one job slips. They are busy, wary of software and buy on the recommendation of people they trust.'),
  h(2, 'Message'),
  p(t('In one line: ', bold), 'know what every bench is doing this week, and what happens when a job runs late.'),
  bullets(
    'Plan by dragging jobs onto people and machines.',
    'See the knock-on effect of a delay before the customer does.',
    'Runs on the workshop tablet, with no training.',
  ),
  h(2, 'Pricing'),
  p('One plan at ', t('£29 per workshop per month', comment('price')), ', billed monthly, with a 30-day trial. Pilot customers keep their current price for a year.'),
  h(2, 'Launch plan'),
  table(['When', 'What', 'Who'],
    ['This week', 'Release candidate on staging, press kit ready', 'Grace, Ada'],
    ['Next Monday', 'Pricing review and final decision', 'Ada'],
    ['Next Wednesday', 'Launch rehearsal; flyers delivered', 'Both'],
    ['Next Thursday', 'Public launch, webinar at 16:00', 'Both'],
    ['Next Friday', 'First-week numbers and follow-up calls', 'Ada'],
  ),
  h(2, 'Risks'),
  bullets(
    p('Importing orders from a spreadsheet is the step pilots find hardest. Grace is adding a ', t('guided import', comment('import')), ' before launch.'),
    'The webinar relies on the Guild of Furniture Makers announcing it to members. We hear back from them on Friday.',
    'Flyers need five working days to print, so the artwork must be signed off this week.',
  ),
  p('Questions and changes go in comments on this brief, so the decisions stay in one place.'),
], [
  {
    id: 'price', by: 'grace', ago: 26 * 60,
    text: 'Two of the pilots told me they would pay £39 without blinking. Can we hold the price until we have seen this week’s conversion numbers?',
    replies: [{ id: 'price-r1', by: 'ada', ago: 23 * 60, text: 'Fair point. Let’s settle it at the pricing review on Monday; it’s in the calendar.' }],
  },
  {
    id: 'import', by: 'ada', ago: 5 * 60,
    text: '@Grace Hopper is this on track for the release candidate?', mentions: ['grace'],
    replies: [{ id: 'import-r1', by: 'grace', ago: 3 * 60, text: 'Yes, it’s in rc2 on staging. Try it with the spreadsheet Priya sent us.' }],
  },
]))

save('notes.bin', textDoc(102, [
  h(1, 'Launch stand-up notes'),
  p('Running notes from the Monday, Wednesday and Friday stand-ups. Newest decisions first.'),
  h(2, 'Decisions'),
  bullets(
    'Launch day is Thursday next week, with a webinar at 16:00 for the Guild of Furniture Makers.',
    'Pilot customers keep their current price for twelve months.',
    'Flyers: 2,000 copies from Brightline Print, delivered to the office by next Wednesday.',
    'Release 1.0 is tagged on launch morning at 08:00, not the night before.',
  ),
  h(2, 'Open questions'),
  bullets(
    'Price: £29 or £39 per workshop per month? Decided at the pricing review on Monday.',
    'Do we offer an annual plan at launch, or wait for the first renewals?',
  ),
  h(2, 'Actions'),
  tasks(
    [true, 'Grace: release candidate rc2 on staging'],
    [false, 'Ada: approve the flyer proof from Brightline by Friday noon'],
    [false, 'Ada: reply to Tomás at Workshop Weekly about the interview'],
    [false, 'Grace: test the guided import with two pilot spreadsheets'],
    [false, 'Both: rehearse the webinar demo end to end'],
  ),
  p('Actions without a name next to them do not get done. Add yours before the stand-up.'),
]))

save('checklist.bin', textDoc(103, [
  h(1, 'Loom 1.0 release checklist'),
  p('Everything that must be true before we tag 1.0. Tick it when it is done, not when it is nearly done.'),
  tasks(
    [true, 'Feature freeze for 1.0'],
    [true, 'Release candidate rc2 on staging'],
    [true, 'Backups restored on a clean server and checked'],
    [false, 'Guided spreadsheet import tested by two pilot customers'],
    [false, 'Load test: 200 workshops with 20 planners each'],
    [false, 'Status page and support address live'],
    [false, 'Release notes written and read by Ada'],
    [false, 'Tag 1.0 and deploy on launch morning, 08:00'],
  ),
  p('If anything here slips, the launch moves with it. Grace decides.'),
]))

// --- the spreadsheet ---------------------------------------------------------

initSync({ module: readFileSync(new URL('../node_modules/@ironcalc/wasm-xlsx/wasm_bg.wasm', import.meta.url)) })

function budget() {
  const m = new Model('Launch budget', 'en', 'Europe/London', 'en')
  m.renameSheet(0, 'Budget')
  const rows = [
    ['Item', 'Planned', 'Actual', 'Variance', 'Notes'],
    ['Launch flyers (2,000)', 640, 612, null, 'Brightline Print quote, incl. VAT'],
    ['Trade show stand', 1800, 1950, null, 'Includes delivery to the venue'],
    ['Paid social ads', 1500, 1180, null, 'Running until launch day'],
    ['Product video', 2200, 2350, null, 'Extra half day for the voice-over'],
    ['Press release distribution', 450, 450, null, ''],
    ['Pilot thank-you gifts', 300, 265, null, '14 hampers'],
    ['Contingency', 500, 0, null, 'Not touched yet'],
  ]
  rows.forEach((r, i) => r.forEach((v, j) => {
    const row = i + 1, col = j + 1
    if (i > 0 && j === 3) m.setUserInput(0, row, col, `=C${row}-B${row}`)
    else if (v !== null && v !== '') m.setUserInput(0, row, col, String(v))
  }))
  const total = rows.length + 1
  m.setUserInput(0, total, 1, 'Total')
  for (const c of ['B', 'C', 'D']) m.setUserInput(0, total, 'BCD'.indexOf(c) + 2, `=SUM(${c}2:${c}${total - 1})`)
  m.setUserInput(0, total + 2, 1, 'Spent so far')
  m.setUserInput(0, total + 2, 2, `=C${total}/B${total}`)

  const area = (row, column, height, width) => ({ sheet: 0, row, column, width, height })
  m.updateRangeStyle(area(1, 1, 1, 5), 'font.b', 'true')
  m.updateRangeStyle(area(1, 1, 1, 5), 'fill.color', '#e8f1fe')
  m.updateRangeStyle(area(total, 1, 1, 4), 'font.b', 'true')
  m.updateRangeStyle(area(2, 2, total - 1, 3), 'num_fmt', '"£"#,##0')
  m.updateRangeStyle(area(total + 2, 1, 1, 1), 'font.b', 'true')
  m.updateRangeStyle(area(total + 2, 2, 1, 1), 'num_fmt', '0%')
  m.setColumnsWidth(0, 1, 1, 210)
  m.setColumnsWidth(0, 2, 4, 96)
  m.setColumnsWidth(0, 5, 5, 250)
  m.setFrozenRowsCount(0, 1)

  // A chart lives in a hidden sheet, one row per chart (apps/sheet-charts.js).
  const sheetId = m.getWorksheetsProperties()[0].sheet_id
  m.newSheet()
  m.renameSheet(1, '_charts_seed1')
  m.hideSheet(1)
  m.setUserInput(1, 1, 1, 'opensuite:charts')
  let x = 24
  for (let c = 1; c <= 5; c++) x += m.getColumnWidth(0, c)
  m.setUserInput(1, 2, 2, JSON.stringify({ type: 'column', sheet: sheetId, x, y: 8, w: 520, h: 320, headers: true, labels: true, legend: 'bottom', title: 'Planned and actual spend' }))
  m.setUserInput(1, 2, 3, `=ROWS(Budget!A1:C${total - 1})`)
  m.setUserInput(1, 2, 1, 'seedchrt')
  m.setSelectedSheet(0)
  m.setSelectedCell(1, 1)
  m.evaluate()
  console.log('budget total', m.getFormattedCellValue(0, total, 2), m.getFormattedCellValue(0, total, 3), m.getFormattedCellValue(0, total, 4))
  const out = m.toBytes()
  m.free()
  return out
}
save('budget.bin', budget())

// --- the presentation --------------------------------------------------------

const box = (id, role, x, y, w, h, text, extra = {}) => ({ id, type: 'box', shape: 'none', role, x, y, w, h, rot: 0, text, ...extra })
const lines = (...xs) => xs.map((x) => p(x))
const list = (...xs) => [bullets(...xs)]

function deck() {
  const d = ydoc(104)
  buildDeck(d, {
    theme: 'ember',
    slides: [
      { id: 's1', layout: 'title', notes: 'Two minutes, no more. The story is: pilots work, now we sell.', els: [
        box('s1t', 'title', 96, 240, 1088, 160, lines('Loom 1.0'), { valign: 'bottom' }),
        box('s1s', 'subtitle', 96, 416, 1088, 90, lines('Launch plan · Thursday next week'), { valign: 'top' }),
      ] },
      { id: 's2', layout: 'titleBody', notes: 'Mention Priya by name: Shah & Daughters is the best story we have.', els: [
        box('s2t', 'title', 80, 52, 1120, 104, lines('Why now'), { valign: 'middle' }),
        box('s2b', 'body', 80, 176, 1120, 480, list(
          '14 workshops have planned real orders in Loom for three months',
          '9 of them will move to a paid plan on launch day',
          'Planning in a spreadsheet breaks once a workshop passes five people',
        ), { valign: 'top' }),
      ] },
      { id: 's3', layout: 'picture', els: [
        { id: 's3i', type: 'image', role: 'picture', src: '/api/blobs/demoplannerscreen0001', x: 64, y: 103, w: 720, h: 514, rot: 0 },
        box('s3t', 'title', 832, 176, 384, 180, lines('The planner'), { valign: 'bottom' }),
        box('s3c', 'caption', 832, 372, 384, 220, lines('Drag jobs onto benches and people. A late job pushes everything after it, in red, before the customer calls.'), { valign: 'top' }),
      ] },
      { id: 's4', layout: 'twoCol', els: [
        box('s4t', 'title', 80, 52, 1120, 104, lines('Launch week'), { valign: 'middle' }),
        box('s4a', 'body', 80, 176, 540, 480, list('Monday: pricing decision', 'Wednesday: rehearsal, flyers arrive'), { slot: 1, valign: 'top' }),
        box('s4b', 'body', 660, 176, 540, 480, list('Thursday: launch, webinar at 16:00', 'Friday: first-week numbers'), { slot: 2, valign: 'top' }),
      ] },
      { id: 's5', layout: 'titleBody', notes: 'The price is still open: £29 or £39. Decided on Monday.', els: [
        box('s5t', 'title', 80, 52, 1120, 104, lines('Pricing'), { valign: 'middle' }),
        box('s5b', 'body', 80, 176, 1120, 480, list(
          'One plan, per workshop, billed monthly',
          '30-day trial, no card needed',
          'Pilot customers keep their price for a year',
        ), { valign: 'top' }),
      ] },
      { id: 's6', layout: 'section', els: [
        box('s6t', 'title', 96, 232, 1088, 150, lines('Questions?'), { valign: 'bottom' }),
        box('s6s', 'subtitle', 96, 398, 1088, 80, lines('Ada Lovelace and Grace Hopper'), { valign: 'top' }),
      ] },
    ],
  })
  return Y.encodeStateAsUpdate(d)
}
save('deck.bin', deck())
