// End-to-end check of document formatting against a live Open Suite, with
// two people in the document at once: fonts and sizes, line spacing and
// indents, page breaks, a table of contents, footnotes, pictures, page setup
// with a header and footer, find and replace, word count, the menu bar and
// its search, a Word download and version history. Fails on any console
// error or failed request.
//
//   OS_BASE=... OS_E2E_USER=ada OS_E2E_PASS=... node tests/e2e-docformat.cjs
//
// Run tests/e2e.cjs once first: it creates the colleague. Set OS_SHOTS to a
// directory to keep screenshots.
const fs = require('fs')
const path = require('path')
const os = require('os')
const { connect, login, collect, BASE } = require('./browser.cjs')

const { state } = require('./browser.cjs').remember()
const ADMIN = { user: process.env.OS_E2E_USER, pass: process.env.OS_E2E_PASS }
const COLLEAGUE_PASS = process.env.OS_E2E_COLLEAGUE_PASS || 'compilers-are-great-07'
if (!ADMIN.user || !ADMIN.pass) throw new Error('set OS_E2E_USER and OS_E2E_PASS to an administrator account')
if (!state.colleague?.changed) throw new Error('run tests/e2e.cjs first: it creates the colleague')
const SHOTS = process.env.OS_SHOTS
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true })
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const live = '.doc-live .paper'

// A small picture to insert: a 40 × 30 PNG, two colours.
function png() {
  const zlib = require('zlib')
  const w = 40, h = 30
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3
    raw[o] = x < 20 ? 18 : 240; raw[o + 1] = 105; raw[o + 2] = x < 20 ? 232 : 60
  }
  const crc = (b) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1 } return ~c >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function shot(page, name) {
  if (!SHOTS) return
  await page.waitForTimeout(150)
  await page.screenshot({ path: path.join(SHOTS, name + '.png') })
}

// selectText selects some text in the document as dragging would, and waits
// until the editor has taken the selection (see e2e-depth.cjs).
async function selectText(page, text) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.evaluate(({ text, live }) => {
      const root = document.querySelector(live)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n; (n = walker.nextNode());) {
        if (n.parentElement.closest('.caret, .fn-list, nav.toc')) continue
        const i = n.data.indexOf(text)
        if (i < 0) continue
        root.focus()
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + text.length)
        getSelection().removeAllRanges()
        getSelection().addRange(r)
        return
      }
      throw new Error(`"${text}" is not in the document`)
    }, { text, live })
    await page.waitForTimeout(150)
    if ((await page.evaluate(() => getSelection().toString())) === text) return
  }
  throw new Error(`could not select "${text}"`)
}

async function caretAtEnd(page) {
  await page.click(live)
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
}

async function menu(page, ...path) {
  await page.click(`.menubar .mb-btn:text-is("${path[0]}")`)
  for (const [i, label] of path.slice(1).entries()) {
    const item = page.locator(`.menubar .menu-item:has(.mb-label:text-is("${label}"))`).last()
    if (i < path.length - 2) await item.hover()
    else await item.click()
  }
}

;(async () => {
  const b = await connect()
  const problems = []
  let created = null
  const ok = (msg) => console.log('  ok  ' + msg)
  try {
    const A = await b.open()
    const B = await b.open()
    collect(A, 'admin', problems)
    collect(B, 'colleague', problems)
    await login(A, ADMIN.user, ADMIN.pass)
    await login(B, state.colleague.user, COLLEAGUE_PASS)

    await A.goto(BASE + '/')
    await A.click('.quick-btn:has-text("New document")')
    await A.waitForSelector(live)
    created = '/api/docs/' + A.url().split('/').pop()
    await A.fill('.doc-title', 'Formatting check')
    await A.click(live)
    await A.keyboard.type('Introduction')
    await A.keyboard.press(mod + '+Alt+1')
    await A.keyboard.press('Enter')
    await A.keyboard.type('The cat sat on the mat. A Cat is not a dog.')
    await A.click('text=Share')
    await A.click('.modal >> text=Everyone at')
    await A.click('.modal >> text=Done')
    await A.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
    await B.goto(A.url())
    await B.waitForFunction((live) => document.querySelector(live)?.textContent.includes('mat'), live)
    const seen = (what, fn, arg) => B.waitForFunction(fn, arg, { timeout: 8000 }).catch(() => { throw new Error(`the colleague does not see ${what}`) })

    // Fonts and sizes from the toolbar.
    await selectText(A, 'sat on the mat')
    await A.selectOption('[aria-label="Font"]', { label: 'Georgia' })
    await selectText(A, 'sat on the mat')
    await A.selectOption('[aria-label="Font size"]', '18')
    await seen('the font and size', (live) => [...document.querySelectorAll(live + ' span[style]')].some((s) => s.style.fontFamily.includes('Georgia') && s.style.fontSize === '18pt'), live)
    ok('font and size reach the colleague')

    // Line spacing from the menu bar, an indent from the toolbar.
    await selectText(A, 'sat on the mat')
    await menu(A, 'Format', 'Line spacing', 'Double')
    await A.click('[aria-label="Increase indent"]')
    await seen('line spacing and indent', (live) => { const p = document.querySelector(live + ' p'); return p && p.style.lineHeight === '2' && p.getAttribute('data-indent') === '1' }, live)
    ok('line spacing and indent reach the colleague')

    // A page break, a table of contents that follows the headings.
    await caretAtEnd(A)
    await menu(A, 'Insert', 'Page break')
    await A.keyboard.type('Second part')
    await A.keyboard.press(mod + '+Alt+2')
    await A.keyboard.press('Enter')
    await A.keyboard.type('More text here.')
    await A.click(live + ' h1')
    await A.keyboard.press('Home')
    await menu(A, 'Insert', 'Table of contents')
    await seen('the page break and contents', (live) => {
      const toc = document.querySelector(live + ' nav.toc')
      return !!document.querySelector(live + ' .page-break') && toc && toc.textContent.includes('Introduction') && toc.textContent.includes('Second part')
    }, live)
    await caretAtEnd(A)
    await A.keyboard.press('Enter')
    await A.keyboard.type('Third part')
    await A.keyboard.press(mod + '+Alt+2')
    await seen('the contents update', (live) => document.querySelector(live + ' nav.toc')?.textContent.includes('Third part'), live)
    ok('page break and a table of contents that updates for everyone')

    // A footnote.
    await selectText(A, 'mat')
    await A.keyboard.press('ArrowRight')
    await menu(A, 'Insert', 'Footnote')
    await A.waitForSelector('.fn-box textarea')
    await A.keyboard.type('Mats are usually woven.')
    await A.keyboard.press('Enter')
    await A.waitForSelector('.fn-box', { state: 'detached' })
    await seen('the footnote', (live) => document.querySelector(live + ' sup.fn-ref')?.getAttribute('data-footnote') === 'Mats are usually woven.' && document.querySelector(live + ' .fn-list li')?.textContent === 'Mats are usually woven.', live)
    await shot(A, 'doc-footnote')
    ok('a footnote, numbered in the text and listed at the end')

    // A picture: inserted, wrapped and sized.
    await caretAtEnd(A)
    const file = path.join(os.tmpdir(), 'os-e2e-picture.png')
    fs.writeFileSync(file, png())
    const [chooser] = await Promise.all([A.waitForEvent('filechooser'), A.click('.toolbar [aria-label="Image"]')])
    await chooser.setFiles(file)
    await A.waitForSelector(live + ' .img-wrap img')
    await A.click(live + ' .img-wrap img')
    await A.waitForSelector('.pic-bar')
    await A.selectOption('[aria-label="Picture layout"]', 'left')
    await A.selectOption('[aria-label="Picture size"]', '50%')
    await seen('the wrapped picture', (live) => { const w = document.querySelector(live + ' .img-wrap'); return w && w.dataset.wrap === 'left' && w.style.width === '50%' && getComputedStyle(w).float === 'left' }, live)
    await A.selectOption('[aria-label="Picture layout"]', 'inline')
    await seen('the picture in line', (live) => !!document.querySelector(live + ' p .img-wrap.inline'), live)
    await shot(A, 'doc-picture')
    ok('a picture wraps, sizes and sits in a line, for everyone')

    // Page setup, with a header and footer.
    await menu(A, 'File', 'Page setup…')
    await A.selectOption('.modal [aria-label="Paper size"]', 'letter')
    await A.click('.modal [role="radio"]:has-text("Landscape")')
    await A.fill('.modal [aria-label="Top margin (mm)"]', '30')
    await A.fill('.modal [aria-label="Header"]', '{title}')
    await A.fill('.modal [aria-label="Footer"]', 'Page ')
    await A.locator('.modal .ps-chip:has-text("Page number")').nth(1).click()
    await A.selectOption('.modal [aria-label="Footer alignment"]', 'right')
    await shot(A, 'doc-page-setup')
    await A.click('.modal >> text=Apply')
    await seen('the page setup', () => {
      const p = document.querySelector('.doc-page')
      return p && p.style.width === '1056px' && document.querySelector('.page-band.bottom')?.textContent === 'Page #'
    })
    const print = await A.evaluate(() => [...document.querySelectorAll('.doc-view style')].map((s) => s.textContent).join(''))
    if (!print.includes('size: 279.4mm 215.9mm') || !print.includes('margin: 30mm') || !print.includes('@bottom-right { content: "Page " counter(page)') || !print.includes('@top-center { content: "Formatting check"')) throw new Error('print rule: ' + print)
    ok('page setup reaches the colleague, and printing uses it')

    // Find and replace.
    await A.click(live)
    await A.keyboard.press(mod + '+Shift+h')
    await A.waitForSelector('.find-bar')
    await A.fill('.find-bar [aria-label="Find"]', 'cat')
    await A.waitForFunction(() => document.querySelector('.find-count')?.textContent === '0 of 2')
    await A.click('.find-bar [aria-label="Match case"]')
    await A.waitForFunction(() => document.querySelector('.find-count')?.textContent === '0 of 1')
    await A.click('.find-bar [aria-label="Match case"]')
    await A.fill('.find-bar [aria-label="Replace with"]', 'dog')
    await shot(A, 'doc-find')
    await A.click('.find-bar >> text=Replace all')
    await seen('the replacements', (live) => document.querySelector(live).textContent.includes('The dog sat') && document.querySelector(live).textContent.includes('A dog is not'), live)
    await A.click('.find-bar [aria-label="Close"]')
    ok('find and replace, with match case')

    // Word count.
    await menu(A, 'Tools', 'Word count')
    const words = await A.$eval('.wc-table tbody tr:first-child td:last-child', (el) => +el.textContent)
    if (words < 15) throw new Error('word count shows ' + words)
    await shot(A, 'doc-word-count')
    await A.click('.modal >> text=OK')
    ok(`word count: ${words} words`)

    // The menu search.
    await A.click(live)
    await A.keyboard.press('Alt+/')
    await A.fill('.mb-search input', 'footnote')
    await A.waitForSelector('.mb-search .menu-item:has-text("Footnote")')
    await A.keyboard.press('Escape')
    ok('the menus can be searched')

    // A Word file carries the page setup and footnote.
    // The file is caught as the page hands it to the browser to save: a
    // browser attached over CDP does not report downloads.
    await A.evaluate(() => {
      window.__saved = null
      const make = URL.createObjectURL
      URL.createObjectURL = (blob) => {
        window.__saved = blob
        return make(blob)
      }
      const click = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download) return click.call(this)
      }
    })
    await menu(A, 'File', 'Download', 'Microsoft Word (.docx)')
    await A.waitForFunction(() => window.__saved, null, { timeout: 15000 })
    const docx = await A.evaluate(async () => new TextDecoder('latin1').decode(await window.__saved.arrayBuffer()))
    if (!docx.includes('footer-os.xml') || !docx.includes('header-os.xml') || !docx.includes('footnotes.xml')) throw new Error('the Word file lacks its header, footer or footnotes')
    ok('a Word download carries header, footer and footnotes')

    // A restored version brings its page setup back.
    await menu(A, 'File', 'Version history')
    await A.waitForSelector('.versions')
    await A.click('.versions >> text=Name this version')
    await A.fill('.modal input', 'Letter landscape')
    await A.click('.modal >> text=Save')
    await A.waitForSelector('.ver-row >> text=Letter landscape')
    await A.click('[aria-label="Close version history"]')
    await menu(A, 'File', 'Page setup…')
    await A.click('.modal >> text=Reset to defaults')
    await A.click('.modal >> text=Apply')
    await A.waitForFunction(() => document.querySelector('.doc-page').style.width === '794px')
    await A.waitForFunction(() => document.querySelector('.save-state')?.textContent === 'Saved')
    await menu(A, 'File', 'Version history')
    await A.click('.ver-row >> text=Letter landscape')
    await A.waitForSelector('.version-bar')
    await A.waitForFunction(() => document.querySelector('.doc-page').style.width === '1056px')
    await A.click('.version-bar >> text=Restore this version')
    await A.waitForSelector('.version-bar', { state: 'detached' })
    await seen('the restored page setup', () => document.querySelector('.doc-page').style.width === '1056px')
    ok('restoring a version brings back its page setup, for everyone')
    await A.click('[aria-label="Close version history"]')
    await shot(A, 'doc-menubar')

    await A.goto(BASE + '/')
    await A.waitForSelector('.rail')
    await A.evaluate((p) => fetch(p, { method: 'DELETE' }), created)
    created = null
    ok('cleaned up')

    if (problems.length) throw new Error('problems during the run:\n' + problems.join('\n'))
    console.log('all good')
  } catch (e) {
    console.error('FAILED: ' + e.message.split('\n').slice(0, 12).join('\n'))
    if (problems.length) console.error(problems.slice(0, 12).join('\n'))
    if (SHOTS) for (const [i, page] of b.pages.entries()) await page.screenshot({ path: path.join(SHOTS, `failed-${i}.png`) }).catch(() => {})
    process.exitCode = 1
  } finally {
    await b.close()
  }
})()
