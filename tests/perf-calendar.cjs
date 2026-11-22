// Performance check for calendar and contacts against the product rule: once
// someone has used Open Suite on a device, every screen is usable within
// 100 ms and nothing shows a loading state. Timings are taken inside the
// page, from the click (or the navigation start) to the frame that paints.
//
//   OS_BASE=... OS_E2E_USER=... OS_E2E_PASS=... node tests/perf-calendar.cjs
//
// Needs at least one event in the coming weeks and one contact or colleague.
const { connect, login, BASE } = require('./browser.cjs')

const BUDGET = 100
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
let over = false
function report(label, samples, budget = BUDGET) {
  const m = med(samples)
  if (m > budget) over = true
  console.log(`${m > budget ? 'OVER' : ' ok '}  ${label}: median ${m.toFixed(0)} ms (min ${Math.min(...samples).toFixed(0)}, max ${Math.max(...samples).toFixed(0)}, n=${samples.length})`)
}

;(async () => {
  const b = await connect()
  try {
    const page = await b.open()
    await page.addInitScript(() => {
      window.__until = (cond) => new Promise((res) => {
        if (cond()) return res()
        const mo = new MutationObserver(() => { if (cond()) { mo.disconnect(); res() } })
        mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
      })
      window.__painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      // When, counted from the start of the navigation, a screen first had its
      // data painted. Watched from the very start so nothing is added by the
      // test's own round trips.
      window.__marks = {}
      const watch = { cal: '.ag-row', con: '.ct-row' }
      new MutationObserver(() => {
        for (const k in watch) {
          if (k in window.__marks || !document.querySelector(watch[k])) continue
          window.__marks[k] = 0
          requestAnimationFrame(() => setTimeout(() => (window.__marks[k] = performance.now()), 0))
        }
      }).observe(document, { subtree: true, childList: true })
    })
    const mark = async (k) => (await page.waitForFunction((k) => window.__marks[k] > 0 && window.__marks[k], k)).jsonValue()
    await login(page, process.env.OS_E2E_USER, process.env.OS_E2E_PASS)
    await page.goto(BASE + '/calendar')
    await page.waitForSelector('.cal-bar')
    await page.click('.seg:has-text("Agenda")') // every later load starts on a view that lists events
    await page.waitForSelector('.ag-row', { timeout: 15000 })
    await page.waitForTimeout(5000) // background preload of the other screens

    const cal = []
    const con = []
    for (let i = 0; i < 8; i++) {
      await page.goto(BASE + '/calendar')
      cal.push(await mark('cal'))
      await page.goto(BASE + '/contacts')
      con.push(await mark('con'))
      await page.waitForTimeout(200)
    }
    report('return visit, full page load to the calendar with its events', cal)
    report('return visit, full page load to contacts with the list', con)

    const click = (selector, ready) => page.evaluate(async ({ selector, ready }) => {
      const t = performance.now()
      document.querySelector(selector).click()
      // eslint-disable-next-line no-new-func
      await window.__until(new Function('return ' + ready))
      await window.__painted()
      return performance.now() - t
    }, { selector, ready })
    const key = (k, ready) => page.evaluate(async ({ k, ready }) => {
      const t = performance.now()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      // eslint-disable-next-line no-new-func
      await window.__until(new Function('return ' + ready))
      await window.__painted()
      return performance.now() - t
    }, { k, ready })

    await page.goto(BASE + '/')
    await page.waitForSelector('.rail')
    await page.waitForTimeout(4000)
    const hops = []
    for (let i = 0; i < 6; i++) {
      hops.push(await click('a[href="/calendar"]', `document.querySelector('.ag-row')`))
      hops.push(await click('.rail a[href="/contacts"]', `document.querySelector('.ct-row')`))
      hops.push(await click('a[href="/"]', `document.querySelector('.agenda-card')`))
    }
    report('switching between home, calendar and contacts', hops)

    await click('a[href="/calendar"]', `document.querySelector('.ag-row')`)
    const views = []
    for (let i = 0; i < 5; i++) {
      views.push(await key('w', `document.querySelector('.tg-cols')`))
      views.push(await key('m', `document.querySelector('.mo-week')`))
      views.push(await key('d', `document.querySelector('.tg-cols') && document.querySelectorAll('.tg-day').length === 1`))
      views.push(await key('a', `document.querySelector('.ag-row')`))
    }
    report('changing view (week, month, day, agenda)', views)

    const moves = []
    await key('w', `document.querySelector('.tg-cols')`)
    for (let i = 0; i < 12; i++) {
      const before = await page.textContent('.tg-day .num')
      moves.push(await key(i % 2 ? 'ArrowLeft' : 'ArrowRight', `document.querySelector('.tg-day .num').textContent !== ${JSON.stringify(before)}`))
    }
    report('moving a week forward or back', moves)

    await key('a', `document.querySelector('.ag-row')`)
    const cards = []
    const forms = []
    for (let i = 0; i < 8; i++) {
      cards.push(await click('.ag-row', `document.querySelector('.ev-card')`))
      await key('Escape', `!document.querySelector('.ev-card')`)
      forms.push(await key('c', `document.querySelector('.ev-form')`))
      await click('.modal footer .btn', `!document.querySelector('.ev-form')`)
    }
    report('open an event', cards)
    report('open the editor for a new event', forms)

    await click('.rail a[href="/contacts"]', `document.querySelector('.ct-row')`)
    const people = []
    for (let i = 0; i < 8; i++) {
      people.push(await page.evaluate(async () => {
        const row = document.querySelector('.ct-row:not(.on)')
        const name = row.querySelector('.name').textContent
        const t = performance.now()
        row.click()
        await window.__until(() => document.querySelector('.ct-hero h1')?.textContent === name)
        await window.__painted()
        return performance.now() - t
      }))
      await page.waitForTimeout(60)
    }
    report('open a contact', people)
    if (over) throw new Error(`over the ${BUDGET} ms budget`)
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 6).join('\n'))
    process.exitCode = 1
  } finally {
    await b.close()
  }
})()
