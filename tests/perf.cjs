// Performance check against the product rule: once someone has used Open
// Suite on a device, every screen is usable within 100 ms and nothing shows a
// loading state. Timings are taken inside the page, from the click (or the
// navigation start) to the frame that paints the result.
//
//   OS_BASE=... OS_E2E_USER=... OS_E2E_PASS=... node tests/perf.cjs
//
// Needs at least one document, one spreadsheet and one mail conversation in
// the account (tests/e2e.cjs creates them). Exits non-zero over budget.
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
    })

    await page.goto(BASE + '/')
    await page.waitForSelector('.auth-card')
    const cold = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0]
      return { ttfb: n.responseStart, painted: performance.getEntriesByName('os:painted')[0]?.startTime, kb: performance.getEntriesByType('resource').reduce((s, r) => s + (r.transferSize || 0), n.transferSize) / 1024 }
    })
    console.log(`info  first ever visit, nothing cached: first byte ${cold.ttfb.toFixed(0)} ms, painted ${cold.painted.toFixed(0)} ms, ${cold.kb.toFixed(0)} KB (bounded by network distance)`)

    await login(page, process.env.OS_E2E_USER, process.env.OS_E2E_PASS)
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 20000 })
    await page.waitForTimeout(7000) // background preload of editors and recent documents

    const loads = []
    for (let i = 0; i < 12; i++) {
      await page.goto(BASE + ['/', '/mail', '/docs', '/chat'][i % 4])
      await page.waitForSelector('.rail')
      loads.push(await page.evaluate(() => performance.getEntriesByName('os:painted')[0].startTime))
      await page.waitForTimeout(250)
    }
    report('return visit, full page load to usable screen', loads)

    const click = (selector, ready) => page.evaluate(async ({ selector, ready }) => {
      const t = performance.now()
      document.querySelector(selector).click()
      // eslint-disable-next-line no-new-func
      await window.__until(new Function('return ' + ready))
      await window.__painted()
      return performance.now() - t
    }, { selector, ready })

    await page.goto(BASE + '/')
    await page.waitForSelector('.rail')
    await page.waitForTimeout(5000)
    const hops = []
    for (let i = 0; i < 5; i++) {
      for (const [href, sel] of [['/mail', '.mail-list'], ['/chat', '.chat-side'], ['/meet', '.meet-hero'], ['/docs', '.page-head'], ['/', '.quick']]) {
        hops.push(await click(`a[href="${href}"]`, `document.querySelector('${sel}')`))
      }
    }
    report('switching sections', hops)

    await click('a[href="/docs"]', `document.querySelector('.page-head')`)
    const docHref = await page.getAttribute('a.list-row[href^="/d/"]', 'href')
    const sheetHref = await page.getAttribute('a.list-row[href^="/s/"]', 'href')
    const docs = []
    const sheets = []
    const parts = []
    const docParts = []
    for (let i = 0; i < 13; i++) {
      await click('a[href="/docs"]', `document.querySelector('.page-head')`)
      await page.waitForTimeout(300)
      docs.push(await click(`a[href="${docHref}"]`, `document.querySelector('.paper')?.textContent.trim().length > 0`))
      docParts.push(await page.evaluate(() => window.__docTiming))
      await click('a[href="/docs"]', `document.querySelector('.page-head')`)
      await page.waitForTimeout(300)
      sheets.push(await click(`a[href="${sheetHref}"]`, `!!document.querySelector('.toolbar .select') && document.querySelector('.formula-bar .ref')?.textContent === 'A1'`))
      parts.push(await page.evaluate(() => window.__sheetTiming))
    }
    const part = (k) => med(parts.map((p) => p[k])).toFixed(0)
    const dpart = (k) => med(docParts.map((p) => p[k])).toFixed(0)
    console.log(`info  inside a document open: load state ${dpart('state')} ms, build editor ${dpart('editor')} ms`)
    console.log(`info  inside a spreadsheet open: load model ${part('model')} ms, lay out ${part('layout')} ms, paint ${part('paint')} ms`)
    console.log(`info  first open in this session: document ${docs[0].toFixed(0)} ms, spreadsheet ${sheets[0].toFixed(0)} ms`)
    report('open a document, content on screen', docs.slice(1))
    report('open a spreadsheet, ready to type', sheets.slice(1))

    await click('a[href="/mail"]', `document.querySelector('.mrow')`)
    await page.waitForTimeout(2500)
    const mails = []
    for (let i = 0; i < 6; i++) {
      await page.click('.folder')
      await page.waitForTimeout(700)
      mails.push(await click('.mrow', `document.querySelector('.msg iframe')`))
    }
    report('open a mail conversation', mails)
    if (over) throw new Error(`over the ${BUDGET} ms budget`)
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 6).join('\n'))
    process.exitCode = 1
  } finally {
    await b.close()
  }
})()
