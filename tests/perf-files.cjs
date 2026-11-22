// Speed check for Files, against the product rule: once someone has used
// Open Suite on a device, every screen is usable within 100 ms and nothing
// shows a loading state. Timings are taken inside the page, from the click to
// the frame that paints the result.
//
//   OS_BASE=... OS_E2E_USER=... OS_E2E_PASS=... node tests/perf-files.cjs
//
// Makes a folder of 400 small files to work in and removes it afterwards.
const { connect, login, BASE } = require('./browser.cjs')

const BUDGET = 100
const COUNT = 400
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
let over = false
function report(label, samples, budget = BUDGET) {
  const m = med(samples)
  if (m > budget) over = true
  console.log(`${m > budget ? 'OVER' : ' ok '}  ${label}: median ${m.toFixed(0)} ms (min ${Math.min(...samples).toFixed(0)}, max ${Math.max(...samples).toFixed(0)}, n=${samples.length})`)
}

;(async () => {
  const b = await connect()
  let page
  let folderId
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

    folderId = await page.evaluate(async (count) => {
      const post = (path, body, type) => fetch(path, { method: 'POST', headers: { 'Content-Type': type || 'application/json' }, body }).then((r) => r.json())
      const folder = await post('/api/files/folders', JSON.stringify({ name: 'Speed check ' + Date.now().toString(36) }))
      for (let i = 0; i < count; i += 20) {
        await Promise.all(Array.from({ length: Math.min(20, count - i) }, (_, k) => {
          const n = i + k
          return post(`/api/files/upload?parent=${folder.id}&name=${encodeURIComponent(`note-${String(n).padStart(3, '0')}.txt`)}`, `Note number ${n}\n`, 'text/plain')
        }))
      }
      return folder.id
    }, COUNT)

    // A fresh page load, as a returning visitor: the device copy is in place.
    await page.goto(BASE + '/files')
    await page.waitForSelector('.drive-row')
    await page.waitForTimeout(1500)
    const loads = []
    for (let i = 0; i < 8; i++) {
      await page.goto(BASE + '/files')
      await page.waitForFunction(() => performance.getEntriesByName('os:painted').length > 0)
      loads.push(await page.evaluate(() => performance.getEntriesByName('os:painted')[0].startTime))
      await page.waitForFunction(() => document.querySelector('.drive-row'))
      await page.waitForTimeout(200)
    }
    report('return visit straight to Files, page load to usable screen', loads)

    const click = (selector, ready) => page.evaluate(async ({ selector, ready }) => {
      const t = performance.now()
      document.querySelector(selector).click()
      // eslint-disable-next-line no-new-func
      await window.__until(new Function('return ' + ready))
      await window.__painted()
      return performance.now() - t
    }, { selector, ready })

    const hops = []
    const opens = []
    for (let i = 0; i < 11; i++) {
      await click('a[href="/"]', `document.querySelector('.quick')`)
      await page.waitForTimeout(150)
      hops.push(await click('a[href="/files"]', `document.querySelector('.drive-row')`))
      await page.waitForTimeout(150)
      opens.push(await click(`a[href="/files/folder/${folderId}"]`, `document.querySelectorAll('.drive-row').length >= 100`))
      await page.waitForTimeout(150)
    }
    report('switch to Files, list on screen', hops)
    report(`open a folder of ${COUNT} files`, opens)

    const previews = []
    const closes = []
    const firstFile = await page.getAttribute('.drive-row[href^="/files/file/"]', 'href')
    for (let i = 0; i < 11; i++) {
      previews.push(await click(`a[href="${firstFile}"]`, `!!document.querySelector('.preview-bar .name')`))
      await page.waitForSelector('.preview-text')
      await page.waitForTimeout(100)
      closes.push(await click('.preview-bar a[aria-label="Close preview"]', `!document.querySelector('.preview') && document.querySelectorAll('.drive-row').length >= 100`))
      await page.waitForTimeout(100)
    }
    report('open a file preview', previews)
    report('close the preview, back in the folder', closes)

    const grids = []
    for (let i = 0; i < 9; i++) {
      grids.push(await click('[aria-label="Grid"]', `document.querySelectorAll('.ftile').length >= 100`))
      await page.waitForTimeout(100)
      await click('[aria-label="List"]', `document.querySelectorAll('.drive-row').length >= 100`)
      await page.waitForTimeout(100)
    }
    report(`switch a folder of ${COUNT} to the grid`, grids)

    const filters = []
    for (let i = 0; i < 9; i++) {
      filters.push(await page.evaluate(async () => {
        const input = document.querySelector('.drive-filter input')
        const t = performance.now()
        input.value = 'note-12'
        input.dispatchEvent(new InputEvent('input', { bubbles: true }))
        await window.__until(() => document.querySelectorAll('.drive-row').length === 10)
        await window.__painted()
        const took = performance.now() - t
        input.value = ''
        input.dispatchEvent(new InputEvent('input', { bubbles: true }))
        return took
      }))
      await page.waitForTimeout(150)
    }
    report('filter the folder by name', filters)

    const makes = []
    for (let i = 0; i < 7; i++) {
      await page.click('.page-head button:has-text("New")')
      await page.click('.menu >> text=New folder')
      await page.fill('.modal input.input', 'Made ' + i)
      makes.push(await click('.modal footer .btn-primary', `[...document.querySelectorAll('.drive-row .name')].some((n) => n.textContent === 'Made ${i}')`))
      await page.waitForTimeout(200)
    }
    report('create a folder, on screen', makes)

    // The rest of a long folder arrives as it is scrolled towards.
    let drawn = 0
    for (let i = 0; i < 12 && drawn < COUNT; i++) {
      drawn = await page.evaluate(() => {
        document.querySelector('.drive-main').scrollTo(0, 1e7)
        return document.querySelectorAll('.drive-row').length
      })
      await page.waitForTimeout(150)
    }
    if (drawn < COUNT) throw new Error(`scrolling to the end drew only ${drawn} of ${COUNT} rows`)
    console.log(` ok   scrolling to the end of the folder draws all ${COUNT} rows`)

    // The same fixed piece of work, timed now: far above ~5 ms means this
    // machine was busy with something else and the numbers above are inflated.
    const load = await page.evaluate(() => Array.from({ length: 9 }, () => {
      const t = performance.now()
      let x = 0
      for (let i = 0; i < 3e6; i++) x += Math.sqrt(i)
      return performance.now() - t + (x ? 0 : 0)
    }))
    console.log(`info  machine check: a fixed workload took ${med(load).toFixed(0)} ms (about 5 ms on an idle machine)`)
    if (over) throw new Error(`over the ${BUDGET} ms budget`)
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 6).join('\n'))
    process.exitCode = 1
  } finally {
    if (page && folderId) await page.evaluate((id) => fetch('/api/files/' + id, { method: 'DELETE' }), folderId).catch(() => {})
    await b.close()
  }
})()
