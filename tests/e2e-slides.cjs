// End-to-end check of presentations against a live Open Suite: two people
// build one deck together, then present it. Fails on any console error or
// failed request.
//
//   OS_BASE=https://office.example OS_E2E_USER=ada OS_E2E_PASS=... node tests/e2e-slides.cjs
//
// Uses the same colleague as tests/e2e.cjs (tests/.state.json) and creates
// one if there is none. Set OS_SHOTS to a directory to keep screenshots.
// Nothing here touches the real clipboard, opens a window or saves a file
// outside the temporary directory.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect, login, collect, BASE } = require('./browser.cjs')
const JSZip = require('../web/node_modules/jszip')

const { state, save } = require('./browser.cjs').remember()
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
const SHOTS = process.env.OS_SHOTS
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS to an administrator account')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const CLIP = 'application/x-opensuite-slides'

// sibling opens another background tab in the same browser profile as `page`,
// the way a presenter's second window shares the first one's sign-in.
async function sibling(page, url, opened) {
  const browser = page.context().browser()
  const own = await page.context().newCDPSession(page)
  const { targetInfo } = await own.send('Target.getTargetInfo')
  await own.detach()
  const cdp = await browser.newBrowserCDPSession()
  const { targetId } = await cdp.send('Target.createTarget', { url, browserContextId: targetInfo.browserContextId, background: true, focus: false })
  opened.push(() => cdp.send('Target.closeTarget', { targetId }).catch(() => {}))
  for (let i = 0; i < 200; i++) {
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.isClosed()) continue
        const s = await ctx.newCDPSession(p)
        try {
          if ((await s.send('Target.getTargetInfo')).targetInfo.targetId === targetId) return p
        } finally {
          await s.detach().catch(() => {})
        }
      }
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('second tab did not attach')
}

;(async () => {
  const b = await connect()
  const problems = []
  const created = []
  const extra = []
  const ok = (msg) => console.log('  ok  ' + msg)
  let n = 0
  const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${String(++n).padStart(2, '0')}-${name}.png`) })
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
    const A = await b.open()
    const B = await b.open()
    collect(A, 'admin', problems)
    collect(B, 'colleague', problems)
    await login(A, ADMIN.user, ADMIN.pass)
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
    }
    await login(B, state.colleague.user, state.colleague.changed ? COLLEAGUE_PASS : state.colleague.temp)
    if (await B.$('input[autocomplete=new-password]')) {
      await B.fill('input[autocomplete=new-password]', COLLEAGUE_PASS)
      await B.click('button[type=submit]')
      await B.waitForSelector('.rail')
      state.colleague.changed = true
      save()
    }
    ok('two people signed in')

    const deck = (page, fn, arg) => page.evaluate(new Function('arg', `const deck = window.__deck; return (${fn})(deck, arg)`), arg)
    const els = (page) => page.evaluate(() => window.__deck.els().map((e) => ({ id: e.id, type: e.type, shape: e.shape, role: e.role, x: e.x, y: e.y, w: e.w, h: e.h, src: e.src })))
    const rect = async (page, id) => {
      await page.waitForSelector(`.sl-canvas [data-el="${id}"]`)
      return page.evaluate((id) => {
        const r = document.querySelector(`.sl-canvas [data-el="${id}"]`).getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      }, id)
    }
    const stageText = (page) => page.evaluate(() => document.querySelector('.sl-canvas .sl-slide').textContent)
    // into puts the caret at the start or end of a box that already has text:
    // one click selects it, a second one starts typing.
    const into = async (page, selector, where) => {
      const at = { position: { x: 60, y: 24 } }
      await page.click(selector, at)
      await page.waitForTimeout(450)
      if (!(await page.$('.sl-edit-host .sl-text'))) await page.click(selector, at)
      await page.waitForSelector('.sl-edit-host .sl-text')
      await page.evaluate((w) => window.__deck.editor.commands.focus(w), where)
    }

    // --- a new deck opens at once, with a title slide ------------------------
    const tag = Date.now().toString(36)
    await A.click('a[href="/"]')
    await A.click('text=New presentation')
    await A.waitForSelector('.sl-canvas .sl-role-title')
    const url = A.url()
    const id = url.split('/').pop()
    created.push('/api/docs/' + id)
    await A.fill('.doc-title', 'Launch deck')
    await A.click('.sl-canvas .sl-role-title')
    await A.waitForSelector('.sl-edit-host .sl-text')
    await A.keyboard.type(`Launch plan ${tag}`)
    // The toolbar must follow the caret and the keyboard.
    await A.keyboard.press(mod + '+b')
    await A.waitForSelector('[aria-label="Bold"][aria-pressed="true"]', { timeout: 3000 })
    await A.keyboard.press(mod + '+b')
    await A.waitForSelector('[aria-label="Bold"][aria-pressed="false"]', { timeout: 3000 })
    await A.keyboard.press('Escape')
    await A.click('.sl-canvas .sl-role-subtitle')
    await A.keyboard.type('Everything we ship this quarter')
    await A.keyboard.press('Escape')
    await A.waitForFunction((t) => document.querySelector('.sl-thumb .sl-slide').textContent.includes(t), tag)
    ok('deck: title slide typed, thumbnail follows, toolbar reflects the text')
    await shot(A, 'title')

    // --- second slide: a list, a shape, a picture -----------------------------
    await A.click('.sl-add')
    await A.waitForFunction(() => window.__deck.order().length === 2)
    await A.click('.sl-canvas .sl-role-title')
    await A.keyboard.type('What ships')
    await A.keyboard.press('Escape')
    await A.click('.sl-canvas .sl-role-body')
    await A.click('[aria-label="Bulleted list"]')
    for (const line of ['Calendar', 'Files', 'Presentations']) {
      await A.keyboard.type(line)
      await A.keyboard.press('Enter')
    }
    await A.keyboard.press('Escape')
    if ((await A.$$eval('.sl-canvas .sl-role-body li', (l) => l.length)) < 3) throw new Error('bulleted list was not written')

    await A.click('[aria-label="Shape"]')
    await A.click('.menu >> text="Rounded rectangle"')
    await A.keyboard.type('Ready') // typing with a shape selected goes straight into it
    await A.keyboard.press('Escape')
    const shape = (await els(A)).find((e) => e.shape === 'round')
    await A.waitForTimeout(100)
    if (!(await stageText(A)).includes('Ready')) throw new Error('text typed onto a selected shape was lost: ' + (await stageText(A)))
    let r = await rect(A, shape.id)
    await A.mouse.move(r.x + r.w / 2, r.y + r.h / 2)
    await A.mouse.down()
    await A.mouse.move(r.x + r.w / 2 + 180, r.y + r.h / 2 + 120, { steps: 6 })
    await A.mouse.up()
    const moved = (await els(A)).find((e) => e.id === shape.id)
    if (!(moved.x > shape.x + 100 && moved.y > shape.y + 60)) throw new Error(`drag did not move the shape: ${JSON.stringify(moved)}`)
    await A.keyboard.press(mod + '+z')
    if ((await els(A)).find((e) => e.id === shape.id).x !== shape.x) throw new Error('undo did not put the shape back')
    await A.keyboard.press(mod + '+Shift+z')
    if ((await els(A)).find((e) => e.id === shape.id).x !== moved.x) throw new Error('redo did not move the shape again')
    ok('deck: list, shape with text, drag, undo and redo')

    await A.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = 640
      c.height = 400
      const g = c.getContext('2d')
      const grad = g.createLinearGradient(0, 0, 640, 400)
      grad.addColorStop(0, '#1269e8')
      grad.addColorStop(1, '#ff5a1f')
      g.fillStyle = grad
      g.fillRect(0, 0, 640, 400)
      const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
      const dt = new DataTransfer()
      dt.items.add(new File([blob], 'chart.png', { type: 'image/png' }))
      document.querySelector('.sl-area').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    await A.waitForFunction(() => {
      const img = document.querySelector('.sl-canvas .sl-img img')
      return img && img.complete && img.naturalWidth === 640
    }, null, { timeout: 10000 })
    ok('deck: a dropped picture is uploaded and shown')
    await A.keyboard.press('Escape')
    await shot(A, 'second-slide')

    // --- copy and paste, also into another deck -------------------------------
    await deck(A, '(deck, id) => deck.select([id])', shape.id)
    const copied = await A.evaluate((type) => {
      const dt = new DataTransfer()
      document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }))
      return dt.getData(type)
    }, CLIP)
    if (!copied.includes('Ready')) throw new Error('copy did not put the shape on the clipboard')
    const paste = (page) => page.evaluate(([type, data]) => {
      const dt = new DataTransfer()
      dt.setData(type, data)
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, [CLIP, copied])
    await paste(A)
    if ((await els(A)).filter((e) => e.shape === 'round').length !== 2) throw new Error('paste did not add a copy')
    await A.keyboard.press('Delete')
    await A.goto(BASE + '/files')
    await A.click('.page-head button:has-text("New")')
    await A.click('.menu >> text=New presentation')
    await A.waitForSelector('.sl-canvas .sl-role-title')
    created.push('/api/docs/' + A.url().split('/').pop())
    await paste(A)
    await A.waitForFunction(() => document.querySelector('.sl-canvas .sl-slide').textContent.includes('Ready'))
    ok('deck: copy and paste, also from one deck into another')
    await A.goto(url)
    await A.waitForFunction((t) => document.querySelector('.sl-canvas .sl-slide')?.textContent.includes(t), tag)

    // --- a colleague joins ----------------------------------------------------
    await A.click('text=Share')
    await A.click('.modal >> text=Everyone at')
    await A.click('.modal >> text=Done')
    await A.waitForTimeout(600)
    await B.goto(url)
    await B.waitForFunction((t) => document.querySelector('.sl-canvas .sl-slide')?.textContent.includes(t), tag, { timeout: 8000 })
    if ((await B.inputValue('.doc-title')) !== 'Launch deck') throw new Error('title did not sync')
    await A.waitForSelector('.doc-bar .presence .avatar', { timeout: 8000 })
    ok('deck: colleague sees the deck and shows up as present')

    // Both go to slide two.
    await A.click('.sl-thumb:nth-of-type(2)')
    await B.click('.sl-thumb:nth-of-type(2)')
    await A.waitForSelector('.sl-thumb:nth-of-type(2) .sl-thumb-peers i', { timeout: 8000 })
    await into(B, '.sl-canvas .sl-role-body', 'end')
    await B.keyboard.type('Search')
    await A.waitForFunction(() => document.querySelector('.sl-canvas .sl-role-body').textContent.includes('Search'), null, { timeout: 8000 })
    await A.waitForSelector('.sl-overlay .sl-peer', { timeout: 8000 })
    ok('deck: colleague types, the text and their selection arrive live')
    await shot(A, 'colleague-editing')

    // Two people in the same box at the same moment.
    await B.keyboard.press('Escape')
    await into(A, '.sl-canvas .sl-role-title', 'end')
    await into(B, '.sl-canvas .sl-role-title', 'start')
    await Promise.all([A.keyboard.type(' today', { delay: 20 }), B.keyboard.type('Now: ', { delay: 20 })])
    const both = (page) => page.waitForFunction(() => {
      const t = (document.querySelector('.sl-edit-host .sl-text') || document.querySelector('.sl-canvas .sl-role-title')).textContent
      return t.includes('Now: ') && t.includes(' today') && t.includes('What ships')
    }, null, { timeout: 8000 })
    await both(A)
    await both(B)
    await A.keyboard.press('Escape')
    await B.keyboard.press('Escape')
    ok('deck: two people type in the same box at once and both keep their words')

    // Moving a shape and changing the theme arrive too.
    r = await rect(A, shape.id)
    await A.mouse.move(r.x + r.w / 2, r.y + r.h / 2)
    await A.mouse.down()
    await A.mouse.move(r.x + r.w / 2 - 60, r.y + r.h / 2 + 30, { steps: 5 })
    await A.mouse.up()
    const after = (await els(A)).find((e) => e.id === shape.id)
    await B.waitForFunction(([id, x]) => window.__deck.el(id)?.x === x, [shape.id, after.x], { timeout: 8000 })
    await A.keyboard.press('Escape')
    await A.click('[aria-label="Theme"]')
    await A.click('[aria-label="Midnight theme"]')
    await B.waitForFunction(() => window.__deck.themeId() === 'midnight', null, { timeout: 8000 })
    await A.fill('.sl-notes textarea', 'Ask for questions here.')
    await B.waitForFunction(() => document.querySelector('.sl-notes textarea').value === 'Ask for questions here.', null, { timeout: 8000 })
    ok('deck: moves, theme and speaker notes sync')
    await shot(B, 'midnight-colleague')

    // Reordering slides by dragging in the strip.
    const before = await deck(A, '(deck) => deck.order()')
    const t1 = await A.evaluate(() => { const r = document.querySelector('.sl-thumb:nth-of-type(1)').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    const t2 = await A.evaluate(() => { const r = document.querySelector('.sl-thumb:nth-of-type(2)').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    await A.mouse.move(t2.x, t2.y)
    await A.mouse.down()
    await A.mouse.move(t1.x, t1.y - 30, { steps: 6 })
    await A.mouse.up()
    await B.waitForFunction((first) => window.__deck.order()[0] === first, before[1], { timeout: 8000 })
    await A.mouse.move(t1.x, t1.y)
    await A.mouse.down()
    await A.mouse.move(t2.x, t2.y + 60, { steps: 6 })
    await A.mouse.up()
    await B.waitForFunction((first) => window.__deck.order()[0] === first, before[0], { timeout: 8000 })
    ok('deck: slides reorder by dragging, for both people')

    // --- presenting -----------------------------------------------------------
    await A.click('.sl-present >> text=Present')
    await A.waitForSelector('.sl-show')
    await A.waitForFunction((t) => document.querySelector('.sl-show .sl-slide').textContent.includes(t), tag)
    const P = await sibling(A, url + '?presenter=1', extra)
    collect(P, 'presenter', problems)
    await P.waitForSelector('.sl-presenter .sl-slide', { timeout: 10000 })
    await P.waitForFunction(() => document.querySelector('.sl-pr-label').textContent.startsWith('Slide 1 of'))
    await A.keyboard.press('ArrowRight')
    await A.waitForFunction(() => document.querySelector('.sl-show-count').textContent.trim().startsWith('2 /'))
    await P.waitForFunction(() => document.querySelector('.sl-pr-label').textContent.startsWith('Slide 2 of'), null, { timeout: 5000 })
    if (!(await P.textContent('.sl-pr-notes')).includes('Ask for questions')) throw new Error('presenter view does not show the notes')
    await shot(P, 'presenter-view')
    await shot(A, 'slide-show')
    await P.click('text=Previous')
    await A.waitForFunction(() => document.querySelector('.sl-show-count').textContent.trim().startsWith('1 /'), null, { timeout: 5000 })
    await A.keyboard.press('Escape')
    await A.waitForSelector('.sl-show', { state: 'detached' })
    ok('deck: slide show runs, and the presenter view drives it from a second window')

    // --- out: PDF pages and PowerPoint, and back in ----------------------------
    const pages = await A.evaluate(() => {
      window.dispatchEvent(new Event('beforeprint'))
      const n = document.querySelectorAll('.sl-print .sl-page .sl-slide').length
      window.dispatchEvent(new Event('afterprint'))
      return [n, document.querySelectorAll('.sl-print').length]
    })
    if (pages[0] !== 2 || pages[1] !== 0) throw new Error('print pages: ' + pages)
    ok('deck: printing lays out one page per slide')

    await A.evaluate(() => {
      // Keep the file in the page instead of saving it to the Downloads folder.
      const click = HTMLAnchorElement.prototype.click
      const make = URL.createObjectURL
      let last = null
      URL.createObjectURL = (blob) => make.call(URL, (last = blob))
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) window.__saved = { blob: last, name: this.download }
        else click.call(this)
      }
    })
    await A.click('[aria-label="More"]')
    await A.click('.menu >> text=Download as PowerPoint')
    await A.waitForFunction(() => window.__saved, null, { timeout: 20000 })
    const b64 = await A.evaluate(async () => {
      const buf = new Uint8Array(await window.__saved.blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
      return btoa(s)
    })
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'os-slides-')), 'Launch deck.pptx')
    fs.writeFileSync(file, Buffer.from(b64, 'base64'))
    const zip = await JSZip.loadAsync(fs.readFileSync(file))
    const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    const first = await zip.file('ppt/slides/slide1.xml').async('string')
    const second = await zip.file('ppt/slides/slide2.xml').async('string')
    if (slideFiles.length !== 2 || !first.includes(tag) || !second.includes('Presentations') || !second.includes('<p:pic>') || !second.includes('roundRect')) throw new Error('the .pptx file is missing content')
    ok(`deck: exported to PowerPoint (${(fs.statSync(file).size / 1024).toFixed(0)} KB, text, shape and picture inside)`)
    if (SHOTS) fs.copyFileSync(file, path.join(SHOTS, 'export.pptx'))

    const [chooser] = await Promise.all([
      A.waitForEvent('filechooser'),
      (async () => {
        await A.click('[aria-label="More"]')
        await A.click('.menu >> text=Add slides from PowerPoint')
      })(),
    ])
    await chooser.setFiles(file)
    await A.waitForFunction(() => window.__deck.order().length === 4, null, { timeout: 20000 })
    const back = await deck(A, `(deck) => deck.order().slice(2).map((sid) => ({
      text: [...deck.slides.get(sid).get('els').values()].map((m) => m.get('type') + ':' + (m.get('text') ? m.get('text').toString().replace(/<[^>]+>/g, ' ') : '')).join('|'),
      notes: deck.notes(sid), kinds: deck.els(sid).map((e) => e.type + (e.shape && e.shape !== 'none' ? '/' + e.shape : '')) }))`)
    if (!back[0].text.includes(tag) || !back[1].text.includes('Presentations') || !back[1].kinds.includes('image') || !back[1].kinds.includes('box/round') || !back[1].notes.includes('Ask for questions')) {
      throw new Error('round trip through PowerPoint lost content: ' + JSON.stringify(back))
    }
    ok('deck: the exported file reads back in with its text, list, shape, picture and notes')
    await A.click('.sl-thumb:nth-of-type(4)')
    await A.waitForTimeout(300)
    await shot(A, 'imported-slide')

    // --- a person who may only view ---------------------------------------------
    await A.evaluate(async ([id, who]) => {
      const boot = await (await fetch('/api/boot')).json()
      const user = boot.people.find((p) => p.email === who).id
      await fetch('/api/docs/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access: 'private', shares: [{ user, role: 'view' }] }) })
    }, [id, state.colleague.user])
    await B.goto(BASE + '/docs')
    await B.waitForSelector('.page-head')
    await B.goto(url)
    await B.waitForSelector('.sl-view.readonly .sl-canvas .sl-slide', { timeout: 8000 })
    if (await B.$('.sl-toolbar')) throw new Error('a viewer was given the editing toolbar')
    // Over a real network the deck is still arriving when its first slide
    // shows; count once it has stopped growing.
    let count = -1
    for (let i = 0; i < 20; i++) {
      const n = (await els(B)).length
      if (n === count) break
      count = n
      await B.waitForTimeout(500)
    }
    r = await B.evaluate(() => { const q = document.querySelector('.sl-canvas .sl-box').getBoundingClientRect(); return { x: q.x + 20, y: q.y + 20 } })
    await B.mouse.click(r.x, r.y)
    await B.keyboard.type('x')
    await B.keyboard.press('Delete')
    if ((await els(B)).length !== count || (await B.$('.sl-edit-host .sl-text'))) throw new Error('a viewer could change the deck')
    await B.click('.sl-present >> text=Present')
    await B.waitForSelector('.sl-show .sl-slide')
    await B.keyboard.press('Escape')
    ok('deck: someone with view access can look and present, not edit')

    await A.goto(BASE + '/')
    await A.waitForSelector('.rail')
    await A.evaluate(async (made) => {
      for (const p of made) await fetch(p, { method: 'DELETE' })
    }, created)
    ok(`cleaned up ${created.length} test item(s)`)

    if (problems.length) throw new Error('problems during the run:\n' + problems.join('\n'))
    console.log('all good')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 14).join('\n'))
    if (SHOTS) for (const [i, p] of b.pages.entries()) await p.screenshot({ path: path.join(SHOTS, `fail-${i}.png`) }).catch(() => {})
    process.exitCode = 1
  } finally {
    for (const close of extra) await close()
    await b.close()
  }
})()
