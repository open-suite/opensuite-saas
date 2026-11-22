// Speed check for search. The rule: results from what the device already
// holds are on screen within 50 ms of a keystroke, and the palette itself
// opens within the suite's 100 ms budget. Timings are taken inside the page,
// from the event to the frame that paints the result.
//
//   OS_BASE=... OS_E2E_USER=... OS_E2E_PASS=... node tests/perf-search.cjs
//
// The account is filled with 200 documents for the run (removed afterwards)
// so the local sources have something realistic to go through. Exits non-zero
// over budget.
const { connect, login, BASE } = require('./browser.cjs')

const KEY_BUDGET = 50
const OPEN_BUDGET = 100
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))]
let over = false
function report(label, samples, budget) {
  const m = med(samples)
  if (m > budget) over = true
  console.log(`${m > budget ? 'OVER' : ' ok '}  ${label}: median ${m.toFixed(0)} ms (p95 ${p95(samples).toFixed(0)}, max ${Math.max(...samples).toFixed(0)}, n=${samples.length}, budget ${budget})`)
}

const WORDS = ['budget', 'zeppelin', 'roadmap', 'minutes', 'hangar', 'invoice', 'planning', 'review', 'quarterly', 'launch', 'offsite', 'hiring', 'pricing', 'security', 'onboarding', 'retrospective']

;(async () => {
  const b = await connect()
  let page
  let seeded = []
  try {
    page = await b.open()
    await page.addInitScript(() => {
      window.__until = (cond) => new Promise((res) => {
        if (cond()) return res()
        const mo = new MutationObserver(() => { if (cond()) { mo.disconnect(); res() } })
        mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
      })
      window.__painted = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
      // One keystroke: the field takes the new text exactly as typing would
      // set it, and the clock stops at the frame showing results for it.
      window.__key = async (scope, text) => {
        const input = document.querySelector(scope + ' .search-input')
        const list = document.querySelector(scope + ' [data-q]')
        const t = performance.now()
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text)
        input.dispatchEvent(new InputEvent('input', { bubbles: true }))
        await window.__until(() => list.dataset.q === text)
        const dom = performance.now() - t
        await window.__painted()
        return { ms: performance.now() - t, dom, rows: list.querySelectorAll('.sr-group .sr-row').length }
      }
    })
    await login(page, process.env.OS_E2E_USER, process.env.OS_E2E_PASS)
    await page.waitForSelector('.rail')

    seeded = await page.evaluate(async (words) => {
      const ids = []
      const make = async (i) => {
        const title = `${words[i % words.length]} ${words[(i * 7 + 3) % words.length]} ${2020 + (i % 7)} perf-${i}`
        const res = await fetch('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: i % 3 ? 'doc' : 'sheet', title }) })
        if (res.ok) ids.push((await res.json()).id)
      }
      for (let i = 0; i < 200; i += 10) await Promise.all(Array.from({ length: 10 }, (_, k) => make(i + k)))
      return ids
    }, WORDS)
    await page.goto(BASE + '/')
    await page.waitForSelector('.rail')
    await page.waitForTimeout(4000) // mail and chat copies load, editors preload
    const held = await page.evaluate(() => JSON.parse(localStorage.getItem('os:boot')).docs.length)
    console.log(`info  ${held} documents on the device`)

    // Opening the palette.
    const opens = []
    for (let i = 0; i < 12; i++) {
      opens.push(await page.evaluate(async () => {
        const t = performance.now()
        document.querySelector('.rail button[aria-label=Search]').click()
        await window.__until(() => document.activeElement?.matches('.search-panel .search-input'))
        await window.__painted()
        return performance.now() - t
      }))
      await page.keyboard.press('Escape')
      await page.waitForSelector('.search-panel', { state: 'detached' })
      await page.waitForTimeout(120)
    }
    report('open the palette, ready to type', opens, OPEN_BUDGET)

    // Typing: every prefix of several searches, as a person would type them.
    const type = async (scope, texts, gap) => {
      const ms = []
      const dom = []
      let rows = 0
      for (const text of texts) {
        for (let n = 1; n <= text.length; n++) {
          const r = await page.evaluate(({ scope, t }) => window.__key(scope, t), { scope, t: text.slice(0, n) })
          ms.push(r.ms)
          dom.push(r.dom)
          rows = Math.max(rows, r.rows)
          if (gap) await page.waitForTimeout(gap)
        }
      }
      console.log(`info  of which matching and rendering: median ${med(dom).toFixed(1)} ms, max ${Math.max(...dom).toFixed(1)} ms; the rest is the wait for the next frame`)
      return { ms, rows }
    }
    const searches = ['budget', 'zeppelin 2023', 'quarterly review', 'grace', 'perf-17', 'invoice']
    await page.click('.rail button[aria-label=Search]')
    await page.waitForSelector('.search-panel .search-input:focus')
    let run = await type('.search-panel', searches, 40)
    if (!run.rows) throw new Error('typing produced no results at all')
    report('palette: keystroke to results from the device', run.ms, KEY_BUDGET)
    // Flat out, with server answers for earlier keystrokes landing meanwhile.
    run = await type('.search-panel', searches, 0)
    report('palette: the same, typed without pausing', run.ms, KEY_BUDGET)

    // How long the server-side part takes to join (information, not a budget).
    const joins = []
    for (const text of ['budget review', 'zeppelin', 'perf-1']) {
      joins.push(await page.evaluate(async (text) => {
        await window.__key('.search-panel', '')
        const list = document.querySelector('.search-panel [data-q]')
        const t = performance.now()
        await window.__key('.search-panel', text)
        await window.__until(() => list.dataset.q === text && !list.dataset.busy)
        return performance.now() - t
      }, text))
    }
    console.log(`info  server results (document text, whole mailbox) merged after ${joins.map((j) => j.toFixed(0)).join(', ')} ms, including the ${110} ms pause before asking`)
    await page.keyboard.press('Escape')

    // The full page.
    await page.goto(BASE + '/search')
    await page.waitForSelector('.search-page .search-input')
    await page.waitForTimeout(1500)
    run = await type('.search-page', searches, 40)
    report('results page: keystroke to results from the device', run.ms, KEY_BUDGET)

    if (over) throw new Error('over budget')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 6).join('\n'))
    process.exitCode = 1
  } finally {
    try {
      await page.goto(BASE + '/')
      await page.evaluate(async (ids) => {
        for (let i = 0; i < ids.length; i += 10) await Promise.all(ids.slice(i, i + 10).map((id) => fetch('/api/docs/' + id, { method: 'DELETE' })))
      }, seeded)
      console.log(`info  removed ${seeded.length} seeded documents`)
    } catch {}
    await b.close()
  }
})()
