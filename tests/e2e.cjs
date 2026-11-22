// End-to-end check against a live Open Suite: an administrator adds a
// colleague, then the two of them (and a guest) use every part of the suite
// together. Fails on any console error or failed request.
//
//   OS_BASE=https://office.example OS_E2E_USER=ada OS_E2E_PASS=... node tests/e2e.cjs [step ...]
//
// Steps: people doc sheet mail chat meet (default: all). The colleague
// created on the first run is remembered in tests/.state.json.
const fs = require('fs')
const path = require('path')
const { connect, login, fakeMedia, collect, BASE } = require('./browser.cjs')

const { state, save } = require('./browser.cjs').remember()
const steps = process.argv.slice(2)
const want = (s) => !steps.length || steps.includes(s)
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS to an administrator account')

const cell = (col, row) => ({ x: 46 + 90 * col - 45, y: 24 + 25 * row - 12 }) // centre of a default-size cell

;(async () => {
  const b = await connect()
  const problems = []
  const created = [] // API paths of everything this run makes
  const ok = (msg) => console.log('  ok  ' + msg)
  try {
    const A = await b.open()
    const B = await b.open()
    await A.addInitScript(fakeMedia)
    await B.addInitScript(fakeMedia)
    collect(A, 'admin', problems)
    collect(B, 'colleague', problems)
    await login(A, ADMIN.user, ADMIN.pass)
    ok('administrator signed in')

    if (!state.colleague) {
      await A.click('a[href="/admin"]')
      await A.click('text=Add person')
      await A.fill('.modal input.input', 'Grace Hopper')
      await A.click('.modal >> text=Add person')
      await A.waitForSelector('text=Person added')
      const lines = await A.$$eval('.modal .card div', (els) => els.map((e) => e.textContent))
      state.colleague = { user: lines[0], temp: lines[1] }
      save()
      await A.click('.modal >> text=Done')
      ok('colleague added: ' + state.colleague.user)
    }
    await login(B, state.colleague.user, state.colleague.changed ? COLLEAGUE_PASS : state.colleague.temp)
    if (await B.$('input[autocomplete=new-password]')) {
      await B.fill('input[autocomplete=new-password]', COLLEAGUE_PASS)
      await B.click('button[type=submit]')
      await B.waitForSelector('.rail')
      state.colleague.changed = true
      save()
      ok('colleague replaced the temporary password')
    }
    ok('colleague signed in')

    if (want('doc')) {
      const tag = 'doc ' + Date.now().toString(36)
      await A.click('a[href="/"]')
      await A.click('text=New document')
      await A.waitForSelector('.paper')
      created.push('/api/docs/' + A.url().split('/').pop())
      await A.fill('.doc-title', 'Launch plan')
      await A.click('.paper')
      await A.keyboard.type(`First line, ${tag}.`)
      // The toolbar must follow the caret and the keyboard.
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
      await A.keyboard.press(mod + '+b')
      await A.waitForSelector('[aria-label="Bold"][aria-pressed="true"]', { timeout: 3000 })
      await A.keyboard.press(mod + '+b')
      await A.waitForSelector('[aria-label="Bold"][aria-pressed="false"]', { timeout: 3000 })
      ok('document: toolbar reflects the editor state')
      await A.click('text=Share')
      await A.click('.modal >> text=Everyone at')
      await A.click('.modal >> text=Done')
      await A.waitForTimeout(600)
      await B.goto(A.url())
      await B.waitForFunction((t) => document.querySelector('.paper')?.textContent.includes(t), tag, { timeout: 8000 })
      ok('document: colleague sees the text')
      await B.click('.paper')
      await B.keyboard.type(' Reply typed by the colleague.')
      await A.waitForFunction(() => document.querySelector('.paper')?.textContent.includes('typed by the colleague'), null, { timeout: 8000 })
      ok('document: edits arrive live in the other direction')
      if ((await B.inputValue('.doc-title')) !== 'Launch plan') throw new Error('title did not sync')
      ok('document: title synced')
    }

    if (want('sheet')) {
      await A.goto(BASE + '/files')
      await A.click('.page-head button:has-text("New")')
      await A.click('.menu >> text=New spreadsheet')
      await A.waitForSelector('.toolbar .select')
      created.push('/api/docs/' + A.url().split('/').pop())
      await A.fill('.doc-title', 'Budget')
      await A.click('.grid-scroll', { position: cell(1, 1) })
      for (const v of ['Item', 'Laptops', 'Chairs', 'Total']) { await A.keyboard.type(v); await A.keyboard.press('Enter') }
      await A.click('.grid-scroll', { position: cell(2, 1) })
      for (const v of ['Cost', '4200', '1350', '=SUM(B2:B3)']) { await A.keyboard.type(v); await A.keyboard.press('Enter') }
      await A.click('text=Share')
      await A.click('.modal >> text=Everyone at')
      await A.click('.modal >> text=Done')
      await A.waitForTimeout(700)
      await B.goto(A.url())
      await B.waitForSelector('.toolbar .select')
      await B.click('.grid-scroll', { position: cell(2, 4) })
      await B.waitForFunction(() => document.querySelector('.formula-bar input')?.value === '=SUM(B2:B3)', null, { timeout: 8000 })
      ok('spreadsheet: colleague sees the formula, typed at full speed with nothing dropped')
      await B.click('.grid-scroll', { position: cell(2, 2) })
      await B.keyboard.type('5000')
      await B.keyboard.press('Enter')
      await A.click('.grid-scroll', { position: cell(2, 2) })
      await A.waitForFunction(() => document.querySelector('.formula-bar input')?.value === '5000', null, { timeout: 8000 })
      ok('spreadsheet: cell edits arrive live')
    }

    if (want('mail')) {
      const subject = 'Budget ' + Date.now().toString(36)
      await A.goto(BASE + '/mail')
      await A.click('text=Compose')
      await A.fill('#c-to', state.colleague.user)
      await A.fill('#c-subj', subject)
      await A.click('.compose-body')
      await A.keyboard.type('The numbers are in the Budget sheet.')
      await A.click('.compose >> text=Send')
      await A.waitForSelector('.compose', { state: 'detached', timeout: 10000 })
      await B.goto(BASE + '/mail')
      await B.waitForSelector(`.mrow >> text=${subject}`, { timeout: 15000 })
      ok('mail: delivered')
      await B.click(`.mrow >> text=${subject}`)
      const body = await B.frameLocator('.msg iframe').locator('body').innerText()
      if (!body.includes('numbers are in the Budget sheet')) throw new Error('mail body missing: ' + body)
      ok('mail: body renders in its isolated frame')
      await B.keyboard.press('r')
      await B.waitForSelector('.compose-body')
      await B.keyboard.type('Thanks, looking now.')
      await B.click('.compose >> text=Send')
      await B.waitForSelector('.compose', { state: 'detached', timeout: 10000 })
      await A.waitForSelector(`.mrow >> text=Re: ${subject}`, { timeout: 15000 })
      ok('mail: reply arrives by push, with no reload')
    }

    if (want('chat')) {
      const tag = 'plan ' + Date.now().toString(36)
      await A.goto(BASE + '/chat')
      await A.click('.conv >> text=Grace Hopper')
      await A.waitForSelector('.composer textarea')
      await A.fill('.composer textarea', `Got a minute for the ${tag}?`)
      await A.keyboard.press('Enter')
      await B.goto(BASE + '/chat')
      await B.click(`a.conv:has-text("${tag}")`, { timeout: 15000 })
      await B.waitForSelector(`.text >> text=${tag}`, { timeout: 10000 })
      ok('chat: message delivered')
      await B.fill('.composer textarea', `Yes, ${tag} works.`)
      await B.keyboard.press('Enter')
      await A.waitForSelector(`.text >> text=${tag} works`, { timeout: 10000 })
      ok('chat: reply arrives live')
    }

    if (want('meet')) {
      await A.goto(BASE + '/meet')
      await A.click('text=Start a meeting now')
      await A.waitForSelector('.lobby')
      await A.click('text=Join now')
      await A.waitForSelector('.call-bar', { timeout: 15000 })
      created.push('/api/meet/' + A.url().split('/').pop())
      await B.goto(A.url())
      await B.click('text=Join now')
      await B.waitForSelector('.call-bar', { timeout: 15000 })
      const G = await b.open()
      await G.addInitScript(fakeMedia)
      collect(G, 'guest', problems)
      await G.goto(A.url())
      await G.fill('.lobby input', 'Charles (guest)')
      await G.click('text=Join now')
      await G.waitForSelector('.call-bar', { timeout: 15000 })
      await A.waitForFunction(() => document.querySelectorAll('.tile').length === 3, null, { timeout: 15000 })
      ok('meet: three in the call, one a guest with no account')
      await A.waitForFunction(() => [...document.querySelectorAll('.tile video')].filter((v) => v.videoWidth > 0).length === 3, null, { timeout: 20000 })
      ok('meet: video flows from all three')
    }

    // Leave the account as it was found: remove what this run created.
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
    process.exitCode = 1
  } finally {
    await b.close()
  }
})()
