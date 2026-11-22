// Unit checks for the search core (web/src/lib/search.js): matching,
// highlighting, and the rule that results arriving late never move the row
// someone is on. Needs no browser:
//
//   node --test tests/search-unit.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { addProvider, providers, parse, score, rank, excerpt, pieces, Session } from '../web/src/lib/search.js'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

test('matching ignores case and accents and needs every word', () => {
  const q = parse('  Crème  BUDGET ')
  assert.deepEqual(q.terms, ['creme', 'budget'])
  assert.ok(score(q, 'Budget for crème brûlée') > 0)
  assert.equal(score(q, 'Budget for cake'), 0)
  assert.ok(score(q, 'Budget', 'notes about creme') > 0, 'second word may be in the other text')
  assert.ok(score(parse('bud'), 'Budget') > score(parse('bud'), 'Team budget'), 'start of title wins')
  assert.ok(score(parse('bud'), 'Team budget') > score(parse('udg'), 'Team budget'), 'start of a word beats the middle')
  assert.ok(score(parse('bud'), 'Team budget') > score(parse('bud'), 'Plan', 'the budget'), 'title beats body')
})

test('rank orders by match, then by recency', () => {
  const items = [{ t: 'Old budget', at: 1 }, { t: 'New budget', at: 9 }, { t: 'Budget', at: 5 }, { t: 'Other', at: 99 }]
  const out = rank(items, parse('budget'), (i) => [i.t], (i) => i.at).map((r) => r.item.t)
  assert.deepEqual(out, ['Budget', 'New budget', 'Old budget'])
})

test('highlighting maps back onto the original text', () => {
  const join = (p) => p.map((x) => (x.hit ? `[${x.text}]` : x.text)).join('')
  assert.equal(join(pieces('Crème brûlée budget', parse('creme bud'))), '[Crème] brûlée [bud]get')
  assert.equal(join(pieces('aXbxc', parse('x'))), 'a[X]b[x]c')
  assert.equal(join(pieces('plain', parse(''))), 'plain')
  assert.equal(join(pieces('a \x02hit\x03 b', null, true)), 'a [hit] b')
})

test('excerpt keeps the match in view', () => {
  const long = 'lorem ipsum '.repeat(30) + 'the zeppelin lands at noon ' + 'dolor sit '.repeat(30)
  const e = excerpt(long, parse('zeppelin'), 80)
  assert.ok(e.includes('zeppelin') && e.startsWith('…') && e.endsWith('…') && e.length < 100, e)
  assert.equal(excerpt('short text', parse('text')), 'short text')
})

// Three sources: a (local only), b (local + slow remote), c (local only).
function setup(remoteHits) {
  providers.length = 0
  let release
  const gate = new Promise((r) => (release = r))
  const hit = (id) => ({ id, title: id, href: '/' + id })
  addProvider({ id: 'a', label: 'A', order: 1, local: (q) => (q.text.includes('a') ? [hit('a1')] : []) })
  addProvider({ id: 'b', label: 'B', order: 2, local: () => [hit('b1')], remote: () => gate.then(() => remoteHits.map((h) => ({ ...hit(h), snippet: 'from server' }))) })
  addProvider({ id: 'c', label: 'C', order: 3, local: () => [hit('c1'), hit('c2')] })
  return release
}
const shown = (s) => s.view.value.groups.map((g) => g.id + ':' + g.hits.map((h) => h.id).join(',')).join(' | ')

test('local results are there at once; remote ones append and fill in', async () => {
  const release = setup(['b1', 'b2'])
  const s = new Session({ perGroup: 3 })
  s.set('a')
  assert.equal(shown(s), 'a:a1 | b:b1 | c:c1,c2', 'synchronously, before any await')
  assert.equal(s.view.value.busy, true)
  release()
  await tick(150)
  assert.equal(shown(s), 'a:a1 | b:b1,b2 | c:c1,c2')
  assert.equal(s.view.value.groups[1].hits[0].snippet, 'from server', 'the row already shown gains the snippet')
  assert.equal(s.view.value.busy, false)
})

test('nothing is inserted above the row someone is on', async () => {
  const release = setup(['b1', 'b2', 'b3'])
  const s = new Session({ perGroup: 3 })
  s.set('a')
  s.anchor('c') // the cursor is on a row of the last group
  release()
  await tick(150)
  assert.equal(shown(s), 'a:a1 | b:b1 | c:c1,c2', 'held back: adding rows to b would push c down')
  s.anchor('b') // moving up to that group releases them, below the cursor
  assert.equal(shown(s), 'a:a1 | b:b1,b2,b3 | c:c1,c2')
})

test('a row on or above the changing group is never held up', async () => {
  const release = setup(['b2'])
  const s = new Session({ perGroup: 3 })
  s.set('a')
  s.anchor('a')
  release()
  await tick(150)
  assert.equal(shown(s), 'a:a1 | b:b1,b2 | c:c1,c2')
})

test('typing again drops what the previous text was waiting for', async () => {
  const release = setup(['b9'])
  const s = new Session({ perGroup: 3 })
  s.set('a')
  await tick(150) // the remote call is now in flight
  s.set('x')
  release()
  await tick(20)
  assert.equal(shown(s), 'a: | b:b1 | c:c1,c2', 'the answer to the old text is discarded')
  assert.equal(s.view.value.text, 'x')
  s.set('')
  assert.equal(shown(s), '')
})

test('a group is capped and reports how many there are', async () => {
  const release = setup(['b2', 'b3', 'b4', 'b5'])
  const s = new Session({ perGroup: 3 })
  s.set('a')
  release()
  await tick(150)
  const b = s.view.value.groups[1]
  assert.equal(b.hits.length, 3)
  assert.equal(b.total, 5)
})
