// End-to-end check of review features against a live Open Suite: comments,
// suggestions, version history and spreadsheet charts, each with two people
// working at once. Fails on any console error or failed request.
//
//   OS_BASE=... OS_E2E_USER=ada OS_E2E_PASS=... node tests/e2e-depth.cjs [step ...]
//
// Steps: comments suggest history charts (default: all). Run tests/e2e.cjs
// once first: it creates the colleague these checks sign in as. Set OS_SHOTS
// to a directory to keep screenshots of every state, in light and dark and at
// a phone's width.
const fs = require('fs')
const path = require('path')
const { connect, login, collect, BASE } = require('./browser.cjs')

const STATE = path.join(__dirname, '.state.json')
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}
const steps = process.argv.slice(2)
const want = (s) => !steps.length || steps.includes(s)
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS to an administrator account')
if (!state.colleague?.changed) throw new Error('run tests/e2e.cjs first: it creates the colleague')
const SHOTS = process.env.OS_SHOTS
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const cell = (col, row) => ({ x: 46 + 90 * col - 45, y: 24 + 25 * row - 12 }) // centre of a default-size cell
const live = '.doc-scroll > div:first-child .paper' // the live document, not a past version shown beside it

async function shot(page, name, { dark = true, phone = true } = {}) {
  if (!SHOTS) return
  await page.screenshot({ path: path.join(SHOTS, name + '.png') })
  if (dark) {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(150)
    await page.screenshot({ path: path.join(SHOTS, name + '-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
  }
  if (phone) {
    const size = page.viewportSize()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(SHOTS, name + '-phone.png') })
    await page.setViewportSize(size)
    await page.waitForTimeout(150)
  }
}

// selectText selects the first occurrence of some text in the document, the
// way dragging across it would. An empty `text` with `at` puts the caret at
// the very start or end instead.
//
// For a short time after a keystroke the editor puts back its own selection
// if the page's selection changes under it. That window is 50 ms in a tab
// someone is looking at, but these checks run in background tabs, where the
// browser slows timers to one a second. So the selection is set, then looked
// at again, until it has held.
async function selectText(page, text, at) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const want = await page.evaluate(({ text, at, live }) => {
      const walker = document.createTreeWalker(document.querySelector(live), NodeFilter.SHOW_TEXT)
      const nodes = []
      let all = ''
      for (let n; (n = walker.nextNode());) {
        if (n.parentElement.closest('.caret')) continue
        nodes.push([n, all.length])
        all += n.data
      }
      const find = (off) => { for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i][1] <= off) return [nodes[i][0], off - nodes[i][1]] }
      const range = document.createRange()
      let start = at === 'end' ? all.length : 0
      if (at) {
        const [n, o] = find(start)
        range.setStart(n, o)
        range.collapse(true)
      } else {
        start = all.indexOf(text)
        if (start < 0) throw new Error(`"${text}" is not in the document: ${all}`)
        const [a, ao] = find(start)
        const [b, bo] = find(start + text.length - 1)
        range.setStart(a, ao)
        range.setEnd(b, bo + 1)
      }
      document.querySelector(live).focus()
      const sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      return { before: start, selected: at ? '' : text }
    }, { text, at, live })
    await page.waitForTimeout(150)
    const got = await page.evaluate((live) => {
      const sel = getSelection()
      if (!sel.rangeCount) return null
      const plain = (range) => {
        const part = range.cloneContents()
        part.querySelectorAll('.caret').forEach((x) => x.remove())
        return part.textContent
      }
      const cur = sel.getRangeAt(0)
      const lead = document.createRange()
      lead.selectNodeContents(document.querySelector(live))
      lead.setEnd(cur.startContainer, cur.startOffset)
      return { before: plain(lead).length, selected: plain(cur) }
    }, live)
    if (got && got.before === want.before && got.selected === want.selected) return
  }
  throw new Error(`could not select ${at || `"${text}"`}`)
}

// Text as its author wrote it: a colleague's caret carries their name as a
// label inside the document, which is not part of the text.
const helpers = () => {
  window.__all = (sel) => [...document.querySelectorAll(sel)].map((el) => {
    const copy = el.cloneNode(true)
    copy.querySelectorAll('.caret').forEach((x) => x.remove())
    return copy.textContent
  })
  window.__txt = (sel) => (document.querySelector(sel) ? window.__all(sel)[0] : null)
}
const text = (page) => page.evaluate((live) => window.__txt(live), live)
const painted = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)' }

;(async () => {
  const b = await connect()
  const problems = []
  const created = []
  const ok = (msg) => console.log('  ok  ' + msg)
  try {
    const A = await b.open()
    const B = await b.open()
    collect(A, 'admin', problems)
    collect(B, 'colleague', problems)
    await A.addInitScript(helpers)
    await B.addInitScript(helpers)
    await login(A, ADMIN.user, ADMIN.pass)
    await login(B, state.colleague.user, COLLEAGUE_PASS)
    const colleague = await B.evaluate(() => JSON.parse(localStorage.getItem('os:boot')).user)

    const newDoc = async (title, body, shareWithEveryone = true) => {
      await A.goto(BASE + '/')
      await A.click('.quick-btn:has-text("New document")')
      await A.waitForSelector(live)
      created.push('/api/docs/' + A.url().split('/').pop())
      await A.fill('.doc-title', title)
      await A.click(live)
      for (const [i, line] of body.entries()) {
        if (i) await A.keyboard.press('Enter')
        await A.keyboard.type(line)
      }
      if (shareWithEveryone) {
        await A.click('text=Share')
        await A.click('.modal >> text=Everyone at')
        await A.click('.modal >> text=Done')
      }
      await A.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
      await A.waitForTimeout(400)
    }
    const bothRead = async (expected, what) => {
      for (const [name, page] of [['author', A], ['colleague', B]]) {
        await page.waitForFunction(({ live, expected }) => window.__txt(live)?.includes(expected), { live, expected }, { timeout: 8000 }).catch(() => { throw new Error(`${what}: ${name} does not read "${expected}"`) })
      }
    }

    if (want('comments')) {
      await newDoc('Quarterly review', ['The quarterly numbers look strong. We should publish on Friday.', 'The second paragraph says more about next year.'])
      await B.goto(A.url())
      await B.waitForFunction((live) => document.querySelector(live)?.textContent.includes('Friday'), live)

      await selectText(A, 'publish on Friday')
      await A.click('[aria-label="Comment"]')
      await A.waitForSelector('.review .rv-compose textarea')
      await A.keyboard.type('Is Friday confirmed? @Gra')
      await A.waitForSelector('.rv-people [role=option]')
      await shot(A, 'comment-compose', { phone: false })
      await A.keyboard.press('Enter')
      await A.keyboard.type('please check.')
      await A.click('.review .rv-compose .btn-primary')
      await A.waitForSelector('.rv-card .mention')
      ok('comment: posted on selected text, with a colleague mentioned')
      await B.waitForSelector('.rv-card .mention', { timeout: 8000 })
      if ((await B.textContent('.rv-card .mention')) !== '@' + colleague.name) throw new Error('mention does not name the colleague')
      if (!(await B.evaluate(painted, live + ' .cmt'))) throw new Error('colleague sees no highlight')
      if ((await B.textContent('.rv-count .count')) !== '1') throw new Error('count on the comments button is wrong')
      ok('comment: colleague sees the thread, the highlight and the count')

      // The highlight stays on its words while the text around them changes.
      await selectText(A, '', 'start')
      await A.keyboard.type('Draft. ')
      await B.waitForFunction((live) => window.__txt(live)?.startsWith('Draft. '), live, { timeout: 8000 })
      if ((await B.evaluate((sel) => window.__all(sel).join(''), live + ' .cmt')) !== 'publish on Friday') throw new Error('highlight moved off its text')
      if ((await B.textContent('.rv-quote')) !== 'publish on Friday') throw new Error('quote in the thread is wrong')
      ok('comment: highlight follows its text through edits')

      await B.click('.rv-card')
      await B.fill('.rv-card.on .rv-compose textarea', 'Yes, confirmed with the board.')
      await B.click('.rv-card.on .rv-compose .btn-primary')
      await A.waitForSelector('.rv-card >> text=confirmed with the board', { timeout: 8000 })
      ok('comment: reply arrives live')
      await shot(A, 'comment-thread')

      await A.click('.rv-card .rv-entry >> nth=0 >> [aria-label="More"]')
      await A.click('.rv-card .menu >> text=Edit')
      await A.fill('.rv-card .rv-entry >> nth=0 >> textarea', 'Is Friday still the date?')
      await A.click('.rv-card .rv-entry >> nth=0 >> .btn-primary')
      await B.waitForSelector('.rv-card >> text=Is Friday still the date?', { timeout: 8000 })
      await B.waitForSelector('.rv-when >> text=edited')
      ok('comment: an edit reaches the colleague, marked as edited')

      await A.click('.rv-card [aria-label="Resolve"]')
      await B.waitForFunction((sel) => { const el = document.querySelector(sel); return el && getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)' }, live + ' .cmt', { timeout: 8000 })
      await B.waitForSelector('.rv-count .count', { state: 'detached' })
      ok('comment: resolving removes the highlight and the count for everyone')
      await B.click('[aria-label="Comments"]')
      await B.click('.rv-more')
      await shot(B, 'comment-resolved', { phone: false })
      await B.click('.rv-card.done [aria-label="Reopen"]')
      await A.waitForFunction(painted, live + ' .cmt', { timeout: 8000 })
      ok('comment: reopening brings it back')

      // A second thread may overlap the first; each keeps its own anchor.
      await selectText(B, 'should publish on')
      await B.click('[aria-label="Comment"]')
      await B.fill('.review .rv-compose textarea', 'A second thread, overlapping the first.')
      await B.click('.review .rv-compose .btn-primary')
      await A.waitForFunction((sel) => new Set([...document.querySelectorAll(sel)].map((el) => el.dataset.c)).size === 2, live + ' .cmt', { timeout: 8000 })
      await B.reload()
      await B.waitForFunction((sel) => new Set([...document.querySelectorAll(sel)].map((el) => el.dataset.c)).size === 2 && document.querySelectorAll('.rv-card').length === 2, live + ' .cmt', { timeout: 8000 })
      ok('comment: overlapping threads keep separate anchors, also after a reload')
      await B.click('.rv-card:has-text("A second thread") .rv-entry >> nth=0 >> [aria-label="More"]')
      await B.click('.rv-card .menu >> text=Delete')
      await A.waitForFunction(() => document.querySelectorAll('.rv-card').length === 1, null, { timeout: 8000 })

      await A.waitForSelector('.rv-card') // the rail opens again by itself
      await A.click('.rv-card .rv-entry >> nth=0 >> [aria-label="More"]')
      await A.click('.rv-card .menu >> text=Delete')
      await B.waitForSelector(live + ' .cmt', { state: 'detached', timeout: 8000 })
      await B.waitForSelector('.rv-card', { state: 'detached' })
      ok('comment: deleting a thread removes it and its anchor')
    }

    if (want('suggest')) {
      await newDoc('Launch notes', ['The quarterly numbers look strong. We should publish on Friday.'])
      await B.goto(A.url())
      await B.waitForFunction((live) => document.querySelector(live)?.textContent.includes('Friday'), live)
      await B.selectOption('[aria-label="Mode"]', 'suggest')
      await selectText(B, 'strong')
      await B.keyboard.type('excellent')
      await A.waitForSelector(live + ' ins.sug-ins', { timeout: 8000 })
      await A.waitForFunction((live) => window.__txt(live + ' ins.sug-ins') === 'excellent', live, { timeout: 8000 })
      const seen = await A.evaluate((live) => ({ del: window.__txt(live + ' del.sug-del'), ins: window.__txt(live + ' ins.sug-ins'), by: document.querySelector(live + ' ins.sug-ins').dataset.name }), live)
      if (seen.del !== 'strong' || seen.ins !== 'excellent' || seen.by !== colleague.name) throw new Error('suggestion arrived as ' + JSON.stringify(seen))
      await A.waitForSelector('.rv-sug .rv-what:has-text("Replace strong with excellent")')
      ok('suggest: a replacement shows as struck and added text, in one card')

      // Two people at once: one editing directly at the start, one suggesting
      // at the end. Neither disturbs the other.
      await selectText(A, '', 'start')
      await selectText(B, '', 'end')
      await Promise.all([A.keyboard.type('Agreed. ', { delay: 25 }), B.keyboard.type(' Or on Monday.', { delay: 25 })])
      await bothRead('Agreed. The quarterly', 'concurrent editing')
      await bothRead('Friday. Or on Monday.', 'concurrent editing')
      await A.waitForTimeout(600)
      const [ta, tb] = [await text(A), await text(B)]
      if (ta !== tb) throw new Error(`the two copies differ:\n${ta}\n${tb}`)
      const added = await A.evaluate((live) => window.__all(live + ' ins.sug-ins').join('|'), live)
      if (added !== 'excellent| Or on Monday.') throw new Error('suggested text after concurrent editing: ' + added)
      ok('suggest: survives someone else editing at the same time')

      await selectText(B, 'quarterly')
      await B.keyboard.press(mod + '+b')
      await A.waitForSelector('.rv-sug >> text=Add bold', { timeout: 8000 })
      ok('suggest: a formatting change is recorded')
      await B.keyboard.press('ArrowRight')
      await shot(A, 'suggestions')
      await shot(B, 'suggestions-author', { dark: false, phone: false })

      await A.click('.rv-sug:has-text("Replace") [aria-label="Accept"]')
      await bothRead('numbers look excellent.', 'accepting a replacement')
      if (await A.$(live + ' del.sug-del')) throw new Error('struck text is still there after accepting')
      await A.click('.rv-sug:has-text("Add bold") [aria-label="Reject"]')
      await B.waitForSelector(live + ' strong', { state: 'detached', timeout: 8000 })
      await A.click('.rv-sug:has-text("Or on Monday") [aria-label="Reject"]')
      await B.waitForFunction((live) => !window.__txt(live).includes('Monday'), live, { timeout: 8000 })
      ok('suggest: accept and reject apply for everyone')

      // Backspace in Suggesting strikes text instead of removing it.
      await selectText(B, '', 'end')
      for (let i = 0; i < 7; i++) await B.keyboard.press('Backspace')
      await A.waitForFunction((live) => window.__all(live + ' del.sug-del').join('') === 'Friday.', live, { timeout: 8000 })
      ok('suggest: deleting with the keyboard strikes the text')
      await A.selectOption('[aria-label="Mode"]', 'view')
      await A.waitForSelector('.doc-scroll.clean')
      const viewing = await A.$eval(live, (el) => ({ struck: getComputedStyle(el.querySelector('del.sug-del')).display, editable: el.getAttribute('contenteditable') }))
      if (viewing.struck !== 'none' || viewing.editable !== 'false') throw new Error('viewing mode: ' + JSON.stringify(viewing))
      await shot(A, 'viewing-mode', { phone: false })
      await A.selectOption('[aria-label="Mode"]', 'edit')
      ok('suggest: Viewing reads as if accepted and cannot be typed in')
      await A.click('[aria-label="All suggestions"]')
      await A.click('.menu >> text=Reject all suggestions')
      await B.waitForSelector(live + ' del.sug-del', { state: 'detached', timeout: 8000 })
      await bothRead('We should publish on Friday.', 'rejecting everything')
      if (await B.$(live + ' ins.sug-ins')) throw new Error('suggestions remain after rejecting all')
      ok('suggest: reject all restores the text')

      // Someone who may only comment can suggest and comment, never edit.
      await newDoc('For comment only', ['Please review this paragraph.'], false)
      const id = A.url().split('/').pop()
      await A.evaluate(async ({ id, user }) => { await fetch('/api/docs/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shares: [{ user, role: 'comment' }] }) }) }, { id, user: colleague.id })
      await B.goto(BASE + '/')
      await B.waitForSelector('.rail')
      await B.evaluate(() => fetch('/api/boot').then((r) => r.json()).then((boot) => localStorage.setItem('os:boot', JSON.stringify(boot))))
      await B.goto(A.url())
      await B.waitForFunction((live) => document.querySelector(live)?.textContent.includes('Please review'), live)
      const can = await B.evaluate(() => ({ modes: [...document.querySelector('[aria-label="Mode"]').options].map((o) => o.value), mode: document.querySelector('[aria-label="Mode"]').value, title: document.querySelector('.doc-title').disabled }))
      if (can.modes.includes('edit') || can.mode !== 'suggest' || !can.title) throw new Error('commenter controls: ' + JSON.stringify(can))
      await selectText(B, '', 'end')
      await B.keyboard.type(' Looks fine.')
      await A.waitForFunction((live) => window.__txt(live + ' ins.sug-ins') === ' Looks fine.', live, { timeout: 8000 })
      await selectText(B, 'this paragraph')
      await B.click('[aria-label="Comment"]')
      await B.fill('.review .rv-compose textarea', 'Which paragraph?')
      await B.click('.review .rv-compose .btn-primary')
      await A.waitForSelector('.rv-card >> text=Which paragraph?', { timeout: 8000 })
      if (await B.$('.rv-sug [aria-label="Accept"]')) throw new Error('a commenter can accept suggestions')
      ok('comment role: can suggest and comment, cannot edit or accept')
    }

    if (want('history')) {
      await newDoc('Board paper', ['Version one of the paper.'])
      await B.goto(A.url())
      await B.waitForFunction((live) => document.querySelector(live)?.textContent.includes('Version one'), live)
      await A.click('.doc-bar [aria-label="More"]')
      await A.click('.menu >> text=Version history')
      await A.waitForSelector('.versions')
      await A.click('.versions >> text=Name this version')
      await A.fill('.modal input', 'Sent to the board')
      await A.click('.modal >> text=Save')
      await A.waitForSelector('.ver-row >> text=Sent to the board')
      ok('history: a named version is saved')
      await selectText(A, '', 'end')
      await A.keyboard.type(' And a second sentence that will be undone.')
      await bothRead('second sentence', 'typing after the version')
      await A.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
      await A.click('.ver-row >> text=Sent to the board')
      await A.waitForSelector('.version-bar')
      const past = await A.$eval('.doc-scroll > div:nth-child(2) .paper', (el) => el.textContent)
      if (past !== 'Version one of the paper.') throw new Error('preview shows: ' + past)
      ok('history: a past version can be read without changing the document')
      await shot(A, 'history-document')
      await A.click('.version-bar >> text=Restore this version')
      await A.waitForSelector('.version-bar', { state: 'detached' })
      for (const page of [A, B]) await page.waitForFunction((live) => window.__txt(live) === 'Version one of the paper.', live, { timeout: 8000 })
      ok('history: restoring reaches everyone')
      const kept = await A.evaluate((id) => fetch(`/api/docs/${id}/versions`).then((r) => r.json()), A.url().split('/').pop())
      if (kept.length < 2) throw new Error('the state before the restore was not kept')
      await A.click(live)
      await A.keyboard.press(mod + '+z')
      await bothRead('second sentence', 'undoing the restore')
      ok('history: a restore is an edit, and Undo reverses it')
      await A.click('[aria-label="Close version history"]')

      await A.goto(BASE + '/')
      await A.click('.quick-btn:has-text("New spreadsheet")')
      await A.waitForSelector('.toolbar .select')
      created.push('/api/docs/' + A.url().split('/').pop())
      await A.fill('.doc-title', 'Forecast')
      await A.click('.grid-scroll', { position: cell(1, 1) })
      for (const v of ['100', '200', '=A1+A2']) { await A.keyboard.type(v); await A.keyboard.press('Enter') }
      await A.click('text=Share')
      await A.click('.modal >> text=Everyone at')
      await A.click('.modal >> text=Done')
      await A.waitForTimeout(600)
      await B.goto(A.url())
      await B.waitForSelector('.toolbar .select')
      await A.click('.doc-bar [aria-label="More"]')
      await A.click('.menu >> text=Version history')
      await A.click('.versions >> text=Name this version')
      await A.fill('.modal input', 'Baseline')
      await A.click('.modal >> text=Save')
      await A.waitForSelector('.ver-row >> text=Baseline')
      await A.click('.grid-scroll', { position: cell(1, 1) })
      await A.keyboard.type('999')
      await A.keyboard.press('Enter')
      await A.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
      await A.click('.ver-row >> text=Baseline')
      await A.waitForSelector('.past-grid canvas')
      await A.waitForTimeout(300)
      await shot(A, 'history-spreadsheet')
      await A.click('.version-bar >> text=Restore this version')
      await A.waitForSelector('.past-grid', { state: 'detached' })
      for (const page of [A, B]) {
        await page.click('.sheet-main > .grid-wrap .grid-scroll', { position: cell(1, 1) })
        await page.waitForFunction(() => document.querySelector('.formula-bar input')?.value === '100', null, { timeout: 8000 })
      }
      ok('history: a spreadsheet is restored for everyone connected')
      await A.click('[aria-label="Close version history"]')
    }

    if (want('charts')) {
      await A.goto(BASE + '/')
      await A.click('.quick-btn:has-text("New spreadsheet")')
      await A.waitForSelector('.toolbar .select')
      created.push('/api/docs/' + A.url().split('/').pop())
      await A.fill('.doc-title', 'Revenue by month')
      const rows = [['Month', 'Revenue', 'Costs'], ['Jan', '4200', '3100'], ['Feb', '5100', '3300'], ['Mar', '4800', '3900'], ['Apr', '6400', '4100'], ['May', '7200', '4300']]
      for (let c = 0; c < 3; c++) {
        await A.click('.grid-scroll', { position: cell(c + 1, 1) })
        for (const r of rows) { await A.keyboard.type(r[c]); await A.keyboard.press('Enter') }
      }
      await A.click('text=Share')
      await A.click('.modal >> text=Everyone at')
      await A.click('.modal >> text=Done')
      await A.waitForTimeout(600)
      await B.goto(A.url())
      await B.waitForSelector('.toolbar .select')

      // One cell inside the data is enough: the chart finds the block.
      await A.click('.grid-scroll', { position: cell(2, 3) })
      await A.click('[aria-label="Insert chart"]')
      await A.waitForSelector('.chart svg.ch rect.ch-bar')
      const drawn = await A.$eval('.chart svg.ch', (el) => ({ bars: el.querySelectorAll('rect.ch-bar').length, legend: [...el.querySelectorAll('.ch-legend')].map((t) => t.textContent), range: document.querySelector('[aria-label="Data range"]').value }))
      if (drawn.bars !== 10 || drawn.legend.join() !== 'Revenue,Costs' || drawn.range !== 'A1:C6') throw new Error('first chart: ' + JSON.stringify(drawn))
      ok('charts: a column chart is drawn from the block around the selected cell, headers and labels found')
      await B.waitForSelector('.chart svg.ch rect.ch-bar', { timeout: 8000 })
      ok('charts: the colleague sees it')

      await A.fill('[aria-label="Chart title"]', 'Revenue and costs')
      await A.keyboard.press('Enter')
      await B.waitForSelector('.chart .ch-title >> text=Revenue and costs', { timeout: 8000 })
      await shot(A, 'chart-column')
      const marks = { Bar: 'rect.ch-bar', Line: 'path.ch-line', Area: 'path.ch-line', Pie: 'path.ch-slice', Scatter: 'circle.ch-dot' }
      for (const [type, mark] of Object.entries(marks)) {
        await A.click(`.chart-type[title="${type}"]`)
        await B.waitForSelector(`.chart svg.ch ${mark}`, { timeout: 8000 })
        await shot(A, 'chart-' + type.toLowerCase(), { phone: false })
      }
      ok('charts: bar, line, area, pie and scatter all draw, for both people')
      await A.click('.chart-type[title="Column"]')
      await A.check('text=Stack the series')
      await A.check('text=Show values')
      await A.fill('[aria-label="Vertical axis title"]', 'Euro')
      await A.keyboard.press('Enter')
      await A.selectOption('[aria-label="Legend"]', 'right')
      await B.waitForSelector('.chart .ch-axis-title >> text=Euro', { timeout: 8000 })
      await shot(A, 'chart-options', { phone: false })
      await A.uncheck('text=Stack the series')
      await A.uncheck('text=Show values')
      ok('charts: title, axis, legend, stacking and value options sync')

      const before = await B.$eval('.chart svg.ch', (el) => el.innerHTML)
      await A.click('.sheet-main > .grid-wrap .grid-scroll', { position: cell(2, 2) })
      await A.keyboard.type('9000')
      await A.keyboard.press('Enter')
      await B.waitForFunction((was) => document.querySelector('.chart svg.ch').innerHTML !== was, before, { timeout: 8000 })
      ok('charts: redraws live when a cell changes')

      // Inserting a row above the data moves the chart's range with it.
      await A.click('.sheet-main > .grid-wrap .grid-scroll', { position: cell(1, 1) })
      await A.click('[aria-label="Rows"]')
      await A.click('.menu >> text=Insert row above')
      await A.click('.chart')
      await A.dblclick('.chart')
      await A.waitForFunction(() => document.querySelector('[aria-label="Data range"]')?.value === 'A2:C7', null, { timeout: 5000 })
      ok('charts: the data range follows inserted rows')

      const at = await A.$eval('.chart', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
      await A.mouse.move(at.x + 60, at.y + 14)
      await A.mouse.down()
      await A.mouse.move(at.x + 140, at.y + 74, { steps: 6 })
      await A.mouse.up()
      await B.waitForFunction((was) => document.querySelector('.chart').style.left !== was, await B.$eval('.chart', (el) => el.style.left), { timeout: 8000 }).catch(() => {})
      const moved = await A.$eval('.chart', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y } })
      if (Math.abs(moved.x - at.x - 80) > 2 || Math.abs(moved.y - at.y - 60) > 2) throw new Error(`chart moved to ${JSON.stringify(moved)} from ${JSON.stringify(at)}`)
      const grip = await A.$eval('.grip-se', (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
      await A.mouse.move(grip.x, grip.y)
      await A.mouse.down()
      await A.mouse.move(grip.x + 100, grip.y + 50, { steps: 6 })
      await A.mouse.up()
      await A.waitForFunction((w) => Math.abs(document.querySelector('.chart').getBoundingClientRect().width - w - 100) < 3, at.w)
      const same = async () => (await A.$eval('.chart', (el) => el.style.cssText)) === (await B.$eval('.chart', (el) => el.style.cssText))
      await A.waitForTimeout(500)
      if (!(await same())) throw new Error('the chart is in a different place for the colleague')
      ok('charts: moving and resizing sync')

      await B.reload()
      await B.waitForSelector('.chart svg.ch rect.ch-bar', { timeout: 8000 })
      ok('charts: kept across a reload')
      await shot(B, 'chart-colleague', { dark: true, phone: true })

      await A.click('[aria-label="Close chart options"]')
      await A.click('.chart')
      await A.keyboard.press('Delete')
      await B.waitForSelector('.chart', { state: 'detached', timeout: 8000 })
      await A.keyboard.press(mod + '+z')
      await B.waitForSelector('.chart svg.ch rect.ch-bar', { timeout: 8000 })
      ok('charts: Delete removes a chart and Undo brings it back')
    }

    await A.goto(BASE + '/')
    await A.waitForSelector('.rail')
    await A.evaluate(async (made) => {
      for (const path of made) await fetch(path, { method: 'DELETE' })
    }, created)
    ok(`cleaned up ${created.length} test item(s)`)

    if (problems.length) throw new Error('problems during the run:\n' + problems.join('\n'))
    console.log('all good')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 12).join('\n'))
    if (problems.length) console.error(problems.slice(0, 12).join('\n'))
    if (SHOTS) for (const [i, page] of b.pages.entries()) await page.screenshot({ path: path.join(SHOTS, `failed-${i}.png`) }).catch(() => {})
    process.exitCode = 1
  } finally {
    await b.close()
  }
})()
