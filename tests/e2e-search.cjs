// End-to-end check of search against a live Open Suite: two colleagues, a
// document, a spreadsheet, a meeting and an email, then every way in to
// search and every kind of result. Fails on any console error or failed
// request.
//
//   OS_BASE=https://office.example OS_E2E_USER=ada OS_E2E_PASS=... node tests/e2e-search.cjs
//
// On a server with open sign-up (a local dev instance) the administrator
// account is created if it does not exist. The colleague is shared with
// tests/e2e.cjs through tests/.state.json. Set OS_SHOTS to a directory to
// keep a screenshot of every state. Chat needs its engine, so chat results
// are only checked where chat is running.
const fs = require('fs')
const path = require('path')
const { connect, login, BASE } = require('./browser.cjs')

const { state, save } = require('./browser.cjs').remember()
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS to an administrator account')
const SHOTS = process.env.OS_SHOTS
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const cell = (col, row) => ({ x: 46 + 90 * col - 45, y: 24 + 25 * row - 12 })

const json = (method, url, body) => ({ method, url, body })
const call = (page, { method, url, body }) => page.evaluate(async ({ method, url, body }) => {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, data: await res.json().catch(() => null) }
}, { method, url, body })

;(async () => {
  const b = await connect()
  const problems = []
  const created = []
  const ok = (msg) => console.log('  ok  ' + msg)
  let shotNo = 0
  const shot = async (page, name) => {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, String(++shotNo).padStart(2, '0') + '-' + name + '.png') })
  }
  // Everything that should never happen, except chat where it has no engine.
  const watch = (page, name) => {
    const chat = (url) => /\/_matrix\/|\/api\/chat\//.test(url || '')
    page.on('console', (m) => m.type() === 'error' && !chat(m.location().url) && problems.push(`${name} console: ${m.text()} ${m.location().url || ''}`))
    page.on('pageerror', (e) => problems.push(`${name} error: ${e.message}`))
    page.on('response', (r) => r.status() >= 400 && !chat(r.url()) && problems.push(`${name} ${r.status()} ${r.url().slice(0, 140)}`))
  }
  // The palette: open it, type, read what is listed.
  const open = async (page) => {
    await page.keyboard.press(mod + '+k')
    await page.waitForSelector('.search-panel .search-input:focus')
  }
  const ask = (page, text) => page.fill('.search-panel .search-input', text)
  const rows = (page, scope = '.search-panel') => page.$$eval(scope + ' .sr-group', (groups) => groups.flatMap((g) => [...g.querySelectorAll('.sr-row')].map((r) => ({
    group: g.querySelector('h4').firstChild.textContent,
    title: r.querySelector('.sr-title').textContent,
    sub: r.querySelector('.sr-sub')?.textContent || '',
    marks: [...r.querySelectorAll('mark')].map((m) => m.textContent.toLowerCase()),
    on: r.classList.contains('on'),
  }))))
  const has = async (page, group, title, scope) => (await rows(page, scope)).find((r) => r.group === group && r.title.includes(title))
  const settled = (page, scope = '.search-panel') => page.waitForFunction((s) => {
    const l = document.querySelector(s + ' [data-q]')
    return l && !l.dataset.busy
  }, scope, { timeout: 8000 })
  const arrives = async (page, group, title, scope = '.search-panel') => {
    await page.waitForFunction(({ group, title, scope }) => [...document.querySelectorAll(scope + ' .sr-group')].some((g) =>
      g.querySelector('h4').firstChild.textContent === group && [...g.querySelectorAll('.sr-title')].some((t) => t.textContent.includes(title))), { group, title, scope }, { timeout: 8000 })
    return has(page, group, title, scope)
  }

  let A, B
  try {
    A = await b.open()
    B = await b.open()

    // --- accounts ---------------------------------------------------------------
    await A.goto(BASE + '/')
    await A.waitForSelector('.auth-card, .rail')
    const tried = await call(A, json('POST', '/api/login', { email: ADMIN.user, password: ADMIN.pass }))
    if (tried.status !== 200) {
      const made = await call(A, json('POST', '/api/signup', { org: 'Analytical Engines', name: 'Ada Lovelace', username: ADMIN.user, password: ADMIN.pass, code: process.env.OS_SIGNUP_CODE || '' }))
      if (made.status !== 200) throw new Error(`cannot sign in as ${ADMIN.user} (${tried.status}) or create the account (${made.status})`)
      ok('administrator account created')
    }
    await A.goto(BASE + '/')
    await A.waitForSelector('.rail')
    if (!state.colleague) {
      const made = await call(A, json('POST', '/api/admin/users', { name: 'Grace Hopper', username: 'grace.hopper' }))
      if (made.status === 200) state.colleague = { user: made.data.email, temp: made.data.password }
      else state.colleague = { user: 'grace.hopper', changed: true } // already there from an earlier run
      save()
    }
    await login(B, state.colleague.user, state.colleague.changed ? COLLEAGUE_PASS : state.colleague.temp)
    if (await B.$('input[autocomplete=new-password]')) {
      await B.fill('input[autocomplete=new-password]', COLLEAGUE_PASS)
      await B.click('button[type=submit]')
      await B.waitForSelector('.rail')
      state.colleague.changed = true
      save()
    }
    watch(A, 'admin')
    watch(B, 'colleague')
    ok('two colleagues signed in')
    const chatOn = await A.evaluate(() => JSON.parse(localStorage.getItem('os:boot')).chat.ready)

    // --- things to find ---------------------------------------------------------
    const tag = Date.now().toString(36)
    await A.click('text=New document')
    await A.waitForSelector('.paper')
    const docId = A.url().split('/').pop()
    created.push('/api/docs/' + docId)
    await A.fill('.doc-title', `Zeppelin plan ${tag}`)
    await A.click('.paper')
    await A.keyboard.type(`The launch is in spring. The secret word is quokka${tag}, and Crème brûlée is served.`)
    await A.waitForTimeout(700) // the title is saved half a second after the last key
    await A.click('.rail a[href="/files"]') // leaving an editor hands its text to the index
    await A.click('.page-head button:has-text("New")')
    await A.click('.menu >> text=New spreadsheet')
    await A.waitForSelector('.toolbar .select')
    created.push('/api/docs/' + A.url().split('/').pop())
    await A.fill('.doc-title', `Hangar budget ${tag}`)
    await A.click('.grid-scroll', { position: cell(1, 1) })
    for (const v of ['Item', `wombat${tag}`, 'Mooring mast']) { await A.keyboard.type(v); await A.keyboard.press('Enter') }
    await A.click('.grid-scroll', { position: cell(2, 1) })
    for (const v of ['Cost', '4200', '1350']) { await A.keyboard.type(v); await A.keyboard.press('Enter') }
    await A.waitForTimeout(700)
    const meet = await call(A, json('POST', '/api/meet', { title: `Airship standup ${tag}` }))
    created.push('/api/meet/' + meet.data.code)

    const subject = `Invoice ${tag}`
    await A.click('.rail a[href="/mail"]')
    await A.click('text=Compose')
    await A.fill('#c-to', state.colleague.user)
    await A.fill('#c-subj', subject)
    await A.click('.compose-body')
    await A.keyboard.type(`Please pay for the platypus${tag} enclosure by Friday.`)
    await A.click('.compose >> text=Send')
    await A.waitForSelector('.compose', { state: 'detached', timeout: 10000 })
    await B.goto(BASE + '/mail')
    await B.waitForSelector(`.mrow >> text=${subject}`, { timeout: 15000 })
    if (chatOn) {
      await A.goto(BASE + '/chat')
      await A.click('.conv >> text=Grace Hopper')
      await A.fill('.composer textarea', `Did the narwhal${tag} shipment arrive?`)
      await A.keyboard.press('Enter')
      await A.waitForSelector(`.text >> text=narwhal${tag}`)
    }
    await A.goto(BASE + '/')
    await A.waitForSelector('.quick')
    ok('a document, a spreadsheet, a meeting and an email exist')

    // --- the palette ------------------------------------------------------------
    await A.click('.rail button[aria-label=Search]')
    await A.waitForSelector('.search-panel .search-input:focus')
    if (!(await has(A, 'Recently edited', `Hangar budget ${tag}`))) throw new Error('the empty palette should offer recent documents: ' + JSON.stringify(await rows(A)))
    await shot(A, 'palette-empty')
    ok('palette opens from the rail and offers recent documents before anything is typed')

    // Titles, people and meetings are on the device: listed with no waiting.
    await ask(A, 'zeppelin pl')
    let row = await has(A, 'Documents', `Zeppelin plan ${tag}`)
    if (!row || !row.marks.includes('zeppelin') || !row.marks.includes('pl')) throw new Error('document title not matched at once: ' + JSON.stringify(await rows(A)))
    if (!row.on) throw new Error('the first result should be selected')
    await ask(A, 'HANGAR')
    if (!(await has(A, 'Documents', `Hangar budget ${tag}`))) throw new Error('spreadsheet title not matched at once')
    await ask(A, 'grace')
    row = await has(A, 'People', 'Grace Hopper')
    if (!row || !row.sub.includes('grace.hopper@')) throw new Error('colleague not listed: ' + JSON.stringify(await rows(A)))
    await shot(A, 'palette-person')
    if (!chatOn) {
      // Without chat, choosing a person starts an email to them.
      await A.keyboard.press('Enter')
      await A.waitForSelector('.compose #c-to')
      if (!(await A.inputValue('#c-to')).includes('grace.hopper@')) throw new Error('compose did not start with the person chosen')
      await A.click('.compose [aria-label=Discard]')
      await A.click('.rail a[href="/"]')
      await A.waitForSelector('.quick')
      await open(A)
    }
    await ask(A, `standup ${tag}`)
    if (!(await has(A, 'Meetings', `Airship standup ${tag}`))) throw new Error('meeting not listed')
    ok('titles, people and meetings appear with the keystroke')

    // Words inside documents come from the server's index.
    await ask(A, `quokka${tag}`)
    row = await arrives(A, 'Documents', `Zeppelin plan ${tag}`)
    if (!row.marks.includes(`quokka${tag}`)) throw new Error('snippet does not mark the match: ' + JSON.stringify(row))
    await shot(A, 'palette-document-text')
    await ask(A, 'creme brulee')
    await arrives(A, 'Documents', `Zeppelin plan ${tag}`)
    await ask(A, `wombat${tag}`)
    row = await arrives(A, 'Documents', `Hangar budget ${tag}`)
    if (!row.sub.includes('4200')) throw new Error('spreadsheet snippet should carry the row: ' + JSON.stringify(row))
    ok('text inside a document and a spreadsheet is found, accents and all')

    // The sender's copy is in Sent, which this device has not listed: server search.
    await ask(A, `platypus${tag}`)
    row = await arrives(A, 'Mail', subject)
    if (!row.marks.some((m) => m.includes('platypus'))) throw new Error('mail snippet does not mark the match: ' + JSON.stringify(row))
    await shot(A, 'palette-mail')
    ok('mail is found in the whole mailbox, with the match marked')

    if (chatOn) {
      await ask(A, `narwhal${tag}`)
      row = await has(A, 'Chat', 'Grace Hopper')
      if (!row) throw new Error('chat message not found at once: ' + JSON.stringify(await rows(A)))
      ok('chat messages on the device are found')
    }

    await ask(A, `nothing-like-this-${tag}`)
    await A.waitForSelector('.search-panel .search-none')
    await shot(A, 'palette-nothing')
    ok('says so when nothing matches')

    // Results that arrive late must not push the row someone is on. Mail is
    // slowed down, the selection is moved to the meeting below where mail
    // will go, and the mail group has to wait until the selection moves up.
    await A.route('**/api/mail/jmap', async (route) => {
      await new Promise((r) => setTimeout(r, 900))
      await route.continue()
    })
    const top = (title) => A.$eval(`.search-panel .sr-row:has-text("${title}")`, (el) => Math.round(el.getBoundingClientRect().top))
    await ask(A, tag)
    let at
    for (let i = 0; i < 8 && at?.group !== 'Meetings'; i++) { // further down when chat has a match too
      await A.keyboard.press('ArrowDown')
      at = (await rows(A)).find((r) => r.on)
    }
    if (at?.group !== 'Meetings') throw new Error('expected the selection on the meeting: ' + JSON.stringify(await rows(A)))
    const before = await top('Airship standup')
    await settled(A)
    if (await has(A, 'Mail', subject)) throw new Error('mail was inserted above the selected row')
    if ((await top('Airship standup')) !== before) throw new Error('the selected row moved')
    for (let i = 0; i < 8 && at?.group !== 'Documents'; i++) { // up past any chat match, to above where mail goes
      await A.keyboard.press('ArrowUp')
      at = (await rows(A)).find((r) => r.on)
    }
    await arrives(A, 'Mail', subject)
    at = (await rows(A)).find((r) => r.on)
    if (at?.group !== 'Documents') throw new Error('the selection should now be on a document: ' + JSON.stringify(at))
    await A.unroute('**/api/mail/jmap')
    await shot(A, 'palette-late-results')
    ok('late results wait rather than move the selected row')

    // Keyboard: arrows move, Enter opens, the search is remembered.
    await ask(A, tag + ' ')
    await settled(A)
    const listed = await rows(A)
    if (listed.length < 3) throw new Error('expected several results for the tag: ' + JSON.stringify(listed))
    await shot(A, 'palette-several-kinds')
    await A.keyboard.press('ArrowDown')
    if (!(await rows(A))[1].on) throw new Error('ArrowDown did not move the selection')
    await A.keyboard.press('ArrowUp')
    const first = (await rows(A))[0]
    if (!first.on) throw new Error('ArrowUp did not move the selection back')
    await A.keyboard.press('Enter')
    await A.waitForSelector('.search-panel', { state: 'detached' })
    await A.waitForFunction(() => /^\/[ds]\//.test(location.pathname))
    await A.waitForSelector(first.title.includes('Hangar') ? '.toolbar .select' : '.paper')
    ok('arrow keys and Enter open the selected result')

    // In an editor "/" is a character; the shortcut still works.
    if (first.title.includes('Hangar')) {
      await A.goto(BASE + '/d/' + docId)
      await A.waitForSelector('.paper')
    }
    await A.click('.paper')
    await A.keyboard.press('/')
    await A.waitForFunction(() => document.querySelector('.paper').textContent.includes('/'))
    if (await A.$('.search-panel')) throw new Error('"/" opened search while typing in a document')
    await A.keyboard.press('Backspace')
    await open(A)
    row = await has(A, 'Recent searches', tag)
    if (!row) throw new Error('the search was not remembered: ' + JSON.stringify(await rows(A)))
    await A.click(`.search-panel .sr-row:has-text("${tag}") .sr-main`)
    await A.waitForFunction((t) => document.querySelector('.search-panel .search-input').value === t, tag)
    await A.keyboard.press('Escape')
    await A.waitForSelector('.search-panel', { state: 'detached' })
    if (!(await A.evaluate(() => document.activeElement?.classList.contains('paper')))) throw new Error('closing search did not return to the document')
    ok('"/" stays a character in a document; Escape returns to where you were')

    await A.goto(BASE + '/')
    await A.waitForSelector('.quick')
    // A background tab runs effects up to a second late, so the shortcut may
    // not be listening the instant the page has painted.
    for (let i = 0; i < 4 && !(await A.$('.search-panel .search-input:focus')); i++) {
      await A.keyboard.press('/')
      await A.waitForSelector('.search-panel .search-input:focus', { timeout: 2500 }).catch(() => {})
    }
    await A.waitForSelector('.search-panel .search-input:focus')
    await A.keyboard.type('a/b')
    if ((await A.inputValue('.search-panel .search-input')) !== 'a/b') throw new Error('typing in the palette lost a character')
    ok('"/" opens search from anywhere else')

    // --- the full page ----------------------------------------------------------
    await ask(A, tag)
    await settled(A)
    await A.click('.search-panel .sr-all .sr-main')
    await A.waitForSelector('.search-page')
    if (!A.url().includes('/search?q=' + tag)) throw new Error('wrong address: ' + A.url())
    await settled(A, '.search-page')
    for (const [group, title] of [['Documents', `Zeppelin plan ${tag}`], ['Documents', `Hangar budget ${tag}`], ['Mail', subject], ['Meetings', `Airship standup ${tag}`]]) {
      await arrives(A, group, title, '.search-page')
    }
    await shot(A, 'page-all')
    await A.click('.search-page .tab >> text=Documents')
    await A.waitForFunction(() => new URLSearchParams(location.search).get('in') === 'docs')
    await settled(A, '.search-page')
    const only = await rows(A, '.search-page')
    if (!only.length || only.some((r) => r.group !== 'Documents')) throw new Error('the filter let other kinds through: ' + JSON.stringify(only))
    await shot(A, 'page-documents')
    await A.click('.search-page .tab >> text=All')
    await A.fill('.search-page .search-input', 'grace')
    await A.waitForFunction(() => new URLSearchParams(location.search).get('q') === 'grace')
    if (!(await has(A, 'People', 'Grace Hopper', '.search-page'))) throw new Error('page did not follow the typing')
    await A.reload()
    await A.waitForSelector('.search-page')
    if ((await A.inputValue('.search-page .search-input')) !== 'grace') throw new Error('the address did not restore the search')
    await A.fill('.search-page .search-input', `nothing-like-this-${tag}`)
    await A.waitForSelector('.search-page .empty')
    await shot(A, 'page-nothing')
    ok('full results page: every kind, filters, and an address that can be shared or reloaded')

    // --- who may find what ------------------------------------------------------
    await B.goto(BASE + '/')
    await B.waitForSelector('.quick')
    await open(B)
    await ask(B, 'invoice')
    if (!(await has(B, 'Mail', subject))) {
      // The inbox copy on this device may still be loading on a first visit.
      await arrives(B, 'Mail', subject)
    }
    await ask(B, `quokka${tag}`)
    await B.waitForSelector('.search-panel .search-none')
    await ask(B, `Zeppelin plan ${tag}`)
    await B.waitForSelector('.search-panel .search-none')
    ok('a colleague cannot find a private document, by title or by text')
    await call(A, json('PATCH', '/api/docs/' + docId, { access: 'org' }))
    await ask(B, `quokka${tag} `)
    row = await arrives(B, 'Documents', `Zeppelin plan ${tag}`)
    await B.click(`.search-panel .sr-row:has-text("Zeppelin plan ${tag}") .sr-main`)
    await B.waitForFunction((t) => document.querySelector('.paper')?.textContent.includes('quokka' + t), tag, { timeout: 8000 })
    ok('once it is shared, the colleague finds it and opens it from the result')

    // --- other sizes and themes -------------------------------------------------
    if (SHOTS) {
      await A.goto(BASE + '/')
      await A.waitForSelector('.quick')
      await A.emulateMedia({ colorScheme: 'dark' })
      await open(A)
      await ask(A, tag)
      await settled(A)
      await shot(A, 'dark-palette')
      await A.click('.search-panel .sr-all .sr-main')
      await A.waitForSelector('.search-page')
      await settled(A, '.search-page')
      await shot(A, 'dark-page')
      await A.emulateMedia({ colorScheme: 'light' })
      await A.setViewportSize({ width: 390, height: 780 })
      await shot(A, 'phone-page')
      await A.goto(BASE + '/')
      await A.waitForSelector('.quick')
      await shot(A, 'phone-home')
      await A.click('.rail button[aria-label=Search]')
      await A.waitForSelector('.search-panel .search-input:focus')
      await shot(A, 'phone-palette-empty')
      await ask(A, tag)
      await settled(A)
      await shot(A, 'phone-palette')
      await A.keyboard.press('Escape')
      await A.setViewportSize({ width: 1440, height: 900 })
    }

    if (problems.length) throw new Error('problems during the run:\n' + problems.join('\n'))
    console.log('all good')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 14).join('\n'))
    process.exitCode = 1
  } finally {
    // Leave the account as it was found, whether or not the run passed.
    try {
      await A.goto(BASE + '/')
      for (const p of created) await call(A, json('DELETE', p))
      ok(`cleaned up ${created.length} test item(s)`)
    } catch {}
    await b.close()
  }
})()
