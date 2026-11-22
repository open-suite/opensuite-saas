// Speed check for presentations against the product rule: once a deck has
// been used on a device it opens with its first slide on screen within
// 100 ms, and moving between slides is immediate. Timings are taken inside
// the page, from the click to the frame that paints the result.
//
//   OS_BASE=... OS_E2E_USER=... OS_E2E_PASS=... node tests/perf-slides.cjs
//
// Builds its own twelve-slide deck and removes it again. Exits non-zero over
// budget.
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
  let made = null
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
    await page.waitForSelector('.rail')

    // A deck of realistic size: title, text, lists and shapes on twelve slides.
    await page.click('text=New presentation')
    await page.waitForSelector('.sl-canvas .sl-role-title')
    made = page.url().split('/').pop()
    await page.fill('.doc-title', 'Speed check deck')
    await page.evaluate(() => {
      const deck = window.__deck
      const text = (t) => [{ type: 'paragraph', content: [{ type: 'text', text: t }] }]
      const list = (items) => [{ type: 'bulletList', content: items.map((t) => ({ type: 'listItem', content: text(t) })) }]
      for (let i = 2; i <= 12; i++) {
        deck.addSlide('titleBody', deck.order()[deck.order().length - 1], { layout: 'titleBody', els: [
          { type: 'box', shape: 'none', role: 'title', x: 80, y: 52, w: 1120, h: 104, valign: 'middle', text: text(`Section ${i}: what we learned`) },
          { type: 'box', shape: 'none', role: 'body', x: 80, y: 176, w: 700, h: 480, valign: 'top', text: list(['Revenue grew faster than plan', 'Churn fell for the third quarter', 'Two new regions opened', 'Hiring is on track']) },
          { type: 'box', shape: 'round', x: 840, y: 200, w: 340, h: 180, fill: 'accent', valign: 'middle', text: text(`${i * 7}%`) },
          { type: 'box', shape: 'ellipse', x: 900, y: 420, w: 220, h: 220, fill: 'soft', valign: 'middle', text: text('Goal') },
          { type: 'line', x1: 840, y1: 400, x2: 1180, y2: 400, stroke: 'line', sw: 4, head: 'end' },
        ] })
      }
      deck.goto(deck.order()[0])
    })
    await page.click('.sl-canvas .sl-role-title')
    await page.keyboard.type('Speed check')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => window.__deck.saved() && window.__deck.state.online, null, { timeout: 15000 })

    const click = (selector, ready) => page.evaluate(async ({ selector, ready }) => {
      const t = performance.now()
      document.querySelector(selector).click()
      // eslint-disable-next-line no-new-func
      await window.__until(new Function('return ' + ready))
      await window.__painted()
      return performance.now() - t
    }, { selector, ready })

    await page.goto(BASE + '/docs')
    await page.waitForSelector(`a.list-row[href="/p/${made}"]`)
    await page.waitForTimeout(7000) // background preload of the editors and recent decks

    const opens = []
    const parts = []
    for (let i = 0; i < 13; i++) {
      await click('a[href="/docs"]', `document.querySelector('.page-head')`)
      await page.waitForTimeout(300)
      opens.push(await click(`a.list-row[href="/p/${made}"]`, `document.querySelector('.sl-canvas .sl-slide')?.textContent.includes('Speed check') && document.querySelectorAll('.sl-thumb .sl-slide').length === 12`))
      parts.push(await page.evaluate(() => ({ ...window.__slidesTiming })))
    }
    const part = (k) => med(parts.map((p) => p[k] || 0)).toFixed(0)
    console.log(`info  inside a deck open: load state ${part('state')} ms, text to HTML ${part('text')} ms, slide in the page after ${part('shown')} ms; first open in this session ${opens[0].toFixed(0)} ms`)
    report('open a presentation, first slide and all thumbnails on screen', opens.slice(1))

    const steps = []
    for (let i = 0; i < 22; i++) {
      const n = (i % 11) + 2
      steps.push(await page.evaluate(async (n) => {
        const t = performance.now()
        document.querySelector(`.sl-thumb:nth-of-type(${n})`).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
        await window.__until(() => document.querySelector('.sl-canvas .sl-slide')?.textContent.includes(`Section ${n}:`))
        await window.__painted()
        return performance.now() - t
      }, n))
    }
    report('go to another slide', steps)

    const edits = []
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Escape')
      edits.push(await page.evaluate(async () => {
        const deck = window.__deck
        const id = deck.els().find((e) => e.role === 'title').id
        const t = performance.now()
        deck.startEdit(id, { all: true })
        await window.__until(() => document.querySelector('.sl-edit-host .sl-text'))
        await window.__painted()
        return performance.now() - t
      }))
    }
    await page.keyboard.press('Escape')
    report('start typing in a text box', edits)

    const shows = []
    for (let i = 0; i < 6; i++) {
      shows.push(await click('.sl-present > .btn', `document.querySelector('.sl-show .sl-slide')`))
      await page.keyboard.press('Escape')
      await page.waitForSelector('.sl-show', { state: 'detached' })
    }
    report('start the slide show', shows)
    if (over) throw new Error(`over the ${BUDGET} ms budget`)
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 6).join('\n'))
    process.exitCode = 1
  } finally {
    if (made && page) await page.evaluate((id) => fetch('/api/docs/' + id, { method: 'DELETE' }), made).catch(() => {})
    await b.close()
  }
})()
