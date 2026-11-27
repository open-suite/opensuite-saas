// Performance check for review features, against the same rule as
// tests/perf.cjs: once the app is on a device, every screen is usable within
// 100 ms. It builds a document with comments and suggestions and a
// spreadsheet with charts, then times opening them and their panels, from the
// click to the frame that paints the result. Timings are taken in the page.
//
//   OS_BASE=... OS_E2E_USER=... OS_E2E_PASS=... node tests/perf-depth.cjs
//
// Exits non-zero over budget. Removes what it creates.
const { connect, login, BASE } = require('./browser.cjs')

const BUDGET = 100
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
let over = false
function report(label, samples, budget = BUDGET) {
  const m = med(samples)
  if (m > budget) over = true
  console.log(`${m > budget ? 'OVER' : ' ok '}  ${label}: median ${m.toFixed(0)} ms (min ${Math.min(...samples).toFixed(0)}, max ${Math.max(...samples).toFixed(0)}, n=${samples.length})`)
}
const cell = (col, row) => ({ x: 46 + 90 * col - 45, y: 24 + 25 * row - 12 })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

;(async () => {
  const b = await connect()
  const created = []
  let page
  try {
    page = await b.open()
    await page.addInitScript(() => {
      window.__until = (cond) => new Promise((res) => {
        if (cond()) return res()
        const mo = new MutationObserver(() => { if (cond()) { mo.disconnect(); res() } })
        mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
      })
      window.__painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
    })
    await login(page, process.env.OS_E2E_USER, process.env.OS_E2E_PASS)
    const click = (selector, ready) => page.evaluate(async ({ selector, ready }) => {
      const el = document.querySelector(selector)
      if (!el) throw new Error('nothing matches ' + selector)
      const t = performance.now()
      el.click()
      // eslint-disable-next-line no-new-func
      await window.__until(new Function('return ' + ready))
      await window.__painted()
      return performance.now() - t
    }, { selector, ready })
    const saved = () => page.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')

    // --- a document with something on every page of the rail -----------------
    await page.goto(BASE + '/')
    await page.click('.quick-btn:has-text("New document")')
    await page.waitForSelector('.paper')
    const docHref = new URL(page.url()).pathname
    created.push('/api/docs/' + docHref.split('/').pop())
    await page.fill('.doc-title', 'Perf: review')
    await page.click('.paper')
    for (let i = 1; i <= 30; i++) {
      await page.keyboard.type(`Paragraph ${i} of a longer document, with enough words in it to wrap onto a second line of the page and give the editor something to lay out.`)
      await page.keyboard.press('Enter')
    }
    // Six comments and six suggestions, made with the keyboard.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('ArrowUp')
      await page.keyboard.press('Shift+ArrowLeft')
      await page.keyboard.press('Shift+ArrowLeft')
      await page.keyboard.press('Shift+ArrowLeft')
      await page.keyboard.press(mod + '+Alt+m')
      // Only the box for a new comment has a Cancel button beside it.
      await page.waitForSelector('.review .rv-compose .btn-ghost')
      await page.keyboard.type(`Comment number ${i + 1} on this paragraph.`)
      await page.keyboard.press(mod + '+Enter')
      await page.waitForSelector('.review .rv-compose .btn-ghost', { state: 'detached' })
      await page.waitForTimeout(1100) // see e2e-depth.cjs: selection changes need a moment in a background tab
    }
    await page.selectOption('[aria-label="Mode"]', 'suggest')
    await page.click('.paper p >> nth=3')
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.type(` Suggested addition ${i + 1}.`)
      await page.keyboard.press('Backspace')
    }
    const typing = await page.evaluate(() => performance.now())
    await page.keyboard.type('Sixty characters typed in suggesting mode to time each stroke.')
    const perKey = ((await page.evaluate(() => performance.now())) - typing) / 62
    await page.selectOption('[aria-label="Mode"]', 'edit')
    await saved()
    const counts = await page.evaluate(() => ({ cards: document.querySelectorAll('.rv-card').length, marks: document.querySelectorAll('.paper .cmt').length }))
    console.log(`info  document has ${counts.cards} cards in the rail (${counts.marks} highlighted ranges); typing while suggesting: ${perKey.toFixed(1)} ms a key including the test driver`)

    // --- a spreadsheet with two charts ----------------------------------------
    await page.goto(BASE + '/')
    await page.click('.quick-btn:has-text("New spreadsheet")')
    await page.waitForSelector('.toolbar .select')
    const sheetHref = new URL(page.url()).pathname
    created.push('/api/docs/' + sheetHref.split('/').pop())
    await page.fill('.doc-title', 'Perf: charts')
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const columns = [['Month', ...months], ['Revenue', ...months.map((_, i) => String(4000 + i * 310))], ['Costs', ...months.map((_, i) => String(3000 + i * 190))], ['Margin', ...months.map((_, i) => `=B${i + 2}-C${i + 2}`)]]
    for (const [c, values] of columns.entries()) {
      await page.click('.grid-scroll', { position: cell(c + 1, 1) })
      for (const v of values) { await page.keyboard.type(v); await page.keyboard.press('Enter') }
    }
    await page.click('.grid-scroll', { position: cell(2, 3) })
    await page.click('[aria-label="Insert chart"]')
    await page.waitForSelector('.chart svg.ch rect.ch-bar')
    await page.click('.grid-scroll', { position: cell(2, 3) })
    await page.click('[aria-label="Insert chart"]')
    await page.waitForFunction(() => document.querySelectorAll('.chart').length === 2)
    await page.click('.chart-type[title="Line"]')
    await page.click('[aria-label="Close chart options"]')
    await saved()
    await page.waitForTimeout(1500) // let the device copy be written

    // --- timings ----------------------------------------------------------------
    // The list of documents is the "Files" section where there is one.
    const list = (await page.$('a.rail-link[href="/files"]')) ? '/files' : '/docs'
    const toList = () => click(`a[href="${list}"]`, `document.querySelector('.page-head')`)
    await page.goto(BASE + list)
    await page.waitForSelector('.page-head')
    await page.waitForTimeout(6000) // background preload of editors and recent documents
    const docs = []
    const sheets = []
    for (let i = 0; i < 13; i++) {
      await toList()
      await page.waitForTimeout(300)
      docs.push(await click(`a[href="${docHref}"]`, `document.querySelector('.paper')?.textContent.trim().length > 0 && document.querySelectorAll('.rv-card').length > 0`))
      await toList()
      await page.waitForTimeout(300)
      sheets.push(await click(`a[href="${sheetHref}"]`, `document.querySelectorAll('.chart svg.ch').length === 2 && document.querySelector('.formula-bar .ref')?.textContent === 'A1'`))
    }
    console.log(`info  first open in this session: document ${docs[0].toFixed(0)} ms, spreadsheet ${sheets[0].toFixed(0)} ms`)
    report('open a document with comments and suggestions, rail drawn', docs.slice(1))
    report('open a spreadsheet with two charts, charts drawn', sheets.slice(1))

    const panel = []
    await page.click('.chart >> nth=-1')
    for (let i = 0; i < 8; i++) {
      panel.push(await page.evaluate(async () => {
        const t = performance.now()
        document.querySelector('.chart.on').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
        await window.__until(() => document.querySelector('.chart-panel'))
        await window.__painted()
        return performance.now() - t
      }))
      await page.click('[aria-label="Close chart options"]')
    }
    report('open chart options', panel)
    const types = []
    await page.dblclick('.chart.on')
    for (const t of ['Bar', 'Line', 'Area', 'Pie', 'Scatter', 'Column', 'Line', 'Column']) {
      types.push(await click(`.chart-type[title="${t}"]`, `document.querySelector('.chart-type[title="${t}"]').classList.contains('on')`))
    }
    report('change chart type', types)

    await toList()
    await click(`a[href="${docHref}"]`, `document.querySelector('.paper')?.textContent.trim().length > 0`)
    const rail = []
    for (let i = 0; i < 8; i++) {
      await click('[aria-label="Comments"]', `!document.querySelector('.review')`)
      rail.push(await click('[aria-label="Comments"]', `document.querySelectorAll('.rv-card').length > 0`))
    }
    report('open the comments rail', rail)
    const history = []
    for (let i = 0; i < 7; i++) {
      await page.click('.menubar >> text=File')
      history.push(await page.evaluate(async () => {
        const item = [...document.querySelectorAll('.menu .menu-item')].find((el) => el.textContent.includes('Version history'))
        const t = performance.now()
        item.click()
        await window.__until(() => document.querySelector('.versions .ver-row'))
        await window.__painted()
        return performance.now() - t
      }))
      await page.click('[aria-label="Close version history"]')
    }
    console.log(`info  first open of version history, which loads its code: ${history[0].toFixed(0)} ms`)
    report('open version history', history.slice(1))
    if (over) throw new Error(`over the ${BUDGET} ms budget`)
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 6).join('\n'))
    process.exitCode = 1
  } finally {
    if (page) {
      await page.goto(BASE + '/').catch(() => {})
      await page.evaluate(async (made) => { for (const path of made) await fetch(path, { method: 'DELETE' }) }, created).catch(() => {})
    }
    await b.close()
  }
})()
