// End-to-end check of calendar and contacts against a live Open Suite: two
// colleagues schedule a meeting, answer it, move things around and keep an
// address book. Fails on any console error or failed request.
//
//   OS_BASE=https://office.example OS_E2E_USER=ada OS_E2E_PASS=... node tests/e2e-calendar.cjs
//
// Uses the colleague that tests/e2e.cjs remembers in tests/.state.json (run
// that first on a fresh server). Everything this run creates is removed.
const fs = require('fs')
const path = require('path')
const { connect, login, BASE } = require('./browser.cjs')

const STATE = path.join(__dirname, '.state.json')
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1))
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS to an administrator account')
if (!state.colleague) throw new Error('no colleague yet: run tests/e2e.cjs people first')

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const HOUR = 48 // pixels per hour in the time grid

// Chat and calls have no engine on a development machine; their failures
// there say nothing about the calendar.
const elsewhere = (url = '') => /\/_matrix\/|\/api\/chat\/|\/lk\b/.test(url)
function collect(page, name, problems) {
  page.on('console', (m) => m.type() === 'error' && !elsewhere(m.location().url) && problems.push(`${name} console: ${m.text()} ${m.location().url || ''}`))
  page.on('pageerror', (e) => problems.push(`${name} error: ${e.message}`))
  page.on('response', (r) => r.status() >= 400 && !elsewhere(r.url()) && problems.push(`${name} ${r.status()} ${r.url().slice(0, 140)}`))
}

;(async () => {
  const b = await connect()
  const problems = []
  const tag = Date.now().toString(36)
  const ok = (msg) => console.log('  ok  ' + msg)
  let A, B
  try {
    A = await b.open()
    B = await b.open()
    // Exporting contacts saves a file; in a test, keep it in the page instead.
    await A.addInitScript(() => {
      window.__saved = []
      const make = URL.createObjectURL.bind(URL)
      URL.createObjectURL = (blob) => { window.__saved.push(blob); return make(blob) }
      const click = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () { if (!this.hasAttribute('download')) click.call(this) }
    })
    collect(A, 'organiser', problems)
    collect(B, 'guest', problems)
    await login(A, ADMIN.user, ADMIN.pass)
    await login(B, state.colleague.user, state.colleague.changed ? COLLEAGUE_PASS : state.colleague.temp)
    if (await B.$('input[autocomplete=new-password]')) {
      await B.fill('input[autocomplete=new-password]', COLLEAGUE_PASS)
      await B.click('button[type=submit]')
      await B.waitForSelector('.rail')
      state.colleague.changed = true
      save()
    }
    ok('both signed in')

    const openCalendar = async (page, view) => {
      await page.goto(BASE + '/calendar')
      await page.waitForSelector('.cal-bar')
      await page.click(`.seg:has-text("${view}")`)
    }
    const editor = async (page, { title, date, from, to, guest }) => {
      await page.keyboard.press('c')
      await page.waitForSelector('.ev-form')
      await page.fill('.ev-title', title)
      await page.fill('[aria-label="Start date"]', date)
      if (from) await page.fill('[aria-label="Start time"]', from)
      if (to) await page.fill('[aria-label="End time"]', to)
      if (guest) {
        await page.fill('[aria-label="Add guests"]', guest)
        await page.waitForSelector('.suggest .menu-item')
        await page.keyboard.press('Enter')
        await page.waitForSelector('.gchip')
      }
    }
    const saveEditor = async (page) => {
      await page.click('.modal footer .btn-primary')
      await page.waitForSelector('.ev-form', { state: 'detached' })
    }

    // --- an invitation, start to finish ---------------------------------------
    const now = new Date()
    const today = now.getHours() < 21
    const start = new Date(now)
    if (today) start.setHours(now.getHours() + 2, 0, 0, 0)
    else { start.setDate(now.getDate() + 1); start.setHours(10, 0, 0, 0) }
    const end = new Date(start.getTime() + 3600000)
    const plan = 'Planning ' + tag

    await openCalendar(B, 'Agenda') // the guest is already looking at their calendar
    await openCalendar(A, 'Agenda')
    await editor(A, { title: plan, date: ymd(start), from: hm(start), to: hm(end), guest: 'Grace' })
    await A.click('.ev-form >> text=Add meeting')
    await A.waitForSelector('.ev-row .link')
    if (!/Save and invite/.test(await A.textContent('.modal footer .btn-primary'))) throw new Error('save button does not announce the invitation')
    await saveEditor(A)
    await A.waitForSelector(`.ag-row:has-text("${plan}")`)
    ok('organiser: event with a guest and a meeting is on the calendar at once')

    await B.waitForSelector(`.ag-row.pending:has-text("${plan}")`, { timeout: 25000 })
    ok('guest: the invitation appears on their calendar without a reload')

    await B.goto(BASE + '/mail')
    await B.click(`.mrow:has-text("Invitation: ${plan}")`, { timeout: 20000 })
    await B.waitForSelector('.inv')
    const card = await B.textContent('.inv')
    if (!card.includes(plan) || !/Organised by Ada/.test(card)) throw new Error('invitation card is missing details: ' + card)
    const frame = await B.frameLocator('.msg iframe').locator('body').innerText()
    if (!frame.includes('invited you') || /stalwart/i.test(frame)) throw new Error('invitation mail body is wrong: ' + frame.slice(0, 200))
    await B.click('.inv .rsvp-btn:has-text("Accept")')
    await B.waitForSelector('.inv .rsvp-btn.on:has-text("Accept")')
    ok('guest: invitation mail shows the event and accepts in one click')

    await A.click(`.ag-row:has-text("${plan}")`)
    await A.waitForSelector('.ev-card')
    await A.waitForSelector('.ev-card .guest:has-text("Grace") .st-yes', { timeout: 25000 })
    await A.waitForSelector('.ev-card >> text=Join meeting')
    await A.keyboard.press('Escape')
    ok("organiser: the guest's answer arrives live, and the event has a Join button")

    if (today) {
      await A.goto(BASE + '/')
      await A.waitForSelector(`.agenda-card .list-row:has-text("${plan}") >> text=Join`)
      ok("home: today's agenda lists it with Join")
    }
    await A.goto(BASE + '/mail')
    await A.click(`.mrow:has-text("Accepted: ${plan}")`, { timeout: 20000 })
    await A.waitForSelector('.inv:has-text("Grace Hopper accepted")')
    ok('organiser: the answer also arrives as mail')

    // --- free/busy ----------------------------------------------------------------
    await openCalendar(A, 'Agenda')
    await editor(A, { title: 'Clash ' + tag, date: ymd(start), from: hm(start), to: hm(end), guest: 'Grace' })
    await A.waitForSelector('.avail-note.warn')
    const note = await A.textContent('.avail-note')
    if (!/Grace/.test(note) || !/busy/.test(note)) throw new Error('availability note: ' + note)
    await A.fill('[aria-label="Start date"]', ymd(new Date(start.getTime() + 9 * 86400000)))
    await A.waitForSelector('.avail-note:not(.warn)')
    await A.click('.modal footer >> text=Cancel')
    ok("free/busy: a colleague's busy time shows when choosing a time")

    // --- the organiser changes it -----------------------------------------------------
    await openCalendar(B, 'Agenda')
    await B.waitForSelector(`.ag-row:not(.pending):has-text("${plan}")`)
    await B.click(`.ag-row:has-text("${plan}")`)
    await B.waitForSelector('.ev-card >> text=Join meeting')
    if (/Join: http/.test(await B.textContent('.ev-card'))) throw new Error("the guest's event shows the raw meeting link line")
    await B.keyboard.press('Escape')
    ok("guest: their copy of the event has the meeting's Join button")
    await A.click(`.ag-row:has-text("${plan}")`)
    await A.click('.ev-card [aria-label="Edit"]')
    await A.waitForSelector('.ev-form')
    await A.fill('.ev-title', plan + ' moved')
    await A.fill('[aria-label="Start time"]', hm(new Date(start.getTime() + 1800000)))
    if (!/Save and notify/.test(await A.textContent('.modal footer .btn-primary'))) throw new Error('save button does not announce the notice')
    await saveEditor(A)
    await B.waitForSelector(`.ag-row.pending:has-text("${plan} moved")`, { timeout: 25000 })
    ok('changing the time updates the guest and asks them again')

    // --- several calendars ---------------------------------------------------------------
    const side = 'Side ' + tag
    await A.click('[aria-label="New calendar"]')
    await A.fill('.modal input.input', side)
    await A.click('.modal footer .btn-primary')
    await A.waitForSelector(`.cal-item:has-text("${side}")`)
    await editor(A, { title: 'Errand ' + tag, date: ymd(start), from: '07:00', to: '07:30' })
    await A.selectOption('[aria-label="Calendar"]', { label: side })
    await saveEditor(A)
    await A.waitForSelector(`.ag-row:has-text("Errand ${tag}")`)
    await A.click(`.cal-item:has-text("${side}") input`)
    await A.waitForSelector(`.ag-row:has-text("Errand ${tag}")`, { state: 'detached' })
    await A.click(`.cal-item:has-text("${side}") input`)
    await A.waitForSelector(`.ag-row:has-text("Errand ${tag}")`)
    await A.hover(`.cal-item:has-text("${side}")`)
    await A.click(`.cal-item:has-text("${side}") .icon-btn`)
    await A.click('.menu >> text=Delete calendar')
    await A.waitForSelector(`.cal-item:has-text("${side}")`, { state: 'detached' })
    await A.waitForSelector(`.ag-row:has-text("Errand ${tag}")`, { state: 'detached' })
    ok('calendars: add one, put an event in it, hide and show it, delete it')

    // --- an event in another time zone ----------------------------------------------------
    const tomorrow = new Date(now.getTime() + 86400000)
    const here = await A.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
    const there = here === 'America/New_York' ? 'Asia/Tokyo' : 'America/New_York'
    await editor(A, { title: 'Abroad ' + tag, date: ymd(tomorrow), from: '09:00', to: '10:00' })
    await A.waitForFunction(() => document.querySelectorAll('[aria-label="Time zone"] option').length > 50)
    await A.selectOption('[aria-label="Time zone"]', there)
    await saveEditor(A)
    await A.click(`.ag-row:has-text("Abroad ${tag}")`)
    const abroad = await A.textContent('.ev-card')
    if (!new RegExp('0?9[:.]00.* in ' + there.replace('_', ' ')).test(abroad)) throw new Error('time zone note missing: ' + abroad)
    const shown = await A.textContent(`.ag-row:has-text("Abroad ${tag}") .time`)
    if (/^0?9[:.]00/.test(shown.trim())) throw new Error('event in another zone is shown at its own clock time: ' + shown)
    await A.keyboard.press('Escape')
    ok('time zones: an event keeps its own zone and shows in local time')

    // --- a repeating event ------------------------------------------------------------
    const standup = 'Standup ' + tag
    await editor(A, { title: standup, date: ymd(tomorrow), from: '09:00', to: '09:15' })
    await A.selectOption('[aria-label="Repeat"]', 'daily')
    await A.selectOption('[aria-label="Ends"]', 'after')
    await A.fill('[aria-label="Number of times"]', '4')
    await saveEditor(A)
    const count = (text) => A.locator(`.ag-row:has-text("${text}")`).count()
    await A.waitForFunction((t) => [...document.querySelectorAll('.ag-row')].filter((r) => r.textContent.includes(t)).length === 4, standup)
    await A.locator(`.ag-row:has-text("${standup}")`).nth(1).click()
    await A.click('.ev-card [aria-label="Delete"]')
    await A.click('.modal .btn:text-is("This event")')
    await A.waitForFunction((t) => [...document.querySelectorAll('.ag-row')].filter((r) => r.textContent.includes(t)).length === 3, standup)
    await A.locator(`.ag-row:has-text("${standup}")`).first().click()
    await A.click('.ev-card [aria-label="Edit"]')
    await A.click('.modal .btn:text-is("All events")')
    await A.waitForSelector('.ev-form')
    await A.fill('.ev-title', 'Daily ' + standup)
    await saveEditor(A)
    await A.waitForFunction((t) => [...document.querySelectorAll('.ag-row')].filter((r) => r.textContent.includes(t)).length === 3, 'Daily ' + standup)
    if ((await count('Daily ' + standup)) !== 3) throw new Error('series rename did not reach every occurrence')
    ok('repeating: four occurrences, one removed alone, the rest renamed together')

    // --- drawing, dragging and resizing in the day view -----------------------------------
    // A night more than a year away: nothing else is likely to be in the way.
    await A.click('.seg:has-text("Day")')
    await A.goto(BASE + '/calendar?day=' + ymd(new Date(now.getTime() + 437 * 86400000)))
    await A.waitForSelector('.tg-cols')
    await A.evaluate(() => (document.querySelector('.tg-scroll').scrollTop = 0))
    const box = await A.locator('.tg-cols').boundingBox()
    const x = box.x + box.width / 2
    const y = (h) => box.y + h * HOUR
    await A.mouse.move(x, y(2) + 2)
    await A.mouse.down()
    await A.mouse.move(x, y(2.6), { steps: 4 })
    await A.mouse.move(x, y(3.5), { steps: 4 })
    await A.mouse.up()
    await A.waitForSelector('.ev-quick')
    await A.keyboard.type('Drawn ' + tag)
    await A.keyboard.press('Enter')
    const drawn = A.locator(`.tg-ev:has-text("Drawn ${tag}")`)
    await drawn.waitFor()
    const place = () => drawn.evaluate((el) => [parseFloat(el.style.top), parseFloat(el.style.height)])
    const [top0, h0] = await place()
    if (top0 !== 2 * HOUR || Math.round(h0) !== 1.5 * HOUR - 2) throw new Error(`drawn event sits at ${top0}/${h0}`)
    await A.waitForTimeout(600) // let the save finish so the move applies to the stored event
    await A.mouse.move(x, y(2.5))
    await A.mouse.down()
    await A.mouse.move(x, y(3), { steps: 4 })
    await A.mouse.move(x, y(3.5), { steps: 4 })
    await A.mouse.up()
    await A.waitForFunction((t) => [...document.querySelectorAll('.tg-ev')].some((e) => e.textContent.includes(t) && e.style.top === '144px'), 'Drawn ' + tag)
    await A.mouse.move(x, y(4.5) - 4)
    await A.mouse.down()
    await A.mouse.move(x, y(4.8), { steps: 3 })
    await A.mouse.move(x, y(5), { steps: 3 })
    await A.mouse.up()
    await A.waitForFunction((t) => [...document.querySelectorAll('.tg-ev')].some((e) => e.textContent.includes(t) && Math.round(parseFloat(e.style.height)) === 94), 'Drawn ' + tag)
    await A.keyboard.press('Escape')
    ok('day view: draw an event, drag it an hour later, stretch it by half an hour')

    // --- a reminder ----------------------------------------------------------------------------
    if (now.getHours() < 23 || now.getMinutes() < 50) {
      const soon = new Date(Date.now() + 4 * 60000)
      await A.keyboard.press('t')
      await editor(A, { title: 'Soon ' + tag, date: ymd(soon), from: hm(soon), to: hm(new Date(soon.getTime() + 1800000)) })
      await saveEditor(A)
      await A.waitForSelector(`.reminder:has-text("Soon ${tag}")`, { timeout: 8000 })
      await A.click('.reminder [aria-label="Dismiss"]')
      await A.waitForSelector('.reminder', { state: 'detached' })
      ok('reminder: shows ten minutes before the start and can be dismissed')
    }

    // --- cancelling tells the guest ---------------------------------------------------------------
    await openCalendar(B, 'Agenda')
    await B.waitForSelector(`.ag-row:has-text("${plan}")`)
    await openCalendar(A, 'Agenda')
    await A.click(`.ag-row:has-text("${plan}")`)
    await A.click('.ev-card [aria-label="Delete"]')
    await A.waitForSelector(`.ag-row:has-text("${plan}")`, { state: 'detached' })
    await B.waitForSelector(`.ag-row:has-text("${plan}")`, { state: 'detached', timeout: 25000 })
    ok("cancelling: the event leaves the guest's calendar on its own")

    // --- contacts ---------------------------------------------------------------------------------
    const first = 'Charles' + tag
    const mail = `charles.${tag}@example.org`
    await A.goto(BASE + '/contacts')
    await A.waitForSelector('.ct-top')
    await A.waitForSelector('.ct-row:has-text("Grace Hopper")')
    await A.click('.ct-top .btn-primary')
    await A.waitForSelector('.ct-form')
    const fields = A.locator('.ct-form .two input')
    await fields.nth(0).fill(first)
    await fields.nth(1).fill('Babbage')
    await fields.nth(2).fill('Difference Engines')
    await A.fill('.ct-form input[type=email]', mail)
    await A.fill('.ct-form input[type=tel]', '+44 20 7946 0000')
    await A.click('.ct-bar >> text=Save')
    await A.waitForSelector(`.ct-row.on:has-text("${first} Babbage")`)
    await A.waitForSelector(`.ct-body:has-text("${mail}")`)
    await A.fill('.ct-search input', 'no such person')
    await A.waitForSelector('.ct-none:has-text("No contacts match")')
    await A.fill('.ct-search input', 'difference')
    await A.waitForSelector(`.ct-row:has-text("${first}")`)
    await A.fill('.ct-search input', '')
    ok('contacts: add, see and find a contact; colleagues are listed too')

    await A.waitForTimeout(800) // the new contact gets its lasting id
    await A.click(`.ct-row:has-text("${first}")`)
    await A.click('.ct-bar [aria-label="Edit"]')
    await fields.nth(3).fill('Inventor')
    await A.click('.ct-bar >> text=Save')
    await A.waitForSelector('.ct-hero:has-text("Inventor · Difference Engines")')
    ok('contacts: edit')

    const vcf = ['BEGIN:VCARD', 'VERSION:3.0', `FN:Mary ${tag}`, `N:${tag};Mary;;;`, `EMAIL;TYPE=WORK:mary.${tag}@example.org`, 'TEL;TYPE=CELL:+44 1234', 'END:VCARD',
      'BEGIN:VCARD', 'VERSION:2.1', `N:${tag};Zo=C3=AB;;;`.replace('N:', 'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:'), `EMAIL:zoe.${tag}@example.org`, 'END:VCARD', ''].join('\r\n')
    await A.click('.ct-top [aria-label="More"]')
    const [chooser] = await Promise.all([A.waitForEvent('filechooser'), A.click('.menu >> text=Import from a file')])
    await chooser.setFiles({ name: 'people.vcf', mimeType: 'text/vcard', buffer: Buffer.from(vcf) })
    await A.waitForSelector(`.ct-row:has-text("Mary ${tag}")`)
    await A.waitForSelector(`.ct-row:has-text("Zoë ${tag}")`)
    await A.click('.ct-top [aria-label="More"]')
    await A.click('.menu >> text=Export all')
    const exported = await A.evaluate(() => window.__saved.at(-1).text())
    if (!exported.includes(`FN:${first} Babbage`) || !exported.includes(`EMAIL;TYPE=INTERNET,WORK:mary.${tag}@example.org`)) throw new Error('export is missing contacts:\n' + exported.slice(0, 400))
    ok('contacts: import a file with two cards (one in an old encoding), export them all')

    await A.goto(BASE + '/mail?compose=1')
    await A.waitForSelector('.compose')
    if (!(await A.$(`#c-people option[value*="${mail}"]`)) || !(await A.$('#c-people option[value*="Grace Hopper"]'))) throw new Error('mail compose does not offer contacts and colleagues')
    await A.click('.compose [aria-label="Discard"]')
    await openCalendar(A, 'Agenda')
    await A.keyboard.press('c')
    await A.waitForSelector('.ev-form')
    await A.fill('[aria-label="Add guests"]', first.slice(0, 6))
    await A.waitForSelector(`.suggest:has-text("${mail}")`)
    await A.click('.modal footer >> text=Cancel')
    ok('address completion: mail and event guests draw on contacts and colleagues')

    await A.goto(BASE + '/contacts')
    await A.click(`.ct-row:has-text("${first}")`)
    await A.click('.ct-bar [aria-label="Delete"]')
    await A.waitForSelector(`.ct-row:has-text("${first}")`, { state: 'detached' })
    ok('contacts: delete')

    if (problems.length) throw new Error('problems during the run:\n' + problems.join('\n'))
    console.log('all good')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 12).join('\n'))
    if (problems.length) console.error(problems.slice(0, 12).join('\n'))
    // OS_E2E_SHOTS=<dir> keeps a picture of both screens at the point of failure.
    if (process.env.OS_E2E_SHOTS) {
      await A?.screenshot({ path: path.join(process.env.OS_E2E_SHOTS, 'failed-organiser.png') }).catch(() => {})
      await B?.screenshot({ path: path.join(process.env.OS_E2E_SHOTS, 'failed-guest.png') }).catch(() => {})
    }
    process.exitCode = 1
  } finally {
    // Leave both accounts as they were found: remove everything carrying this run's tag.
    for (const page of [A, B]) {
      if (!page) continue
      await page.evaluate(async (tag) => {
        const call = async (calls) => (await (await fetch('/api/mail/jmap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ methodCalls: calls }) })).json()).methodResponses.map((r) => r[1])
        const [ev, cards, mail] = await call([['CalendarEvent/get', { properties: ['title'] }, '0'], ['ContactCard/get', { properties: ['name', 'emails'] }, '1'], ['Email/query', { filter: { text: tag }, limit: 100 }, '2']])
        const mine = (list) => (list || []).filter((x) => JSON.stringify(x).includes(tag)).map((x) => x.id)
        await call([['CalendarEvent/set', { destroy: mine(ev.list) }, '0'], ['ContactCard/set', { destroy: mine(cards.list) }, '1'], ['Email/set', { destroy: mail.ids || [] }, '2']])
      }, tag).catch(() => {})
    }
    await b.close()
  }
})()
